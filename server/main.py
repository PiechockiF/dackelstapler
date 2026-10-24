"""SiteTwin API server.

  uv run uvicorn server.main:app --reload --port 8000

REST + SSE chat + WebSocket per docs/CONTRACT.md. Works without any API keys: the chat falls back to
built-in rules, voice returns 501 (frontend uses Web Speech), floor-plan images return 501."""

from __future__ import annotations

import asyncio
import json
import logging
from contextlib import asynccontextmanager

from dotenv import load_dotenv

load_dotenv()

from fastapi import FastAPI, File, Form, HTTPException, Query, Request, UploadFile  # noqa: E402
from fastapi.middleware.cors import CORSMiddleware  # noqa: E402
from fastapi.responses import JSONResponse, StreamingResponse  # noqa: E402
from fastapi.staticfiles import StaticFiles  # noqa: E402
from pydantic import BaseModel, ConfigDict, Field  # noqa: E402

from server import db, twin, ws  # noqa: E402
from server.floorplan import (  # noqa: E402
    NoVisionKey, PlanError, guess_kind, new_site_id, parse_plan_with_claude, sanity_fix, validate_building,
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


@app.post("/api/sites")
async def create_site(name: str = Form(...), lat: float = Form(...), lon: float = Form(...),
                      file: UploadFile = File(...), kind: str | None = Form(None),
                      width_m: float | None = Form(None), preview: bool = Form(False)) -> dict:
    """Create a site from a building.json or a floor-plan image/PDF (Claude vision)."""
    _ensure_seeded()
    name = name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="The site needs a name.")
    content = await file.read()
    if not content:
        raise HTTPException(status_code=400, detail="The uploaded file is empty.")
    filename = (file.filename or "").lower()
    media_type = (file.content_type or "").lower()
    site_id = new_site_id(name)
    if filename.endswith(".json") or media_type == "application/json":
        try:
            building = validate_building(json.loads(content), site_id, name)
        except json.JSONDecodeError as error:
            raise HTTPException(status_code=400, detail=f"Not valid JSON: {error}") from error
        except PlanError as error:
            raise HTTPException(status_code=400, detail=str(error)) from error
        source = building["building"].get("source", "user_upload")
    else:
        if filename.endswith(".pdf"):
            media_type = "application/pdf"
        elif not media_type.startswith("image/"):
            guessed = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp"}
            media_type = next((v for k, v in guessed.items() if filename.endswith(k)), "")
            if not media_type:
                raise HTTPException(status_code=400, detail="Upload a building.json, a PNG/JPG floor plan or a PDF.")
        try:
            building = await asyncio.to_thread(parse_plan_with_claude, content, media_type, site_id, name, width_m)
        except NoVisionKey as error:
            raise HTTPException(status_code=501, detail=str(error)) from error
        except PlanError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error
        source = "floor_plan"
    building, warnings = sanity_fix(building)
    if preview:
        return {"building": building, "warnings": warnings}
    folder = db.storage_dir() / "sites" / site_id
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "building.json").write_text(json.dumps(building, indent=1, ensure_ascii=False), encoding="utf-8")
    if source == "floor_plan":
        suffix = ".pdf" if media_type == "application/pdf" else "." + media_type.split("/")[-1]
        (folder / f"plan{suffix}").write_bytes(content)
    site = twin.create_site_row({
        "id": site_id, "name": name, "lat": lat, "lon": lon, "source": source,
        "building_id": building["building"].get("id", site_id),
        "data_path": str((folder).relative_to(db.ROOT)) if folder.is_relative_to(db.ROOT) else str(folder),
        "floors": len(building["floors"]), "demo_location": False, "kind": kind or guess_kind(name),
    })
    return {**site, "warnings": warnings}


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
