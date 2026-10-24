"""Deterministic solvers for the benchmark question kinds, on top of the shared core.

Each solver takes resolved ids (space ids, floor ids, asset/room types) and returns a dict with the
answer value plus the facts used to explain it."""

from __future__ import annotations

import math

from core import geometry
from core.building_map import OUTSIDE, BuildingMap, MapError
from core.reachability import reachable_spaces

ROOM_TYPE = "room"
IMPROVEMENT_THRESHOLD_M = 1.0


def rooms_of_type(bm: BuildingMap, floor_id: str, room_type: str) -> list[dict]:
    return [space for space in bm.spaces_on_floor(floor_id) if space["room_type"] == room_type]


def ranked_by_area(bm: BuildingMap, floor_id: str, room_type: str) -> list[tuple[dict, float]]:
    rooms = rooms_of_type(bm, floor_id, room_type)
    return sorted(((room, bm.room_area(room["id"])) for room in rooms), key=lambda item: -item[1])


def largest_room(bm: BuildingMap, floor_id: str, room_type: str) -> dict:
    ranked = ranked_by_area(bm, floor_id, room_type)
    if not ranked:
        raise MapError(f"No {room_type.replace('_', ' ')} on {bm.floor_name(floor_id)}.")
    room, area = ranked[0]
    return {
        "space_id": room["id"],
        "area_m2": area,
        "runner_up": (ranked[1][0]["id"], ranked[1][1]) if len(ranked) > 1 else None,
        "count": len(ranked),
    }


def floor_area_total(bm: BuildingMap, floor_id: str, room_type: str) -> dict:
    ranked = ranked_by_area(bm, floor_id, room_type)
    return {"total_m2": sum(area for _, area in ranked), "count": len(ranked), "rooms": ranked}


def errand(bm: BuildingMap, start: str, asset_type: str, floor_id: str, room_type: str) -> dict:
    """Walk to the nearest room holding an asset of asset_type, then to the largest room_type on floor."""
    target = largest_room(bm, floor_id, room_type)["space_id"]
    graph = bm.graph(step_free=False)
    from_start = bm.distances_from(start, graph=graph)
    holders = {asset["space_id"] for asset in bm.assets.values() if asset["type"] == asset_type}
    reachable_holders = [space_id for space_id in holders if space_id in from_start]
    if not reachable_holders:
        raise MapError(f"No reachable room has a {asset_type.replace('_', ' ')}.")
    to_target = bm.distances_from(target, graph=graph)
    via = min(reachable_holders, key=lambda space_id: (from_start[space_id], to_target.get(space_id, math.inf)))
    if via not in to_target:
        raise MapError("The target room can't be reached from the pick-up room.")
    first_leg, second_leg = from_start[via], to_target[via]
    return {
        "via": via,
        "target": target,
        "first_leg_m": first_leg,
        "second_leg_m": second_leg,
        "total_m": first_leg + second_leg,
    }


def rooms_reached(bm: BuildingMap, reached: set[str], floor_id: str) -> list[str]:
    return sorted(
        space_id
        for space_id in reached
        if bm.spaces[space_id]["floor_id"] == floor_id and bm.spaces[space_id]["type"] == ROOM_TYPE
    )


def wide_delivery_count(bm: BuildingMap, start: str, floor_id: str, min_width: float) -> dict:
    reached = reachable_spaces(bm, start, min_width_m=min_width, step_free=True)
    rooms = rooms_reached(bm, reached, floor_id)
    return {"count": len(rooms), "rooms": rooms}


def step_free_reachable_count(bm: BuildingMap, start: str, floor_id: str, closed: set[str]) -> dict:
    reached = reachable_spaces(bm, start, step_free=True, closed=set(closed))
    rooms = rooms_reached(bm, reached, floor_id)
    return {"count": len(rooms), "rooms": rooms}


def room_stacked(bm: BuildingMap, start: str, direction: str) -> dict:
    step = 1 if direction == "above" else -1
    ranked = geometry.stacked_candidates(bm, start, step)
    if not ranked:
        raise MapError(f"Nothing is directly {direction} {bm.spaces[start]['name']}.")
    return {"space_id": ranked[0][0], "overlap_m2": ranked[0][1], "ranked": ranked}


def shared_walls_count(bm: BuildingMap, start: str) -> dict:
    rooms = geometry.shared_walls(bm, start)
    return {"count": len(rooms), "rooms": rooms}


def straight_line_3d(bm: BuildingMap, first: str, second: str) -> dict:
    return {
        "distance_m": geometry.distance_3d(bm, first, second),
        "first": geometry.centroid_3d(bm, first),
        "second": geometry.centroid_3d(bm, second),
    }


def what_if_door(bm: BuildingMap, first: str, second: str, floor_id: str) -> dict:
    """Add a door at the middle of the wall first/second share; count rooms on floor_id whose
    nearest-entrance walk gets shorter by more than 1 m."""
    before = bm.entrance_distances()
    position = geometry.shared_wall_midpoint(bm, first, second)
    opening = {
        "id": f"{bm.spaces[first]['floor_id']}-O-whatif",
        "floor_id": bm.spaces[first]["floor_id"],
        "space_ids": [first, second],
        "kind": "door",
        "position": [position[0], position[1]],
        "width_m": 0.9,
        "step_free": True,
        "synthetic": True,
    }
    bm.openings[opening["id"]] = opening
    for space_id in (first, second):  # the starter caches walks per space: walk these two with the door
        bm.walks.pop(space_id, None)
    try:
        after = bm.entrance_distances()
    finally:
        del bm.openings[opening["id"]]
        for space_id in (first, second):
            bm.walks.pop(space_id, None)
    improved = []
    for space in bm.spaces_on_floor(floor_id, ROOM_TYPE):
        old, new = before.get(space["id"], math.inf), after.get(space["id"], math.inf)
        if new < old - IMPROVEMENT_THRESHOLD_M:
            improved.append(space["id"])
    return {"count": len(improved), "rooms": improved, "door_position": position}


__all__ = [
    "OUTSIDE",
    "largest_room",
    "floor_area_total",
    "errand",
    "wide_delivery_count",
    "step_free_reachable_count",
    "room_stacked",
    "shared_walls_count",
    "straight_line_3d",
    "what_if_door",
]
