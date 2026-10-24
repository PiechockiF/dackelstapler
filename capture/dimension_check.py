"""Cross-check a measured delivery against the PO and the building: declared dims, route fit, floor fit.

Route fit: from the receiving space (the dock / goods-in zone nearest an entrance) to the target space,
for a load of width min(W, D): step-free, no opening narrower than the load. When the shortest step-free
route has narrow doors, they are returned as blocking_openings and the shortest route that does fit (if
any) as the alternative.
"""

from __future__ import annotations

import math
import re
from types import SimpleNamespace

from shapely.geometry import Point

from core.building_map import DOOR_PREFIX, OUTSIDE, MapError
from core.geometry import footprint_fits

RECEIVING_TYPES = ("logistics_zone", "warehouse_zone")
RECEIVING_WORDS = re.compile(r"dock|loading|goods|wareneingang|receiving|logistic|warehouse|lager", re.I)
DOOR_CLEARANCE_M = 0.0          # a load passes a door at least as wide as itself (core uses the same rule)
PLACEMENT_CLEARANCE_M = 0.15


# ---------------------------------------------------------------- naming


def space_label(bm, space_id: str) -> str:
    return bm.spaces[space_id].get("name") or space_id


def opening_label(bm, opening: dict) -> str:
    """'door 0.21', 'entrance of Main aisle H-B5', 'opening Main aisle H-B1 / Production zone H-A1'."""
    kind = opening.get("kind", "door")
    spaces = [bm.spaces[s] for s in opening["space_ids"] if s in bm.spaces]
    if OUTSIDE in opening["space_ids"] or kind == "entrance":
        return f"entrance of {spaces[0]['name']}" if spaces else "entrance"
    rooms = [s for s in spaces if s.get("type") == "room" and s.get("ref")]
    if kind == "door" and rooms:
        return f"door {rooms[0]['ref']}"
    named = " / ".join(s.get("name", s["id"]) for s in spaces)
    return f"{kind} {named}".strip()


def _blocking_json(bm, opening: dict) -> dict:
    return {
        "id": opening["id"], "width_m": float(opening.get("width_m") or 0.0),
        "position": [float(opening["position"][0]), float(opening["position"][1])],
        "floor_id": opening["floor_id"], "label": opening_label(bm, opening),
    }


# ---------------------------------------------------------------- receiving space


def _entrance_spaces(bm) -> list[tuple[str, dict]]:
    pairs = []
    for opening in bm.openings.values():
        if opening["id"] in bm.closed or OUTSIDE not in opening["space_ids"]:
            continue
        for space_id in opening["space_ids"]:
            if space_id in bm.spaces and space_id not in bm.closed:
                pairs.append((space_id, opening))
    return pairs


def receiving_space(bm) -> dict:
    """{"space_id", "entrance_space_id", "entrance_opening_id", "reason"} — where deliveries arrive."""
    entrances = _entrance_spaces(bm)
    levels = {floor_id: floor["level"] for floor_id, floor in bm.floors.items()}

    def dock_rank(space: dict) -> int | None:
        if space.get("room_type") == "logistics_zone" or re.search(r"dock|loading|goods|wareneingang|receiving", space.get("name", ""), re.I):
            return 0
        if space.get("room_type") == "warehouse_zone" or RECEIVING_WORDS.search(space.get("name", "")):
            return 1
        return None

    docks = [(rank, space) for space in bm.spaces.values() if space["id"] not in bm.closed
             for rank in [dock_rank(space)] if rank is not None]
    if entrances and docks:
        best = None
        for rank, dock in docks:
            polygon = bm.polygons[dock["id"]] if hasattr(bm, "polygons") else None
            for entrance_space, opening in entrances:
                if bm.spaces[entrance_space]["floor_id"] != dock["floor_id"]:
                    continue
                distance = polygon.distance(Point(opening["position"])) if polygon is not None else 0.0
                key = (rank, round(distance, 1), -float(opening.get("width_m") or 0))
                if best is None or key < best[0]:
                    best = (key, dock, entrance_space, opening)
        if best is not None:
            _, dock, entrance_space, opening = best
            return {"space_id": dock["id"], "entrance_space_id": entrance_space, "entrance_opening_id": opening["id"],
                    "reason": f"{dock['name']} (nearest goods-in zone to the {opening_label(bm, opening)})"}
    if entrances:
        entrance_space, opening = max(
            entrances,
            key=lambda pair: (pair[1].get("step_free", True), float(pair[1].get("width_m") or 0),
                              -abs(levels.get(bm.spaces[pair[0]]["floor_id"], 0))),
        )
        return {"space_id": entrance_space, "entrance_space_id": entrance_space, "entrance_opening_id": opening["id"],
                "reason": f"{space_label(bm, entrance_space)} (widest step-free entrance)"}
    ground = min(bm.spaces.values(), key=lambda s: (abs(levels.get(s["floor_id"], 0)), -bm.room_area(s["id"])))
    return {"space_id": ground["id"], "entrance_space_id": ground["id"], "entrance_opening_id": None,
            "reason": f"{ground['name']} (no entrance in the data; largest ground-floor space)"}


# ---------------------------------------------------------------- route fit


def _narrow_openings(bm, route, width: float) -> list[dict]:
    blocking = []
    for node in route.nodes:
        if node.startswith(DOOR_PREFIX):
            opening = bm.openings[node[len(DOOR_PREFIX):]]
            if float(opening.get("width_m") or 0.0) < width + DOOR_CLEARANCE_M - 1e-6:
                blocking.append(_blocking_json(bm, opening))
    return blocking


def _first_new_space(bm, alternative, direct) -> str | None:
    direct_spaces = set(direct.space_path) if direct is not None else set()
    new = [s for s in alternative.space_path[1:-1] if s not in direct_spaces]
    if new:
        gates = [s for s in new if bm.spaces[s].get("room_type") == "lobby"
                 or re.search(r"gate|tor|access|lobby|foyer", bm.spaces[s].get("name", ""), re.I)]
        return space_label(bm, (gates or new)[-1])
    for node in alternative.nodes:
        if node.startswith(DOOR_PREFIX) and node not in (direct.nodes if direct is not None else []):
            return opening_label(bm, bm.openings[node[len(DOOR_PREFIX):]])
    return None


def route_fit(bm, start: str, target: str, width: float) -> dict:
    """Contract route_fit + internal keys (_alt_via, _direct_len)."""
    direct = None
    try:
        direct = bm.find_route(start, target, step_free=True)
    except MapError:
        direct = None
    if direct is None:
        try:  # no step-free route at all: show the unconstrained one so the steps/stairs are visible
            direct = bm.find_route(start, target)
        except MapError:
            direct = None
    blocking = _narrow_openings(bm, direct, width) if direct is not None else []
    if direct is not None and not direct.step_free:
        for element in bm.element_path(direct) if hasattr(bm, "element_path") else []:
            item = bm.openings.get(element) or bm.connectors.get(element)
            if item is not None and not item.get("step_free", True) and element in bm.openings:
                blocking.append(_blocking_json(bm, item) | {"reason": "steps"})
    if direct is not None and not blocking and direct.step_free:
        payload = bm.route_payload(direct, blocking=[])
        payload["min_width_m"] = round(width, 3)
        return {"ok": True, "route": payload, "blocking_openings": [], "_direct_len": direct.length_m}

    alternative = None
    try:
        alternative = bm.find_route(start, target, min_width_m=width + DOOR_CLEARANCE_M)
    except MapError:
        alternative = None
    result = {
        "ok": False,
        "route": bm.route_payload(direct, blocking=blocking) if direct is not None else None,
        "blocking_openings": blocking,
        "_direct_len": direct.length_m if direct is not None else None,
    }
    if alternative is not None:
        result["alternative"] = bm.route_payload(alternative, blocking=[])
        result["_alt_via"] = _first_new_space(bm, alternative, direct)
        result["_alt_len"] = alternative.length_m
    return result


# ---------------------------------------------------------------- floor fit / placement


def _obstacle_view(bm, deliveries: list[dict]):
    """bm-like view whose assets also include earlier deliveries (so new ones don't stack on them)."""
    assets = dict(bm.assets)
    for delivery in deliveries:
        dims = delivery.get("dims_m") or {}
        if not delivery.get("space_id") or not dims:
            continue
        assets[f"delivery:{delivery['id']}"] = {
            "id": f"delivery:{delivery['id']}", "space_id": delivery["space_id"], "position": delivery["position"],
            "footprint": {"width_m": dims["w"], "depth_m": dims["d"], "rotation_deg": delivery.get("rotation_deg", 0)},
        }
    return SimpleNamespace(assets=assets, polygons=bm.polygons, spaces=bm.spaces)


def floor_fit(bm, space_id: str, w: float, d: float, deliveries: list[dict]) -> dict:
    view = _obstacle_view(bm, deliveries)
    result = footprint_fits(view, space_id, w, d, clearance_m=PLACEMENT_CLEARANCE_M)
    if not result["ok"]:
        tight = footprint_fits(view, space_id, w, d)
        if tight["ok"]:
            tight["reason"] = tight["reason"] + " (tight: under 15 cm clearance)"
            return tight
    return result


# ---------------------------------------------------------------- declared


def declared_check(measured: dict, tolerance: float, declared: dict | None) -> dict | None:
    if not declared or not all(declared.get(k) for k in ("w", "d", "h")):
        return None
    m_w, m_d = sorted((measured["w"], measured["d"]), reverse=True)
    d_w, d_d = sorted((float(declared["w"]), float(declared["d"])), reverse=True)
    deviation = {"w": round(m_w - d_w, 3), "d": round(m_d - d_d, 3), "h": round(measured["h"] - float(declared["h"]), 3)}
    reference = {"w": d_w, "d": d_d, "h": float(declared["h"])}
    ok = all(abs(deviation[k]) <= tolerance + max(0.03, 0.03 * reference[k]) for k in deviation)
    return {"ok": ok, "deviation_m": deviation}


# ---------------------------------------------------------------- summary


def _fmt(value: float) -> str:
    return f"{value:.2f}"


def summarize(dims: dict, tolerance: float, declared: dict | None, declared_dims: dict | None,
              fit: dict | None, floor: dict | None, target: str | None, bm, placed_in: str) -> str:
    size = f"{_fmt(dims['w'])} × {_fmt(dims['d'])} × {_fmt(dims['h'])} m"
    parts = [f"{size} (±{round(tolerance * 100):.0f} cm)." if tolerance else f"{size}."]
    if declared is not None:
        if declared["ok"]:
            parts.append(f"Matches PO ({_fmt(max(declared_dims['w'], declared_dims['d']))} × "
                         f"{_fmt(min(declared_dims['w'], declared_dims['d']))} × {_fmt(declared_dims['h'])}).")
        else:
            worst = max(declared["deviation_m"], key=lambda k: abs(declared["deviation_m"][k]))
            value = declared["deviation_m"][worst]
            parts.append(f"⚠ Differs from PO: {'+' if value > 0 else ''}{value * 100:.0f} cm in {'WDH'['wdh'.index(worst)]}.")
    if fit is not None and target:
        target_name = space_label(bm, target)
        if fit["ok"]:
            length = fit["route"]["length_m"] if fit.get("route") else None
            parts.append(f"Fits every door to {target_name}" + (f", {length:.0f} m." if length else "."))
        else:
            blocking = fit["blocking_openings"]
            if blocking:
                first = blocking[0]
                door = f"{first['label']} ({first['width_m']:.2f} m)" if first.get("reason") != "steps" else f"steps at {first['label']}"
                more = f" +{len(blocking) - 1} more" if len(blocking) > 1 else ""
                lead = f"⚠ Won't pass {door}{more} to {target_name}"
            else:
                lead = f"⚠ No step-free route to {target_name}"
            if fit.get("alternative"):
                via = fit.get("_alt_via")
                parts.append(f"{lead} — alternative{' via ' + via if via else ''}, {fit['_alt_len']:.0f} m.")
            else:
                parts.append(f"{lead} — no route wide enough.")
    if floor is not None and not floor["ok"]:
        parts.append(f"⚠ {floor['reason']}")
    if not target:
        parts.append(f"Placed in {space_label(bm, placed_in)}.")
    return " ".join(parts)


# ---------------------------------------------------------------- main entry


def check_delivery(bm, dims: dict, tolerance: float, declared_dims: dict | None = None,
                   target_space: str | None = None, existing_deliveries: list[dict] | None = None,
                   at_space: str | None = None) -> dict:
    """Returns {"check": DimensionCheck, "status", "space_id", "floor_id", "position", "rotation_deg", "receiving"}.

    at_space: where the item already stands (logged by hand). The route check to target_space starts there
    instead of at the dock, and the item is placed there."""
    existing = existing_deliveries or []
    w, d = max(dims["w"], dims["d"]), min(dims["w"], dims["d"])
    load_width = d  # the narrow side goes through the door first
    receiving = receiving_space(bm)
    target = bm.resolve_space(target_space) if target_space else None
    start = bm.resolve_space(at_space) if at_space else receiving["space_id"]

    declared = declared_check(dims, tolerance, declared_dims)
    fit = route_fit(bm, start, target, load_width) if target and target != start else None
    if fit is None and target == start:
        fit = {"ok": True, "route": None, "blocking_openings": []}
    floor_target = target or start
    floor = floor_fit(bm, floor_target, w, d, existing)

    blocked = (fit is not None and not fit["ok"] and not fit.get("alternative")) or not floor["ok"]
    status = "blocked" if blocked else ("mismatch" if declared is not None and not declared["ok"] else "ok")

    # Place it: in the target when it can actually get there through the direct route and fits,
    # otherwise at the dock (where it waits for the alternative route / a decision).
    # An item logged where it already stands stays there.
    if at_space:
        placed_in = start
    else:
        placed_in = target if (target and fit is not None and fit["ok"] and floor["ok"]) else start
    placement = floor if placed_in == floor_target and floor["ok"] else floor_fit(bm, placed_in, w, d, existing)
    if placement["ok"]:
        position, rotation = placement["position"], placement["rotation_deg"]
    else:
        point = bm.polygons[placed_in].representative_point()
        position, rotation = [round(point.x, 3), round(point.y, 3)], 0.0

    summary = summarize(dims, tolerance, declared, declared_dims, fit, floor if target else (None if floor["ok"] else floor),
                        target, bm, placed_in)
    public_fit = None
    if fit is not None:
        public_fit = {k: v for k, v in fit.items() if not k.startswith("_")}
        public_fit.setdefault("blocking_openings", [])
        if public_fit.get("route") is None:
            public_fit.pop("route", None)
    check = {
        "declared": declared,
        "route_fit": public_fit,
        "floor_fit": {"ok": floor["ok"], "reason": floor["reason"]},
        "summary": summary,
    }
    return {
        "check": check, "status": status, "space_id": placed_in, "floor_id": bm.spaces[placed_in]["floor_id"],
        "position": position, "rotation_deg": rotation, "receiving": receiving, "target_space_id": target,
    }


def describe_dims(dims: dict) -> str:
    return " × ".join(_fmt(dims[k]) for k in ("w", "d", "h")) + " m"


def footprint_area(dims: dict) -> float:
    return math.prod((dims["w"], dims["d"]))
