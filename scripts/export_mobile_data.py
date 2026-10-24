"""Export authoritative, versioned offline data. Python is a build dependency only."""
from __future__ import annotations

import hashlib
import json
import random
from pathlib import Path

from core.building_map import BuildingMap, MapError
from core.geometry import capacity

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "web/public/offline"
FIXTURES = ROOT / "web/tests/fixtures/routes.json"
VERSION = 1


def dump(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False))


def export() -> None:
    catalog = json.loads((ROOT / "data/sites.json").read_text())
    fixtures = []
    rng = random.Random(42)
    hashes = {}
    for site in catalog:
        path = ROOT / site["data_path"] / "building.json"
        raw = path.read_bytes()
        building = json.loads(raw)
        bm = BuildingMap(building)
        graph = bm.graph(False)
        edges = []
        for a, b, attrs in graph.edges(data=True):
            via = attrs["via"]
            element = bm.openings.get(via) or bm.connectors[via]
            edges.append({"a": a, "b": b, "w": attrs["weight"], "via": via,
                          "stepFree": bool(element.get("step_free")),
                          "width": element.get("width_m"), "kind": element["kind"]})
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
    dump(OUT / "catalog.json", {"version": VERSION, "sites": catalog, "hashes": hashes})
    dump(FIXTURES, fixtures)
    print(f"Exported {len(catalog)} offline sites and {len(fixtures)} Python routing fixtures.")


if __name__ == "__main__":
    export()
