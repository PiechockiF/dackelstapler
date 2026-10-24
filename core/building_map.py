"""SiteTwin building map: the starter BuildingMap plus areas, constrained routing and route payloads.

The route cost model is the starter's, unchanged (representative-point anchors, door nodes, 12 m per
stair floor, 15 m + 6 m per lift floor, one zero-cost "outside" node joining all entrances), so route
lengths reproduce the dataset's expected answers to the centimetre. Width and step-free constraints only
remove edges from that graph."""

from __future__ import annotations

import itertools
import math
from dataclasses import dataclass, field
from functools import cached_property

import networkx as nx
from shapely.geometry import LineString, Polygon

from starter_agent.building_map import (
    DOOR_PREFIX,
    LIFT,
    LIFT_COST_PER_FLOOR_M,
    LIFT_WAIT_COST_M,
    OUTSIDE,
    STAIRS_COST_PER_FLOOR_M,
    MapError,
    RouteResult,
)
from starter_agent.building_map import BuildingMap as StarterBuildingMap

__all__ = ["BuildingMap", "MapError", "RouteResult", "SiteRoute", "OUTSIDE", "DOOR_PREFIX"]

# Doors are compared to load widths with a small tolerance so 1.0 m doors pass a 1.0 m load.
WIDTH_EPSILON_M = 1e-6


@dataclass
class SiteRoute(RouteResult):
    """A RouteResult that also remembers the node path (spaces, door:<id>, outside) and constraints."""

    nodes: list[str] = field(default_factory=list)
    min_width_m: float | None = None
    graph: nx.MultiGraph | None = field(default=None, repr=False)


class BuildingMap(StarterBuildingMap):
    # ---------- geometry caches ----------

    @cached_property
    def polygons(self) -> dict[str, Polygon]:
        return {space_id: Polygon(space["polygon"]) for space_id, space in self.spaces.items()}

    @cached_property
    def anchors(self) -> dict[str, tuple[float, float]]:
        return {space_id: self.anchor(space_id) for space_id in self.spaces}

    @cached_property
    def floor_levels(self) -> dict[str, int]:
        return {floor_id: floor["level"] for floor_id, floor in self.floors.items()}

    def floors_by_level(self) -> list[dict]:
        return sorted(self.floors.values(), key=lambda floor: floor["level"])

    def floor_at_level(self, level: int) -> dict | None:
        for floor in self.floors.values():
            if floor["level"] == level:
                return floor
        return None

    def spaces_on_floor(self, floor_id: str, space_type: str | None = None) -> list[dict]:
        return [
            space
            for space in self.spaces.values()
            if space["floor_id"] == floor_id and (space_type is None or space["type"] == space_type)
        ]

    def room_area(self, space_id: str) -> float:
        """Floor area in m² of the space outline (shapely polygon area)."""
        return float(self.polygons[space_id].area)

    # ---------- edits ----------

    def invalidate(self) -> None:
        """Call after changing spaces, polygons or floors in self.data so cached geometry is rebuilt."""
        self.floors = {floor["id"]: floor for floor in self.data["floors"]}
        self.spaces = {space["id"]: space for space in self.data["spaces"]}
        for name in ("polygons", "anchors", "floor_levels"):
            self.__dict__.pop(name, None)

    def add_opening(self, opening: dict) -> dict:
        """Add a prepared opening dict (id, floor_id, space_ids, kind, position, width_m, step_free)."""
        opening = {"kind": "door", "width_m": 0.9, "step_free": True, "synthetic": True, **opening}
        self.openings[opening["id"]] = opening
        self.data["openings"].append(opening)
        return opening

    # ---------- routing ----------

    def graph(
        self,
        step_free: bool,
        min_width_m: float | None = None,
        closed: set[str] | frozenset[str] | None = None,
    ) -> nx.MultiGraph:
        """The starter graph, optionally without openings narrower than min_width_m (loads also imply
        step-free) and with extra closed element ids on top of self.closed."""
        if min_width_m is not None:
            step_free = True
        blocked = set(self.closed) | set(closed or ())
        graph = nx.MultiGraph()
        anchors = {space_id: point for space_id, point in self.anchors.items() if space_id not in blocked}
        graph.add_nodes_from(anchors)
        for opening in self.openings.values():
            if opening["id"] in blocked or (step_free and not opening["step_free"]):
                continue
            if min_width_m is not None and float(opening.get("width_m") or 0.0) < min_width_m - WIDTH_EPSILON_M:
                continue
            door = DOOR_PREFIX + opening["id"]
            for space_id in opening["space_ids"]:
                if space_id == OUTSIDE:
                    graph.add_edge(OUTSIDE, door, weight=0.0, via=opening["id"])
                elif space_id in anchors:
                    distance = math.dist(anchors[space_id], opening["position"])
                    graph.add_edge(space_id, door, weight=distance, via=opening["id"])
        levels = self.floor_levels
        for connector in self.connectors.values():
            if connector["id"] in blocked or (step_free and not connector["step_free"]):
                continue
            stops = sorted(
                zip(connector["floor_ids"], connector["space_ids"], strict=True),
                key=lambda stop: levels[stop[0]],
            )
            for (low_floor, low_space), (high_floor, high_space) in itertools.pairwise(stops):
                if low_space not in anchors or high_space not in anchors:
                    continue
                span = abs(levels[high_floor] - levels[low_floor])
                cost = (
                    LIFT_WAIT_COST_M + LIFT_COST_PER_FLOOR_M * span
                    if connector["kind"] == LIFT
                    else STAIRS_COST_PER_FLOOR_M * span
                )
                graph.add_edge(low_space, high_space, weight=cost, via=connector["id"])
        return graph

    def find_route(
        self,
        start: str,
        destination: str,
        *,
        step_free: bool = False,
        min_width_m: float | None = None,
        via: list[str] | None = None,
        closed: set[str] | None = None,
    ) -> SiteRoute:
        """Shortest route under constraints. Raises MapError when there is none."""
        stops = [
            self.resolve_space(start),
            *[self.resolve_space(stop) for stop in via or []],
            self.resolve_space(destination),
        ]
        step_free = step_free or min_width_m is not None
        graph = self.graph(step_free, min_width_m, closed)
        nodes: list[str] = []
        length = 0.0
        for leg_start, leg_end in itertools.pairwise(stops):
            try:
                leg_length, leg_nodes = nx.single_source_dijkstra(graph, leg_start, leg_end, weight="weight")
            except (nx.NetworkXNoPath, nx.NodeNotFound) as error:
                constraint = []
                if step_free:
                    constraint.append("step-free")
                if min_width_m is not None:
                    constraint.append(f"{min_width_m:g} m wide")
                reason = (" ".join(constraint) + " ") if constraint else ""
                raise MapError(
                    f"No {reason}route from {self.describe_space(leg_start)} to "
                    f"{self.describe_space(leg_end)} with the current closures "
                    f"{sorted(set(self.closed) | set(closed or ()))}."
                ) from error
            length += leg_length
            nodes += leg_nodes if not nodes else leg_nodes[1:]
        result = SiteRoute(
            start_space_id=stops[0],
            destination_space_id=stops[-1],
            length_m=round(length, 2),
            space_path=[node for node in nodes if not node.startswith(DOOR_PREFIX) and node != OUTSIDE],
            steps=self.directions(graph, nodes) if len(nodes) > 1 else [
                f"You are already in {self.describe_space(nodes[0])}."
            ],
            step_free=step_free,
            closed=sorted(set(self.closed) | set(closed or ())),
            nodes=nodes,
            min_width_m=min_width_m,
            graph=graph,
        )
        self.last_route = result
        return result

    def route(self, start: str, destination: str, step_free: bool = False, via: list[str] | None = None):
        return self.find_route(start, destination, step_free=step_free, via=via)

    def distances_from(
        self,
        source: str,
        *,
        step_free: bool = False,
        min_width_m: float | None = None,
        closed: set[str] | None = None,
        graph: nx.MultiGraph | None = None,
    ) -> dict[str, float]:
        """Route-model distance from one space (or 'outside') to every reachable space."""
        graph = graph if graph is not None else self.graph(step_free, min_width_m, closed)
        if source not in graph:
            return {}
        lengths = nx.single_source_dijkstra_path_length(graph, source, weight="weight")
        return {node: value for node, value in lengths.items() if node in self.spaces}

    def entrance_distances(self, graph: nx.MultiGraph | None = None, step_free: bool = False) -> dict[str, float]:
        """Distance from every space to its nearest entrance (via the shared 'outside' node)."""
        graph = graph if graph is not None else self.graph(step_free)
        return self.distances_from(OUTSIDE, graph=graph)

    # ---------- route payload for the frontend ----------

    def _edge_via(self, graph: nx.MultiGraph, first: str, second: str) -> str:
        edge = min(graph[first][second].values(), key=lambda candidate: candidate["weight"])
        return edge["via"]

    def _skip_anchor(self, nodes: list[str], index: int) -> bool:
        """For drawing only: a pass-through space between two doors on its floor is drawn door to door
        when that straight segment stays inside the space (the cost model still uses the anchor)."""
        if index == 0 or index == len(nodes) - 1:
            return False
        before, after = nodes[index - 1], nodes[index + 1]
        if not (before.startswith(DOOR_PREFIX) and after.startswith(DOOR_PREFIX)):
            return False
        first = self.openings[before[len(DOOR_PREFIX):]]
        second = self.openings[after[len(DOOR_PREFIX):]]
        space = self.spaces[nodes[index]]
        if first["floor_id"] != space["floor_id"] or second["floor_id"] != space["floor_id"]:
            return False
        segment = LineString([first["position"], second["position"]])
        return self.polygons[nodes[index]].buffer(0.35).contains(segment)

    def route_payload(
        self, route: RouteResult | None, *, blocking: list[dict] | None = None, raw: bool = False
    ) -> dict:
        """Route JSON as in docs/CONTRACT.md: per-floor polylines, connectors, steps.
        Polylines run anchor -> doors -> anchor; with raw=False pass-through corridors are drawn door to
        door when the straight line stays inside them (length_m is always the cost-model length)."""
        if route is None:
            payload = {
                "reachable": False,
                "length_m": 0.0,
                "step_free": False,
                "min_width_m": None,
                "space_path": [],
                "steps": [],
                "floors": [],
                "connectors": [],
            }
            if blocking is not None:
                payload["blocking_openings"] = blocking
            return payload
        nodes = getattr(route, "nodes", None) or []
        graph = getattr(route, "graph", None)
        if not nodes:
            # A plain starter RouteResult: recompute the node path along its space path.
            rebuilt = self.find_route(
                route.start_space_id, route.destination_space_id, step_free=route.step_free
            )
            nodes, graph = rebuilt.nodes, rebuilt.graph
        if graph is None:
            graph = self.graph(route.step_free, getattr(route, "min_width_m", None))

        floors: list[dict] = []
        connectors: list[dict] = []

        def floor_entry(floor_id: str) -> dict:
            floor = self.floors[floor_id]
            return {
                "floor_id": floor_id,
                "level": floor["level"],
                "elevation_m": float(floor.get("elevation_m", 0.0)),
                "points": [],
            }

        def add_point(floor_id: str, point) -> None:
            point = [round(float(point[0]), 3), round(float(point[1]), 3)]
            if not floors or floors[-1]["floor_id"] != floor_id:
                floors.append(floor_entry(floor_id))
            points = floors[-1]["points"]
            if not points or points[-1] != point:
                points.append(point)

        for index, node in enumerate(nodes):
            if node == OUTSIDE:
                continue
            if node.startswith(DOOR_PREFIX):
                opening = self.openings[node[len(DOOR_PREFIX):]]
                add_point(opening["floor_id"], opening["position"])
                continue
            space = self.spaces[node]
            previous = nodes[index - 1] if index > 0 else None
            if previous is not None and previous in self.spaces and graph.has_edge(previous, node):
                connector_id = self._edge_via(graph, previous, node)
                connector = self.connectors.get(connector_id)
                if connector is not None:
                    connectors.append(
                        {
                            "id": connector_id,
                            "kind": "lift" if connector["kind"] == LIFT else "stairs",
                            "name": connector.get("name", connector_id),
                            "from_floor_id": self.spaces[previous]["floor_id"],
                            "to_floor_id": space["floor_id"],
                            "position": [round(v, 3) for v in self.anchors[previous]],
                        }
                    )
            if raw or not self._skip_anchor(nodes, index):
                add_point(space["floor_id"], self.anchors[node])

        payload = {
            "reachable": True,
            "length_m": round(float(route.length_m), 2),
            "step_free": bool(route.step_free),
            "min_width_m": getattr(route, "min_width_m", None),
            "space_path": list(route.space_path),
            "steps": list(route.steps),
            "floors": floors,
            "connectors": connectors,
        }
        if blocking is not None:
            payload["blocking_openings"] = blocking
        return payload

    def element_path(self, route: SiteRoute) -> list[str]:
        """Ordered opening and connector ids along a route."""
        elements = []
        graph = route.graph if route.graph is not None else self.graph(route.step_free, route.min_width_m)
        for first, second in itertools.pairwise(route.nodes):
            if first.startswith(DOOR_PREFIX):
                continue
            if second.startswith(DOOR_PREFIX):
                elements.append(second[len(DOOR_PREFIX):])
            elif first in self.spaces and second in self.spaces:
                elements.append(self._edge_via(graph, first, second))
        return elements
