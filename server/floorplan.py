"""New sites from uploads: validate a building.json, or turn a floor-plan image/PDF into one with
Claude vision, then sanity-check that every room is reachable from an entrance (adding doors where a
room has none) before saving to storage/sites/<site_id>/building.json."""

from __future__ import annotations

import base64
import io
import json
import logging
import os
import re
import uuid

from shapely.geometry import Polygon

log = logging.getLogger("sitetwin.floorplan")
VISION_MODEL = os.environ.get("SITETWIN_VISION_MODEL", "claude-opus-5-5")
SPACE_TYPES = ["room", "corridor", "stair", "lift", "hall", "outdoor"]
ROOM_TYPES = [
    "office", "meeting_room", "seminar_room", "lecture_hall", "lab", "library", "toilet", "kitchen", "storage",
    "corridor", "stairwell", "lift", "lobby", "canteen", "server_room", "technical_room", "production_zone",
    "assembly_zone", "warehouse_zone", "logistics_zone", "quality_lab", "generic_room",
]


class PlanError(ValueError):
    pass


class NoVisionKey(RuntimeError):
    pass


def slugify(name: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", name.lower().replace("ä", "ae").replace("ö", "oe").replace("ü", "ue").replace("ß", "ss"))
    return (slug.strip("-") or "site")[:32]


def new_site_id(name: str) -> str:
    return f"user-{slugify(name)}-{uuid.uuid4().hex[:6]}"


def guess_kind(name: str) -> str:
    lowered = name.lower()
    if re.search(r"werk|fabrik|factory|halle|produktion|fertigung|plant|lager|warehouse", lowered):
        return "factory"
    if re.search(r"campus|uni|tum|lab|hörsaal|institut|school|schule", lowered):
        return "campus"
    if re.search(r"terminal|airport|flughafen", lowered):
        return "airport"
    if re.search(r"mall|arcaden|center|centre", lowered):
        return "mall"
    if re.search(r"office|büro|buero|tower|haus", lowered):
        return "office"
    return "other"


# ------------------------------------------------------------------ building.json validation

def validate_building(data: dict, site_id: str, name: str) -> dict:
    if not isinstance(data, dict):
        raise PlanError("building.json must be a JSON object.")
    for key in ("floors", "spaces", "openings"):
        if not isinstance(data.get(key), list) or (key != "openings" and not data[key]):
            raise PlanError(f"building.json needs a non-empty '{key}' list.")
    data.setdefault("vertical_connectors", [])
    data.setdefault("assets", [])
    info = data.setdefault("building", {})
    info.setdefault("id", site_id)
    info.setdefault("name", name)
    info.setdefault("source", "user_upload")
    info.setdefault("license", "user")
    info.setdefault("attribution", "Uploaded by a SiteTwin user")
    info.setdefault("units", "m")
    floor_ids = {floor["id"] for floor in data["floors"]}
    for floor in data["floors"]:
        floor.setdefault("name", f"Floor {floor.get('level', 0)}")
        floor.setdefault("elevation_m", 3.5 * float(floor.get("level", 0)))
        floor.setdefault("height_m", 3.5)
    space_ids = set()
    for space in data["spaces"]:
        if space.get("floor_id") not in floor_ids:
            raise PlanError(f"Space {space.get('id')} is on unknown floor {space.get('floor_id')}.")
        if len(space.get("polygon") or []) < 3:
            raise PlanError(f"Space {space.get('id')} needs a polygon with at least 3 points.")
        space.setdefault("type", "room")
        space.setdefault("room_type", "generic_room")
        space.setdefault("name", space["id"])
        space_ids.add(space["id"])
    for opening in data["openings"]:
        sides = opening.get("space_ids") or []
        if len(sides) != 2 or any(side not in space_ids and side != "outside" for side in sides):
            raise PlanError(f"Opening {opening.get('id')} must join two known spaces (or 'outside').")
        opening.setdefault("kind", "entrance" if "outside" in sides else "door")
        opening.setdefault("width_m", 0.9)
        opening.setdefault("step_free", True)
    for connector in data["vertical_connectors"]:
        if any(space not in space_ids for space in connector.get("space_ids", [])):
            raise PlanError(f"Connector {connector.get('id')} stops in an unknown space.")
    return data


# ------------------------------------------------------------------ sanity check

def sanity_fix(data: dict) -> tuple[dict, list[str]]:
    """Make every room reachable from an entrance: add an entrance if there is none, then add doors from
    unreachable rooms to a reachable neighbour. Returns (building, warnings)."""
    from server.twin import BuildingMap  # core map (or starter fallback)
    import networkx as nx

    warnings: list[str] = []
    bm = BuildingMap(data)
    if not any("outside" in opening["space_ids"] for opening in bm.openings.values()):
        candidates = sorted(bm.spaces.values(), key=lambda s: (s.get("type") not in ("corridor", "hall"),
                                                               -Polygon(s["polygon"]).area))
        space = candidates[0]
        polygon = Polygon(space["polygon"])
        minx, miny, maxx, maxy = polygon.bounds
        entrance = {"id": f"{space['floor_id']}-O-entrance", "floor_id": space["floor_id"],
                    "space_ids": [space["id"], "outside"], "kind": "entrance",
                    "position": [round((minx + maxx) / 2, 3), round(miny, 3)], "width_m": 1.2,
                    "step_free": True, "synthetic": True}
        bm.openings[entrance["id"]] = entrance
        bm.data["openings"].append(entrance)
        warnings.append(f"No entrance found; assumed one into {space['name']}.")
    for _ in range(len(bm.spaces)):
        graph = bm.graph(False, outside=True)
        reached = set(nx.node_connected_component(graph, "outside")) if "outside" in graph else set()
        missing = [s for s in bm.spaces if s not in reached]
        if not missing:
            break
        progress = False
        for space_id in missing:
            polygon = Polygon(bm.spaces[space_id]["polygon"])
            neighbours = sorted(
                (other for other in reached if other in bm.spaces
                 and bm.spaces[other]["floor_id"] == bm.spaces[space_id]["floor_id"]
                 and Polygon(bm.spaces[other]["polygon"]).distance(polygon) <= 0.6),
                key=lambda other: (bm.spaces[other].get("type") != "corridor", other))
            for other in neighbours:
                try:
                    bm.add_door(space_id, other, True)
                    warnings.append(f"Added a door from {bm.spaces[space_id]['name']} to {bm.spaces[other]['name']}.")
                    progress = True
                    break
                except Exception:  # noqa: BLE001
                    continue
            if progress:
                break
        if not progress:
            warnings.append("Unreachable from any entrance: " + ", ".join(bm.spaces[s]["name"] for s in missing[:10]))
            break
    return bm.data, warnings


# ------------------------------------------------------------------ Claude vision

def _point_schema() -> dict:
    return {"type": "array", "items": {"type": "number"}}


PLAN_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["plan_width_m", "plan_height_m", "spaces", "openings"],
    "properties": {
        "plan_width_m": {"type": "number", "description": "Real-world width covered by the whole image, metres"},
        "plan_height_m": {"type": "number", "description": "Real-world height covered by the whole image, metres"},
        "spaces": {"type": "array", "items": {
            "type": "object", "additionalProperties": False,
            "required": ["key", "name", "type", "room_type", "polygon"],
            "properties": {
                "key": {"type": "string"},
                "name": {"type": "string"},
                "type": {"type": "string", "enum": SPACE_TYPES},
                "room_type": {"type": "string", "enum": ROOM_TYPES},
                "polygon": {"type": "array", "items": _point_schema()},
            }}},
        "openings": {"type": "array", "items": {
            "type": "object", "additionalProperties": False,
            "required": ["from_key", "to_key", "kind", "x", "y", "width_m", "step_free"],
            "properties": {
                "from_key": {"type": "string"},
                "to_key": {"type": "string", "description": "space key, or 'outside' for an entrance"},
                "kind": {"type": "string", "enum": ["door", "opening", "entrance"]},
                "x": {"type": "number"}, "y": {"type": "number"},
                "width_m": {"type": "number"},
                "step_free": {"type": "boolean"},
            }}},
    },
}

VISION_PROMPT = """This is an architectural floor plan. Extract it for an indoor navigation graph.

Coordinates: use a normalised frame where the image's top-left is (0, 0) and bottom-right is \
(1000, 1000), x to the right, y down, regardless of the image's aspect ratio.

Return:
- plan_width_m / plan_height_m: your best estimate of the real-world size the whole image covers, in metres. \
{scale_hint} Doors are typically 0.9 m wide, corridors 1.5-2.5 m.
- spaces: every room, corridor, stairwell and lift as a polygon outline (clockwise, not closed, 4+ points \
for rectangles). Give each a short unique key (S1, S2, ...), a name using the label on the plan if any \
("Office 2.03", "WC") and the best room_type.
- openings: every door or open passage between two spaces (from_key/to_key) at the door's centre, with \
its width in metres. Doors to the outside are kind "entrance" with to_key "outside". If a room has no \
visible door, add the most plausible one to the corridor it borders.
Be complete: every space must have at least one opening."""


def _media(data: bytes, media_type: str) -> tuple[dict, float]:
    """(content block, image aspect ratio height/width)."""
    if media_type == "application/pdf":
        block = {"type": "document", "source": {"type": "base64", "media_type": "application/pdf",
                                                "data": base64.standard_b64encode(data).decode()}}
        return block, 1 / 1.414  # A-series landscape is the common case
    from PIL import Image

    image = Image.open(io.BytesIO(data))
    aspect = image.height / max(1, image.width)
    if image.width > 2400 or image.height > 2400 or media_type not in ("image/png", "image/jpeg", "image/webp", "image/gif"):
        image.thumbnail((2400, 2400))
        buffer = io.BytesIO()
        image.convert("RGB").save(buffer, format="PNG")
        data, media_type = buffer.getvalue(), "image/png"
    block = {"type": "image", "source": {"type": "base64", "media_type": media_type,
                                         "data": base64.standard_b64encode(data).decode()}}
    return block, aspect


def parse_plan_with_claude(data: bytes, media_type: str, site_id: str, name: str,
                           width_m: float | None = None) -> dict:
    if not (os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN")):
        raise NoVisionKey("Floor-plan parsing needs ANTHROPIC_API_KEY. Upload a building.json instead, "
                          "or set the key in .env and restart the server.")
    import anthropic

    block, aspect = _media(data, media_type)
    hint = (f"The user says the whole image is {width_m:g} m wide." if width_m else
            "Estimate the scale from door widths, furniture and any dimension labels or scale bar.")
    client = anthropic.Anthropic()
    with client.messages.stream(
        model=VISION_MODEL,
        max_tokens=48000,
        output_config={"effort": "medium", "format": {"type": "json_schema", "schema": PLAN_SCHEMA}},
        messages=[{"role": "user", "content": [block, {"type": "text", "text": VISION_PROMPT.format(scale_hint=hint)}]}],
    ) as stream:
        message = stream.get_final_message()
    if message.stop_reason == "refusal":
        raise PlanError("The plan could not be parsed (the model declined).")
    text = next((b.text for b in message.content if b.type == "text"), "")
    try:
        plan = json.loads(text)
    except json.JSONDecodeError as error:
        raise PlanError(f"Could not read the parsed plan: {error}") from error
    return plan_to_building(plan, site_id, name, width_m, aspect)


def plan_to_building(plan: dict, site_id: str, name: str, width_m: float | None = None,
                     aspect: float | None = None) -> dict:
    """Normalised (0..1000, y down) plan → building.json in metres (y up)."""
    plan_w = float(width_m or plan.get("plan_width_m") or 30.0)
    plan_h = float(plan.get("plan_height_m") or plan_w * (aspect or 1.0))
    if width_m and plan.get("plan_width_m"):
        plan_h = plan_h * float(width_m) / float(plan["plan_width_m"])

    def to_m(x: float, y: float) -> list[float]:
        return [round(float(x) / 1000 * plan_w, 3), round((1000 - float(y)) / 1000 * plan_h, 3)]

    floor_id = f"{site_id}-F0"
    spaces, keys = [], {}
    for index, item in enumerate(plan.get("spaces", []), start=1):
        polygon = [to_m(*point[:2]) for point in item.get("polygon", []) if len(point) >= 2]
        if len(polygon) < 3 or Polygon(polygon).area < 0.5:
            continue
        if not Polygon(polygon).is_valid:
            polygon = [list(map(lambda v: round(v, 3), xy)) for xy in Polygon(polygon).buffer(0).exterior.coords[:-1]]
        space_id = f"{floor_id}-S{index:03d}"
        keys[item["key"]] = space_id
        ref_match = re.search(r"\d+(?:\.\d+)?", item.get("name", ""))
        spaces.append({"id": space_id, "floor_id": floor_id, "type": item.get("type", "room"),
                       "room_type": item.get("room_type", "generic_room"), "name": item.get("name") or space_id,
                       "ref": ref_match.group(0) if ref_match else None, "polygon": polygon, "synthetic": False})
    openings = []
    for index, item in enumerate(plan.get("openings", []), start=1):
        first = keys.get(item.get("from_key"))
        second = "outside" if item.get("to_key") == "outside" else keys.get(item.get("to_key"))
        if not first or not second or first == second:
            continue
        openings.append({"id": f"{floor_id}-O{index:04d}", "floor_id": floor_id, "space_ids": [first, second],
                         "kind": "entrance" if second == "outside" else item.get("kind", "door"),
                         "position": to_m(item["x"], item["y"]), "width_m": round(float(item.get("width_m") or 0.9), 2),
                         "step_free": bool(item.get("step_free", True)), "synthetic": False})
    if not spaces:
        raise PlanError("No rooms were recognised on this plan. Try a cleaner image or a building.json.")
    return {
        "building": {"id": site_id, "name": name, "source": "floor_plan_upload", "license": "user",
                     "attribution": "Parsed from an uploaded floor plan with Claude vision", "units": "m",
                     "scale": {"plan_width_m": plan_w, "plan_height_m": plan_h, "user_supplied": bool(width_m)}},
        "floors": [{"id": floor_id, "level": 0, "name": "Ground floor", "elevation_m": 0.0, "height_m": 3.0}],
        "spaces": spaces,
        "openings": openings,
        "vertical_connectors": [],
        "assets": [],
    }
