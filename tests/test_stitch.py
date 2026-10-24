"""Stitching of several floor-plan photos into one building (server/stitch.py). No Claude: the
extractions are generated from a known floor by cropping, rotating and normalising it like a photo."""

from __future__ import annotations

import math

import numpy as np
from shapely.geometry import Polygon, box

from server.stitch import build_from_extractions, similarity_fit

# A 40 x 20 m storey (north up): corridor in the middle, rooms above and below.
ROOMS = [
    ("S1", "Flur", "corridor", (0, 8, 40, 12)),
    ("S2", "Küche", "room", (0, 12, 8, 20)),
    ("S3", "Putzraum", "room", (8, 12, 12, 20)),
    ("S4", "EDV", "room", (12, 12, 16, 20)),
    ("S5", "Büro", "room", (16, 12, 24, 20)),
    ("S6", "Büro", "room", (24, 12, 32, 20)),
    ("S7", "Büro", "room", (32, 12, 40, 20)),
    ("S8", "Besprechung", "room", (0, 0, 10, 8)),
    ("S9", "WC", "room", (10, 0, 14, 8)),
    ("S10", "Treppenhaus", "stair", (14, 0, 20, 8)),
    ("S11", "ELT-Verteiler", "room", (20, 0, 26, 8)),
    ("S12", "Lager", "room", (26, 0, 40, 8)),
]


def _doors() -> list[tuple[str, str, tuple[float, float]]]:
    doors = [("S1", "outside", (0.0, 10.0))]
    for key, _, _, (x0, y0, x1, y1) in ROOMS[1:]:
        doors.append((key, "S1", ((x0 + x1) / 2, 12.0 if y0 >= 12 else 8.0)))
    return doors


def _rot(deg: float, points: np.ndarray) -> np.ndarray:
    r = math.radians(deg)
    m = np.array([[math.cos(r), -math.sin(r)], [math.sin(r), math.cos(r)]])
    return points @ m.T


def photo(window: tuple[float, float, float, float], north_deg: float, level: int = 0, label: str = "",
          offset: tuple[float, float] = (0.0, 0.0), size_error: float = 1.0, filename: str = "plan.jpg",
          rooms=ROOMS) -> dict:
    """Extraction of the part of the storey inside `window` (world metres), photographed so that north
    points `north_deg` clockwise from image-up. `offset` shifts the whole storey (another floor's frame)."""
    corners = np.array([[window[0], window[1]], [window[2], window[1]], [window[2], window[3]], [window[0], window[3]]])
    # Photo frame = world rotated clockwise by north_deg.
    rotated = _rot(-north_deg, corners + offset)
    ax0, ay0 = rotated.min(0)
    ax1, ay1 = rotated.max(0)

    def to_image(points) -> list[list[float]]:
        pts = _rot(-north_deg, np.asarray(points, float) + offset)
        return [[(x - ax0) / (ax1 - ax0) * 1000, (ay1 - y) / (ay1 - ay0) * 1000] for x, y in pts]

    spaces, visible = [], set()
    world_window = box(*window)
    for key, name, kind, rect in rooms:
        part = box(*rect).intersection(world_window)
        if part.is_empty or part.area < 1.0:
            continue
        clipped = Polygon(to_image(list(part.exterior.coords)[:-1]))
        if clipped.intersection(box(0, 0, 1000, 1000)).area < 1:
            continue
        visible.add(key)
        spaces.append({"key": key, "name": name, "type": kind, "room_type": "generic_room",
                       "polygon": [list(p) for p in list(clipped.exterior.coords)[:-1]]})
    openings = []
    for first, second, pos in _doors():
        if first in visible and (second == "outside" or second in visible) and world_window.contains(box(*pos, *pos).buffer(0.01)):
            u, v = to_image([pos])[0]
            openings.append({"from_key": first, "to_key": second, "kind": "entrance" if second == "outside" else "door",
                             "x": u, "y": v, "width_m": 1.0, "step_free": True})
    return {"floor_label": label, "level": level, "has_north_arrow": True, "north_deg": north_deg,
            "plan_width_m": (ax1 - ax0) * size_error, "plan_height_m": (ay1 - ay0) * size_error, "aspect": 1.0,
            "spaces": spaces, "landmarks": [], "openings": openings, "filename": filename}


def _centroids(building: dict, floor_id: str) -> dict[str, np.ndarray]:
    out = {}
    for space in building["spaces"]:
        if space["floor_id"] == floor_id:
            out.setdefault(space["name"], []).append(np.array(Polygon(space["polygon"]).centroid.coords[0]))
    return {name: pts[0] for name, pts in out.items() if len(pts) == 1}


def _truth() -> dict[str, np.ndarray]:
    names = [r[1] for r in ROOMS]
    return {name: np.array(box(*rect).centroid.coords[0]) for _, name, _, rect in ROOMS if names.count(name) == 1}


def test_two_rotated_photos_of_one_storey_are_stitched():
    first = photo((0, 0, 26, 20), north_deg=135, label="3. Obergeschoss", level=3, filename="a.jpg")
    second = photo((10, 0, 40, 20), north_deg=45, label="3. Obergeschoss", level=3, filename="b.jpg")
    building, warnings, _ = build_from_extractions([first, second], "user-test-abc123", "Test")
    assert len(building["floors"]) == 1 and building["floors"][0]["name"] == "3. Obergeschoss"
    names = [s["name"] for s in building["spaces"]]
    assert names.count("Flur") == 1, names  # the corridor seen in both photos is merged
    assert names.count("EDV") == 1 and names.count("Büro") == 3
    got = _centroids(building, building["floors"][0]["id"])
    truth = _truth()
    shared = sorted(set(got) & set(truth))
    fit = similarity_fit([got[n] for n in shared], [truth[n] for n in shared])
    errors = [np.linalg.norm((fit[:2, :2] @ got[n] + fit[:2, 2]) - truth[n]) for n in shared]
    assert max(errors) < 0.3, dict(zip(shared, errors))
    assert abs(math.sqrt(abs(np.linalg.det(fit[:2, :2]))) - 1) < 0.03  # metric scale kept
    assert abs(math.degrees(math.atan2(fit[1, 0], fit[0, 0]))) < 2  # north up
    assert [p["method"] for p in building["building"]["plans"]].count("anchors") == 1
    north = building["building"]["north_deg"]
    assert min(north, 360 - north) < 2  # walls were already axis-aligned with north up
    assert not any("placed it alongside" in w for w in warnings)


def test_storeys_are_stacked_and_connected_by_the_staircase():
    ground = photo((0, 0, 40, 20), north_deg=0, level=0, label="Erdgeschoss", filename="eg.jpg")
    upper = photo((0, 0, 40, 20), north_deg=90, level=1, label="1. Obergeschoss", offset=(7.0, -3.0), filename="og.jpg")
    building, _, _ = build_from_extractions([ground, upper], "user-test-def456", "Test")
    floors = {f["level"]: f["id"] for f in building["floors"]}
    assert set(floors) == {0, 1}
    stairs = [s for s in building["spaces"] if s["type"] == "stair"]
    c0, c1 = (np.array(Polygon(s["polygon"]).centroid.coords[0]) for s in sorted(stairs, key=lambda s: s["floor_id"]))
    assert np.linalg.norm(c0 - c1) < 0.5
    [connector] = building["vertical_connectors"]
    assert connector["kind"] == "stairs" and set(connector["floor_ids"]) == set(floors.values())

    from server.floorplan import sanity_fix
    from server.twin import BuildingMap

    fixed, _ = sanity_fix(building)
    upper_edv = next(s["id"] for s in fixed["spaces"] if s["name"] == "EDV" and s["floor_id"] == floors[1])
    route = BuildingMap(fixed).route(upper_edv, next(
        s["id"] for s in fixed["spaces"] if s["name"] == "Lager" and s["floor_id"] == floors[0]))
    assert set(connector["space_ids"]) <= set(route.space_path)


def test_only_an_upper_storey_gets_a_staircase_exit():
    building, warnings, _ = build_from_extractions([photo((0, 0, 40, 20), 0, level=3)], "user-test-ghi789", "Test")
    assert [o for o in building["openings"] if "outside" in o["space_ids"]]  # a drawn exit is kept as is
    no_entrance = photo((0, 0, 40, 20), 0, level=3)
    no_entrance["openings"] = [o for o in no_entrance["openings"] if o["to_key"] != "outside"]
    building, warnings, _ = build_from_extractions([no_entrance], "user-test-ghi789", "Test")
    exits = [o for o in building["openings"] if "outside" in o["space_ids"]]
    stair_ids = {s["id"] for s in building["spaces"] if s["type"] == "stair"}
    assert exits and all(o["synthetic"] and o["space_ids"][0] in stair_ids for o in exits)
    assert any("lead down to the street" in w for w in warnings)


def test_level_override_and_side_by_side_fallback():
    left = photo((0, 0, 12, 20), 0, level=2, filename="left.jpg")
    right = photo((28, 0, 40, 20), 0, level=2, filename="right.jpg")
    for space in left["spaces"] + right["spaces"]:
        space["name"], space["type"] = "", "room"  # nothing to match on
    building, warnings, _ = build_from_extractions([left, right], "user-test-jkl000", "Test")
    assert len(building["floors"]) == 1
    assert any("placed it alongside" in w for w in warnings), warnings
    building, _, _ = build_from_extractions([left, right], "user-test-jkl000", "Test", level_overrides={1: 3})
    assert sorted(f["level"] for f in building["floors"]) == [2, 3]
    plans = building["building"]["plans"]
    assert plans[1]["level"] == 3 and plans[1]["detected_level"] == 2


def test_matcher_pairs_are_used_and_cached():
    first = photo((0, 0, 26, 20), north_deg=0, level=0, filename="a.jpg")
    second = photo((10, 0, 40, 20), north_deg=0, level=0, filename="b.jpg")
    for space in first["spaces"] + second["spaces"]:
        space["name"], space["type"] = "", "room"  # nothing left to match on
    calls = []

    def matcher(a: int, b: int) -> list:
        calls.append((a, b))
        # same physical corners (world) expressed in each image's normalised frame
        world = [(12, 12), (16, 20), (20, 0), (26, 8)]
        def norm(ex, window):
            x0, y0, x1, y1 = window
            return [[(x - x0) / (x1 - x0) * 1000, (y1 - y) / (y1 - y0) * 1000] for x, y in world]
        order = {0: (first, (0, 0, 26, 20)), 1: (second, (10, 0, 40, 20))}
        return [list(p) for p in zip(norm(*order[a]), norm(*order[b]))]

    building, warnings, matches = build_from_extractions([first, second], "user-test-mno111", "Test", matcher=matcher)
    assert calls and matches
    assert any(p["method"] == "point_match" for p in building["building"]["plans"])
    # re-stitching with the cached pairs needs no matcher
    again, _, _ = build_from_extractions([first, second], "user-test-mno111", "Test", matches=matches)
    assert any(p["method"] == "point_match" for p in again["building"]["plans"])


def test_degenerate_extraction_is_read_again_at_high_effort(monkeypatch):
    from server import floorplan

    good = photo((0, 0, 40, 20), 0)
    bad = {**good, "spaces": good["spaces"][:1] * 3, "openings": []}
    calls = []

    def fake_ask(content, schema, max_tokens=48000, effort="medium"):
        calls.append(effort)
        return dict(bad if effort == "medium" else good)

    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    monkeypatch.setattr(floorplan, "_ask_json", fake_ask)
    monkeypatch.setattr(floorplan, "_media", lambda data, media_type: ({}, 0.5))
    plan = floorplan.extract_plan(b"x", "image/jpeg")
    assert calls == ["medium", "high"] and len(plan["spaces"]) == len(good["spaces"]) and plan["aspect"] == 0.5


def test_inconsistent_size_estimates_and_north_errors_are_absorbed():
    """Claude's size guess for one photo is 1.8x off and its north arrow reading 12° off; the plans must
    still stitch (scales are harmonised via same-named rooms, rotation snapped to the walls)."""
    first = photo((0, 0, 26, 20), north_deg=135, level=3, filename="a.jpg")
    second = photo((10, 0, 40, 20), north_deg=45, level=3, size_error=1.8, filename="b.jpg")
    second["north_deg"] = 57
    building, warnings, _ = build_from_extractions([first, second], "user-test-pqr222", "Test")
    names = [s["name"] for s in building["spaces"]]
    assert names.count("Flur") == 1 and names.count("EDV") == 1, (names, warnings)
    got = _centroids(building, building["floors"][0]["id"])
    truth = _truth()
    shared = sorted(set(got) & set(truth))
    fit = similarity_fit([got[n] for n in shared], [truth[n] for n in shared])
    errors = [np.linalg.norm((fit[:2, :2] @ got[n] + fit[:2, 2]) - truth[n]) for n in shared]
    assert max(errors) < 0.6, dict(zip(shared, errors))


def test_storey_without_overlap_on_its_floor_is_placed_via_the_floor_above():
    """Two photos of floor 1 that do not overlap each other: the second is placed by stacking it under the
    matching part of floor 2 instead of being dropped beside the first."""
    upper = photo((0, 0, 40, 20), north_deg=0, level=2, label="2. OG", filename="og2.jpg")
    west = photo((0, 0, 15, 20), north_deg=0, level=1, label="1. OG", filename="og1-west.jpg")
    east = photo((24, 0, 40, 20), north_deg=0, level=1, label="1. OG", filename="og1-east.jpg")
    building, warnings, _ = build_from_extractions([upper, west, east], "user-test-stu333", "Test")
    assert not any("placed it alongside" in w for w in warnings), warnings
    floor1 = next(f["id"] for f in building["floors"] if f["level"] == 1)
    floor2 = next(f["id"] for f in building["floors"] if f["level"] == 2)
    lower, top = _centroids(building, floor1), _centroids(building, floor2)
    for name in ("Lager", "Besprechung", "Küche"):
        assert np.linalg.norm(lower[name] - top[name]) < 0.6, (name, warnings)
