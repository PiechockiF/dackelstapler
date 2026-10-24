"""Chat tools for one site + one conversation. Every fact comes from the twin service (server/twin.py)
and agent A's core; every visual effect is an `action` emitted to the chat stream (see docs/CONTRACT.md):
highlight / focus_floor / show_route / understood / state_changed.

`TwinTools` holds plain methods (used by the deterministic no-key fallback too); `make_tools()` wraps
them as Anthropic `@beta_tool` functions for the tool runner."""

from __future__ import annotations

import json
from collections.abc import Callable
from datetime import timedelta

from anthropic import beta_tool
from anthropic.lib.tools import ToolError

from server import twin
from server.twin import MapError

MAX_RESULTS = 12
Emit = Callable[[dict], None]
HERE_WORDS = {"here", "me", "my location", "my position", "where i am", "current location"}
THERE_WORDS = {"there", "it", "that", "that place", "this"}


def as_json(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, default=str)


class TwinTools:
    """State for one chat session: where the person is and what we talked about last."""

    def __init__(self, site_id: str, emit: Emit | None = None) -> None:
        self.site_id = site_id
        self.emit: Emit = emit or (lambda action: None)
        self.here: str = twin.default_here(site_id)
        self.here_is_default = True
        self.last_target: str | None = None
        self.last_route_args: dict | None = None

    # ------------------------------------------------------------ helpers

    @property
    def bm(self):
        return twin.get_map(self.site_id)

    def space_label(self, space_id: str) -> str:
        bm = self.bm
        space = bm.spaces[space_id]
        return f"{space['name']} ({bm.floor_name(space['floor_id'])})"

    def resolve(self, reference: str) -> str:
        """Space id for a space/asset/delivery id or name, or 'here'/'there'."""
        text = (reference or "").strip()
        lowered = text.lower()
        if lowered in HERE_WORDS or not text:
            return self.here
        if lowered in THERE_WORDS:
            if self.last_target is None:
                raise MapError("I don't know which place 'there' means yet - what are you looking for?")
            return self.last_target
        for delivery in twin.list_deliveries(self.site_id):
            if delivery.get("id") == text or delivery.get("label", "").lower() == lowered:
                return delivery["space_id"]
        return self.bm.resolve_space(text)

    def chips_for_route(self, start: str, destination: str, step_free: bool, min_width_m, via) -> list[str]:
        chips = [f"from: {self.space_label(start)}" + (" (assumed)" if start == self.here and self.here_is_default else ""),
                 f"to: {self.space_label(destination)}"]
        chips += [f"via: {self.space_label(stop)}" for stop in via]
        if step_free:
            chips.append("step-free")
        if min_width_m:
            chips.append(f"load width ≥ {min_width_m:g} m")
        closed = sorted(self.bm.closed)
        if closed:
            chips.append("avoiding: " + ", ".join(twin.element_name(self.bm, c)[0] for c in closed[:3]))
        return chips

    def _focus_space(self, space_id: str) -> None:
        self.emit({"type": "focus_floor", "floor_id": self.bm.spaces[space_id]["floor_id"]})

    # ------------------------------------------------------------ read tools

    def overview(self) -> dict:
        bm = self.bm
        info = bm.overview()
        info["you_are_in"] = self.space_label(self.here)
        info["closed_names"] = [twin.element_name(bm, element)[0] for element in sorted(bm.closed)]
        return info

    def locate(self, query: str, floor_level: int | None = None) -> dict:
        bm = self.bm
        deliveries = self.find_delivery(query, emit=False, strict=True)["matches"] if query else []
        results = bm.search(query, floor_level)
        if not results and not deliveries:
            # retry with the longest word, people say "the big press" for "press"
            words = sorted((w for w in query.split() if len(w) > 2), key=len, reverse=True)
            for word in words:
                results = bm.search(word, floor_level)
                if results:
                    break
        if not results and not deliveries:
            raise MapError(f"Nothing matches '{query}'. Try a shorter or more general word.")
        # Nearest first: "where do I get coffee" should answer with the closest coffee machine.
        try:
            distances = bm.distances_from(self.here) if hasattr(bm, "distances_from") else {}
        except Exception:  # noqa: BLE001
            distances = {}
        if distances:
            def space_of(result: dict) -> str:
                return result["id"] if result["kind"] == "space" else bm.assets[result["id"]]["space_id"]
            results.sort(key=lambda result: distances.get(space_of(result), float("inf")))
        ids = [d["id"] for d in deliveries] + [r["id"] for r in results][:MAX_RESULTS]
        first_space = deliveries[0]["space_id"] if deliveries else (
            results[0]["id"] if results[0]["kind"] == "space" else bm.assets[results[0]["id"]]["space_id"])
        self.last_target = first_space
        self.emit({"type": "highlight", "ids": ids[:MAX_RESULTS], "label": query})
        self._focus_space(first_space)
        enriched = []
        for result in results[:MAX_RESULTS]:
            space_id = result["id"] if result["kind"] == "space" else bm.assets[result["id"]]["space_id"]
            if result["kind"] == "asset":
                asset = bm.assets[result["id"]]
                result = {**result, "space_id": asset["space_id"], "position": asset["position"]}
            if space_id in distances:
                result = {**result, "walk_m_from_person": round(distances[space_id], 1)}
            enriched.append(result)
        return {"matches": len(results) + len(deliveries), "deliveries": deliveries[:5], "results": enriched,
                "highlighted": ids[:MAX_RESULTS]}

    def find_delivery(self, description: str = "", emit: bool = True, strict: bool = False) -> dict:
        words = [w for w in description.lower().replace("_", " ").split() if len(w) > 1 and w not in {"the", "a", "of"}]
        matches = []
        for delivery in twin.list_deliveries(self.site_id):
            text = f"{delivery.get('label', '')} {delivery.get('note', '')} {delivery.get('id')}".lower()
            score = sum(word in text for word in words) if words else 1
            needed = len(words) if strict else max(1, len(words) // 2)
            if score and (not words or score >= needed):
                matches.append((score, delivery))
        matches.sort(key=lambda pair: pair[1].get("ts", ""), reverse=True)  # newest first...
        matches.sort(key=lambda pair: -pair[0])  # ...then best match (stable sort keeps newest among ties)
        found = [self._delivery_summary(d) for _, d in matches[:MAX_RESULTS]]
        if emit and found:
            self.last_target = found[0]["space_id"]
            self.emit({"type": "highlight", "ids": [found[0]["id"]], "label": found[0]["label"]})
            self._focus_space(found[0]["space_id"])
        return {"matches": found}

    def _delivery_summary(self, delivery: dict) -> dict:
        bm = self.bm
        space_id = delivery.get("space_id")
        where = self.space_label(space_id) if space_id in bm.spaces else space_id
        return {"id": delivery["id"], "label": delivery.get("label"), "ts": delivery.get("ts"),
                "space_id": space_id, "where": where, "dims_m": delivery.get("dims_m"),
                "status": delivery.get("status"), "summary": (delivery.get("check") or {}).get("summary"),
                "note": delivery.get("note")}

    def recent_changes(self, since_hours: float = 24.0, since: str | None = None) -> dict:
        start = since or twin.iso(twin.local_now() - timedelta(hours=since_hours))
        events = twin.list_events(self.site_id, since=start, limit=40)
        return {"since": start, "count": len(events),
                "events": [{"ts": e["ts"], "type": e["type"], "title": e["title"]} for e in events]}

    def room_facts(self, space: str) -> dict:
        bm = self.bm
        space_id = self.resolve(space)
        record = bm.spaces[space_id]
        doors = [
            {"id": o["id"], "to": (bm.spaces[s]["name"] if s in bm.spaces else "outside"), "width_m": o["width_m"],
             "step_free": o["step_free"], "closed": o["id"] in bm.closed}
            for o in bm.openings.values() if space_id in o["space_ids"]
            for s in o["space_ids"] if s != space_id
        ]
        facts = {"id": space_id, "name": record["name"], "floor": bm.floor_name(record["floor_id"]),
                 "room_type": record.get("room_type"), "area_m2": round(twin.room_area(bm, space_id), 2),
                 "capacity": twin.room_capacity(bm, space_id), "doors": doors,
                 "assets": [a["name"] for a in bm.assets.values() if a["space_id"] == space_id][:30]}
        try:
            from core import geometry
            facts["room_above"] = geometry.room_above(bm, space_id)
            facts["room_below"] = geometry.room_below(bm, space_id)
            facts["shares_walls_with"] = geometry.shared_walls(bm, space_id)[:20]
        except Exception:  # noqa: BLE001
            pass
        self.last_target = space_id
        self.emit({"type": "highlight", "ids": [space_id], "label": record["name"]})
        self._focus_space(space_id)
        return facts

    def reachability(self, start: str | None = None, min_width_m: float | None = None, step_free: bool = False) -> dict:
        bm = self.bm
        try:
            from core.reachability import reachable_spaces
        except Exception as error:  # noqa: BLE001
            raise MapError(f"Reachability analysis unavailable: {error}") from error
        entry = self.resolve(start) if start else "outside"
        reached = reachable_spaces(bm, entry, min_width_m=min_width_m, step_free=step_free, closed=set(bm.closed))
        unreachable = [s for s in bm.spaces if s not in reached]
        return {"from": entry, "reachable_count": len(reached), "total_spaces": len(bm.spaces),
                "unreachable_examples": [bm.spaces[s]["name"] for s in unreachable[:15]]}

    def set_location(self, place: str) -> dict:
        self.here = self.bm.resolve_space(place)
        self.here_is_default = False
        self.emit({"type": "understood", "chips": [f"you are in: {self.space_label(self.here)}"]})
        return {"you_are_in": self.space_label(self.here), "space_id": self.here}

    # ------------------------------------------------------------ routes

    def route(self, start: str | None, destination: str, step_free: bool = False,
              min_width_m: float | None = None, via: list[str] | None = None, announce: bool = True) -> dict:
        start_id = self.resolve(start or "here")
        destination_id = self.resolve(destination)
        via_ids = [self.resolve(stop) for stop in via or []]
        if announce:
            self.emit({"type": "understood",
                       "chips": self.chips_for_route(start_id, destination_id, step_free, min_width_m, via_ids)})
        payload = twin.compute_route(self.site_id, start_id, destination_id, step_free=step_free,
                                     min_width_m=min_width_m, via=via_ids)
        self.last_route_args = {"start": start_id, "destination": destination_id, "step_free": step_free,
                                "min_width_m": min_width_m, "via": via_ids}
        self.last_target = destination_id
        self.emit({"type": "show_route", "route": payload})
        if payload["floors"]:
            self.emit({"type": "focus_floor", "floor_id": payload["floors"][0]["floor_id"]})
        result = {"reachable": payload["reachable"], "length_m": payload["length_m"],
                  "from": self.space_label(start_id), "to": self.space_label(destination_id),
                  "steps": payload["steps"], "lifts_and_stairs": [c.get("name", c["id"]) for c in payload["connectors"]]}
        result["step_free"] = payload.get("step_free", step_free)
        if not payload["reachable"]:
            result["why"] = payload.get("message")
            result["closed_names"] = [twin.element_name(self.bm, c)[0] for c in sorted(self.bm.closed)]
            if payload.get("blocking_openings"):
                result["blocking_openings"] = payload["blocking_openings"]
        return result

    def replan(self) -> dict | None:
        if not self.last_route_args:
            return None
        args = self.last_route_args
        try:
            return self.route(args["start"], args["destination"], args["step_free"], args["min_width_m"],
                              args["via"], announce=False)
        except MapError as error:
            return {"reachable": False, "why": str(error)}

    # ------------------------------------------------------------ edits

    def set_closed(self, element: str, closed: bool) -> dict:
        bm = self.bm
        element_id = bm.find_element(element)
        name, kind = twin.element_name(bm, element_id)
        self.emit({"type": "understood", "chips": [f"{'close' if closed else 'reopen'}: {name}", f"type: {kind}"]})
        result = twin.set_closed(self.site_id, element_id, closed)
        self.emit({"type": "state_changed"})
        self.emit({"type": "highlight", "ids": [element_id], "label": f"{name} {'closed' if closed else 'open'}"})
        answer = {"element_id": element_id, "name": name, "closed": closed,
                  "now_closed": [twin.element_name(bm, c)[0] for c in sorted(bm.closed)]}
        replanned = self.replan()
        if replanned is not None:
            answer["previous_route_replanned"] = replanned
        return answer

    def move_asset(self, asset: str, to_space: str) -> dict:
        bm = self.bm
        asset_id = twin.resolve_asset(bm, asset)
        space_id = self.resolve(to_space)
        self.emit({"type": "understood", "chips": [f"move: {bm.assets[asset_id]['name']}",
                                                   f"to: {self.space_label(space_id)}"]})
        result = twin.move_asset(self.site_id, asset_id, space_id)
        self.emit({"type": "state_changed"})
        self.emit({"type": "highlight", "ids": [asset_id], "label": result["name"]})
        self._focus_space(space_id)
        return {k: v for k, v in result.items() if k != "event"}

    def add_door(self, first_space: str, second_space: str, step_free: bool = True, width_m: float | None = None) -> dict:
        first_id, second_id = self.resolve(first_space), self.resolve(second_space)
        chips = [f"new door: {self.space_label(first_id)} ↔ {self.bm.spaces[second_id]['name']}"]
        if width_m:
            chips.append(f"width {width_m:g} m")
        self.emit({"type": "understood", "chips": chips})
        result = twin.add_door(self.site_id, first_id, second_id, step_free, width_m)
        self.emit({"type": "state_changed"})
        self.emit({"type": "highlight", "ids": [result["opening"]["id"]], "label": "new door"})
        self._focus_space(first_id)
        answer = {"added": result["opening"]}
        replanned = self.replan()
        if replanned is not None:
            answer["previous_route_replanned"] = replanned
        return answer

    def add_equipment(self, kind: str, space: str, name: str | None = None, width_m: float | None = None,
                      depth_m: float | None = None) -> dict:
        space_id = self.resolve(space)
        self.emit({"type": "understood", "chips": [f"add: {name or kind}", f"to: {self.space_label(space_id)}"]})
        result = twin.add_asset(self.site_id, kind, space_id, name, width_m=width_m, depth_m=depth_m)
        asset = result["asset"]
        self.emit({"type": "state_changed"})
        self.emit({"type": "highlight", "ids": [asset["id"]], "label": asset["name"]})
        self._focus_space(space_id)
        self.last_target = space_id
        return {"added": {k: asset[k] for k in ("id", "name", "type", "category", "footprint")},
                "room": self.space_label(space_id)}

    def log_delivery(self, label: str, space: str, width_m: float | None = None, depth_m: float | None = None,
                     height_m: float | None = None, destination: str | None = None, note: str | None = None) -> dict:
        space_id = self.resolve(space)
        target_id = self.resolve(destination) if destination else None
        sizes = (width_m, depth_m, height_m)
        dims = dict(zip("wdh", sizes)) if all(sizes) else None
        chips = [f"delivery: {label}", f"at: {self.space_label(space_id)}"]
        if target_id:
            chips.append(f"to: {self.bm.spaces[target_id]['name']}")
        chips.append(f"{width_m:g} × {depth_m:g} × {height_m:g} m" if dims else "size: Euro pallet (assumed)")
        self.emit({"type": "understood", "chips": chips})
        delivery = twin.log_delivery(self.site_id, label, space_id, dims, target_id, note)
        self.emit({"type": "state_changed"})
        self.emit({"type": "highlight", "ids": [delivery["id"]], "label": delivery["label"]})
        self._focus_space(delivery["space_id"])
        self.last_target = delivery["space_id"]
        return self._delivery_summary(delivery)

    def update_equipment(self, asset: str, name: str | None = None, kind: str | None = None,
                         width_m: float | None = None, depth_m: float | None = None) -> dict:
        bm = self.bm
        asset_id = twin.resolve_asset(bm, asset)
        changes = [f"{label}: {value:g} m" if isinstance(value, float) else f"{label}: {value}"
                   for label, value in (("name", name), ("type", kind), ("width", width_m), ("depth", depth_m)) if value]
        self.emit({"type": "understood", "chips": [f"edit: {bm.assets[asset_id]['name']}", *changes]})
        updated = twin.update_asset(self.site_id, asset_id, name, kind, width_m=width_m, depth_m=depth_m)
        self.emit({"type": "state_changed"})
        self.emit({"type": "highlight", "ids": [asset_id], "label": updated["name"]})
        return {"updated": {k: updated[k] for k in ("id", "name", "type", "category", "footprint")}}

    def remove_equipment(self, asset: str) -> dict:
        bm = self.bm
        asset_id = twin.resolve_asset(bm, asset)
        record = bm.assets[asset_id]
        self.emit({"type": "understood", "chips": [f"remove: {record['name']}", f"from: {self.space_label(record['space_id'])}"]})
        removed = twin.remove_asset(self.site_id, asset_id)
        self.emit({"type": "state_changed"})
        return {"removed": {k: removed[k] for k in ("id", "name", "type")}, "room": self.space_label(removed["space_id"])}

    def _resolve_delivery(self, reference: str) -> dict:
        deliveries = twin.list_deliveries(self.site_id)
        exact = [d for d in deliveries if reference in (d["id"], d.get("label"))]
        if len(exact) == 1:
            return exact[0]
        matches = self.find_delivery(reference, emit=False, strict=True)["matches"]
        if len(matches) == 1:
            return twin.get_delivery(self.site_id, matches[0]["id"])
        if not matches:
            raise MapError(f"No delivery matches '{reference}'.")
        raise MapError("Several deliveries match: " + "; ".join(f"{m['id']} ({m['label']}, {m['where']})" for m in matches[:8]))

    def update_delivery(self, delivery: str, label: str | None = None, space: str | None = None,
                        width_m: float | None = None, depth_m: float | None = None, height_m: float | None = None,
                        destination: str | None = None, note: str | None = None) -> dict:
        current = self._resolve_delivery(delivery)
        space_id = self.resolve(space) if space else None
        target = self.resolve(destination) if destination else twin.UNCHANGED
        sizes = (width_m, depth_m, height_m)
        if any(sizes) and not all(sizes):
            raise ValueError("Give all three sizes (width, depth, height) or none.")
        dims = dict(zip("wdh", sizes)) if all(sizes) else None
        chips = [f"edit: {current['label']}"]
        if label:
            chips.append(f"label: {label}")
        if space_id:
            chips.append(f"now at: {self.space_label(space_id)}")
        if dims:
            chips.append(f"{width_m:g} × {depth_m:g} × {height_m:g} m")
        if target is not twin.UNCHANGED:
            chips.append(f"to: {self.bm.spaces[target]['name']}")
        self.emit({"type": "understood", "chips": chips})
        updated = twin.update_delivery(self.site_id, current["id"], label, space_id, dims, target, note)
        self.emit({"type": "state_changed"})
        self.emit({"type": "highlight", "ids": [updated["id"]], "label": updated["label"]})
        self._focus_space(updated["space_id"])
        return self._delivery_summary(updated)

    def remove_delivery(self, delivery: str) -> dict:
        current = self._resolve_delivery(delivery)
        self.emit({"type": "understood", "chips": [f"remove delivery: {current['label']}"]})
        twin.remove_delivery(self.site_id, current["id"])
        self.emit({"type": "state_changed"})
        return {"removed": {"id": current["id"], "label": current["label"]}}

    # ------------------------------------------------------------ rooms

    def free_rooms(self, start: str, end: str | None = None, people: int = 1, near: str | None = None) -> dict:
        start_dt = twin.parse_time(start)
        end_dt = twin.parse_time(end, start_dt + timedelta(hours=1))
        near_id = self.resolve(near) if near else self.here
        rooms = twin.bookable_rooms(self.site_id, twin.iso(start_dt), twin.iso(end_dt), people, near=near_id)
        free = [room for room in rooms if room["free"]]
        self.emit({"type": "understood", "chips": [
            f"when: {start_dt.astimezone(twin.LOCAL_TZ):%a %H:%M}–{end_dt.astimezone(twin.LOCAL_TZ):%H:%M}",
            f"people: {people}", f"near: {self.space_label(near_id)}"]})
        if free:
            self.emit({"type": "highlight", "ids": [room["space_id"] for room in free[:6]], "label": "free rooms"})
            self._focus_space(free[0]["space_id"])
            self.last_target = free[0]["space_id"]
        return {"start": twin.iso(start_dt), "end": twin.iso(end_dt), "people": people,
                "free_rooms": [{k: room.get(k) for k in ("space_id", "name", "level", "capacity", "area_m2", "distance_m")}
                               for room in free[:8]],
                "busy_rooms_count": len(rooms) - len(free)}

    def book_room(self, space: str, start: str, end: str | None = None, who: str = "", title: str = "") -> dict:
        space_id = self.resolve(space)
        start_dt = twin.parse_time(start)
        end_dt = twin.parse_time(end, start_dt + timedelta(hours=1))
        self.emit({"type": "understood", "chips": [
            f"book: {self.space_label(space_id)}",
            f"{start_dt.astimezone(twin.LOCAL_TZ):%a %H:%M}–{end_dt.astimezone(twin.LOCAL_TZ):%H:%M}"]
            + ([f"for: {who}"] if who else [])})
        booking = twin.create_booking(self.site_id, space_id, twin.iso(start_dt), twin.iso(end_dt), who, title)
        self.emit({"type": "state_changed"})
        self.emit({"type": "highlight", "ids": [space_id], "label": "booked"})
        self.last_target = space_id
        return {"booked": booking, "room": self.space_label(space_id)}


def make_tools(tools: TwinTools) -> list:
    """Anthropic tool-runner tools bound to one chat session. MapErrors become is_error results."""

    def guarded(function, *args, **kwargs) -> str:
        try:
            return as_json(function(*args, **kwargs))
        except (MapError, twin.BookingConflict, twin.NotFound, ValueError, KeyError) as error:
            raise ToolError(str(error)) from error

    @beta_tool
    def building_overview() -> str:
        """Floors, stairs and lifts, entrances, current closures, and where the person is assumed to be."""
        return guarded(tools.overview)

    @beta_tool
    def locate(query: str, floor_level: int | None = None) -> str:
        """Find rooms, machines, equipment and deliveries by name, room number or type, and highlight them
        in the 3D view. Use for "where is ...".

        Args:
            query: Words to look for, e.g. "cnc mill", "0.21", "toilet", "meeting room", "steel drum".
            floor_level: Only search this floor (0 = ground floor). Omit to search all floors.
        """
        return guarded(tools.locate, query, floor_level)

    @beta_tool
    def find_route(start: str, destination: str, step_free: bool = False, min_width_m: float | None = None,
                   via: list[str] | None = None) -> str:
        """Walking route between two places; the 3D view animates it. Returns length and landmark directions.

        Args:
            start: Space/asset/delivery id or exact room name/number, or "here" for the person's location.
            destination: Space/asset/delivery id or exact room name/number, or "there" for the last place discussed.
            step_free: True to avoid stairs and steps (wheelchair, trolley, pram, crutches, "no stairs").
            min_width_m: Width of a load that must fit through every door (pallet, machine); implies step-free.
            via: Optional places to visit in order on the way (multi-stop tour).
        """
        return guarded(tools.route, start, destination, step_free, min_width_m, via)

    @beta_tool
    def set_closed(element: str, closed: bool) -> str:
        """Close or reopen a lift, staircase, door or room (maintenance, blocked aisle). Saved for everyone,
        shown live, and the last route is re-planned.

        Args:
            element: Name or id of a lift/staircase ("Office lift"), a door/opening id, or a room/aisle name.
            closed: True to close it, False to reopen it.
        """
        return guarded(tools.set_closed, element, closed)

    @beta_tool
    def move_asset(asset: str, to_space: str) -> str:
        """Record that a machine, tool or piece of furniture now stands in another room ("this is now here").

        Args:
            asset: Asset id or exact asset name, e.g. "Forklift H-C5-A".
            to_space: Space id or exact room name/number where it now is.
        """
        return guarded(tools.move_asset, asset, to_space)

    @beta_tool
    def add_door(first_space: str, second_space: str, step_free: bool = True, width_m: float | None = None) -> str:
        """Add a door between two neighbouring rooms on the same floor (edits the plan for everyone).

        Args:
            first_space: Space id or exact room name/number.
            second_space: Space id or exact room name/number.
            step_free: Whether the new door has no step.
            width_m: Door width in metres (default 0.9).
        """
        return guarded(tools.add_door, first_space, second_space, step_free, width_m)

    @beta_tool
    def add_equipment(kind: str, space: str, name: str | None = None, width_m: float | None = None,
                      depth_m: float | None = None) -> str:
        """Add a new machine, piece of equipment or furniture to a room's equipment list ("we got a new
        coffee machine in the kitchen", "put a CNC mill in hall A"). Saved for everyone and shown live.

        Args:
            kind: What it is, e.g. "coffee machine", "cnc mill", "workbench", "fire extinguisher".
            space: Space id or exact room name/number, or "here".
            name: Its own name if the person gave one; otherwise one is generated from kind and room.
            width_m: Footprint width in metres if known (typical size used otherwise).
            depth_m: Footprint depth in metres if known.
        """
        return guarded(tools.add_equipment, kind, space, name, width_m, depth_m)

    @beta_tool
    def log_delivery(label: str, space: str, width_m: float | None = None, depth_m: float | None = None,
                     height_m: float | None = None, destination: str | None = None, note: str | None = None) -> str:
        """Record a delivery that arrived, without a photo ("3 drums of oil arrived at goods-in"). Checks
        that it fits the room and, if a destination is given, every door on the way there.

        Args:
            label: What was delivered, e.g. "Steel sheet pallet", "CNC spare parts".
            space: Where it stands now: space id or exact room name/number, or "here".
            width_m: Width in metres; give all three sizes or none (then a Euro pallet is assumed).
            depth_m: Depth in metres.
            height_m: Height in metres.
            destination: Where it has to go next, if said.
            note: Anything else worth keeping (supplier, PO number).
        """
        return guarded(tools.log_delivery, label, space, width_m, depth_m, height_m, destination, note)

    @beta_tool
    def update_equipment(asset: str, name: str | None = None, kind: str | None = None, width_m: float | None = None,
                         depth_m: float | None = None) -> str:
        """Rename an asset or correct its type or size. To put it in another room use move_asset.

        Args:
            asset: Asset id or exact asset name, e.g. "Coffee machine 1.04".
            name: New name.
            kind: New type, e.g. "espresso machine".
            width_m: New footprint width in metres.
            depth_m: New footprint depth in metres.
        """
        return guarded(tools.update_equipment, asset, name, kind, width_m, depth_m)

    @beta_tool
    def remove_equipment(asset: str) -> str:
        """Remove a machine, piece of equipment or furniture from the building ("the old drill press is gone").
        Only call when the person clearly says it was removed or added by mistake.

        Args:
            asset: Asset id or exact asset name.
        """
        return guarded(tools.remove_equipment, asset)

    @beta_tool
    def update_delivery(delivery: str, label: str | None = None, space: str | None = None, width_m: float | None = None,
                        depth_m: float | None = None, height_m: float | None = None, destination: str | None = None,
                        note: str | None = None) -> str:
        """Correct a recorded delivery: what it is, where it stands now, its size, where it has to go, or the note.
        Re-checks doors and floor space when place, size or destination change.

        Args:
            delivery: Delivery id or what was delivered, e.g. "steel sheet pallet".
            label: New description.
            space: Where it stands now (space id or exact room name/number, or "here").
            width_m: New width in metres (give all three sizes).
            depth_m: New depth in metres.
            height_m: New height in metres.
            destination: Where it has to go next.
            note: New note (supplier, PO number).
        """
        return guarded(tools.update_delivery, delivery, label, space, width_m, depth_m, height_m, destination, note)

    @beta_tool
    def remove_delivery(delivery: str) -> str:
        """Delete a delivery record (picked up, unpacked, or logged by mistake). Only call when the person
        clearly asks for it.

        Args:
            delivery: Delivery id or what was delivered.
        """
        return guarded(tools.remove_delivery, delivery)

    @beta_tool
    def recent_changes(since_hours: float = 24.0) -> str:
        """What changed recently on this site: deliveries, moved machines, closures, new doors, bookings.

        Args:
            since_hours: How far back to look, in hours (24 = since yesterday, 168 = last week).
        """
        return guarded(tools.recent_changes, since_hours)

    @beta_tool
    def find_delivery(description: str) -> str:
        """Find delivered goods (pallets, drums, spare parts) by description and highlight the best match.

        Args:
            description: What was delivered, e.g. "steel drum", "sheet metal pallet", "CNC spare parts".
        """
        return guarded(tools.find_delivery, description)

    @beta_tool
    def free_rooms(start: str, end: str | None = None, people: int = 1, near: str | None = None) -> str:
        """Bookable rooms (meeting/seminar rooms, lecture halls, libraries) that are free in a time window,
        with enough seats, nearest first. Free rooms glow in the 3D view.

        Args:
            start: Local start time, ISO "YYYY-MM-DDTHH:MM" (Europe/Berlin).
            end: Local end time; defaults to one hour after start.
            people: Number of people who need a seat.
            near: Place to measure distance from; defaults to where the person is.
        """
        return guarded(tools.free_rooms, start, end, people, near)

    @beta_tool
    def book_room(space: str, start: str, end: str | None = None, who: str = "", title: str = "") -> str:
        """Book a room. Only call after the person has chosen or clearly accepted the room.

        Args:
            space: Space id or exact room name/number.
            start: Local start time, ISO "YYYY-MM-DDTHH:MM".
            end: Local end time; defaults to one hour after start.
            who: Who books it, if known.
            title: Meeting title, if given.
        """
        return guarded(tools.book_room, space, start, end, who, title)

    @beta_tool
    def room_facts(space: str) -> str:
        """Facts about one room: area in m², seat capacity, doors with widths and step-free flags, assets,
        room directly above/below, rooms sharing a wall.

        Args:
            space: Space id or exact room name/number.
        """
        return guarded(tools.room_facts, space)

    @beta_tool
    def reachability(start: str | None = None, min_width_m: float | None = None, step_free: bool = False) -> str:
        """How many spaces can be reached from an entry point under constraints (wide loads, step-free).

        Args:
            start: Starting space; omit to start from any entrance.
            min_width_m: Load width that must fit through every door.
            step_free: Avoid stairs and steps.
        """
        return guarded(tools.reachability, start, min_width_m, step_free)

    @beta_tool
    def set_my_location(place: str) -> str:
        """Remember where the person is now (when they say "I'm in 1.04" or "I'm at the CNC mill").

        Args:
            place: Space id, asset id or exact room name/number.
        """
        return guarded(tools.set_location, place)

    return [building_overview, locate, find_route, set_closed, move_asset, add_door, add_equipment, update_equipment,
            remove_equipment, log_delivery, update_delivery, remove_delivery, recent_changes, find_delivery, free_rooms,
            book_room, room_facts, reachability, set_my_location]
