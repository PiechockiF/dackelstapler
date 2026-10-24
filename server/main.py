"""SiteTwin API server.

  uv run uvicorn server.main:app --reload --port 8000

REST + SSE chat + WebSocket per docs/CONTRACT.md. Works without any API keys: the chat falls back to
built-in rules, voice returns 501 (frontend uses Web Speech), floor-plan images return 501."""

from __future__ import annotations

import asyncio
import json
import logging
import re
from contextlib import asynccontextmanager

from dotenv import load_dotenv

load_dotenv()

from fastapi import FastAPI, File, Form, HTTPException, Query, Request, UploadFile  # noqa: E402
from fastapi.middleware.cors import CORSMiddleware  # noqa: E402
from fastapi.responses import JSONResponse, StreamingResponse  # noqa: E402
from fastapi.staticfiles import StaticFiles  # noqa: E402
from pydantic import BaseModel, ConfigDict, Field  # noqa: E402

from server import db, geocode, twin, ws  # noqa: E402
from server.floorplan import (  # noqa: E402
    NoVisionKey, PlanError, guess_kind, new_site_id, parse_plans_with_claude, restitch, sanity_fix,
    validate_building,
)
from server.twin import BookingConflict, MapError, NotFound  # noqa: E402
from server.voice import router as voice_router  # noqa: E402

log = logging.getLogger("sitetwin")
STORAGE = db.storage_dir()


@asynccontextmanager
async def lifespan(app: FastAPI):
    ws.bind_loop(asyncio.get_running_loop())
    db.engine()
    added = twin.seed_sites()
    if added:
        log.info("seeded %d sites from data/sites.json", added)
    yield


app = FastAPI(title="SiteTwin", version="0.1", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
app.include_router(ws.router)
app.include_router(voice_router)
app.mount("/storage", StaticFiles(directory=STORAGE), name="storage")

try:  # agent C's capture endpoints (phone → 3D → checks)
    from capture.router import router as capture_router

    app.include_router(capture_router)
    CAPTURE_STATUS = "mounted"
except Exception as error:  # noqa: BLE001 - capture is optional
    CAPTURE_STATUS = f"unavailable: {error}"
    log.warning("capture router not mounted: %s", error)


@app.exception_handler(NotFound)
async def not_found(_: Request, error: NotFound):
    return JSONResponse(status_code=404, content={"detail": str(error)})


@app.exception_handler(MapError)
async def map_error(_: Request, error: MapError):
    return JSONResponse(status_code=400, content={"detail": str(error)})


@app.exception_handler(BookingConflict)
async def booking_conflict(_: Request, error: BookingConflict):
    return JSONResponse(status_code=409, content={"detail": str(error)})


def _ensure_seeded() -> None:
    """TestClient without lifespan, or a fresh DB: make sure the sites exist."""
    with db.session() as session:
        if session.exec(db.select(db.SiteRow.id)).first() is None:
            twin.seed_sites()


# ------------------------------------------------------------------ health

@app.get("/api/health")
def health() -> dict:
    from agent.chat import llm_available
    import os

    return {"ok": True, "core": twin.HAVE_CORE, "capture": CAPTURE_STATUS, "llm": llm_available(),
            "voice": bool(os.environ.get("ELEVENLABS_API_KEY"))}


# ------------------------------------------------------------------ sites

@app.get("/api/sites")
def sites() -> list[dict]:
    _ensure_seeded()
    return twin.list_sites()


PLAN_TYPES = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
              ".pdf": "application/pdf"}
SITE_ID_RE = re.compile(r"^user-[a-z0-9-]{1,48}$")


def _site_name(name: str | None, address: str | None, lat: float, lon: float) -> str:
    return (name or "").strip() or (address or "").strip() or f"Standort {lat:.4f}, {lon:.4f}"


def _site_id(requested: str | None, name: str) -> str:
    """Keep the id a preview was built with (all space/floor ids derive from it), if it is still free."""
    if requested and SITE_ID_RE.match(requested) and not (db.storage_dir() / "sites" / requested).exists():
        try:
            twin.get_site(requested)
        except NotFound:
            return requested
    return new_site_id(name)


def _plan_media_type(upload: UploadFile) -> str:
    filename = (upload.filename or "").lower()
    media_type = (upload.content_type or "").lower()
    if filename.endswith(".pdf"):
        return "application/pdf"
    if media_type.startswith("image/"):
        return media_type
    guessed = next((v for k, v in PLAN_TYPES.items() if filename.endswith(k)), "")
    if not guessed:
        raise HTTPException(status_code=400, detail=f"{upload.filename}: upload a building.json, "
                                                    "PNG/JPG/WebP floor plans or a PDF.")
    return guessed


@app.post("/api/sites")
async def create_site(lat: float = Form(...), lon: float = Form(...), name: str | None = Form(None),
                      address: str | None = Form(None), file: UploadFile | None = File(None),
                      files: list[UploadFile] | None = File(None), kind: str | None = Form(None),
                      width_m: float | None = Form(None), preview: bool = Form(False),
                      site_id: str | None = Form(None)) -> dict:
    """Create a site from a building.json or one or more floor-plan images/PDFs (Claude vision).

    With several plans, images of the same storey are stitched and storeys stacked. When a building.json
    and images come together (the confirm step after a preview), the images are stored next to it."""
    _ensure_seeded()
    address = (address or "").strip() or None
    name = _site_name(name, address, lat, lon)
    uploads = [u for u in [file, *(files or [])] if u is not None]
    if not uploads:
        raise HTTPException(status_code=400, detail="Upload a building.json or at least one floor plan.")
    jsons, plans = [], []
    for upload in uploads:
        content = await upload.read()
        if not content:
            raise HTTPException(status_code=400, detail=f"{upload.filename or 'The uploaded file'} is empty.")
        if (upload.filename or "").lower().endswith(".json") or (upload.content_type or "").lower() == "application/json":
            jsons.append(content)
        else:
            plans.append((content, _plan_media_type(upload), upload.filename or f"plan-{len(plans) + 1}"))
    if len(jsons) > 1:
        raise HTTPException(status_code=400, detail="Upload only one building.json.")
    site_id = _site_id(site_id, name)
    extractions, matches = None, None
    if jsons:
        try:
            building = validate_building(json.loads(jsons[0]), site_id, name)
        except json.JSONDecodeError as error:
            raise HTTPException(status_code=400, detail=f"Not valid JSON: {error}") from error
        except PlanError as error:
            raise HTTPException(status_code=400, detail=str(error)) from error
        source = building["building"].get("source", "user_upload")
    else:
        try:
            building, stitch_warnings, extractions, matches = await asyncio.to_thread(
                parse_plans_with_claude, plans, site_id, name, width_m, address)
        except NoVisionKey as error:
            raise HTTPException(status_code=501, detail=str(error)) from error
        except PlanError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error
        source = "floor_plan"
    if address:
        building["building"]["address"] = address
    building, warnings = sanity_fix(building)
    if extractions is not None:
        warnings = stitch_warnings + warnings
    stitch_input = {"extractions": extractions, "matches": matches, "level_overrides": {}, "width_m": width_m}
    if preview:
        if extractions is not None:
            _save_draft(site_id, stitch_input)
        return {"site_id": site_id, "building": building, "warnings": warnings,
                "extractions": extractions, "matches": matches}
    folder = db.storage_dir() / "sites" / site_id
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "building.json").write_text(json.dumps(building, indent=1, ensure_ascii=False), encoding="utf-8")
    if plans:
        (folder / "plans").mkdir(exist_ok=True)
        # What Claude read from each plan, so the site can be re-stitched later without new Claude calls.
        draft = _draft_path(site_id)
        if extractions is not None:
            _write_json(folder / "plans" / "extractions.json", stitch_input)
        elif draft.exists():
            draft.replace(folder / "plans" / "extractions.json")
        for index, (content, media_type, filename) in enumerate(plans, start=1):
            suffix = ".pdf" if media_type == "application/pdf" else "." + media_type.split("/")[-1].replace("jpeg", "jpg")
            stem = re.sub(r"[^A-Za-z0-9_-]+", "-", filename.rsplit(".", 1)[0]).strip("-")[:40] or "plan"
            (folder / "plans" / f"{index:02d}-{stem}{suffix}").write_bytes(content)
        if source == "floor_plan_upload":  # confirmed preview: the reviewed JSON plus its source images
            source = "floor_plan"
    site = twin.create_site_row({
        "id": site_id, "name": name, "lat": lat, "lon": lon, "source": source,
        "building_id": building["building"].get("id", site_id),
        "data_path": str((folder).relative_to(db.ROOT)) if folder.is_relative_to(db.ROOT) else str(folder),
        "floors": len(building["floors"]), "demo_location": False, "kind": kind or guess_kind(name),
        "address": address,
    })
    return {**site, "warnings": warnings}


class RestitchBody(BaseModel):
    extractions: list[dict]
    matches: dict[str, list] | None = None
    level_overrides: dict[int, int] = Field(default_factory=dict)
    site_id: str | None = None
    name: str | None = None
    address: str | None = None
    lat: float = 0.0
    lon: float = 0.0
    width_m: float | None = None


@app.post("/api/sites/restitch")
def restitch_site(body: RestitchBody) -> dict:
    """Stitch earlier extractions again (e.g. with corrected storeys) without another Claude call."""
    address = (body.address or "").strip() or None
    name = _site_name(body.name, address, body.lat, body.lon)
    site_id = body.site_id if body.site_id and SITE_ID_RE.match(body.site_id) else new_site_id(name)
    try:
        building, stitch_warnings, matches = restitch(
            body.extractions, site_id, name, width_m=body.width_m, address=address, matches=body.matches,
            level_overrides=body.level_overrides)
    except PlanError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    building, warnings = sanity_fix(building)
    _save_draft(site_id, {"extractions": body.extractions, "matches": matches,
                          "level_overrides": body.level_overrides, "width_m": body.width_m})
    return {"site_id": site_id, "building": building, "warnings": stitch_warnings + warnings,
            "extractions": body.extractions, "matches": matches}


@app.post("/api/sites/{site_id}/rebuild")
def rebuild_site(site_id: str) -> dict:
    """Re-stitch a saved floor-plan site from its stored extractions (after stitching improvements),
    without calling Claude again. The previous building.json is kept as building.prev.json."""
    _ensure_seeded()
    site = twin.get_site(site_id)
    folder = twin.building_file(site).parent
    stored = folder / "plans" / "extractions.json"
    if not stored.exists():
        raise HTTPException(status_code=404, detail="This site has no stored plan extractions to rebuild from.")
    data = json.loads(stored.read_text(encoding="utf-8"))
    old = json.loads((folder / "building.json").read_text(encoding="utf-8"))
    overrides = {int(k): int(v) for k, v in (data.get("level_overrides") or {}).items()}
    try:
        building, stitch_warnings, matches = restitch(
            data["extractions"], site_id, site["name"], width_m=data.get("width_m"),
            address=site.get("address") or old["building"].get("address"), matches=data.get("matches"),
            level_overrides=overrides)
    except PlanError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    building, warnings = sanity_fix(building)
    (folder / "building.prev.json").write_text(json.dumps(old, indent=1, ensure_ascii=False), encoding="utf-8")
    _write_json(folder / "building.json", building)
    _write_json(stored, {**data, "matches": matches})
    twin.invalidate(site_id)
    with db.session() as session:
        row = session.get(db.SiteRow, site_id)
        row.floors = len(building["floors"])
        session.add(row)
        session.commit()
    return {**twin.get_site(site_id), "warnings": stitch_warnings + warnings}


def _draft_path(site_id: str):
    return db.storage_dir() / "drafts" / f"{site_id}.json"


def _save_draft(site_id: str, data: dict) -> None:
    path = _draft_path(site_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    _write_json(path, data)


def _write_json(path, data) -> None:
    path.write_text(json.dumps(data, indent=1, ensure_ascii=False), encoding="utf-8")


@app.get("/api/geocode")
async def geocode_search(q: str = Query(..., min_length=1), lat: float | None = None,
                         lon: float | None = None) -> list[dict]:
    try:
        return await geocode.search(q, (lat, lon) if lat is not None and lon is not None else None)
    except geocode.GeocodeError as error:
        raise HTTPException(status_code=502, detail=str(error)) from error


@app.get("/api/geocode/reverse")
async def geocode_reverse(lat: float, lon: float) -> dict:
    try:
        return await geocode.reverse(lat, lon)
    except geocode.GeocodeError as error:
        raise HTTPException(status_code=502, detail=str(error)) from error


@app.get("/api/sites/{site_id}")
def site(site_id: str) -> dict:
    _ensure_seeded()
    return twin.get_site(site_id)


@app.get("/api/sites/{site_id}/building")
def building(site_id: str) -> dict:
    _ensure_seeded()
    return twin.raw_building(site_id)


@app.get("/api/sites/{site_id}/state")
def state(site_id: str) -> dict:
    _ensure_seeded()
    return twin.site_state(site_id)


# ------------------------------------------------------------------ routing and edits

class RouteBody(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    from_: str = Field(alias="from")
    to: str
    step_free: bool = False
    min_width_m: float | None = None
    via: list[str] | None = None


@app.post("/api/sites/{site_id}/route")
def route(site_id: str, body: RouteBody) -> dict:
    _ensure_seeded()
    return twin.compute_route(site_id, body.from_, body.to, step_free=body.step_free,
                              min_width_m=body.min_width_m, via=body.via)


@app.get("/api/sites/{site_id}/reachable")
def reachable(site_id: str, from_: str = Query(alias="from"), step_free: bool = False,
              min_width_m: float | None = None) -> dict:
    _ensure_seeded()
    return twin.reachable(site_id, from_, step_free=step_free, min_width_m=min_width_m)


class ClosureBody(BaseModel):
    element_id: str
    closed: bool = True


@app.post("/api/sites/{site_id}/closures")
def closures(site_id: str, body: ClosureBody) -> dict:
    _ensure_seeded()
    twin.set_closed(site_id, body.element_id, body.closed)
    return twin.site_state(site_id)


class MoveBody(BaseModel):
    space_id: str
    position: list[float] | None = None


@app.post("/api/sites/{site_id}/assets/{asset_id}/move")
def move(site_id: str, asset_id: str, body: MoveBody) -> dict:
    _ensure_seeded()
    twin.move_asset(site_id, asset_id, body.space_id, body.position)
    return twin.site_state(site_id)


class DoorBody(BaseModel):
    first_space: str
    second_space: str
    step_free: bool = True
    width_m: float | None = None


@app.post("/api/sites/{site_id}/doors")
def doors(site_id: str, body: DoorBody) -> dict:
    """Extra (not in contract v1): add a door between two neighbouring spaces."""
    _ensure_seeded()
    twin.add_door(site_id, body.first_space, body.second_space, body.step_free, body.width_m)
    return twin.site_state(site_id)


class AssetBody(BaseModel):
    type: str
    space_id: str
    name: str | None = None
    category: str | None = None
    width_m: float | None = None
    depth_m: float | None = None
    rotation_deg: float | None = None
    position: list[float] | None = None


@app.get("/api/equipment-types")
def equipment_types() -> list[dict]:
    """Extra: known equipment types with category and typical footprint (for the add-equipment form)."""
    from server.equipment import catalog

    return catalog()


@app.post("/api/sites/{site_id}/assets")
def add_asset(site_id: str, body: AssetBody) -> dict:
    """Extra: add equipment/machines/furniture to a room by hand. Returns the new Asset."""
    _ensure_seeded()
    try:
        result = twin.add_asset(site_id, body.type, body.space_id, body.name, body.category, body.width_m,
                                body.depth_m, body.rotation_deg, body.position)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    return result["asset"]


class AssetPatchBody(BaseModel):
    name: str | None = None
    type: str | None = None
    category: str | None = None
    width_m: float | None = None
    depth_m: float | None = None
    rotation_deg: float | None = None
    space_id: str | None = None


@app.patch("/api/sites/{site_id}/assets/{asset_id}")
def edit_asset(site_id: str, asset_id: str, body: AssetPatchBody) -> dict:
    """Extra: edit any asset (name, type, category, size; a new space_id moves it). Returns the Asset."""
    _ensure_seeded()
    try:
        return twin.update_asset(site_id, asset_id, body.name, body.type, body.category, body.width_m, body.depth_m,
                                 body.rotation_deg, body.space_id)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error


@app.delete("/api/sites/{site_id}/assets/{asset_id}")
def delete_asset(site_id: str, asset_id: str) -> dict:
    """Extra: delete any asset (also ones from the original building data)."""
    _ensure_seeded()
    try:
        asset = twin.remove_asset(site_id, asset_id)
    except ValueError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    return {"ok": True, "id": asset["id"]}


class DimsBody(BaseModel):
    w: float
    d: float
    h: float


class ManualDeliveryBody(BaseModel):
    label: str
    space_id: str
    dims_m: DimsBody | None = None
    target_space_id: str | None = None
    note: str | None = None


@app.post("/api/sites/{site_id}/deliveries")
def log_delivery(site_id: str, body: ManualDeliveryBody) -> dict:
    """Extra: record a delivery by hand (no photo). Returns the Delivery with its door/route/floor check."""
    _ensure_seeded()
    try:
        return twin.log_delivery(site_id, body.label, body.space_id, body.dims_m.model_dump() if body.dims_m else None,
                                 body.target_space_id, body.note)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error


class DeliveryPatchBody(BaseModel):
    label: str | None = None
    space_id: str | None = None
    dims_m: DimsBody | None = None
    target_space_id: str | None = None
    note: str | None = None


@app.patch("/api/sites/{site_id}/deliveries/{delivery_id}")
def edit_delivery(site_id: str, delivery_id: str, body: DeliveryPatchBody) -> dict:
    """Extra: edit a delivery. Send target_space_id: null to clear the destination; omit it to keep it."""
    _ensure_seeded()
    target = body.target_space_id if "target_space_id" in body.model_fields_set else twin.UNCHANGED
    try:
        return twin.update_delivery(site_id, delivery_id, body.label, body.space_id,
                                    body.dims_m.model_dump() if body.dims_m else None, target, body.note)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error


@app.delete("/api/sites/{site_id}/deliveries/{delivery_id}")
def delete_delivery(site_id: str, delivery_id: str) -> dict:
    _ensure_seeded()
    twin.remove_delivery(site_id, delivery_id)
    return {"ok": True, "id": delivery_id}


# ------------------------------------------------------------------ events and bookings

@app.get("/api/sites/{site_id}/events")
def events(site_id: str, since: str | None = None, limit: int = Query(200, ge=1, le=2000)) -> list[dict]:
    _ensure_seeded()
    return twin.list_events(site_id, since, limit)


@app.get("/api/sites/{site_id}/rooms/bookable")
def bookable(site_id: str, start: str | None = None, end: str | None = None, people: int = 1,
             near: str | None = None) -> list[dict]:
    _ensure_seeded()
    try:
        return twin.bookable_rooms(site_id, start, end, people, near)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=f"Bad time: {error}") from error


@app.get("/api/sites/{site_id}/bookings")
def bookings(site_id: str) -> list[dict]:
    _ensure_seeded()
    return twin.list_bookings(site_id)


class BookingBody(BaseModel):
    space_id: str
    start: str
    end: str
    who: str = ""
    title: str = ""


@app.post("/api/sites/{site_id}/bookings")
def book(site_id: str, body: BookingBody) -> dict:
    _ensure_seeded()
    try:
        return twin.create_booking(site_id, body.space_id, body.start, body.end, body.who, body.title)
    except BookingConflict:
        raise
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error


# ------------------------------------------------------------------ chat

class ChatBody(BaseModel):
    session_id: str = "default"
    message: str
    here: str | None = None


@app.post("/api/sites/{site_id}/chat")
def chat(site_id: str, body: ChatBody) -> StreamingResponse:
    from agent.chat import stream_chat

    _ensure_seeded()
    twin.get_site(site_id)
    if not body.message.strip():
        raise HTTPException(status_code=400, detail="Empty message.")
    here = twin.get_map(site_id).resolve_space(body.here) if body.here else None
    return StreamingResponse(stream_chat(site_id, body.session_id, body.message, here=here), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


# ------------------------------------------------------------------ admin

@app.post("/api/admin/reload")
def reload_cache() -> dict:
    """Drop cached maps (after scripts/seed_demo_events.py wrote to the DB) and re-read sites.json."""
    twin.invalidate()
    added = twin.seed_sites()
    return {"ok": True, "sites_added": added}
