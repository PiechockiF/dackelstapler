"""SiteTwin building map: the starter BuildingMap plus areas, constrained routing and route payloads.

The route cost model is the starter's (kit 1.1.0, the judges' rules: door to door inside a space, 15 cm off
the walls; stairs 2 m and lifts 15 m + 1 m per metre climbed; no way round the outside), so route lengths
reproduce the dataset's expected answers to the centimetre. Width, step-free and closure constraints only
remove nodes and edges from that graph. Only loads, and searches that start outside, get an "outside" node."""

from __future__ import annotations

import itertools
import math
from dataclasses import dataclass, field
from functools import cached_property

import networkx as nx
from shapely.geometry import LineString, Polygon

from starter_agent.building_map import DOOR_PREFIX, LIFT, OUTSIDE, MapError, RouteResult
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
        self.walks.clear()

    def add_opening(self, opening: dict) -> dict:
        """Add a prepared opening dict (id, floor_id, space_ids, kind, position, width_m, step_free)."""
        opening = {"kind": "door", "width_m": 0.9, "step_free": True, "synthetic": True, **opening}
        self.openings[opening["id"]] = opening
        self.data["openings"].append(opening)
        for space_id in opening["space_ids"]:
            self.walks.pop(space_id, None)
        return opening

    # ---------- routing ----------

    def graph(
        self,
        step_free: bool,
        min_width_m: float | None = None,
        closed: set[str] | frozenset[str] | None = None,
        outside: bool = False,
    ) -> nx.MultiGraph:
        """The starter graph, optionally without openings narrower than min_width_m (loads also imply
        step-free) and with extra closed element ids on top of self.closed.
        Pedestrians stay inside: a zero-cost "outside" node joining all entrances is only added for loads
        (min_width_m set), which may drive round the building, or with outside=True for searches that start
        outside (entrance distances, reachability from the street)."""
        if min_width_m is not None:
            step_free = True
        outside = outside or min_width_m is not None
        graph = super().graph(step_free)
        extra = set(closed or ()) - set(self.closed)
        narrow = set()
        if min_width_m is not None:
            narrow = {
                opening["id"]
                for opening in self.openings.values()
                if float(opening.get("width_m") or 0.0) < min_width_m - WIDTH_EPSILON_M
            }
        graph.remove_nodes_from([*extra, *(DOOR_PREFIX + element for element in extra | narrow)])
        graph.remove_edges_from(
            [(first, second, key) for first, second, key, via in graph.edges(keys=True, data="via") if via in extra]
        )
        if outside:
            for opening in self.openings.values():
                door = DOOR_PREFIX + opening["id"]
                if OUTSIDE in opening["space_ids"] and door in graph:
                    graph.add_edge(OUTSIDE, door, weight=0.0, via=opening["id"])
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
        outside: bool = False,
    ) -> SiteRoute:
        """Shortest route under constraints. Raises MapError when there is none.
        outside=True lets the route leave and re-enter the building (loads always may, see graph())."""
        stops = [
            self.resolve_space(start),
            *[self.resolve_space(stop) for stop in via or []],
            self.resolve_space(destination),
        ]
        step_free = step_free or min_width_m is not None
        graph = self.graph(step_free, min_width_m, closed, outside)
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
            space_path=[space for space in self.spaces_passed(graph, nodes) if space != OUTSIDE],
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

    def directions(self, graph: nx.MultiGraph, nodes: list[str]) -> list[str]:
        """The starter's steps (one per door or floor change), plus loads that go round the building:
        via the "outside" node, or door to door via "outside" in the app's map (server/twin.py)."""
        steps = [f"Start in {self.describe_space(nodes[0])}."]
        walked = 0.0
        for index, (previous, current) in enumerate(itertools.pairwise(nodes), start=1):
            edge = self.cheapest(graph, previous, current)
            via = edge.get("via")
            if via in self.connectors and previous in self.spaces and current in self.spaces:
                connector = self.connectors[via]
                verb = "Take" if connector["kind"] == LIFT else "Use"
                steps.append(
                    f"{verb} {connector['name']} ({connector['kind']}) to "
                    f"{self.floor_name(self.spaces[current]['floor_id'])}."
                )
                walked = 0.0
                continue
            if current == OUTSIDE or via == OUTSIDE:
                steps.append(f"Walk about {walked:.0f} m and leave the building through the entrance.")
                walked = 0.0
            walked += edge["weight"]
            if current.startswith(DOOR_PREFIX) and index + 1 < len(nodes):
                following = self.cheapest(graph, current, nodes[index + 1]).get("space")
                if following is None:  # the next step leaves the building
                    continue
                opening = self.openings[current.removeprefix(DOOR_PREFIX)]
                passage = {"door": "through the door", "entrance": "in through the entrance"}.get(
                    opening["kind"], "through the opening"
                )
                steps.append(f"Walk about {walked:.0f} m {passage} into {self.spaces[following]['name']}.")
                walked = 0.0
        steps.append(f"Walk about {walked:.0f} m. You have arrived at {self.describe_space(nodes[-1])}.")
        return steps

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
        graph = graph if graph is not None else self.graph(step_free, min_width_m, closed, outside=source == OUTSIDE)
        if source not in graph:
            return {}
        lengths = nx.single_source_dijkstra_path_length(graph, source, weight="weight")
        return {node: value for node, value in lengths.items() if node in self.spaces}

    def entrance_distances(self, graph: nx.MultiGraph | None = None, step_free: bool = False) -> dict[str, float]:
        """Distance from every space to its nearest entrance (via the shared 'outside' node)."""
        graph = graph if graph is not None else self.graph(step_free, outside=True)
        return self.distances_from(OUTSIDE, graph=graph)

    # ---------- route payload for the frontend ----------

    def _edge_via(self, graph: nx.MultiGraph, first: str, second: str) -> str:
        edge = min(graph[first][second].values(), key=lambda candidate: candidate["weight"])
        return edge["via"]

    def _detour_anchor(self, graph: nx.MultiGraph, first: str, second: str) -> str | None:
        """For drawing only: the space walked between two doors when the straight line between them leaves
        it (an L-shaped corridor), so the polyline bends through its anchor (the cost model goes round
        the corners)."""
        space_id = self.cheapest(graph, first, second).get("space")
        if space_id is None or not (first.startswith(DOOR_PREFIX) and second.startswith(DOOR_PREFIX)):
            return None
        segment = LineString([self.openings[node[len(DOOR_PREFIX):]]["position"] for node in (first, second)])
        return None if self.polygons[space_id].buffer(0.35).contains(segment) else space_id

    def route_payload(self, route: RouteResult | None, *, blocking: list[dict] | None = None) -> dict:
        """Route JSON as in docs/CONTRACT.md: per-floor polylines, connectors, steps.
        Polylines run anchor -> doors -> anchor, door to door through the spaces passed, bending through a
        space's anchor where the straight line would leave it (length_m is always the cost-model length)."""
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
                detour = self._detour_anchor(graph, nodes[index - 1], node) if index else None
                if detour is not None:
                    add_point(self.spaces[detour]["floor_id"], self.anchors[detour])
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
        """Ordered opening and connector ids along a route, each used once."""
        elements = []
        graph = route.graph if route.graph is not None else self.graph(route.step_free, route.min_width_m)
        for index, node in enumerate(route.nodes):
            previous = route.nodes[index - 1] if index else None
            if node.startswith(DOOR_PREFIX):
                elements.append(node[len(DOOR_PREFIX):])
            elif previous in self.spaces and node in self.spaces:
                connector = self._edge_via(graph, previous, node)
                if not elements or elements[-1] != connector:  # one stair over several flights
                    elements.append(connector)
        return elements
