"""Deterministic solvers for the benchmark question kinds, on top of the shared core.

Each solver takes resolved ids (space ids, floor ids, asset/room types) and returns a dict with the
answer value plus the facts used to explain it."""

from __future__ import annotations

import math

import networkx as nx

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


# ---------- routes (warm-up and Sunday benchmark questions) ----------

FORKLIFT_MIN_WIDTH_M = 3.0
# ponytail: the organizers haven't said which halls are production bays (destinations only, never driven
# through); these are the halls where the machines stand. Warehouse and logistics zones stay drivable.
PRODUCTION_BAY_TYPES = {"production_zone", "assembly_zone", "additive_zone"}


def route_graph(
    bm: BuildingMap,
    *,
    step_free: bool = False,
    min_width_m: float | None = None,
    closed: set[str] | frozenset[str] = frozenset(),
    forklift: bool = False,
    endpoints: set[str] | frozenset[str] = frozenset(),
):
    """The judges' route graph: never round the outside. A forklift needs openings of at least 3 m, no stairs
    or steps, and may end in a production bay (one of `endpoints`) but never drive through one."""
    if forklift:
        min_width_m = max(min_width_m or 0.0, FORKLIFT_MIN_WIDTH_M)
    graph = bm.graph(step_free or min_width_m is not None, min_width_m, set(closed))
    if OUTSIDE in graph:  # bm.graph lets loads round the building; the judges never do
        graph.remove_node(OUTSIDE)
    if forklift:
        bays = {space_id for space_id, space in bm.spaces.items() if space["room_type"] in PRODUCTION_BAY_TYPES}
        graph.remove_edges_from(
            [(first, second, key) for first, second, key, space in graph.edges(keys=True, data="space")
             if space in bays and first not in bm.spaces and second not in bm.spaces]  # door to door through a bay
        )
        graph.remove_nodes_from(bays - set(endpoints))
        graph.remove_edges_from(  # no lift rides either: aisles and wide openings only
            [(first, second, key) for first, second, key, via in graph.edges(keys=True, data="via") if via in bm.connectors]
        )
    return graph


def best_route(
    bm: BuildingMap,
    starts: list[str],
    ends: list[str],
    *,
    step_free: bool = False,
    min_width_m: float | None = None,
    closed: set[str] | frozenset[str] = frozenset(),
    forklift: bool = False,
):
    """Shortest route from any of `starts` to any of `ends` (e.g. every room that holds a CNC mill).
    Raises MapError when there is none."""
    graph = route_graph(
        bm, step_free=step_free, min_width_m=min_width_m, closed=closed, forklift=forklift,
        endpoints=set(starts) | set(ends),
    )
    sources = sorted(space_id for space_id in set(starts) if space_id in graph)
    if not sources:
        raise MapError("The start can't be used under these constraints.")
    lengths, paths = nx.multi_source_dijkstra(graph, sources, weight="weight")
    reached = sorted((lengths[end], end) for end in set(ends) if end in lengths)
    if not reached:
        raise MapError("There is no route under these constraints.")
    length, end = reached[0]
    return bm.route_from_nodes(
        graph, paths[end], length, step_free=step_free or forklift or min_width_m is not None,
        min_width_m=FORKLIFT_MIN_WIDTH_M if forklift and min_width_m is None else min_width_m, closed=set(closed),
    )


def tour(bm: BuildingMap, stops: list[list[str]], **constraints) -> list:
    """One route per leg, visiting the stops in order. Each stop is a list of candidate spaces; a leg ends
    at its nearest candidate, which starts the next leg.
    ponytail: greedy per leg, so with several candidates per stop the total can miss the best chain; a DP over
    the stops (super-source Dijkstra per stop) fixes it if tours with item/room-type stops matter."""
    legs, here = [], stops[0]
    for candidates in stops[1:]:
        legs.append(best_route(bm, here, candidates, **constraints))
        here = [legs[-1].destination_space_id]
    return legs


def assets_of_type(bm: BuildingMap, asset_type: str, floor_id: str | None = None) -> list[dict]:
    return sorted(
        (asset for asset in bm.assets.values()
         if asset["type"] == asset_type and (floor_id is None or asset["floor_id"] == floor_id)),
        key=lambda asset: asset["id"],
    )


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
    "route_graph",
    "best_route",
    "tour",
    "assets_of_type",
]
