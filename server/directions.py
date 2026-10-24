"""Followable, landmark-based directions for a route: "Turn left at the CNC mill into Main aisle H-B2".

Built from the route's node path (space, door:<id>, space, ..., with connectors as space→space edges).
Distances use the route model's edge weights, so the per-step metres add up to the route length."""

from __future__ import annotations

import itertools
import math

from starter_agent.building_map import DOOR_PREFIX, LIFT, OUTSIDE

LANDMARK_RADIUS_M = 7.0
# Things people notice and can name when walking past. Ordered by how good a landmark they make.
LANDMARK_PRIORITY = {
    "machine": 0,
    "equipment": 1,
    "fixture": 2,
}
LOW_PRIORITY_TYPES = {"fire_extinguisher", "plant", "whiteboard"}
BORING_TYPES = {
    "chair", "office_chair", "dining_chair", "outdoor_chair", "desk", "plant", "filing_cabinet",
    "bookshelf", "shelf", "locker", "toilet", "sink", "hand_dryer", "bench", "armchair", "sofa",
    "lecture_seating_row", "shoe_cabinet", "wardrobe", "bed", "nightstand", "lab_bench", "table",
    "dining_table", "coffee_table", "tv_stand", "server_rack", "pallet_rack", "ups_unit",
}
NICE_NAMES = {"cnc": "CNC", "3d": "3D", "ups": "UPS"}


def asset_label(asset: dict) -> str:
    words = asset["type"].split("_")
    text = " ".join(NICE_NAMES.get(word, word) for word in words)
    return f"the {text}"


def nearest_landmark(bm, floor_id: str, point, exclude_space: set[str] | None = None) -> dict | None:
    best, best_key = None, None
    for asset in bm.assets.values():
        if asset["floor_id"] != floor_id or asset["type"] in BORING_TYPES:
            continue
        priority = 4 if asset["type"] in LOW_PRIORITY_TYPES else LANDMARK_PRIORITY.get(asset.get("category"), 3)
        distance = math.dist(asset["position"], point)
        if distance > LANDMARK_RADIUS_M:
            continue
        key = (priority, distance)
        if best_key is None or key < best_key:
            best, best_key = asset, key
    return best


def turn_word(incoming, outgoing) -> str:
    """'left' / 'right' / 'straight' from two 2D direction vectors (x right, y up)."""
    if math.hypot(*incoming) < 1e-6 or math.hypot(*outgoing) < 1e-6:
        return "straight"
    angle = math.degrees(math.atan2(outgoing[1], outgoing[0]) - math.atan2(incoming[1], incoming[0]))
    angle = (angle + 180) % 360 - 180
    if abs(angle) < 35:
        return "straight"
    if abs(angle) > 150:
        return "back"
    return "left" if angle > 0 else "right"


def _edge(graph, first: str, second: str) -> dict:
    return min(graph[first][second].values(), key=lambda candidate: candidate["weight"])


def landmark_steps(bm, route) -> list[str]:
    """Directions with turns and landmarks. Falls back to the route's own steps on any surprise."""
    nodes = list(getattr(route, "nodes", None) or [])
    graph = getattr(route, "graph", None)
    if len(nodes) < 2 or graph is None:
        return list(route.steps)
    try:
        return _landmark_steps(bm, nodes, graph, route)
    except Exception:  # noqa: BLE001 - directions must never break routing
        return list(route.steps)


def _point(bm, node: str):
    if node.startswith(DOOR_PREFIX):
        return bm.openings[node[len(DOOR_PREFIX):]]["position"]
    return bm.anchor(node) if node in bm.spaces else None


def _floor(bm, node: str) -> str | None:
    if node.startswith(DOOR_PREFIX):
        return bm.openings[node[len(DOOR_PREFIX):]]["floor_id"]
    return bm.spaces[node]["floor_id"] if node in bm.spaces else None


def _landmark_steps(bm, nodes: list[str], graph, route) -> list[str]:
    start = nodes[0]
    steps = [f"Start in {bm.spaces[start]['name']} ({bm.floor_name(bm.spaces[start]['floor_id'])})."]
    walked = 0.0
    straight_m, straight_through = 0.0, []  # pending straight-on segments, flushed before a turn
    last_point = _point(bm, start)

    def flush() -> None:
        nonlocal straight_m, straight_through
        if straight_through:
            names = straight_through if len(straight_through) <= 3 else straight_through[:1] + ["…"] + straight_through[-1:]
            steps.append(f"Go straight on for about {straight_m:.0f} m through {', '.join(names)}.")
        straight_m, straight_through = 0.0, []

    for index, (previous, current) in enumerate(itertools.pairwise(nodes)):
        edge = _edge(graph, previous, current)
        walked += edge["weight"]
        via = edge["via"]
        if via in bm.connectors and previous in bm.spaces and current in bm.spaces:
            flush()
            connector = bm.connectors[via]
            to_floor = bm.spaces[current]["floor_id"]
            up = bm.floors[to_floor]["level"] > bm.floors[bm.spaces[previous]["floor_id"]]["level"]
            if connector["kind"] == LIFT:
                steps.append(f"Take {connector['name']} {'up' if up else 'down'} to {bm.floor_name(to_floor)}.")
            else:
                steps.append(f"{'Climb' if up else 'Go down'} {connector['name']} to {bm.floor_name(to_floor)}.")
            walked, last_point = 0.0, _point(bm, current)
            continue
        if current == OUTSIDE or previous == OUTSIDE:
            if current == OUTSIDE:
                flush()
                steps.append(f"Walk about {walked:.0f} m and step outside through the entrance.")
                walked = 0.0
            last_point = None
            continue
        if current.startswith(DOOR_PREFIX):
            if previous.startswith(DOOR_PREFIX) and via == OUTSIDE:
                flush()
                walked -= edge["weight"]
                steps.append(f"Walk about {walked:.0f} m and leave the building through the entrance.")
                steps.append(f"Walk about {edge['weight']:.0f} m outside to the next entrance.")
                walked, last_point = 0.0, None
            continue
        # Arrived in space `current` through the door `previous`.
        door_point = _point(bm, previous)
        is_last = current == nodes[-1]
        next_point = _point(bm, nodes[index + 2]) if index + 2 < len(nodes) else _point(bm, current)
        outgoing = (next_point[0] - door_point[0], next_point[1] - door_point[1])
        turn = "straight"
        if last_point is not None:
            turn = turn_word((door_point[0] - last_point[0], door_point[1] - last_point[1]), outgoing)
        opening = bm.openings[previous[len(DOOR_PREFIX):]]
        target = bm.spaces[current]["name"]
        if turn == "straight" and not is_last:
            straight_m += walked
            straight_through.append(target)
        else:
            flush()
            landmark = nearest_landmark(bm, opening["floor_id"], door_point)
            at = f" at {asset_label(landmark)}" if landmark else ""
            passage = {"door": "through the door", "entrance": "in through the entrance"}.get(
                opening.get("kind"), "through the opening")
            distance = f"about {walked:.0f} m" if walked >= 1 else "a few steps"
            if is_last:
                past = f", past {asset_label(landmark)}" if landmark else ""
                steps.append(f"Walk {distance} {passage} into {target}{past}.")
            elif turn == "back":
                steps.append(f"Walk {distance} {passage} into {target}, then turn around{at}.")
            else:
                steps.append(f"Walk {distance} {passage} into {target}, then turn {turn}{at}.")
        walked = 0.0
        last_point = door_point
    flush()
    end = nodes[-1]
    if end in bm.spaces:
        steps.append(f"You have arrived at {bm.spaces[end]['name']} ({bm.floor_name(bm.spaces[end]['floor_id'])}).")
    return steps
