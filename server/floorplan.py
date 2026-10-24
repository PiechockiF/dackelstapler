"""New sites from uploads: validate a building.json, or turn floor-plan images/PDFs into one with Claude
vision (one call per image, then server/stitch.py stitches storeys and stacks them), then sanity-check that
every room is reachable from an entrance (adding doors where a room has none) before saving to
storage/sites/<site_id>/building.json."""

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
        lowest = min(bm.floors.values(), key=lambda floor: floor["level"])["id"]
        candidates = sorted(bm.spaces.values(), key=lambda s: (s["floor_id"] != lowest,
                                                               s.get("type") not in ("corridor", "hall"),
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


def _polygon_schema() -> dict:
    return {"type": "array", "items": _point_schema()}


PLAN_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["floor_label", "level", "has_north_arrow", "north_deg", "plan_width_m", "plan_height_m",
                 "spaces", "landmarks", "openings"],
    "properties": {
        "floor_label": {"type": "string", "description": "Storey as written on the plan, e.g. '3. Obergeschoss'"},
        "level": {"type": "integer", "description": "Storey number: 0 ground floor, 1 first upper floor, -1 basement"},
        "has_north_arrow": {"type": "boolean"},
        "north_deg": {"type": "number", "description": "Direction the north arrow points, degrees clockwise from image-up"},
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
                "polygon": _polygon_schema(),
            }}},
        "landmarks": {"type": "array", "items": {
            "type": "object", "additionalProperties": False,
            "required": ["key", "name", "polygon"],
            "properties": {"key": {"type": "string"}, "name": {"type": "string"}, "polygon": _polygon_schema()}}},
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

VISION_PROMPT = """This is a photo or scan of an architectural floor plan, often a German escape plan \
("Flucht- und Rettungsplan") photographed on a wall. Extract it for an indoor navigation graph. Other \
photos of the same building will be stitched to this one, so labels and positions matter.

Coordinates: use a normalised frame where the whole image's top-left is (0, 0) and bottom-right is \
(1000, 1000), x to the right, y down, regardless of the image's aspect ratio or how much of it the plan fills.

Only the main floor plan counts. Ignore the title bar, the legend, behaviour instructions ("Verhalten im \
Brandfall", "Verhalten bei Unfällen"), the small site overview map ("Übersichtsplan"), the planner's title \
block and anything outside the building drawing.

Return:
- floor_label: the storey as written on the plan ("3. Obergeschoss", "Erdgeschoss", "UG"), or "" if none.
- level: that storey as an integer. Ground floor (EG, Erdgeschoss) is 0, the n-th upper floor (n. OG, \
Obergeschoss) is n, the first basement (UG, KG, Untergeschoss) is -1. If no storey is written, use a plan \
number such as "OG3.06" (= 3), otherwise 0.
- has_north_arrow / north_deg: whether the plan has a north arrow or compass rose, and the direction its \
north ("N") points in degrees clockwise from straight up in the image (0 = up, 90 = right, 180 = down, \
270 = left). Use 0 when there is none.
- plan_width_m / plan_height_m: your best estimate of the real-world size the whole image covers, in metres. \
{scale_hint} Doors are typically 0.9-1.0 m wide, corridors 1.5-2.5 m, offices 3-5 m deep, stair flights \
about 1.2 m wide.
- spaces: every walkable room, corridor, hall, stairwell, lift and terrace as a polygon outline (clockwise, \
not closed, 4+ points for rectangles). Give each a short unique key (S1, S2, ...), its label on the plan if \
any ("Büro", "Küche", "WC", "Besprechung", "Think Tank"), otherwise a descriptive name ("Flur", \
"Treppenhaus", "Aufzug"), and the best room_type. Green escape-route areas (Fluchtweg) are corridors or \
halls; drawn stair flights are stair spaces; terraces and balconies are "outdoor"; a large open-plan area \
("offener Bürobereich") is one room.
- landmarks: labelled areas you cannot walk in that help line plans up, such as voids/atria ("Luftraum") or \
shafts, as polygons with their label. Do not repeat them as spaces.
- openings: every door or open passage between two spaces (from_key/to_key) at the door's centre, with its \
width in metres. Doors leading out of the building are kind "entrance" with to_key "outside". Emergency-exit \
signs ("Notausgang") usually mark the door into a staircase: include that staircase and the door to it. If \
a room has no visible door, add the most plausible one to the corridor it borders.
If the plan is cut off at the image edge, extract only what is visible. Be complete: every space must have \
at least one opening."""

MATCH_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["overlap", "pairs"],
    "properties": {
        "overlap": {"type": "boolean"},
        "pairs": {"type": "array", "items": {
            "type": "object", "additionalProperties": False,
            "required": ["what", "a", "b"],
            "properties": {"what": {"type": "string"}, "a": _point_schema(), "b": _point_schema()}}},
    },
}

MATCH_PROMPT = """Image A and image B are two plans of the same storey of one building; each shows part \
of it and they may be rotated or scaled against each other. Rooms read from A: {rooms_a}. Rooms read from B: \
{rooms_b}.

Find 4-8 points that are the same physical spot in both images: corners of the same room, the centre of the \
same door, stair corners, columns. Give each point in each image's own normalised frame (top-left (0, 0), \
bottom-right (1000, 1000), y down), "a" for image A and "b" for image B, and say briefly what it is. Prefer \
points that are far apart. If the images do not show any common part of the building, set overlap to false \
and return no pairs."""


def _media(data: bytes, media_type: str) -> tuple[dict, float]:
    """(content block, image aspect ratio height/width)."""
    if media_type == "application/pdf":
        block = {"type": "document", "source": {"type": "base64", "media_type": "application/pdf",
                                                "data": base64.standard_b64encode(data).decode()}}
        return block, 1 / 1.414  # A-series landscape is the common case
    from PIL import Image, ImageOps

    image = Image.open(io.BytesIO(data))
    upright = ImageOps.exif_transpose(image)  # phone photos: honour the EXIF orientation
    rotated = upright is not image
    image = upright
    aspect = image.height / max(1, image.width)
    if rotated or image.width > 2400 or image.height > 2400 or media_type not in ("image/png", "image/jpeg", "image/webp", "image/gif"):
        image.thumbnail((2400, 2400))
        buffer = io.BytesIO()
        image.convert("RGB").save(buffer, format="JPEG", quality=90)
        data, media_type = buffer.getvalue(), "image/jpeg"
    block = {"type": "image", "source": {"type": "base64", "media_type": media_type,
                                         "data": base64.standard_b64encode(data).decode()}}
    return block, aspect


def _require_key() -> None:
    if not (os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN")):
        raise NoVisionKey("Floor-plan parsing needs ANTHROPIC_API_KEY. Upload a building.json instead, "
                          "or set the key in .env and restart the server.")


def _ask_json(content: list[dict], schema: dict, max_tokens: int = 48000, effort: str = "medium") -> dict:
    import anthropic

    client = anthropic.Anthropic()
    with client.messages.stream(
        model=VISION_MODEL,
        max_tokens=max_tokens,
        output_config={"effort": effort, "format": {"type": "json_schema", "schema": schema}},
        messages=[{"role": "user", "content": content}],
    ) as stream:
        message = stream.get_final_message()
    if message.stop_reason == "refusal":
        raise PlanError("The plan could not be parsed (the model declined).")
    if message.stop_reason == "max_tokens":
        raise PlanError("The plan was too detailed to read in one go. Try a tighter crop.")
    text = next((b.text for b in message.content if b.type == "text"), "")
    try:
        return json.loads(text)
    except json.JSONDecodeError as error:
        raise PlanError(f"Could not read the parsed plan: {error}") from error


def extract_plan(data: bytes, media_type: str, width_m: float | None = None) -> dict:
    """One image -> raw extraction (normalised coordinates) plus its aspect ratio. One Claude call."""
    _require_key()
    block, aspect = _media(data, media_type)
    hint = (f"The user says the building is about {width_m:g} m along its longest side." if width_m else
            "There is usually no scale bar: estimate the scale from door widths, stairs and furniture.")
    content = [block, {"type": "text", "text": VISION_PROMPT.format(scale_hint=hint)}]
    plan = _ask_json(content, PLAN_SCHEMA)
    if _plan_quality(plan) < MIN_PLAN_QUALITY:
        # Occasionally a read comes back degenerate (a few repeated slivers, no doors): read it again harder.
        log.info("plan extraction looked degenerate (%d distinct rooms); retrying at high effort", _plan_quality(plan))
        retry = _ask_json(content, PLAN_SCHEMA, effort="high")
        if _plan_quality(retry) > _plan_quality(plan):
            plan = retry
    plan["aspect"] = aspect
    return plan


MIN_PLAN_QUALITY = 4


def _plan_quality(plan: dict) -> int:
    """Distinct, plausibly sized spaces (normalised units); 0 when no door was found at all."""
    if not plan.get("openings"):
        return 0
    seen = set()
    for space in plan.get("spaces") or []:
        points = [p[:2] for p in space.get("polygon") or [] if len(p) >= 2]
        if len(points) < 3:
            continue
        polygon = Polygon(points)
        if not polygon.is_valid or polygon.area < 100:  # 100 = 0.01 % of the image
            continue
        seen.add(tuple(round(v, -1) for v in polygon.bounds))
    return len(seen)


def match_points(first: tuple[bytes, str], second: tuple[bytes, str], plan_a: dict, plan_b: dict) -> list:
    """Corresponding points between two plans of one storey (fallback when they share too few labels)."""
    _require_key()
    block_a, _ = _media(*first)
    block_b, _ = _media(*second)

    def rooms(plan: dict) -> str:
        names = [s.get("name") for s in (plan.get("spaces") or []) + (plan.get("landmarks") or []) if s.get("name")]
        return ", ".join(names[:60]) or "none"

    prompt = MATCH_PROMPT.format(rooms_a=rooms(plan_a), rooms_b=rooms(plan_b))
    result = _ask_json([{"type": "text", "text": "Image A:"}, block_a, {"type": "text", "text": "Image B:"}, block_b,
                        {"type": "text", "text": prompt}], MATCH_SCHEMA, max_tokens=16000)
    if not result.get("overlap"):
        return []
    return [[p["a"][:2], p["b"][:2]] for p in result.get("pairs", [])
            if len(p.get("a", [])) >= 2 and len(p.get("b", [])) >= 2]


def parse_plans_with_claude(uploads: list[tuple[bytes, str, str]], site_id: str, name: str,
                            width_m: float | None = None,
                            address: str | None = None) -> tuple[dict, list[str], list[dict], dict]:
    """Floor-plan images (bytes, media type, filename) -> (building, warnings, extractions, matches).

    Every image is read in parallel; images of the same storey are stitched and storeys stacked."""
    from concurrent.futures import ThreadPoolExecutor

    from server.stitch import StitchError, build_from_extractions

    _require_key()

    def read(upload: tuple[bytes, str, str]) -> dict:
        data, media_type, filename = upload
        try:
            plan = extract_plan(data, media_type, width_m)
        except PlanError as error:
            return {"filename": filename, "error": str(error)}
        return {**plan, "filename": filename}

    with ThreadPoolExecutor(max_workers=min(4, len(uploads))) as pool:
        extractions = list(pool.map(read, uploads))
    if all(e.get("error") for e in extractions):
        raise PlanError("; ".join(f"{e['filename']}: {e['error']}" for e in extractions))

    def matcher(a: int, b: int) -> list:
        return match_points(uploads[a][:2], uploads[b][:2], extractions[a], extractions[b])

    try:
        building, warnings, matches = build_from_extractions(
            extractions, site_id, name, width_m=width_m, address=address, matcher=matcher)
    except StitchError as error:
        raise PlanError(str(error)) from error
    return building, warnings, extractions, matches


def restitch(extractions: list[dict], site_id: str, name: str, *, width_m: float | None = None,
             address: str | None = None, matches: dict | None = None,
             level_overrides: dict[int, int] | None = None) -> tuple[dict, list[str], dict]:
    """Re-run stitching on earlier extractions (e.g. after the user corrected a storey). No Claude call."""
    from server.stitch import StitchError, build_from_extractions

    try:
        return build_from_extractions(extractions, site_id, name, width_m=width_m, address=address,
                                      matches=matches, level_overrides=level_overrides)
    except StitchError as error:
        raise PlanError(str(error)) from error


def parse_plan_with_claude(data: bytes, media_type: str, site_id: str, name: str,
                           width_m: float | None = None) -> dict:
    """Single image (kept for callers of the old API)."""
    building, _, _, _ = parse_plans_with_claude([(data, media_type, "plan")], site_id, name, width_m)
    return building


def plan_to_building(plan: dict, site_id: str, name: str, width_m: float | None = None,
                     aspect: float | None = None) -> dict:
    """One normalised (0..1000, y down) extraction -> building.json in metres (y up)."""
    building, _, _ = restitch([{**plan, "aspect": aspect or plan.get("aspect")}], site_id, name, width_m=width_m)
    return building
