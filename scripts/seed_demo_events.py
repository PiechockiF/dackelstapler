"""Seed a plausible week of activity for the demo's hero sites so the timeline and chat feel alive:
deliveries (with real dimension checks from capture/), moved machines, a closed lift, an added door and
today's room bookings.

  uv run python scripts/seed_demo_events.py            # seed sites that have no events yet
  uv run python scripts/seed_demo_events.py --reset    # wipe the hero sites' history and re-seed

Times are relative to now, so re-run with --reset on demo day. A running server is told to reload."""

from __future__ import annotations

import argparse
import random
import sys
from datetime import datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import httpx  # noqa: E402

from server import db, twin  # noqa: E402
from server.db import (  # noqa: E402
    AddedDoorRow, AssetMoveRow, BookingRow, ClosureRow, DeliveryRow, EventRow, select,
)

HERO_SITES = ["proc-factory-dev-003", "proc-campus-dev-000", "osm-way22744230", "proc-factory-dev-005"]

# (label, note, dims w/d/h, declared dims or None, target room_type preference, days ago, hour)
FACTORY_DELIVERIES = [
    ("Steel drum", "200 l steel drum, cutting fluid, PO 4711-0193", (0.60, 0.60, 0.90), (0.60, 0.60, 0.90),
     "logistics_zone", 1, 10.6),
    ("Pallet of sheet metal", "DC01 sheet 2 mm, 1250 x 2500, PO 4711-0188", (1.30, 1.05, 0.45), (1.30, 1.00, 0.45),
     "warehouse_zone", 2, 8.2),
    ("CNC spare parts", "Spindle bearings + tool holders for CNC mill, crate", (0.80, 0.60, 0.50), (0.80, 0.60, 0.50),
     "production_zone", 3, 13.5),
    ("Pallet of granulate", "PP granulate, 25 bags, injection moulding", (1.20, 0.80, 1.10), (1.20, 0.80, 1.00),
     "warehouse_zone", 4, 9.0),
    ("Welding wire spools", "SG2 1.0 mm, 8 spools on a half pallet", (0.80, 0.60, 0.60), None, "production_zone", 5, 15.2),
    ("Pallet of sheet metal", "DX51 galvanised, PO 4711-0172", (1.32, 1.05, 0.40), (1.30, 1.00, 0.40),
     "warehouse_zone", 6, 7.8),
]
CAMPUS_DELIVERIES = [
    ("Lab equipment crate", "Oscilloscopes x4 for the electronics lab", (0.90, 0.70, 0.80), None, "lab", 1, 11.0),
    ("Pallet of printer paper", "A4, 40 boxes", (1.20, 0.80, 1.00), (1.20, 0.80, 1.00), "storage", 3, 8.5),
    ("3D printer filament", "PLA/PETG, 30 spools", (0.60, 0.40, 0.40), None, "makerspace", 5, 14.0),
]
OFFICE_DELIVERIES = [
    ("Parcel of lab supplies", "Pipettes and gloves", (0.60, 0.40, 0.40), None, None, 1, 9.5),
    ("Furniture pallet", "6 folding chairs", (1.20, 0.80, 1.20), None, None, 4, 10.0),
]


def local_at(days_ago: int, hour: float) -> datetime:
    now = twin.local_now()
    day = now - timedelta(days=days_ago)
    return day.replace(hour=int(hour), minute=int((hour % 1) * 60), second=0, microsecond=0)


def ts_at(days_ago: int, hour: float) -> str:
    return twin.iso(local_at(days_ago, hour))


def reset(site_id: str) -> None:
    with db.session() as session:
        for model in (EventRow, BookingRow, ClosureRow, AssetMoveRow, AddedDoorRow, DeliveryRow):
            for row in session.exec(select(model).where(model.site_id == site_id)).all():
                session.delete(row)
        session.commit()
    twin.invalidate(site_id)


def has_events(site_id: str) -> bool:
    with db.session() as session:
        return session.exec(select(EventRow.id).where(EventRow.site_id == site_id)).first() is not None


def spaces_of(bm, room_type: str | None) -> list[dict]:
    spaces = [s for s in bm.spaces.values() if room_type is None or s.get("room_type") == room_type]
    return sorted(spaces, key=lambda s: s["id"])


def seed_delivery(site_id: str, spec: tuple, rng: random.Random, index: int) -> None:
    label, note, dims, declared, room_type, days_ago, hour = spec
    bm = twin.get_map(site_id)
    ground = {fid for fid, floor in bm.floors.items() if floor["level"] == 0}
    candidates = spaces_of(bm, room_type) if room_type else []
    for fallback_type in ("storage", "logistics_zone", "lobby", "technical_room", "office"):
        if candidates:
            break
        candidates = [s for s in spaces_of(bm, fallback_type) if s["floor_id"] in ground] or spaces_of(bm, fallback_type)
    candidates = candidates or [s for s in bm.spaces.values() if s.get("type") in ("room", "hall")]
    target = candidates[index % len(candidates)] if candidates else next(iter(bm.spaces.values()))
    dims_m = {"w": dims[0], "d": dims[1], "h": dims[2]}
    declared_m = {"w": declared[0], "d": declared[1], "h": declared[2]} if declared else None
    tolerance = 0.03
    try:
        from capture.dimension_check import check_delivery

        result = check_delivery(bm, dims_m, tolerance, declared_m, target["id"], twin.list_deliveries(site_id))
        placement = {k: result[k] for k in ("space_id", "floor_id", "position", "rotation_deg", "status", "check")}
    except Exception as error:  # noqa: BLE001 - capture missing or a geometry corner case
        print(f"  (dimension check unavailable for {label}: {error})")
        point = list(bm.anchor(target["id"]))
        placement = {"space_id": target["id"], "floor_id": target["floor_id"],
                     "position": [round(point[0] + rng.uniform(-1, 1), 2), round(point[1] + rng.uniform(-1, 1), 2)],
                     "rotation_deg": float(rng.choice([0, 90])), "status": "ok",
                     "check": {"declared": None, "route_fit": None, "floor_fit": None,
                               "summary": f"{label}: {dims[0]:.2f} × {dims[1]:.2f} × {dims[2]:.2f} m."}}
    ts = ts_at(days_ago, hour)
    delivery = {
        "id": f"dl-seed-{site_id[-12:]}-{index:02d}", "site_id": site_id, "ts": ts, "label": label, "note": note,
        "dims_m": dims_m, "tolerance_m": tolerance, "target_space_id": target["id"], **placement,
    }
    if declared_m:
        delivery["declared_dims_m"] = declared_m
    space_name = bm.spaces[delivery["space_id"]]["name"]
    twin.add_delivery(delivery, broadcast=False, title=f"{label} delivered to {space_name}")


def seed_moves(site_id: str, rng: random.Random, types: list[str], count: int) -> None:
    bm = twin.get_map(site_id)
    movable = [a for a in sorted(bm.assets.values(), key=lambda a: a["id"]) if a["type"] in types]
    rng.shuffle(movable)
    for index, asset in enumerate(movable[:count]):
        same_kind = [s for s in bm.spaces.values() if s["floor_id"] == asset["floor_id"] and s["id"] != asset["space_id"]
                     and s.get("room_type") == bm.spaces[asset["space_id"]].get("room_type")]
        options = same_kind or [s for s in bm.spaces.values() if s["floor_id"] == asset["floor_id"]
                                and s.get("type") in ("hall", "room") and s["id"] != asset["space_id"]]
        if not options:
            continue
        target = sorted(options, key=lambda s: s["id"])[rng.randrange(len(options))]
        point = bm.anchor(target["id"])
        position = [round(point[0] + rng.uniform(-1.5, 1.5), 2), round(point[1] + rng.uniform(-1.5, 1.5), 2)]
        try:
            twin.move_asset(site_id, asset["id"], target["id"], position,
                            ts=ts_at([6, 4, 2, 1, 3][index % 5], 9 + index * 1.7), broadcast=False)
        except Exception as error:  # noqa: BLE001
            print(f"  (skip move {asset['name']}: {error})")


def seed_closures(site_id: str, keep_closed_lift: bool) -> None:
    bm = twin.get_map(site_id)
    lifts = sorted((c for c in bm.connectors.values() if c["kind"] == "lift"), key=lambda c: c["id"])
    if not lifts:
        return
    # A maintenance window earlier in the week (history only).
    twin.set_closed(site_id, lifts[0]["id"], True, ts=ts_at(5, 7.5), broadcast=False)
    twin.set_closed(site_id, lifts[0]["id"], False, ts=ts_at(4, 16.0), broadcast=False)
    if keep_closed_lift and len(lifts) > 1:
        twin.set_closed(site_id, lifts[-1]["id"], True, ts=ts_at(0, 7.25), broadcast=False)


def seed_door(site_id: str, ts: str) -> None:
    bm = twin.get_map(site_id)
    offices = sorted((s for s in bm.spaces.values() if s.get("room_type") in ("office", "meeting_room")), key=lambda s: s["id"])
    existing_pairs = {frozenset(o["space_ids"]) for o in bm.openings.values()}
    for first in offices:
        for second in offices:
            if first["id"] >= second["id"] or first["floor_id"] != second["floor_id"]:
                continue
            if frozenset((first["id"], second["id"])) in existing_pairs:
                continue
            try:
                twin.add_door(site_id, first["id"], second["id"], True, 0.9, ts=ts, broadcast=False)
                return
            except Exception:  # noqa: BLE001 - not neighbours
                continue


def seed_bookings(site_id: str, rng: random.Random) -> None:
    rooms = twin.bookable_rooms(site_id, people=1, near=twin.default_here(site_id))
    near_first = rooms[:6]
    names = ["Anna Huber", "Jonas Weber", "Lea Schmid", "Max Bauer", "Sophie Wagner", "Paul Fischer"]
    titles = ["Shift handover", "Supplier call", "Quality review", "Line 4 planning", "1:1", "Safety briefing"]
    slots = [(8.0, 9.0), (9.5, 10.5), (11.0, 12.0), (13.0, 14.0), (14.0, 15.0), (15.5, 16.5)]
    # The demo asks for "a room for 6 at 14:00": make the nearest big room busy then, so the agent has to pick.
    six_plus = [room for room in rooms if room["capacity"] >= 6]
    if six_plus:
        twin.create_booking(site_id, six_plus[0]["space_id"], ts_at(0, 14.0), ts_at(0, 15.0),
                            "Anna Huber", "Line 4 planning", broadcast=False, ts=ts_at(1, 17.0))
    for index, room in enumerate(near_first):
        start, end = slots[(index * 2 + 1) % len(slots)]
        if start == 14.0:
            continue
        try:
            twin.create_booking(site_id, room["space_id"], ts_at(0, start), ts_at(0, end),
                                names[index % len(names)], titles[rng.randrange(len(titles))],
                                broadcast=False, ts=ts_at(1, 9 + index))
        except twin.BookingConflict:
            pass


def seed_site(site_id: str) -> None:
    rng = random.Random(site_id)
    site = twin.get_site(site_id)
    kind = site["kind"]
    print(f"seeding {site_id} ({site['name']}, {kind})")
    specs = FACTORY_DELIVERIES if kind == "factory" else CAMPUS_DELIVERIES if kind == "campus" and site_id.startswith("proc") else OFFICE_DELIVERIES
    for index, spec in enumerate(specs):
        seed_delivery(site_id, spec, rng, index)
    if kind == "factory":
        seed_moves(site_id, rng, ["forklift", "pallet_jack", "drill_press", "welding_station", "tool_cabinet"], 4)
        seed_closures(site_id, keep_closed_lift=False)
    else:
        seed_moves(site_id, rng, ["3d_printer", "microscope", "printer", "display_screen", "whiteboard", "projector"], 3)
        seed_closures(site_id, keep_closed_lift=True)
    seed_door(site_id, ts_at(3, 11.0))
    seed_bookings(site_id, rng)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--reset", action="store_true", help="delete the hero sites' history first")
    parser.add_argument("--sites", nargs="*", default=HERO_SITES, help="site ids to seed")
    parser.add_argument("--server", default="http://localhost:8000", help="running server to tell to reload")
    args = parser.parse_args()
    twin.seed_sites()
    for site_id in args.sites:
        try:
            twin.get_site(site_id)
        except twin.NotFound:
            print(f"skip unknown site {site_id}")
            continue
        if args.reset:
            reset(site_id)
        elif has_events(site_id):
            print(f"{site_id} already has events (use --reset to re-seed)")
            continue
        seed_site(site_id)
        print(f"  {len(twin.list_events(site_id, limit=2000))} events")
    try:
        httpx.post(f"{args.server}/api/admin/reload", timeout=2)
        print(f"told {args.server} to reload its site cache")
    except httpx.HTTPError:
        pass


if __name__ == "__main__":
    main()
