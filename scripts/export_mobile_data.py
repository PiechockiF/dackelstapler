"""Export authoritative, versioned offline data. Python is a build dependency only."""
from __future__ import annotations

import hashlib
import json
import random
from pathlib import Path

from core.building_map import DOOR_PREFIX, OUTSIDE, BuildingMap, MapError
from core.geometry import capacity
from core.reachability import reachable_spaces
from server.equipment import catalog as equipment_catalog

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "web/public/offline"
FIXTURES = ROOT / "web/tests/fixtures/routes.json"
REACH_FIXTURES = ROOT / "web/tests/fixtures/reachable.json"
VERSION = 2


def dump(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False))


def export() -> None:
    catalog = json.loads((ROOT / "data/sites.json").read_text())
    fixtures = []
    reach_fixtures = []
    rng = random.Random(42)
    hashes = {}
    for site in catalog:
        path = ROOT / site["data_path"] / "building.json"
        raw = path.read_bytes()
        building = json.loads(raw)
        bm = BuildingMap(building)
        # Include the "outside" node: the local router applies the same rule as core (pedestrians stay
        # inside; loads with a width, and searches starting outside, may go round the building).
        # Doors are nodes ("door:<id>"); the local router reads their width and step-free flag from the building.
        # Walks inside a space (room centre to door, door to door) name the space; lifts, stairs and entrances
        # to "outside" name their element in "via". "bend": the drawn walk goes through the space's anchor.
        graph = bm.graph(False, outside=True)
        edges = []
        for a, b, attrs in graph.edges(data=True):
            edge = {"a": a, "b": b, "w": attrs["weight"]}
            if "via" in attrs:
                edge["via"] = attrs["via"]
            else:
                edge["space"] = attrs["space"]
                if a.startswith(DOOR_PREFIX) and b.startswith(DOOR_PREFIX) and bm._detour_anchor(graph, a, b) == attrs["space"]:
                    edge["bend"] = True
            edges.append(edge)
        digest = hashlib.sha256(raw).hexdigest()
        hashes[site["id"]] = digest
        dump(OUT / f"{site['id']}.json", {
            "version": VERSION, "sourceHash": digest, "building": building,
            "anchors": bm.anchors,
            "areas": {sid: bm.room_area(sid) for sid in bm.spaces},
            "capacities": {sid: capacity(bm, sid) for sid in bm.spaces},
            "bookable": [sid for sid, s in bm.spaces.items()
                         if s.get("room_type") in {"meeting_room", "seminar_room", "lecture_hall", "library"}
                         or any(w in s.get("name", "").lower() for w in ("meeting", "besprechung"))],
            "edges": edges,
        })
        ids = list(bm.spaces)
        cases = [{"from": ids[0], "to": ids[0]}, {"from": "outside", "to": ids[-1]}]
        for _ in range(10):
            a, b = rng.sample(ids, 2)
            cases.extend([{"from": a, "to": b}, {"from": a, "to": b, "step_free": True},
                          {"from": a, "to": b, "min_width_m": rng.choice([0.8, 1.0, 1.5, 2.0])}])
        if len(ids) > 2:
            cases.append({"from": ids[0], "to": ids[-1], "via": [ids[len(ids) // 2]]})
        for i, body in enumerate(cases):
            closed = [] if i % 4 else list(bm.connectors)[:1] + list(bm.openings)[::7]
            if i == 2:
                closed.append(body["from"])
            try:
                route = bm.find_route(body["from"], body["to"], step_free=body.get("step_free", False),
                                      min_width_m=body.get("min_width_m"), via=body.get("via"), closed=set(closed))
                expected = {"reachable": True, "length_m": route.length_m}
            except MapError:
                expected = {"reachable": False, "length_m": 0}
            fixtures.append({"site": site["id"], "body": body, "closed": closed, "expected": expected})
        for i, start in enumerate([OUTSIDE, *rng.sample(ids, min(3, len(ids)))]):
            for options in ({}, {"step_free": True}, {"min_width_m": rng.choice([0.9, 1.2, 2.0])}):
                closed = [] if i % 2 else list(bm.connectors)[:1] + list(bm.openings)[::9]
                spaces = reachable_spaces(bm, start, step_free=options.get("step_free", False),
                                          min_width_m=options.get("min_width_m"), closed=set(closed))
                reach_fixtures.append({"site": site["id"], "from": start, **options, "closed": closed,
                                       "expected": sorted(spaces)})
    dump(OUT / "catalog.json", {"version": VERSION, "sites": catalog, "hashes": hashes, "equipment": equipment_catalog()})
    dump(FIXTURES, fixtures)
    dump(REACH_FIXTURES, reach_fixtures)
    print(f"Exported {len(catalog)} offline sites, {len(fixtures)} routing and {len(reach_fixtures)} reachability "
          "fixtures from Python.")


if __name__ == "__main__":
    export()
