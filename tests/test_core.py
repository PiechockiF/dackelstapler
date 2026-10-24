"""Core geometry/routing tests on a few dev buildings, checked against the dataset's labelled answers."""

import json
import shutil
import subprocess
from pathlib import Path

import pytest

from benchmark.score import score_reply, within
from core import geometry, solvers
from core.building_map import OUTSIDE, BuildingMap, MapError
from core.reachability import blocking_openings, reachable_spaces

DATA = Path(__file__).resolve().parent.parent / "data"
BUILDINGS = ["proc-factory-dev-003", "swiss-1689", "osm-way27917482", "resplan-1677"]


def load(building_id: str) -> BuildingMap:
    return BuildingMap.load(DATA / "dev" / building_id)


def questions(building_id: str, filename: str = "questions.jsonl") -> list[dict]:
    path = DATA / "dev" / building_id / filename
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def labelled(kind: str) -> list[tuple[str, dict]]:
    return [(b, q) for b in BUILDINGS for q in questions(b) if q["kind"] == kind and "inputs" in q]


@pytest.fixture(scope="module")
def factory() -> BuildingMap:
    return load("proc-factory-dev-003")


# ---------- areas ----------


def test_room_area_is_polygon_area(factory):
    space = factory.spaces["proc-factory-dev-003-F0-S021"]
    xs = [p[0] for p in space["polygon"]]
    ys = [p[1] for p in space["polygon"]]
    # Quality lab 0.21 is an axis-aligned rectangle in the sample data.
    assert factory.room_area(space["id"]) == pytest.approx((max(xs) - min(xs)) * (max(ys) - min(ys)))


@pytest.mark.parametrize("kind", ["largest_room", "floor_area_total"])
def test_area_questions(kind):
    cases = labelled(kind)
    assert cases
    for building_id, q in cases:
        bm = load(building_id)
        i = q["inputs"]
        if kind == "largest_room":
            result = solvers.largest_room(bm, i["floor_id"], i["room_type"])
            assert result["space_id"] == q["answer"]["space_id"]
            assert within(result["area_m2"], q["answer"]["area"])
        else:
            assert within(solvers.floor_area_total(bm, i["floor_id"], i["room_type"])["total_m2"], q["answer"])


# ---------- spatial reasoning ----------


def test_shared_walls_match_labels():
    cases = labelled("shared_walls_count")
    assert cases
    for building_id, q in cases:
        bm = load(building_id)
        assert len(geometry.shared_walls(bm, q["inputs"]["start"])) == q["answer"]["value"], q["id"]


def test_shared_walls_exclude_corridors_and_self(factory):
    room = "proc-factory-dev-003-F0-S021"
    neighbours = geometry.shared_walls(factory, room)
    assert room not in neighbours
    assert all(factory.spaces[s]["type"] not in {"corridor", "stair", "lift", "outdoor"} for s in neighbours)
    for other in neighbours:  # symmetric
        assert room in geometry.shared_walls(factory, other)


def test_room_above_and_below_are_inverse_on_stacked_building():
    bm = load("osm-way27917482")
    for building_id, q in [(b, q) for b, q in labelled("room_stacked") if b == "osm-way27917482"] or []:
        i = q["inputs"]
        found = geometry.room_above(bm, i["start"]) if i["direction"] == "above" else geometry.room_below(bm, i["start"])
        assert found == q["answer"]["space_id"]
    factory = load("proc-factory-dev-003")
    ground_room = "proc-factory-dev-003-F0-S021"
    above = geometry.room_above(factory, ground_room)
    assert above is not None and factory.spaces[above]["floor_id"].endswith("F1")
    assert geometry.room_below(factory, ground_room) is None


def test_room_stacked_labels():
    for building_id in [b.name for b in (DATA / "dev").iterdir() if b.is_dir()]:
        for q in questions(building_id):
            if q["kind"] != "room_stacked":
                continue
            bm = load(building_id)
            assert solvers.room_stacked(bm, q["inputs"]["start"], q["inputs"]["direction"])["space_id"] == q["answer"]["space_id"]


def test_straight_line_3d_uses_centroid_and_elevation(factory):
    first, second = "proc-factory-dev-003-F0-S021", next(
        s for s in factory.spaces if s.startswith("proc-factory-dev-003-F1-") and factory.spaces[s]["type"] == "room"
    )
    (x1, y1, z1), (x2, y2, z2) = geometry.centroid_3d(factory, first), geometry.centroid_3d(factory, second)
    assert z1 == 0.0 and z2 == factory.floors["proc-factory-dev-003-F1"]["elevation_m"]
    assert geometry.distance_3d(factory, first, second) == pytest.approx(((x1 - x2) ** 2 + (y1 - y2) ** 2 + (z1 - z2) ** 2) ** 0.5)


def test_what_if_door_labels_and_no_side_effects():
    bm = load("osm-way27917482")
    openings_before = dict(bm.openings)
    cases = [q for q in questions("osm-way27917482") if q["kind"] == "what_if_door"]
    assert cases
    for q in cases:
        i = q["inputs"]
        assert solvers.what_if_door(bm, i["first"], i["second"], i["floor_id"])["count"] == q["answer"]["value"]
    assert bm.openings == openings_before


# ---------- routing ----------


def test_warm_up_routes_reproduced():
    for building_id in BUILDINGS:
        bm = load(building_id)
        for q in questions(building_id, "questions_basic.jsonl"):
            a = q["answer"]
            if q["kind"] not in ("route", "route_step_free", "route_with_closure", "tour"):
                continue
            closed = {a["closed_element_id"]} if "closed_element_id" in a else None
            # Kit routes that leave and re-enter the building: pedestrians stay inside, so ours differ.
            paths = [leg["space_path"] for leg in a.get("legs", [])] or [a.get("space_path", [])]
            via_outside = any(OUTSIDE in path for path in paths)
            try:
                if q["kind"] == "tour":
                    stops = a["stops"]
                    route = bm.find_route(stops[0], stops[-1], via=stops[1:-1])
                else:
                    route = bm.find_route(
                        a["from_space_id"], a["to_space_id"], step_free=q["kind"] == "route_step_free", closed=closed
                    )
            except MapError:
                assert a.get("reachable") is False or via_outside, q["id"]
                continue
            assert a.get("reachable") is not False, q["id"]
            assert OUTSIDE not in route.nodes, q["id"]
            if via_outside:
                assert route.length_m >= a["optimal_length_m"] - 0.021, q["id"]
            else:
                assert route.length_m == pytest.approx(a["optimal_length_m"], abs=0.021), q["id"]
        assert not bm.closed


def test_min_width_routing_avoids_narrow_doors_and_stairs(factory):
    start = "proc-factory-dev-003-F0-S020"
    target = "proc-factory-dev-003-F1-S032"
    plain = factory.find_route(start, target)
    wide = factory.find_route(start, target, min_width_m=1.0)
    assert wide.length_m >= plain.length_m
    assert wide.step_free
    for element in factory.element_path(wide):
        if element in factory.openings:
            assert factory.openings[element]["width_m"] >= 1.0
            assert factory.openings[element]["step_free"]
        else:
            assert factory.connectors[element]["step_free"]
    with pytest.raises(MapError):
        factory.find_route(start, target, min_width_m=5.0)


def test_reachability_and_blocking(factory):
    start = "proc-factory-dev-003-F0-S020"
    everything = reachable_spaces(factory, start)
    wide = reachable_spaces(factory, start, min_width_m=1.5)
    assert wide <= everything and start in wide
    target = next(s for s in everything - wide if factory.spaces[s]["type"] == "room")
    blocking = blocking_openings(factory, start, target, 1.5)
    assert blocking and all(b["width_m"] < 1.5 and {"id", "position", "floor_id"} <= set(b) for b in blocking)
    closed_lift = reachable_spaces(factory, start, step_free=True, closed=set(factory.connectors))
    assert all(factory.spaces[s]["floor_id"] == factory.spaces[start]["floor_id"] for s in closed_lift)


def test_wide_delivery_labels():
    cases = labelled("wide_delivery_count")
    assert cases
    for building_id, q in cases:
        bm = load(building_id)
        i = q["inputs"]
        assert solvers.wide_delivery_count(bm, i["start"], i["floor_id"], i["min_width"])["count"] == q["answer"]["value"]


def test_route_payload_shape(factory):
    route = factory.find_route("proc-factory-dev-003-F0-S020", "proc-factory-dev-003-F1-S032", step_free=True)
    payload = factory.route_payload(route)
    assert set(payload) >= {"reachable", "length_m", "step_free", "min_width_m", "space_path", "steps", "floors", "connectors"}
    assert payload["reachable"] and payload["length_m"] == route.length_m
    assert [f["floor_id"] for f in payload["floors"]] == ["proc-factory-dev-003-F0", "proc-factory-dev-003-F1"]
    for floor in payload["floors"]:
        assert {"floor_id", "level", "elevation_m", "points"} <= set(floor)
        assert all(len(point) == 2 for point in floor["points"]) and len(floor["points"]) >= 2
    assert len(payload["connectors"]) == 1
    connector = payload["connectors"][0]
    assert connector["kind"] == "lift" and connector["from_floor_id"].endswith("F0") and connector["to_floor_id"].endswith("F1")
    json.dumps(payload)
    assert factory.route_payload(None)["reachable"] is False


def test_footprint_fits_and_capacity(factory):
    room = "proc-factory-dev-003-F0-S021"
    small = geometry.footprint_fits(factory, room, 0.5, 0.5)
    assert small["ok"] and small["position"] is not None
    huge = geometry.footprint_fits(factory, room, 50, 50)
    assert not huge["ok"] and huge["position"] is None
    assert geometry.capacity(factory, room) >= 1


# ---------- end to end through the text parser ----------


def test_answer_end_to_end_on_dev_building():
    from agent.answer import answer

    for building_id in BUILDINGS:
        for q in questions(building_id):
            reply = answer(DATA / "dev" / building_id, q["question"])
            assert score_reply(q["answer"], reply), (q["id"], reply)


@pytest.mark.skipif(not shutil.which("node"), reason="needs node (type stripping, v22.18+)")
def test_web_interior_point_matches_route_anchor():
    """The twin's markers (web/src/twin/geom.ts interiorPoint) sit on the route anchors."""
    rows = [{"poly": s["polygon"], "rep": list(bm.anchors[s["id"]])} for b in BUILDINGS for bm in [load(b)]
            for s in bm.spaces.values()]
    geom = (DATA.parent / "web" / "src" / "twin" / "geom.ts").as_posix()
    script = (f"import {{ readFileSync }} from 'node:fs'; import {{ interiorPoint }} from '{geom}';"
              "const rows = JSON.parse(readFileSync(0, 'utf8'));"
              "console.log(Math.max(...rows.map((r) => Math.hypot(...interiorPoint(r.poly).map((v, i) => v - r.rep[i])))))")
    out = subprocess.run(["node", "--input-type=module", "-e", script],
                         input=json.dumps(rows), capture_output=True, text=True, check=True)
    assert float(out.stdout) < 1e-6
