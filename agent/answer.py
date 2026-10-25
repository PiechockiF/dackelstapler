"""Benchmark agent: Claude answers one question about one building with tools over the deterministic core.

  uv run run_benchmark <building_dir> <questions.json> <answers.json>              (Sunday benchmark)
  uv run python -m benchmark.evaluate data/dev --agent agent.answer:answer         (kit questions)

Claude reads the question, looks up the ids it needs (find, list_spaces, list_assets, space_details),
computes with the core (route, reachable_rooms, what_if_door, straight_line_distance, calculate) and
commits with submit_answer. Every number comes from a tool; the reply ends with one 'Answer:' line in
the format benchmark/score.py expects. Routes are kept server-side, so answers.json gets the exact space
and element ids of the route the agent chose (route_ref) instead of ids copied by the model."""

from __future__ import annotations

import ast
import json
import math
import operator
import os
import threading
from collections import Counter
from functools import lru_cache
from pathlib import Path

import anthropic
from anthropic import beta_tool
from anthropic.lib.tools import ToolError

from core import geometry, solvers
from core.building_map import OUTSIDE, BuildingMap, MapError
from core.reachability import reachable_spaces

MODEL = os.environ.get("BENCHMARK_MODEL", "claude-opus-5-5")
EFFORT = os.environ.get("BENCHMARK_EFFORT", "medium")
MAX_TOKENS = 16000
MAX_TURNS = 25
FALLBACK_BETA = "server-side-fallback-2026-07-01"
MAX_LISTED = 120
# ponytail: one lock for every tool call; the map is shared across question threads and what_if_door
# edits it temporarily. Tools run in milliseconds next to model turns; per-question maps if that changes.
MAP_LOCK = threading.Lock()

SYSTEM_PROMPT = """You answer one question about one building. The building's plan is behind your tools: \
spaces (rooms, corridors, halls, stairwells, lifts) with polygons, doors and openings with widths, stairs \
and lifts, and assets (furniture, machines, equipment). Nobody can answer follow-up questions, so read \
the question carefully, pick the most likely reading when it is vague, and say what you assumed.

How to work:
- Every id, name, area, distance and count must come from a tool. Never guess or do arithmetic in your \
head: use calculate for sums and conversions.
- Resolve every place first (find, list_spaces, list_assets) and pass ids to the other tools. Floors are \
addressed by level: 0 = ground floor, 1 = "floor 1" / first floor, -1 = first basement.
- When a room name is not unique, use the floor given in the question (e.g. "Office 0.30 (Ground floor)").
- "The nearest X", "a toilet", "the CNC mill": pass every candidate space or asset id as one route stop; \
the route ends at the nearest one. "The room that has an X closest to me" is the same: one stop with every \
asset of that type.
- An entrance: "comes in through the entrance into Lobby 0.01" means the start is Lobby 0.01. "From the \
entrance" with no room named: one stop with every space an entrance opens into (see the overview).
- Closures ("Lift 1 is out of service", "Aisle 4 is blocked", "the door between A and B is closed") go \
into closed as connector, opening or space ids. space_details lists a room's doors with their ids.
- Wheelchairs, prams, trolleys, "without stairs", "step-free": step_free=true. A load of a given width: \
min_width_m (implies step-free). Driving a forklift: forklift=true. "I can carry it on the stairs": \
stairs allowed, step_free=false.

The judges' rules, already built into the tools:
- Routes walk door to door, 15 cm off the walls. Stairs cost 2 m per metre climbed; a lift costs 15 m \
plus 1 m per metre. There is no way round the outside. Closed elements are never used. A route to an item \
or room type ends in the nearest room that holds or matches it.
- Forklifts use only openings of at least 3 m and no stairs or lifts; production bays can be a \
destination but are never driven through.
- Room area: the polygon area. Largest/smallest room: compare list_spaces areas.
- Directly above/below: the space on the next floor up or down whose outline covers most of this room's \
outline (space_details).
- Sharing a wall: at least 1 m of one outline within 0.35 m of the other; corridors, stairwells, lifts and \
outdoor spaces don't count (space_details: shares_wall_with).
- Room centre: the polygon centroid at the floor's elevation (straight_line_distance).
- Rooms reached / counted: spaces of type "room" (reachable_rooms counts them per floor).
- What-if door: a door in the middle of the shared wall; "walk out of the building" is the route distance \
to the nearest entrance (what_if_door).

Answering: call submit_answer exactly once with
- value: the text after "Answer:". Follow the question's "Finish with a line 'Answer: ...'" template \
exactly. A number answer holds exactly one number and nothing else that looks like a number (no room \
names, no ranges, no units with digits). A room answer names that room (full name with its number) \
before any other room. "Answer: <room name or number>, <area> m²" means e.g. "Kitchen 1.14, 28.0 m²". \
A route answer is its length in metres, or "no route" when the route tool finds none. A location is the \
room and floor, e.g. "Quality lab 0.21 (Ground floor)".
- explanation: two or three sentences on how you got it, including any assumption.
- route_ref from the route call your answer is based on, and room_id / item_id of the room or item the \
answer is about.

Building overview:
{overview}"""


# ---------------------------------------------------------------------------------------------- tools


class BenchmarkTools:
    """Plain, testable tool methods over one building. Every method takes ids and returns a JSON-able dict."""

    def __init__(self, bm: BuildingMap) -> None:
        self.bm = bm
        self.routes: list[dict] = []  # answers.json fields per route_ref
        self.submission: dict | None = None

    # ---------- helpers

    def level(self, floor_id: str) -> int:
        return self.bm.floors[floor_id]["level"]

    def floor_id(self, level: int) -> str:
        floor = self.bm.floor_at_level(int(level))
        if floor is None:
            levels = sorted(floor["level"] for floor in self.bm.floors.values())
            raise MapError(f"No floor at level {level}. Levels: {levels}.")
        return floor["id"]

    def label(self, space_id: str) -> str:
        space = self.bm.spaces[space_id]
        return f"{space['name']} ({self.bm.floor_name(space['floor_id'])})"

    def space_row(self, space: dict) -> dict:
        return {"id": space["id"], "name": space["name"], "type": space["type"], "room_type": space["room_type"],
                "floor_level": self.level(space["floor_id"]), "area_m2": round(self.bm.room_area(space["id"]), 2)}

    def asset_row(self, asset: dict) -> dict:
        return {"id": asset["id"], "name": asset["name"], "type": asset["type"], "category": asset["category"],
                "space_id": asset["space_id"], "room": self.label(asset["space_id"])}

    def space_id(self, reference: str) -> str:
        if reference in self.bm.spaces:
            return reference
        if reference in self.bm.assets:
            return self.bm.assets[reference]["space_id"]
        raise MapError(f"Unknown space or asset id '{reference}'. Get ids from find or list_spaces.")

    def element_ids(self, references: list[str] | None) -> set[str]:
        bm, ids = self.bm, set()
        for reference in references or []:
            if reference not in bm.connectors and reference not in bm.openings and reference not in bm.spaces:
                raise MapError(f"Unknown element id '{reference}': closed takes stair/lift, opening or space ids.")
            ids.add(reference)
        return ids

    # ---------- look-ups

    def overview(self) -> dict:
        bm = self.bm
        floors = []
        for floor in bm.floors_by_level():
            spaces = bm.spaces_on_floor(floor["id"])
            floors.append({
                "level": floor["level"], "name": floor["name"], "elevation_m": floor.get("elevation_m"),
                "space_types": dict(Counter(space["type"] for space in spaces).most_common()),
                "room_types": dict(Counter(space["room_type"] for space in spaces).most_common()),
            })
        entrances = [
            {"opening_id": opening["id"], "into": bm.other_side(opening, OUTSIDE),
             "into_name": self.label(bm.other_side(opening, OUTSIDE)), "step_free": opening["step_free"],
             "width_m": opening["width_m"]}
            for opening in bm.openings.values() if OUTSIDE in opening["space_ids"]
        ]
        return {
            "building": bm.data["building"]["name"],
            "source": bm.data["building"].get("source"),
            "floors": floors,
            "stairs_and_lifts": [
                {"id": c["id"], "name": c["name"], "kind": c["kind"], "step_free": c["step_free"],
                 "levels": [self.level(floor_id) for floor_id in c["floor_ids"]]}
                for c in bm.connectors.values()
            ],
            "entrances": entrances[:60],
            "asset_types": dict(sorted(Counter(asset["type"] for asset in bm.assets.values()).items())),
        }

    def find(self, query: str, floor_level: int | None = None) -> dict:
        """Spaces, assets, stairs/lifts matching every word; if none, the best partial matches."""
        bm = self.bm
        words = [word for word in query.lower().replace("_", " ").split() if word]
        if not words:
            raise MapError("Give at least one word to look for.")
        floor_id = self.floor_id(floor_level) if floor_level is not None else None
        rows = []
        for space in bm.spaces.values():
            if floor_id is None or space["floor_id"] == floor_id:
                text = f"{space['name']} {space.get('ref') or ''} {space['room_type'].replace('_', ' ')} {space['id']}"
                rows.append((text.lower(), "space", self.space_row(space)))
        for asset in bm.assets.values():
            if floor_id is None or asset["floor_id"] == floor_id:
                rows.append((f"{asset['name']} {asset['type'].replace('_', ' ')} {asset['id']}".lower(), "asset",
                             self.asset_row(asset)))
        for connector in bm.connectors.values():
            text = f"{connector['name']} {connector['kind']} {connector['id']}".lower()
            rows.append((text, "stairs_or_lift", {"id": connector["id"], "name": connector["name"],
                                                  "kind": connector["kind"]}))
        scored = [(sum(word in text for word in words), kind, row) for text, kind, row in rows]
        best = max((score for score, _, _ in scored), default=0)
        if not best:
            raise MapError(f"Nothing matches '{query}'. Try fewer or more general words, or list_spaces.")
        matches = [{"kind": kind, **row} for score, kind, row in scored if score == best]
        note = None if best == len(words) else f"No match for all words; these match {best} of {len(words)}."
        return {"matches": len(matches), "note": note, "results": matches[:MAX_LISTED]}

    def list_spaces(self, floor_level: int | None = None, room_type: str | None = None,
                    space_type: str | None = None, name_contains: str | None = None) -> dict:
        floor_id = self.floor_id(floor_level) if floor_level is not None else None
        spaces = [
            space for space in self.bm.spaces.values()
            if (floor_id is None or space["floor_id"] == floor_id)
            and (room_type is None or space["room_type"] == room_type)
            and (space_type is None or space["type"] == space_type)
            and (name_contains is None or name_contains.lower() in space["name"].lower())
        ]
        rows = sorted((self.space_row(space) for space in spaces), key=lambda row: -row["area_m2"])
        return {"count": len(rows), "total_area_m2": round(sum(row["area_m2"] for row in rows), 2),
                "largest_first": rows[:MAX_LISTED]}

    def list_assets(self, asset_type: str | None = None, floor_level: int | None = None,
                    space_id: str | None = None, name_contains: str | None = None) -> dict:
        floor_id = self.floor_id(floor_level) if floor_level is not None else None
        assets = sorted(
            (asset for asset in self.bm.assets.values()
             if (asset_type is None or asset["type"] == asset_type)
             and (floor_id is None or asset["floor_id"] == floor_id)
             and (space_id is None or asset["space_id"] == space_id)
             and (name_contains is None or name_contains.lower() in asset["name"].lower())),
            key=lambda asset: asset["id"],
        )
        return {"count": len(assets), "results": [self.asset_row(asset) for asset in assets[:MAX_LISTED]]}

    def space_details(self, space_id: str) -> dict:
        bm = self.bm
        space = bm.spaces[self.space_id(space_id)]
        sid = space["id"]
        openings = [
            {"id": opening["id"], "kind": opening["kind"], "width_m": opening["width_m"],
             "step_free": opening["step_free"], "to": "outside" if other == OUTSIDE else self.label(other),
             "to_id": other}
            for opening in bm.openings.values() if sid in opening["space_ids"]
            for other in [bm.other_side(opening, sid)]
        ]
        stacked = {
            direction: [{"id": other, "name": self.label(other), "overlap_m2": round(overlap, 2)}
                        for other, overlap in geometry.stacked_candidates(bm, sid, step)[:3]]
            for direction, step in (("directly_above", 1), ("directly_below", -1))
        }
        return {
            **self.space_row(space), "ref": space.get("ref"), "floor": bm.floor_name(space["floor_id"]),
            "centroid_xyz": [round(value, 3) for value in geometry.centroid_3d(bm, sid)],
            "openings": openings,
            "stairs_and_lifts": [{"id": c["id"], "name": c["name"], "kind": c["kind"]}
                                 for c in bm.connectors.values() if sid in c["space_ids"]],
            "asset_types": dict(Counter(asset["type"] for asset in bm.assets.values() if asset["space_id"] == sid)),
            **stacked,
            "shares_wall_with": [{"id": other, "name": self.label(other)} for other in geometry.shared_walls(bm, sid)],
        }

    # ---------- computations

    def route(self, stops: list[list[str]], step_free: bool = False, closed: list[str] | None = None,
              forklift: bool = False, min_width_m: float | None = None) -> dict:
        bm = self.bm
        if len(stops) < 2:
            raise MapError("A route needs at least two stops: a start and a destination.")
        candidates = [list(dict.fromkeys(self.space_id(reference) for reference in stop)) for stop in stops]
        if not all(candidates):
            raise MapError("Every stop needs at least one space or asset id.")
        closed_ids = self.element_ids(closed)
        record = {"step_free": bool(step_free or forklift or min_width_m is not None), "closed": sorted(closed_ids),
                  "forklift": bool(forklift), "min_width_m": min_width_m}
        try:
            legs = solvers.tour(bm, candidates, step_free=step_free, closed=closed_ids, forklift=forklift,
                                min_width_m=min_width_m)
        except MapError as error:
            record.update({"reachable": False, "length_m": None, "route": [], "element_path": [],
                           "from_space_id": candidates[0][0], "to_space_id": candidates[-1][0]})
            self.routes.append(record)
            return {"route_ref": len(self.routes) - 1, "reachable": False, "reason": str(error)}
        per_leg = []
        for leg in legs:
            elements = bm.element_path(leg)
            if len(elements) != len(leg.space_path) - 1:
                raise MapError("internal error: route steps and spaces don't line up")
            per_leg.append({"from_space_id": leg.start_space_id, "to_space_id": leg.destination_space_id,
                            "length_m": leg.length_m, "route": list(leg.space_path), "element_path": elements})
        destination = legs[-1].destination_space_id
        record.update({
            "reachable": True,
            "from_space_id": legs[0].start_space_id,
            "to_space_id": destination,
            "room_id": destination,
            "length_m": round(sum(leg.length_m for leg in legs), 2),
            "route": per_leg[0]["route"] + [space for leg in per_leg[1:] for space in leg["route"][1:]],
            "element_path": [element for leg in per_leg for element in leg["element_path"]],
        })
        items = [ref for ref in stops[-1] if ref in bm.assets and bm.assets[ref]["space_id"] == destination]
        if items:  # routed to an item: the one in the room the route ends in
            record["item_id"] = items[0]
        if len(legs) > 1:
            record["stops"] = [legs[0].start_space_id, *(leg.destination_space_id for leg in legs)]
            record["legs"] = per_leg
        self.routes.append(record)
        return {
            "route_ref": len(self.routes) - 1, "reachable": True, "length_m": record["length_m"],
            "legs": [{"from": self.label(leg.start_space_id), "to": self.label(leg.destination_space_id),
                      "to_id": leg.destination_space_id, "length_m": leg.length_m} for leg in legs],
            "spaces_passed": [self.label(space_id) for space_id in record["route"]],
            "directions": [step for leg in legs for step in leg.steps],
        }

    def reachable_rooms(self, start: str, floor_level: int | None = None, step_free: bool = False,
                        min_width_m: float | None = None, closed: list[str] | None = None) -> dict:
        bm = self.bm
        reached = reachable_spaces(bm, self.space_id(start), min_width_m=min_width_m, step_free=step_free,
                                   closed=self.element_ids(closed))
        floor_id = self.floor_id(floor_level) if floor_level is not None else None
        on_floor = [bm.spaces[s] for s in reached if floor_id is None or bm.spaces[s]["floor_id"] == floor_id]
        rooms = sorted(space["id"] for space in on_floor if space["type"] == "room")
        return {"rooms_reached": len(rooms), "spaces_reached_by_type": dict(Counter(s["type"] for s in on_floor)),
                "rooms": [self.label(space_id) for space_id in rooms[:MAX_LISTED]]}

    def what_if_door(self, first_space: str, second_space: str, floor_level: int) -> dict:
        result = solvers.what_if_door(self.bm, self.space_id(first_space), self.space_id(second_space),
                                      self.floor_id(floor_level))
        return {"rooms_with_shorter_walk_out": result["count"], "door_position": result["door_position"],
                "rooms": [self.label(space_id) for space_id in result["rooms"][:MAX_LISTED]]}

    def straight_line_distance(self, first_space: str, second_space: str) -> dict:
        first, second = self.space_id(first_space), self.space_id(second_space)
        return {"distance_m": round(geometry.distance_3d(self.bm, first, second), 3),
                "first_centroid_xyz": geometry.centroid_3d(self.bm, first),
                "second_centroid_xyz": geometry.centroid_3d(self.bm, second)}

    def submit(self, value: str, explanation: str, kind: str = "", room_id: str | None = None,
               item_id: str | None = None, route_ref: int | None = None) -> dict:
        """Validate and record the final answer; raises MapError on ids that don't exist."""
        if not str(value).strip():
            raise MapError("value is empty: give the text that follows 'Answer:'.")
        if room_id and room_id not in self.bm.spaces:
            raise MapError(f"room_id '{room_id}' is not a space id.")
        if item_id and item_id not in self.bm.assets:
            raise MapError(f"item_id '{item_id}' is not an asset id.")
        if route_ref is not None and not 0 <= route_ref < len(self.routes):
            raise MapError(f"route_ref {route_ref} doesn't exist; use the route_ref the route tool returned.")
        entry = {"kind": kind or None}
        if route_ref is not None:
            entry.update(self.routes[route_ref])
        if room_id:
            entry["room_id"] = room_id
        if item_id:
            entry["item_id"] = item_id
        value = str(value).strip().removeprefix("Answer:").strip()
        entry["answer"] = f"{explanation.strip()}\nAnswer: {value}"
        self.submission = entry
        return {"recorded": True}


# ------------------------------------------------------------------------------------------ calculate

OPERATORS = {ast.Add: operator.add, ast.Sub: operator.sub, ast.Mult: operator.mul, ast.Div: operator.truediv,
             ast.Pow: operator.pow, ast.USub: operator.neg, ast.UAdd: operator.pos}
FUNCTIONS = {"sqrt": math.sqrt, "hypot": math.hypot, "abs": abs, "round": round, "min": min, "max": max, "sum": sum}


def evaluate_expression(expression: str) -> float:
    """Arithmetic only: numbers, + - * / **, parentheses, lists and the FUNCTIONS above."""

    def evaluate(node):
        if isinstance(node, ast.Constant) and isinstance(node.value, int | float):
            return node.value
        if isinstance(node, ast.BinOp) and type(node.op) in OPERATORS:
            return OPERATORS[type(node.op)](evaluate(node.left), evaluate(node.right))
        if isinstance(node, ast.UnaryOp) and type(node.op) in OPERATORS:
            return OPERATORS[type(node.op)](evaluate(node.operand))
        if isinstance(node, ast.List | ast.Tuple):
            return [evaluate(item) for item in node.elts]
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id in FUNCTIONS:
            return FUNCTIONS[node.func.id](*(evaluate(arg) for arg in node.args))
        raise ValueError(f"unsupported expression: {ast.unparse(node)}")

    return evaluate(ast.parse(expression, mode="eval").body)


# ------------------------------------------------------------------------------------ tool definitions


def as_json(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, default=str)


def make_tools(tools: BenchmarkTools) -> list:
    """Tools bound to one question (`@beta_tool` gives each its schema and `.call`). MapErrors become ToolErrors."""

    def guarded(function, *args, **kwargs) -> str:
        try:
            with MAP_LOCK:
                return as_json(function(*args, **kwargs))
        except (MapError, ValueError, KeyError, TypeError, ZeroDivisionError, SyntaxError) as error:
            raise ToolError(str(error)) from error

    @beta_tool
    def find(query: str, floor_level: int | None = None) -> str:
        """Find spaces, assets and stairs/lifts by name, room number, type or id. Returns ids to use with
        the other tools, ranked by how many query words match.

        Args:
            query: Words to look for, e.g. "0.21", "kitchen 1.14", "cnc mill", "lift 1", "aisle 4".
            floor_level: Only this floor (0 = ground floor, -1 = first basement). Omit for all floors.
        """
        return guarded(tools.find, query, floor_level)

    @beta_tool
    def list_spaces(floor_level: int | None = None, room_type: str | None = None, space_type: str | None = None,
                    name_contains: str | None = None) -> str:
        """List spaces matching all given filters, largest area first, with the count and total area. Use for
        counting rooms, the largest/smallest room of a type and summed floor areas.

        Args:
            floor_level: Floor level (0 = ground floor). Omit for the whole building.
            room_type: Exact room type from the overview, e.g. "office", "meeting_room", "toilet".
            space_type: room, corridor, hall, stair, lift or outdoor.
            name_contains: Case-insensitive part of the name, e.g. "aisle".
        """
        return guarded(tools.list_spaces, floor_level, room_type, space_type, name_contains)

    @beta_tool
    def list_assets(asset_type: str | None = None, floor_level: int | None = None, space_id: str | None = None,
                    name_contains: str | None = None) -> str:
        """List assets (furniture, fixtures, machines, equipment) matching all given filters, with the count
        and the room each one is in.

        Args:
            asset_type: Exact asset type from the overview, e.g. "cnc_mill", "chair", "stove".
            floor_level: Floor level (0 = ground floor). Omit for the whole building.
            space_id: Only assets in this space.
            name_contains: Case-insensitive part of the asset name.
        """
        return guarded(tools.list_assets, asset_type, floor_level, space_id, name_contains)

    @beta_tool
    def space_details(space_id: str) -> str:
        """Everything about one space: type, floor, area, centroid (x, y, elevation), its doors and openings
        (ids, widths, step-free, where they lead), stairs/lifts stopping there, asset types inside, the spaces
        directly above and below (by outline overlap) and the rooms sharing a wall with it.

        Args:
            space_id: A space id (or an asset id, meaning the space it stands in).
        """
        return guarded(tools.space_details, space_id)

    @beta_tool
    def route(stops: list[list[str]], step_free: bool = False, closed: list[str] | None = None,
              forklift: bool = False, min_width_m: float | None = None) -> str:
        """Best route under the judges' rules through the stops in order. Each stop is a list of candidate
        space or asset ids; a leg ends at its nearest candidate, which starts the next leg. Returns route_ref,
        the length in metres, legs, spaces passed and directions, or reachable=false when no route exists.

        Args:
            stops: Stops in visiting order, at least two, e.g. [["<start id>"], ["<id>", "<id>"]].
            step_free: No stairs or steps (wheelchair, pram, trolley, "without stairs").
            closed: Stair/lift, opening or space ids that are closed or blocked.
            forklift: Route a forklift (openings of at least 3 m, no stairs or lifts, no driving through bays).
            min_width_m: Width of a load every door must fit (implies step-free).
        """
        return guarded(tools.route, stops, step_free, closed, forklift, min_width_m)

    @beta_tool
    def reachable_rooms(start: str, floor_level: int | None = None, step_free: bool = False,
                        min_width_m: float | None = None, closed: list[str] | None = None) -> str:
        """Count the rooms (spaces of type "room") reachable from a start space under constraints, on one
        floor or the whole building.

        Args:
            start: Start space id, e.g. the room an entrance leads into.
            floor_level: Count only this floor. Omit for the whole building.
            step_free: No stairs or steps (lifts are fine).
            min_width_m: Every door passed must be at least this wide (implies step-free).
            closed: Stair/lift, opening or space ids that are closed or out of service.
        """
        return guarded(tools.reachable_rooms, start, floor_level, step_free, min_width_m, closed)

    @beta_tool
    def what_if_door(first_space: str, second_space: str, floor_level: int) -> str:
        """Add a hypothetical door in the middle of the wall two spaces share, and count the rooms on a floor
        whose walk to their nearest entrance gets more than 1 m shorter. The building is unchanged afterwards.

        Args:
            first_space: Space id on one side of the new door.
            second_space: Space id on the other side.
            floor_level: The floor whose rooms are counted.
        """
        return guarded(tools.what_if_door, first_space, second_space, floor_level)

    @beta_tool
    def straight_line_distance(first_space: str, second_space: str) -> str:
        """3D straight-line distance in metres between two room centres (polygon centroid at floor elevation).

        Args:
            first_space: Space id.
            second_space: Space id.
        """
        return guarded(tools.straight_line_distance, first_space, second_space)

    @beta_tool
    def calculate(expression: str) -> str:
        """Evaluate arithmetic exactly: + - * / **, parentheses, sqrt, hypot, abs, round, min, max, sum([...]).

        Args:
            expression: e.g. "12.5 + 30.25 + 8" or "sum([28.0, 31.5])".
        """
        return guarded(evaluate_expression, expression)

    @beta_tool
    def submit_answer(value: str, explanation: str, kind: str = "", room_id: str | None = None,
                      item_id: str | None = None, route_ref: int | None = None) -> str:
        """Commit the final answer. Call exactly once, at the end.

        Args:
            value: The text after "Answer:", in the question's template (a bare number for number answers).
            explanation: Two or three sentences on how the answer was found, with any assumption.
            kind: One word for the question type, e.g. locate, count, route, tour, largest_room, errand.
            room_id: Space id of the room the answer is about (located room, destination, largest room).
            item_id: Asset id of the item the answer is about, if any.
            route_ref: route_ref of the route the answer is based on, if any.
        """
        return guarded(tools.submit, value, explanation, kind, room_id, item_id, route_ref)

    return [find, list_spaces, list_assets, space_details, route, reachable_rooms, what_if_door,
            straight_line_distance, calculate, submit_answer]


# ------------------------------------------------------------------------------------------ the agent


@lru_cache(maxsize=64)
def load_map(building_directory: str) -> BuildingMap:
    return BuildingMap.load(Path(building_directory))


@lru_cache(maxsize=64)
def system_prompt(building_directory: str) -> str:
    overview = BenchmarkTools(load_map(building_directory)).overview()
    return SYSTEM_PROMPT.format(overview=json.dumps(overview, ensure_ascii=False))


@lru_cache(maxsize=1)
def client() -> anthropic.Anthropic:
    return anthropic.Anthropic(max_retries=6)


def answer_entry(building_directory: Path, question_text: str) -> dict:
    """Run the agent on one question. Returns the reply (`answer`, ending in an 'Answer:' line) with the
    kind, room/item ids, the chosen route's fields, the tool trace and token usage."""
    directory = str(Path(building_directory).resolve())
    tools = BenchmarkTools(load_map(directory))
    tool_list = make_tools(tools)
    by_name = {tool.name: tool for tool in tool_list}
    messages: list[dict] = [{"role": "user", "content": question_text}]
    trace, usage, final = [], Counter(), None
    # A plain tool loop rather than the SDK's beta tool_runner, which sometimes ended a turn without running
    # the requested tool. Here a turn without tool calls gets one nudge to submit.
    for _ in range(MAX_TURNS):
        final = client().beta.messages.create(
            model=MODEL,
            max_tokens=MAX_TOKENS,
            system=[{"type": "text", "text": system_prompt(directory), "cache_control": {"type": "ephemeral"}}],
            tools=[tool.to_dict() for tool in tool_list],
            messages=messages,
            cache_control={"type": "ephemeral"},
            output_config={"effort": EFFORT},
            betas=[FALLBACK_BETA],
            fallbacks="default",
        )
        usage.update({"input_tokens": final.usage.input_tokens, "output_tokens": final.usage.output_tokens,
                      "cache_read_input_tokens": final.usage.cache_read_input_tokens or 0,
                      "cache_creation_input_tokens": final.usage.cache_creation_input_tokens or 0})
        messages.append({"role": "assistant", "content": final.content})
        if final.stop_reason == "refusal":
            break
        calls = [block for block in final.content if block.type == "tool_use"]
        if not calls:
            messages.append({"role": "user", "content": "Call submit_answer with your final answer now."})
            continue
        results = []
        for call in calls:
            trace.append({"tool": call.name, "input": call.input})
            try:
                content, is_error = by_name[call.name].call(call.input), False
            except Exception as error:  # noqa: BLE001 - ToolError, bad arguments, unknown tool: Claude sees it
                content, is_error = f"Error: {error}", True
            results.append({"type": "tool_result", "tool_use_id": call.id, "content": content, "is_error": is_error})
        if tools.submission is not None:
            return {**tools.submission, "trace": trace, "usage": dict(usage)}
        messages.append({"role": "user", "content": results})
    text = "\n".join(block.text for block in (final.content if final else []) if block.type == "text").strip()
    error = f"the agent stopped without submitting an answer (stop reason: {final.stop_reason if final else None})"
    return {"kind": None, "error": error, "answer": f"{text}\nI could not finish this question.\nAnswer: unknown",
            "trace": trace, "usage": dict(usage)}


def answer(building_directory: Path, question_text: str) -> str:
    return answer_entry(building_directory, question_text)["answer"]


if __name__ == "__main__":
    import sys

    from dotenv import load_dotenv

    load_dotenv()
    entry = answer_entry(Path(sys.argv[1]), " ".join(sys.argv[2:]))
    print(json.dumps({key: entry[key] for key in entry if key != "usage"}, indent=1, ensure_ascii=False))
