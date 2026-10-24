"""Benchmark entry point: `answer(building_directory, question_text) -> reply`.

  uv run python -m benchmark.evaluate data/dev --agent agent.answer:answer

Pipeline: (1) a template parser turns the question text into a kind plus resolved ids (room names,
floors, asset and room types are resolved against the building), (2) the deterministic solver for that
kind in core.solvers computes the answer, (3) the reply explains it briefly and ends with a single
`Answer: ...` line in the format benchmark/score.py expects. If the templates don't match and
ANTHROPIC_API_KEY is set, claude-haiku-5-5 extracts the same structured parameters as JSON."""

from __future__ import annotations

import difflib
import json
import os
import re
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path

from core import solvers
from core.building_map import BuildingMap, MapError

PARSER_MODEL = "claude-haiku-5-5"

FLOOR_NAME = r"(?:Ground floor|Floor -?\d+|Basement \d+|[^()]{1,40})"
PLACE = rf"(?P<{{name}}>.+?) \((?P<{{name}}_floor>{FLOOR_NAME})\)"


def place(name: str) -> str:
    return PLACE.replace("{name}", name)


TEMPLATES: list[tuple[str, re.Pattern]] = [
    (
        "largest_room",
        re.compile(r"largest (?P<room_type>.+?) on (?:the )?(?P<floor>.+?), and how big is it", re.I | re.S),
    ),
    (
        "floor_area_total",
        re.compile(r"total floor area of every (?P<room_type>.+?) on (?:the )?(?P<floor>.+?) added together", re.I | re.S),
    ),
    (
        "errand",
        re.compile(
            rf"I'?m in {place('start')}\. I need to grab (?:an? |some |the )?(?P<asset_type>.+?) from the room "
            r"that has one closest to me, then carry it to the largest (?P<room_type>.+?) on (?:the )?"
            r"(?P<floor>.+?)\.",
            re.I | re.S,
        ),
    ),
    (
        "wide_delivery_count",
        re.compile(
            r"moving an? (?P<width>\d+(?:\.\d+)?) ?m wide (?P<item>.+?)\..*?at least "
            r"(?P<min_width>\d+(?:\.\d+)?) ?m wide\. It arrives through the entrance into "
            rf"{place('start')}\. Into how many rooms on (?:the )?(?P<floor>.+?) can it be delivered",
            re.I | re.S,
        ),
    ),
    (
        "step_free_reachable_count",
        re.compile(
            r"(?P<closed>[^.]+?) is (?:out of service|closed)[^.]*\. A wheelchair user comes in through the "
            rf"entrance into {place('start')}\. How many rooms on (?:the )?(?P<floor>.+?) can they still reach",
            re.I | re.S,
        ),
    ),
    (
        "room_stacked_above",
        re.compile(rf"dripping from the ceiling in {place('start')}\. Which room is directly above", re.I | re.S),
    ),
    (
        "room_stacked_below",
        re.compile(rf"leaking onto the floor of {place('start')}\. Which room directly below", re.I | re.S),
    ),
    (
        "shared_walls_count",
        re.compile(rf"soundproofing {place('start')}\. How many other rooms", re.I | re.S),
    ),
    (
        "straight_line_3d",
        re.compile(
            r"between (?P<pair>.+?)\. What is the straight-line distance", re.I | re.S
        ),
    ),
    (
        "what_if_door",
        re.compile(
            r"add a door between (?P<pair>.+?), in the middle of the wall they share\? How many rooms on (?:the )?"
            r"(?P<floor>.+?) would then have a shorter walk",
            re.I | re.S,
        ),
    ),
]


class ParseError(ValueError):
    pass


@dataclass
class Parsed:
    kind: str
    params: dict = field(default_factory=dict)


# ---------- resolution against the building ----------


def normalise(text: str) -> str:
    return re.sub(r"\s+", " ", text.strip().strip(".,;:!?\"'").lower())


def resolve_floor(bm: BuildingMap, phrase: str) -> str:
    """'ground floor', 'floor 2', 'basement 1', 'Floor 2', a level number ... → floor id."""
    text = normalise(phrase)
    text = re.sub(r"^the ", "", text)
    for floor in bm.floors.values():
        if normalise(floor["name"]) == text or floor["id"].lower() == text:
            return floor["id"]
    level = None
    if re.fullmatch(r"(ground|ground floor|level 0|floor 0|0)", text):
        level = 0
    elif match := re.fullmatch(r"(?:floor|level|storey|story)?\s*(-?\d+)", text):
        level = int(match.group(1))
    elif match := re.fullmatch(r"(?:basement|underground|cellar)\s*(?:level\s*)?(\d+)?", text):
        level = -int(match.group(1) or 1)
    elif match := re.fullmatch(r"(\d+)(?:st|nd|rd|th) floor", text):
        level = int(match.group(1))
    if level is not None:
        floor = bm.floor_at_level(level)
        if floor is not None:
            return floor["id"]
    raise ParseError(f"unknown floor '{phrase}'")


def resolve_type(phrase: str, known: set[str]) -> str:
    text = normalise(phrase)
    candidates = [text.replace(" ", "_"), text.replace("-", "_").replace(" ", "_")]
    if text.endswith("s"):
        candidates += [text[:-1].replace(" ", "_"), text[:-2].replace(" ", "_") if text.endswith("es") else ""]
    for candidate in candidates:
        if candidate in known:
            return candidate
    lowered = {item.lower(): item for item in known}
    for candidate in candidates:
        if candidate in lowered:
            return lowered[candidate]
    close = difflib.get_close_matches(candidates[0], sorted(known), n=1, cutoff=0.75)
    if close:
        return close[0]
    raise ParseError(f"unknown type '{phrase}'")


def resolve_room(bm: BuildingMap, name: str, floor_phrase: str | None = None) -> str:
    """A room by its full name (or ref), preferring the given floor."""
    floor_id = None
    if floor_phrase:
        try:
            floor_id = resolve_floor(bm, floor_phrase)
        except ParseError:
            floor_id = None
    target = normalise(name)
    pools = []
    if floor_id is not None:
        pools.append([space for space in bm.spaces.values() if space["floor_id"] == floor_id])
    pools.append(list(bm.spaces.values()))
    for pool in pools:
        for key in ("name", "ref", "id"):
            matches = [space for space in pool if normalise(str(space.get(key) or "")) == target]
            if len(matches) == 1:
                return matches[0]["id"]
            if len(matches) > 1:
                # Duplicate names (OSM, e.g. several "Büro" rooms): the question generator's name lookup
                # keeps the last space in file order; this matches every ambiguous train/dev question.
                return matches[-1]["id"]
    # Name with the floor in parentheses still attached, e.g. "Office 0.12 (Ground floor)".
    match = re.fullmatch(rf"(.+) \(({FLOOR_NAME})\)", name.strip())
    if match and floor_phrase is None:
        return resolve_room(bm, match.group(1), match.group(2))
    names = {normalise(space["name"]): space["id"] for space in (pools[0] if pools else [])}
    close = difflib.get_close_matches(target, list(names), n=1, cutoff=0.9)
    if close:
        return names[close[0]]
    raise ParseError(f"unknown room '{name}'")


def resolve_pair(bm: BuildingMap, text: str) -> tuple[str, str]:
    """'A (Floor 1) and B (Floor 2)' where names may themselves contain ' and '."""
    pieces = text.split(" and ")
    errors = []
    for split in range(1, len(pieces)):
        first, second = " and ".join(pieces[:split]), " and ".join(pieces[split:])
        try:
            return resolve_room(bm, first), resolve_room(bm, second)
        except ParseError as error:
            errors.append(str(error))
    raise ParseError("; ".join(errors) or f"no pair in '{text}'")


def resolve_connector(bm: BuildingMap, phrase: str) -> set[str]:
    text = normalise(re.sub(r"^(?:the)\s+", "", phrase.strip(), flags=re.I))
    for collection in (bm.connectors, bm.openings, bm.spaces):
        exact = {key for key, item in collection.items() if normalise(str(item.get("name") or "")) == text}
        if exact:
            return exact
    if text in {key.lower() for key in bm.connectors}:
        return {key for key in bm.connectors if key.lower() == text}
    raise ParseError(f"unknown element '{phrase}'")


def parse(bm: BuildingMap, question: str) -> Parsed:
    room_types = {space["room_type"] for space in bm.spaces.values()}
    asset_types = {asset["type"] for asset in bm.assets.values()}
    text = re.sub(r"\s+", " ", question)
    for kind, pattern in TEMPLATES:
        match = pattern.search(text)
        if not match:
            continue
        groups = match.groupdict()
        if kind in ("largest_room", "floor_area_total"):
            return Parsed(
                kind,
                {
                    "floor_id": resolve_floor(bm, groups["floor"]),
                    "room_type": resolve_type(groups["room_type"], room_types),
                },
            )
        if kind == "errand":
            return Parsed(
                kind,
                {
                    "start": resolve_room(bm, groups["start"], groups["start_floor"]),
                    "asset_type": resolve_type(groups["asset_type"], asset_types),
                    "floor_id": resolve_floor(bm, groups["floor"]),
                    "room_type": resolve_type(groups["room_type"], room_types),
                },
            )
        if kind == "wide_delivery_count":
            return Parsed(
                kind,
                {
                    "start": resolve_room(bm, groups["start"], groups["start_floor"]),
                    "floor_id": resolve_floor(bm, groups["floor"]),
                    "min_width": float(groups["min_width"]),
                    "item": groups["item"],
                },
            )
        if kind == "step_free_reachable_count":
            return Parsed(
                kind,
                {
                    "closed": sorted(resolve_connector(bm, groups["closed"])),
                    "start": resolve_room(bm, groups["start"], groups["start_floor"]),
                    "floor_id": resolve_floor(bm, groups["floor"]),
                },
            )
        if kind.startswith("room_stacked"):
            return Parsed(
                "room_stacked",
                {
                    "start": resolve_room(bm, groups["start"], groups["start_floor"]),
                    "direction": "above" if kind.endswith("above") else "below",
                },
            )
        if kind == "shared_walls_count":
            return Parsed(kind, {"start": resolve_room(bm, groups["start"], groups["start_floor"])})
        if kind == "straight_line_3d":
            first, second = resolve_pair(bm, groups["pair"])
            return Parsed(kind, {"first": first, "second": second})
        if kind == "what_if_door":
            first, second = resolve_pair(bm, groups["pair"])
            return Parsed(
                kind, {"first": first, "second": second, "floor_id": resolve_floor(bm, groups["floor"])}
            )
    raise ParseError("no template matched")


# ---------- LLM fallback parser ----------

LLM_SCHEMA_HINT = """Return only a JSON object {"kind": ..., "params": {...}} for one of these kinds:
- largest_room: {"room_type", "floor"}           (largest room of a type on a floor, with its area)
- floor_area_total: {"room_type", "floor"}       (sum of the areas of all rooms of a type on a floor)
- errand: {"start", "asset_type", "room_type", "floor"}  (fetch the nearest asset, carry it to the largest room of a type on a floor; total walk)
- wide_delivery_count: {"start", "floor", "min_width"}   (rooms on a floor reachable step-free through doors >= min_width from start)
- step_free_reachable_count: {"start", "floor", "closed"} (rooms on a floor reachable step-free from start with element 'closed' closed)
- room_stacked: {"start", "direction": "above"|"below"}
- shared_walls_count: {"start"}
- straight_line_3d: {"first", "second"}
- what_if_door: {"first", "second", "floor"}      (rooms on 'floor' whose walk to the nearest entrance gets >1 m shorter after adding a door between first and second)
Room values ("start", "first", "second") are exact room names as written in the question, without the floor in parentheses; add "<key>_floor" with that floor text.
"floor" is the floor text such as "ground floor", "floor 2", "basement 1". Types are snake_case like "meeting_room", "coffee_table"."""


def llm_parse(bm: BuildingMap, question: str) -> Parsed:
    if not os.environ.get("ANTHROPIC_API_KEY"):
        raise ParseError("no template matched and no ANTHROPIC_API_KEY for the LLM parser")
    import anthropic

    room_types = sorted({space["room_type"] for space in bm.spaces.values()})
    asset_types = sorted({asset["type"] for asset in bm.assets.values()})
    client = anthropic.Anthropic()
    message = client.messages.create(
        model=PARSER_MODEL,
        max_tokens=4000,  # Haiku 5.5 thinks by default; leave room for it plus the JSON
        output_config={"effort": "low"},
        system=LLM_SCHEMA_HINT
        + f"\nRoom types in this building: {', '.join(room_types)}.\nAsset types: {', '.join(asset_types)}.",
        messages=[{"role": "user", "content": question}],
    )
    raw = "".join(block.text for block in message.content if getattr(block, "type", "") == "text")
    match = re.search(r"\{.*\}", raw, flags=re.S)
    if not match:
        raise ParseError("LLM parser returned no JSON")
    data = json.loads(match.group(0))
    kind, params = data["kind"], dict(data.get("params") or {})
    resolved: dict = {}
    for key in ("start", "first", "second"):
        if key in params:
            resolved[key] = resolve_room(bm, params[key], params.get(f"{key}_floor"))
    if "floor" in params:
        resolved["floor_id"] = resolve_floor(bm, str(params["floor"]))
    if "room_type" in params:
        resolved["room_type"] = resolve_type(params["room_type"], set(room_types))
    if "asset_type" in params:
        resolved["asset_type"] = resolve_type(params["asset_type"], set(asset_types))
    if "min_width" in params:
        resolved["min_width"] = float(params["min_width"])
    if "closed" in params:
        resolved["closed"] = sorted(resolve_connector(bm, str(params["closed"])))
    if "direction" in params:
        resolved["direction"] = "below" if "below" in str(params["direction"]).lower() else "above"
    return Parsed(kind, resolved)


# ---------- solving and wording ----------


def label(bm: BuildingMap, space_id: str) -> str:
    """Room name, plus its ref when the name doesn't already contain it."""
    space = bm.spaces[space_id]
    name, ref = space["name"], space.get("ref")
    if ref and ref not in name:
        return f"{name} ({ref})"
    return name


def number(value: float, digits: int = 2) -> str:
    return f"{value:.{digits}f}"


def solve(bm: BuildingMap, parsed: Parsed) -> tuple[str, str]:
    """Return (explanation, answer line value)."""
    kind, p = parsed.kind, parsed.params
    if kind == "largest_room":
        result = solvers.largest_room(bm, p["floor_id"], p["room_type"])
        explanation = (
            f"I compared the polygon areas of all {result['count']} {p['room_type'].replace('_', ' ')} spaces on "
            f"{bm.floor_name(p['floor_id'])}. The largest is {label(bm, result['space_id'])} with "
            f"{result['area_m2']:.1f} m²."
        )
        if result["runner_up"]:
            runner_id, runner_area = result["runner_up"]
            explanation += f" The next largest has {runner_area:.1f} m²."
        return explanation, f"{label(bm, result['space_id'])}, {result['area_m2']:.1f} m²"
    if kind == "floor_area_total":
        result = solvers.floor_area_total(bm, p["floor_id"], p["room_type"])
        explanation = (
            f"I added up the polygon areas of the {result['count']} {p['room_type'].replace('_', ' ')} spaces on "
            f"{bm.floor_name(p['floor_id'])}: {result['total_m2']:.2f} m² in total."
        )
        return explanation, number(result["total_m2"])
    if kind == "errand":
        result = solvers.errand(bm, p["start"], p["asset_type"], p["floor_id"], p["room_type"])
        explanation = (
            f"The nearest {p['asset_type'].replace('_', ' ')} by walking distance is in {label(bm, result['via'])} "
            f"({result['first_leg_m']:.1f} m from {label(bm, p['start'])}). The largest "
            f"{p['room_type'].replace('_', ' ')} on {bm.floor_name(p['floor_id'])} is {label(bm, result['target'])}, "
            f"another {result['second_leg_m']:.1f} m (stairs allowed)."
        )
        return explanation, number(result["total_m"])
    if kind == "wide_delivery_count":
        result = solvers.wide_delivery_count(bm, p["start"], p["floor_id"], p["min_width"])
        explanation = (
            f"Keeping only step-free paths (lifts allowed, no stairs or steps) through doors at least "
            f"{p['min_width']:g} m wide, starting in {label(bm, p['start'])}, the load reaches "
            f"{result['count']} rooms on {bm.floor_name(p['floor_id'])}."
        )
        return explanation, str(result["count"])
    if kind == "step_free_reachable_count":
        closed = set(p.get("closed") or [])
        result = solvers.step_free_reachable_count(bm, p["start"], p["floor_id"], closed)
        names = ", ".join(bm.connectors[c]["name"] if c in bm.connectors else c for c in sorted(closed))
        explanation = (
            f"With {names} closed and only step-free paths, a wheelchair user starting in "
            f"{label(bm, p['start'])} can reach {result['count']} rooms on {bm.floor_name(p['floor_id'])}."
        )
        return explanation, str(result["count"])
    if kind == "room_stacked":
        result = solvers.room_stacked(bm, p["start"], p["direction"])
        explanation = (
            f"Comparing outlines with the floor {p['direction']}, {label(bm, result['space_id'])} covers the largest "
            f"part of {label(bm, p['start'])} ({result['overlap_m2']:.1f} m² of "
            f"{bm.room_area(p['start']):.1f} m²)."
        )
        return explanation, label(bm, result["space_id"])
    if kind == "shared_walls_count":
        result = solvers.shared_walls_count(bm, p["start"])
        names = ", ".join(bm.spaces[s]["name"] for s in result["rooms"]) or "none"
        explanation = (
            f"Rooms on {bm.floor_name(bm.spaces[p['start']]['floor_id'])} with at least 1 m of wall within 0.35 m "
            f"of {label(bm, p['start'])} (corridors, stairwells, lifts and outdoor spaces excluded): {names}."
        )
        return explanation, str(result["count"])
    if kind == "straight_line_3d":
        result = solvers.straight_line_3d(bm, p["first"], p["second"])
        a, b = result["first"], result["second"]
        explanation = (
            f"Centroid of {label(bm, p['first'])}: ({a[0]:.2f}, {a[1]:.2f}, {a[2]:.2f}); centroid of "
            f"{label(bm, p['second'])}: ({b[0]:.2f}, {b[1]:.2f}, {b[2]:.2f}). The straight-line distance is "
            f"{result['distance_m']:.2f} m."
        )
        return explanation, number(result["distance_m"])
    if kind == "what_if_door":
        result = solvers.what_if_door(bm, p["first"], p["second"], p["floor_id"])
        x, y = result["door_position"]
        explanation = (
            f"With a new door at ({x:.2f}, {y:.2f}) between {label(bm, p['first'])} and {label(bm, p['second'])}, "
            f"I recomputed every room's walk to its nearest entrance: {result['count']} rooms on "
            f"{bm.floor_name(p['floor_id'])} get more than 1 m shorter."
        )
        return explanation, str(result["count"])
    raise ParseError(f"unknown kind {kind}")


@lru_cache(maxsize=64)
def load_map(building_directory: str) -> BuildingMap:
    return BuildingMap.load(Path(building_directory))


def answer(building_directory: Path, question_text: str) -> str:
    bm = load_map(str(Path(building_directory).resolve()))
    bm.closed.clear()
    try:
        parsed = parse(bm, question_text)
    except ParseError as template_error:
        try:
            parsed = llm_parse(bm, question_text)
        except Exception as error:  # noqa: BLE001 - any fallback failure becomes a best-effort reply
            return (
                f"I could not interpret this question ({template_error}; {error}).\n"
                "Answer: unknown"
            )
    try:
        explanation, value = solve(bm, parsed)
    except (MapError, ParseError, KeyError) as error:
        return f"I could not compute this: {error}\nAnswer: unknown"
    return f"{explanation}\nAnswer: {value}"


if __name__ == "__main__":
    import sys

    print(answer(Path(sys.argv[1]), " ".join(sys.argv[2:])))
