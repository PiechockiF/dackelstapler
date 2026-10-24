"""Site twin service: sites, one cached BuildingMap per site with live state applied, and every edit
(closures, asset moves, added doors, bookings, deliveries) persisted as rows + an Event + a WebSocket push.

Both the REST handlers (server/main.py) and the chat tools (agent/tools.py) call these functions, so a
change made by voice and one made by clicking look identical to every client."""

from __future__ import annotations

import copy
import importlib
import json
import logging
import math
import threading
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

from server import db
from server.db import (
    AddedDoorRow, AssetMoveRow, BookingRow, ClosureRow, DeliveryRow, EventRow, SiteRow, select,
)
from server.directions import landmark_steps
from server.ws import publish

log = logging.getLogger("sitetwin.twin")
LOCAL_TZ = ZoneInfo("Europe/Berlin")
SITES_JSON = db.ROOT / "data" / "sites.json"
BOOKABLE_TYPES = {"meeting_room", "seminar_room", "lecture_hall", "library"}
BOOKABLE_WORDS = ("meeting", "besprechung")
AREA_PER_PERSON_M2 = 2.5
SEATING_FALLBACK = {"chair", "office_chair", "dining_chair", "armchair", "sofa", "lecture_seating_row", "bench"}

try:  # agent A's core; the starter map keeps us running if it is missing or broken
    from core.building_map import BuildingMap, MapError
    HAVE_CORE = True
except Exception:  # noqa: BLE001
    from starter_agent.building_map import BuildingMap, MapError  # type: ignore[assignment]
    HAVE_CORE = False


class NotFound(LookupError):
    pass


OUTSIDE_NODE = "outside"
DOOR_NODE_PREFIX = "door:"


class AppBuildingMap(BuildingMap):
    """The app's map: identical to the benchmark model except that walking outside between two entrances
    costs the straight-line distance between them (the benchmark joins all entrances at zero cost, which
    would draw routes that teleport across the yard)."""

    def graph(self, step_free, *args, **kwargs):  # type: ignore[override]
        graph = super().graph(step_free, *args, **kwargs)
        if OUTSIDE_NODE not in graph:
            return graph
        doors = [node for node in graph.neighbors(OUTSIDE_NODE) if node.startswith(DOOR_NODE_PREFIX)]
        graph.remove_node(OUTSIDE_NODE)
        for index, first in enumerate(doors):
            a = self.openings[first[len(DOOR_NODE_PREFIX):]]
            for second in doors[index + 1:]:
                b = self.openings[second[len(DOOR_NODE_PREFIX):]]
                weight = math.dist(a["position"], b["position"])
                graph.add_edge(first, second, weight=weight, via=OUTSIDE_NODE)
        return graph


# ---------------------------------------------------------------- time helpers

def parse_time(value: str | datetime | None, default: datetime | None = None) -> datetime:
    """ISO string → aware datetime. Naive times are Munich local time."""
    if value is None or value == "":
        if default is None:
            raise ValueError("time missing")
        return default
    if isinstance(value, datetime):
        moment = value
    else:
        text = value.strip().replace(" ", "T", 1) if "T" not in value and len(value) > 10 else value.strip()
        moment = datetime.fromisoformat(text)
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=LOCAL_TZ)
    return moment


def iso(moment: datetime) -> str:
    return moment.astimezone(ZoneInfo("UTC")).isoformat(timespec="seconds").replace("+00:00", "Z")


def local_now() -> datetime:
    return datetime.now(LOCAL_TZ)


# ---------------------------------------------------------------- sites

def seed_sites() -> int:
    """Insert every site from data/sites.json that is not in the DB yet. Returns the number added."""
    if not SITES_JSON.exists():
        return 0
    sites = json.loads(SITES_JSON.read_text(encoding="utf-8"))
    added = 0
    with db.session() as session:
        existing = set(session.exec(select(SiteRow.id)).all())
        for site in sites:
            if site["id"] in existing:
                continue
            session.add(SiteRow(**{key: site[key] for key in (
                "id", "name", "lat", "lon", "source", "building_id", "data_path", "floors", "demo_location", "kind")}))
            added += 1
        session.commit()
    return added


def list_sites() -> list[dict]:
    with db.session() as session:
        rows = session.exec(select(SiteRow)).all()
    order = {"proc-factory-dev-003": 0}
    rows = sorted(rows, key=lambda row: (order.get(row.id, 1), not row.user_created, row.kind, row.name))
    return [row.to_site() for row in rows]


def get_site(site_id: str) -> dict:
    with db.session() as session:
        row = session.get(SiteRow, site_id)
    if row is None:
        raise NotFound(f"Unknown site '{site_id}'.")
    return row.to_site()


def create_site_row(site: dict, user_created: bool = True) -> dict:
    with db.session() as session:
        session.merge(SiteRow(**site, user_created=user_created))
        session.commit()
    return get_site(site["id"])


def building_file(site: dict) -> Path:
    path = Path(site["data_path"])
    if not path.is_absolute():
        path = db.ROOT / path
    return path / "building.json" if path.suffix != ".json" else path


# ---------------------------------------------------------------- map cache

_maps: dict[str, BuildingMap] = {}
_originals: dict[str, dict] = {}
_locks: dict[str, threading.RLock] = {}
_global_lock = threading.Lock()


def lock(site_id: str) -> threading.RLock:
    with _global_lock:
        return _locks.setdefault(site_id, threading.RLock())


def _original(site_id: str) -> dict:
    if site_id not in _originals:
        site = get_site(site_id)
        path = building_file(site)
        if not path.exists():
            raise NotFound(f"Building file for site '{site_id}' is missing ({path}).")
        _originals[site_id] = json.loads(path.read_text(encoding="utf-8"))
    return _originals[site_id]


def _added_openings(site_id: str) -> list[dict]:
    with db.session() as session:
        rows = session.exec(select(AddedDoorRow).where(AddedDoorRow.site_id == site_id).order_by(AddedDoorRow.ts)).all()
    return [json.loads(row.opening_json) for row in rows]


def raw_building(site_id: str) -> dict:
    """The site's building.json with added doors (assets at their original places; moves are in /state)."""
    with lock(site_id):
        data = copy.deepcopy(_original(site_id))
        known = {opening["id"] for opening in data["openings"]}
        data["openings"].extend(opening for opening in _added_openings(site_id) if opening["id"] not in known)
        return data


def get_map(site_id: str) -> BuildingMap:
    """Cached BuildingMap with closures, moved assets and added doors applied."""
    with lock(site_id):
        if site_id in _maps:
            return _maps[site_id]
        bm = AppBuildingMap(raw_building(site_id))
        with db.session() as session:
            bm.closed = {row.element_id for row in session.exec(select(ClosureRow).where(ClosureRow.site_id == site_id))}
            for move in session.exec(select(AssetMoveRow).where(AssetMoveRow.site_id == site_id)):
                asset = bm.assets.get(move.asset_id)
                if asset is not None:
                    asset.update(space_id=move.space_id, floor_id=move.floor_id, position=[move.x, move.y])
        _maps[site_id] = bm
        return bm


def invalidate(site_id: str | None = None) -> None:
    with _global_lock:
        if site_id is None:
            _maps.clear()
            _originals.clear()
        else:
            _maps.pop(site_id, None)
            _originals.pop(site_id, None)


# ---------------------------------------------------------------- events

def record_event(site_id: str, type_: str, title: str, payload: dict, ts: str | None = None,
                 broadcast: bool = True, event_id: str | None = None) -> dict:
    row = EventRow(id=event_id or db.new_id("ev"), ts=ts or db.now_iso(), site_id=site_id, type=type_,
                   title=title, payload_json=json.dumps(payload, ensure_ascii=False, default=str))
    with db.session() as session:
        session.merge(row)
        session.commit()
        event = row.to_event()
    if broadcast:
        publish({"type": "event", "event": event})
    return event


def list_events(site_id: str, since: str | None = None, limit: int = 200) -> list[dict]:
    get_site(site_id)
    with db.session() as session:
        query = select(EventRow).where(EventRow.site_id == site_id)
        rows = session.exec(query).all()
    events = [row.to_event() for row in rows]
    if since:
        threshold = parse_time(since)
        events = [event for event in events if parse_time(event["ts"]) >= threshold]
    events.sort(key=lambda event: parse_time(event["ts"]), reverse=True)
    return events[: max(1, min(limit, 2000))]


# ---------------------------------------------------------------- deliveries

def _capture_deliveries(site_id: str) -> list[dict]:
    """Deliveries from agent C's capture package, if it exposes a lister."""
    for module_name, function_name in (
        ("capture.store", "list_deliveries"), ("capture.deliveries", "list_deliveries"),
        ("capture.router", "list_deliveries"), ("capture", "list_deliveries"),
    ):
        try:
            module = importlib.import_module(module_name)
        except Exception:  # noqa: BLE001
            continue
        function = getattr(module, function_name, None)
        if callable(function):
            try:
                return list(function(site_id) or [])
            except Exception as error:  # noqa: BLE001
                log.warning("capture deliveries failed: %s", error)
                return []
    return []


def list_deliveries(site_id: str) -> list[dict]:
    with db.session() as session:
        rows = session.exec(select(DeliveryRow).where(DeliveryRow.site_id == site_id)).all()
    deliveries = {row.id: json.loads(row.payload_json) for row in rows}
    for delivery in _capture_deliveries(site_id):
        if isinstance(delivery, dict) and delivery.get("id"):
            deliveries[delivery["id"]] = delivery
    return sorted(deliveries.values(), key=lambda item: item.get("ts", ""), reverse=True)


def add_delivery(delivery: dict, broadcast: bool = True, title: str | None = None) -> dict:
    """Store a Delivery (contract shape) and emit a 'delivery' event. Usable by capture and seeding."""
    delivery = {**delivery}
    delivery.setdefault("id", db.new_id("dl"))
    delivery.setdefault("ts", db.now_iso())
    site_id = delivery["site_id"]
    with db.session() as session:
        session.merge(DeliveryRow(id=delivery["id"], site_id=site_id, ts=delivery["ts"],
                                  payload_json=json.dumps(delivery, ensure_ascii=False)))
        session.commit()
    if title is None:
        where = ""
        try:
            where = f" to {get_map(site_id).spaces[delivery['space_id']]['name']}"
        except Exception:  # noqa: BLE001
            pass
        title = f"{delivery.get('label', 'Delivery')} delivered{where}"
    record_event(site_id, "delivery", title, delivery, ts=delivery["ts"], broadcast=broadcast,
                 event_id=f"ev-{delivery['id']}")
    return delivery


# ---------------------------------------------------------------- state

def site_state(site_id: str) -> dict:
    bm = get_map(site_id)
    with db.session() as session:
        moves = session.exec(select(AssetMoveRow).where(AssetMoveRow.site_id == site_id)).all()
    return {
        "closed": sorted(bm.closed),
        "asset_overrides": {
            move.asset_id: {"position": [move.x, move.y], "floor_id": move.floor_id, "space_id": move.space_id}
            for move in moves
        },
        "deliveries": list_deliveries(site_id),
        "added_openings": _added_openings(site_id),
    }


def element_name(bm, element_id: str) -> tuple[str, str]:
    """(human name, kind) for a closable element."""
    if element_id in bm.connectors:
        connector = bm.connectors[element_id]
        return connector["name"], connector["kind"]
    if element_id in bm.openings:
        opening = bm.openings[element_id]
        sides = [bm.spaces[s]["name"] if s in bm.spaces else "outside" for s in opening["space_ids"]]
        return f"{opening['kind'].capitalize()} between {sides[0]} and {sides[1]}", opening["kind"]
    if element_id in bm.spaces:
        return bm.spaces[element_id]["name"], "space"
    return element_id, "unknown"


def set_closed(site_id: str, element: str, closed: bool, ts: str | None = None, broadcast: bool = True) -> dict:
    """Close/reopen a lift, stair, door or room. Returns {element_id, name, kind, closed, event}."""
    with lock(site_id):
        bm = get_map(site_id)
        element_id = bm.find_element(element)
        name, kind = element_name(bm, element_id)
        changed = (element_id in bm.closed) != closed
        if closed:
            bm.closed.add(element_id)
        else:
            bm.closed.discard(element_id)
        with db.session() as session:
            existing = session.get(ClosureRow, (site_id, element_id))
            if closed and existing is None:
                session.add(ClosureRow(site_id=site_id, element_id=element_id))
            elif not closed and existing is not None:
                session.delete(existing)
            session.commit()
    event = None
    if changed:
        title = f"{name} {'closed' if closed else 'reopened'}"
        event = record_event(site_id, "closure", title,
                             {"element_id": element_id, "name": name, "kind": kind, "closed": closed},
                             ts=ts, broadcast=broadcast)
    return {"element_id": element_id, "name": name, "kind": kind, "closed": closed, "changed": changed, "event": event}


def resolve_asset(bm, reference: str) -> str:
    if reference in bm.assets:
        return reference
    lowered = reference.strip().lower()
    exact = [asset["id"] for asset in bm.assets.values() if asset["name"].lower() == lowered]
    if len(exact) == 1:
        return exact[0]
    words = lowered.replace("_", " ").split()
    matches = [asset for asset in bm.assets.values()
               if all(word in f"{asset['name']} {asset['type'].replace('_', ' ')}".lower() for word in words)]
    if len(matches) == 1:
        return matches[0]["id"]
    if not matches:
        raise MapError(f"No asset matches '{reference}'.")
    raise MapError("Several assets match: " + "; ".join(f"{a['id']} ({a['name']})" for a in matches[:12]))


def move_asset(site_id: str, asset_ref: str, space_ref: str, position: list[float] | None = None,
               ts: str | None = None, broadcast: bool = True) -> dict:
    with lock(site_id):
        bm = get_map(site_id)
        asset_id = resolve_asset(bm, asset_ref)
        space_id = bm.resolve_space(space_ref)
        asset = bm.assets[asset_id]
        space = bm.spaces[space_id]
        if position is None:
            position = list(bm.anchor(space_id))
        position = [round(float(position[0]), 3), round(float(position[1]), 3)]
        before = {"space_id": asset["space_id"], "floor_id": asset["floor_id"], "position": list(asset["position"])}
        after = {"space_id": space_id, "floor_id": space["floor_id"], "position": position}
        asset.update(space_id=space_id, floor_id=space["floor_id"], position=position)
        with db.session() as session:
            session.merge(AssetMoveRow(site_id=site_id, asset_id=asset_id, space_id=space_id,
                                       floor_id=space["floor_id"], x=position[0], y=position[1]))
            session.commit()
    title = f"{asset['name']} moved to {space['name']}"
    event = record_event(site_id, "asset_moved", title,
                         {"asset_id": asset_id, "name": asset["name"], "from": before, "to": after},
                         ts=ts, broadcast=broadcast)
    return {"asset_id": asset_id, "name": asset["name"], "from": before, "to": after, "event": event}


def add_door(site_id: str, first: str, second: str, step_free: bool = True, width_m: float | None = None,
             ts: str | None = None, broadcast: bool = True) -> dict:
    with lock(site_id):
        bm = get_map(site_id)
        opening = bm.add_door(first, second, step_free)  # validates same floor + shared wall
        # The starter numbers new doors by count, which can collide after a restart: use a unique id.
        bm.openings.pop(opening["id"], None)
        opening["id"] = f"{opening['floor_id']}-O-new-{db.new_id('d')[2:]}"
        bm.openings[opening["id"]] = opening
        if width_m:
            opening["width_m"] = float(width_m)
        with db.session() as session:
            session.add(AddedDoorRow(id=opening["id"], site_id=site_id, opening_json=json.dumps(opening)))
            session.commit()
    names = [bm.spaces[space_id]["name"] for space_id in opening["space_ids"]]
    event = record_event(site_id, "door_added", f"New door between {names[0]} and {names[1]}", opening,
                         ts=ts, broadcast=broadcast)
    return {"opening": opening, "event": event}


# ---------------------------------------------------------------- routing

def _blocking(bm, start: str, destination: str, min_width_m: float) -> list[dict]:
    try:
        from core.reachability import blocking_openings
        return blocking_openings(bm, start, destination, min_width_m)
    except Exception:  # noqa: BLE001
        pass
    try:
        route = bm.find_route(start, destination, step_free=True) if HAVE_CORE else bm.route(start, destination, True)
    except Exception:  # noqa: BLE001
        return []
    result = []
    for node in getattr(route, "nodes", []):
        if node.startswith("door:"):
            opening = bm.openings[node[5:]]
            if float(opening.get("width_m") or 0) < min_width_m:
                result.append({"id": opening["id"], "width_m": opening["width_m"],
                               "position": opening["position"], "floor_id": opening["floor_id"]})
    return result


def compute_route(site_id: str, start: str, destination: str, *, step_free: bool = False,
                  min_width_m: float | None = None, via: list[str] | None = None) -> dict:
    """Route JSON per contract. Unknown places raise MapError; no path gives reachable=false."""
    with lock(site_id):
        bm = get_map(site_id)
        start_id = bm.resolve_space(start)
        destination_id = bm.resolve_space(destination)
        via_ids = [bm.resolve_space(stop) for stop in via or []]
        try:
            route = bm.find_route(start_id, destination_id, step_free=step_free, min_width_m=min_width_m, via=via_ids)
        except MapError as error:
            blocking = _blocking(bm, start_id, destination_id, min_width_m) if min_width_m else None
            payload = bm.route_payload(None, blocking=blocking) if HAVE_CORE else _empty_route()
            payload.update(step_free=step_free or min_width_m is not None, min_width_m=min_width_m,
                           message=str(error), space_path=[start_id, destination_id],
                           from_space_id=start_id, to_space_id=destination_id, via=via_ids)
            return payload
        payload = bm.route_payload(route)
        payload["via"] = via_ids
        payload["steps"] = landmark_steps(bm, route)
        payload["from_space_id"], payload["to_space_id"] = start_id, destination_id
        return payload


def _empty_route() -> dict:
    return {"reachable": False, "length_m": 0.0, "step_free": False, "min_width_m": None, "space_path": [],
            "steps": [], "floors": [], "connectors": []}


# ---------------------------------------------------------------- bookings

def room_capacity(bm, space_id: str) -> int:
    try:
        from core.geometry import capacity
        return int(capacity(bm, space_id))
    except Exception:  # noqa: BLE001
        seats = sum(1 for asset in bm.assets.values()
                    if asset["space_id"] == space_id and asset["type"] in SEATING_FALLBACK)
        if seats:
            return seats
        from shapely.geometry import Polygon
        return int(Polygon(bm.spaces[space_id]["polygon"]).area // AREA_PER_PERSON_M2)


def room_area(bm, space_id: str) -> float:
    if hasattr(bm, "room_area"):
        return float(bm.room_area(space_id))
    from shapely.geometry import Polygon
    return float(Polygon(bm.spaces[space_id]["polygon"]).area)


def is_bookable(space: dict) -> bool:
    name = space.get("name", "").lower()
    return space.get("room_type") in BOOKABLE_TYPES or any(word in name for word in BOOKABLE_WORDS)


def list_bookings(site_id: str) -> list[dict]:
    get_site(site_id)
    with db.session() as session:
        rows = session.exec(select(BookingRow).where(BookingRow.site_id == site_id)).all()
    return sorted((row.to_booking() for row in rows), key=lambda booking: booking["start"])


def _overlaps(booking: dict, start: datetime, end: datetime) -> bool:
    return parse_time(booking["start"]) < end and parse_time(booking["end"]) > start


def bookable_rooms(site_id: str, start: str | None = None, end: str | None = None, people: int = 1,
                   near: str | None = None) -> list[dict]:
    bm = get_map(site_id)
    start_dt = parse_time(start, local_now())
    end_dt = parse_time(end, start_dt + timedelta(hours=1))
    bookings = list_bookings(site_id)
    distances: dict[str, float] = {}
    if near:
        try:
            near_id = bm.resolve_space(near)
            if hasattr(bm, "distances_from"):
                distances = bm.distances_from(near_id)
        except Exception:  # noqa: BLE001
            distances = {}
    rooms = []
    for space in bm.spaces.values():
        if not is_bookable(space) or space["id"] in bm.closed:
            continue
        capacity = room_capacity(bm, space["id"])
        if capacity < max(1, int(people or 1)):
            continue
        room_bookings = [b for b in bookings if b["space_id"] == space["id"]]
        free = not any(_overlaps(b, start_dt, end_dt) for b in room_bookings)
        room = {
            "space_id": space["id"], "name": space["name"], "floor_id": space["floor_id"],
            "level": bm.floors[space["floor_id"]]["level"], "capacity": capacity,
            "area_m2": round(room_area(bm, space["id"]), 1), "free": free, "bookings": room_bookings,
        }
        if distances:
            room["distance_m"] = round(distances.get(space["id"], math.inf), 1) if space["id"] in distances else None
        rooms.append(room)
    def sort_key(room: dict):
        distance = room.get("distance_m")
        return (not room["free"], distance if distance is not None else math.inf, room["capacity"], room["name"])
    rooms.sort(key=sort_key)
    return rooms


class BookingConflict(ValueError):
    pass


def create_booking(site_id: str, space: str, start: str, end: str, who: str = "", title: str = "",
                   broadcast: bool = True, ts: str | None = None) -> dict:
    with lock(site_id):
        bm = get_map(site_id)
        space_id = bm.resolve_space(space)
        start_dt, end_dt = parse_time(start), parse_time(end)
        if end_dt <= start_dt:
            raise ValueError("The booking must end after it starts.")
        clash = [b for b in list_bookings(site_id) if b["space_id"] == space_id and _overlaps(b, start_dt, end_dt)]
        if clash:
            raise BookingConflict(f"{bm.spaces[space_id]['name']} is already booked "
                                  f"{_hhmm(clash[0]['start'])}–{_hhmm(clash[0]['end'])}.")
        row = BookingRow(id=db.new_id("bk"), site_id=site_id, space_id=space_id, start=iso(start_dt),
                         end=iso(end_dt), who=who or "", title=title or "")
        with db.session() as session:
            session.add(row)
            session.commit()
            booking = row.to_booking()
    name = bm.spaces[space_id]["name"]
    label = f"{name} booked {_hhmm(booking['start'])}–{_hhmm(booking['end'])}" + (f" by {who}" if who else "")
    record_event(site_id, "booking", label, {**booking, "space_name": name}, ts=ts, broadcast=broadcast)
    return booking


def _hhmm(value: str) -> str:
    return parse_time(value).astimezone(LOCAL_TZ).strftime("%H:%M")


def default_here(site_id: str) -> str:
    """Where we assume the person is when they don't say: the hero site's upstairs office, else a
    space just inside the first step-free entrance."""
    bm = get_map(site_id)
    preferred = {"proc-factory-dev-003": "Office 1.04"}
    if site_id in preferred:
        try:
            return bm.resolve_space(preferred[site_id])
        except Exception:  # noqa: BLE001
            pass
    lobbies = [s for s in bm.spaces.values() if s.get("room_type") == "lobby"
               and bm.floors[s["floor_id"]]["level"] == 0]
    if lobbies:
        return lobbies[0]["id"]
    for opening in bm.openings.values():
        if "outside" in opening["space_ids"] and opening.get("step_free", True):
            return next(s for s in opening["space_ids"] if s != "outside")
    return next(iter(bm.spaces))
