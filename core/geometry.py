"""Polygon geometry on a BuildingMap: centroids, stacking between floors, shared walls, fit checks."""

from __future__ import annotations

import math

from shapely import affinity
from shapely.geometry import Point, Polygon, box
from shapely.ops import unary_union

# Space types that never count as "rooms" sharing a wall: corridors, stairwells, lifts, and outdoor
# spaces such as balconies (they sit outside the facade; verified on all labelled train/dev questions).
NON_ROOM_TYPES = frozenset({"corridor", "stair", "lift", "outdoor"})
SEATING_TYPES = frozenset({"chair", "office_chair", "dining_chair", "armchair"})
AREA_PER_PERSON_M2 = 2.5


def centroid(bm, space_id: str) -> tuple[float, float]:
    point = bm.polygons[space_id].centroid
    return (float(point.x), float(point.y))


def centroid_3d(bm, space_id: str) -> tuple[float, float, float]:
    x, y = centroid(bm, space_id)
    floor = bm.floors[bm.spaces[space_id]["floor_id"]]
    return (x, y, float(floor.get("elevation_m", 0.0)))


def distance_3d(bm, first: str, second: str) -> float:
    return math.dist(centroid_3d(bm, first), centroid_3d(bm, second))


def adjacent_floor(bm, floor_id: str, step: int) -> dict | None:
    """The next floor up (step=+1) or down (step=-1) in level order."""
    ordered = bm.floors_by_level()
    index = next(i for i, floor in enumerate(ordered) if floor["id"] == floor_id)
    target = index + step
    if 0 <= target < len(ordered):
        return ordered[target]
    return None


def stacked_candidates(bm, space_id: str, step: int) -> list[tuple[str, float]]:
    """Spaces on the adjacent floor ranked by overlap area with this space's outline."""
    space = bm.spaces[space_id]
    floor = adjacent_floor(bm, space["floor_id"], step)
    if floor is None:
        return []
    polygon = bm.polygons[space_id]
    ranked = []
    for other in bm.spaces_on_floor(floor["id"]):
        other_polygon = bm.polygons[other["id"]]
        if not other_polygon.intersects(polygon):
            continue
        overlap = polygon.intersection(other_polygon).area
        if overlap > 1e-9:
            ranked.append((other["id"], float(overlap)))
    ranked.sort(key=lambda item: -item[1])
    return ranked


def room_above(bm, space_id: str) -> str | None:
    ranked = stacked_candidates(bm, space_id, +1)
    return ranked[0][0] if ranked else None


def room_below(bm, space_id: str) -> str | None:
    ranked = stacked_candidates(bm, space_id, -1)
    return ranked[0][0] if ranked else None


def shared_wall_length(first: Polygon, second: Polygon, tol_m: float) -> float:
    """Length of either outline that runs within tol_m of the other outline (the larger of both)."""
    if first.distance(second) > tol_m:
        return 0.0
    a = first.exterior.intersection(second.exterior.buffer(tol_m)).length
    b = second.exterior.intersection(first.exterior.buffer(tol_m)).length
    return float(max(a, b))


def shared_walls(bm, space_id: str, min_len_m: float = 1.0, tol_m: float = 0.35) -> list[str]:
    """Other rooms on the same floor whose wall runs along this one for at least min_len_m.
    Corridors, stairwells and lifts don't count."""
    space = bm.spaces[space_id]
    polygon = bm.polygons[space_id]
    result = []
    for other in bm.spaces_on_floor(space["floor_id"]):
        if other["id"] == space_id or other["type"] in NON_ROOM_TYPES:
            continue
        if shared_wall_length(polygon, bm.polygons[other["id"]], tol_m) >= min_len_m:
            result.append(other["id"])
    return result


def shared_wall_midpoint(bm, first: str, second: str, tol_m: float = 0.35) -> tuple[float, float]:
    """Middle of the wall two spaces share: the midpoint of the longest stretch of one outline that runs
    within tol_m of the other, moved halfway across the wall gap."""
    first_polygon, second_polygon = bm.polygons[first], bm.polygons[second]
    best = None
    for source, target in ((first_polygon, second_polygon), (second_polygon, first_polygon)):
        shared = source.exterior.intersection(target.exterior.buffer(tol_m))
        parts = getattr(shared, "geoms", [shared])
        for part in parts:
            if part.is_empty or part.length <= 0:
                continue
            if best is None or part.length > best.length:
                best = part
    if best is None:
        # Not within tolerance: use the closest points.
        from shapely.ops import nearest_points

        a, b = nearest_points(first_polygon, second_polygon)
        return ((a.x + b.x) / 2, (a.y + b.y) / 2)
    middle = best.interpolate(0.5, normalized=True)
    other = second_polygon if first_polygon.exterior.distance(middle) < 1e-6 else first_polygon
    projected = other.exterior.interpolate(other.exterior.project(middle))
    return ((middle.x + projected.x) / 2, (middle.y + projected.y) / 2)


# ---------- fit checks ----------


def asset_footprint(asset: dict) -> Polygon | None:
    footprint = asset.get("footprint") or {}
    width, depth = footprint.get("width_m"), footprint.get("depth_m")
    if not width or not depth:
        return None
    x, y = asset["position"]
    rect = box(x - width / 2, y - depth / 2, x + width / 2, y + depth / 2)
    return affinity.rotate(rect, footprint.get("rotation_deg", 0.0) or 0.0, origin=(x, y))


def _wall_angles(polygon: Polygon) -> list[float]:
    coords = list(polygon.exterior.coords)
    edges = sorted(
        ((math.dist(a, b), math.degrees(math.atan2(b[1] - a[1], b[0] - a[0]))) for a, b in zip(coords, coords[1:])),
        reverse=True,
    )
    angles = [0.0, 90.0]
    for _, angle in edges[:2]:
        angle = angle % 180.0
        if all(abs(angle - known) > 1.0 for known in angles):
            angles += [angle, (angle + 90.0) % 180.0]
    return angles


def footprint_fits(
    bm,
    space_id: str,
    width_m: float,
    depth_m: float,
    *,
    clearance_m: float = 0.0,
    ignore_asset_ids: set[str] | None = None,
) -> dict:
    """Can a width x depth footprint be placed in the room without overlapping existing assets?
    Returns {"ok", "reason", "position": [x, y] | None, "rotation_deg"}."""
    room = bm.polygons[space_id]
    ignore = ignore_asset_ids or set()
    obstacles = [
        footprint.buffer(clearance_m) if clearance_m else footprint
        for asset in bm.assets.values()
        if asset["space_id"] == space_id and asset["id"] not in ignore
        for footprint in [asset_footprint(asset)]
        if footprint is not None
    ]
    free = room.difference(unary_union(obstacles)) if obstacles else room
    area = width_m * depth_m
    if area > room.area:
        return {
            "ok": False,
            "reason": f"{width_m:.2f} x {depth_m:.2f} m ({area:.1f} m²) is larger than the room ({room.area:.1f} m²).",
            "position": None,
            "rotation_deg": 0.0,
        }
    if area > free.area:
        return {
            "ok": False,
            "reason": f"Only {free.area:.1f} m² of floor is free in {bm.spaces[space_id]['name']}.",
            "position": None,
            "rotation_deg": 0.0,
        }
    minx, miny, maxx, maxy = room.bounds
    step = max(0.15, math.sqrt(room.area) / 50.0)
    centre = room.representative_point()
    candidates = []
    x = minx
    while x <= maxx + 1e-9:
        y = miny
        while y <= maxy + 1e-9:
            candidates.append((x, y))
            y += step
        x += step
    candidates.sort(key=lambda point: math.dist(point, (centre.x, centre.y)))
    prepared_free = free.buffer(1e-6)
    for angle in _wall_angles(room):
        base = box(-width_m / 2, -depth_m / 2, width_m / 2, depth_m / 2)
        rotated = affinity.rotate(base, angle, origin=(0, 0))
        for x, y in candidates:
            if not prepared_free.contains(Point(x, y)):
                continue
            placed = affinity.translate(rotated, x, y)
            if prepared_free.contains(placed):
                return {
                    "ok": True,
                    "reason": f"Fits in {bm.spaces[space_id]['name']} at ({x:.1f}, {y:.1f}), rotated {angle:.0f}°.",
                    "position": [round(x, 3), round(y, 3)],
                    "rotation_deg": round(angle, 1),
                }
    return {
        "ok": False,
        "reason": f"No free spot of {width_m:.2f} x {depth_m:.2f} m in {bm.spaces[space_id]['name']} "
        "between the walls and the existing equipment.",
        "position": None,
        "rotation_deg": 0.0,
    }


def capacity(bm, space_id: str) -> int:
    """Seats in the room (chairs of any kind), else floor(area / 2.5 m²)."""
    seats = sum(
        1 for asset in bm.assets.values() if asset["space_id"] == space_id and asset["type"] in SEATING_TYPES
    )
    if seats:
        return seats
    return int(bm.room_area(space_id) // AREA_PER_PERSON_M2)
