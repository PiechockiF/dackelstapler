"""Reachability under constraints (load width, step-free, closures) and the doors that block a load."""

from __future__ import annotations

import networkx as nx

from core.building_map import DOOR_PREFIX, OUTSIDE, MapError


def reachable_spaces(
    bm,
    entry_space_id: str,
    *,
    min_width_m: float | None = None,
    step_free: bool = False,
    closed: set[str] | frozenset[str] = frozenset(),
) -> set[str]:
    """Every space reachable from entry_space_id (itself included) in the constrained graph.
    A load (min_width_m set) also implies step-free: no stairs, no steps."""
    graph = bm.graph(step_free or min_width_m is not None, min_width_m, set(closed), outside=entry_space_id == OUTSIDE)
    if entry_space_id not in graph:
        return set()
    component = nx.node_connected_component(graph, entry_space_id)
    return {node for node in component if node in bm.spaces}


def blocking_openings(bm, start: str, destination: str, min_width_m: float) -> list[dict]:
    """Openings on the unconstrained shortest route that are narrower than min_width_m."""
    try:
        route = bm.find_route(start, destination, outside=True)  # loads may go round the building
    except MapError:
        return []
    blocking = []
    for node in route.nodes:
        if not node.startswith(DOOR_PREFIX):
            continue
        opening = bm.openings[node[len(DOOR_PREFIX):]]
        width = float(opening.get("width_m") or 0.0)
        if width < min_width_m - 1e-6:
            blocking.append(
                {
                    "id": opening["id"],
                    "width_m": width,
                    "position": [float(opening["position"][0]), float(opening["position"][1])],
                    "floor_id": opening["floor_id"],
                }
            )
    return blocking
