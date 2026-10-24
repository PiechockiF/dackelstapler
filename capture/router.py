"""/api/capture — phone capture endpoints (agent C). Mounted by server/main.py: app.include_router(router).

Contract endpoints:
  POST /api/capture/delivery    multipart site_id, photos[] (1–4), declared_w/d/h, target_space, label, note
                                (+ optional bboxes: JSON list, per photo [x0,y0,x1,y1] in 0..1 or null)
  POST /api/capture/room        multipart site_id, space_id, video | splat (+ optional up_axis, corners JSON)
  GET  /api/capture/jobs/{id}   CaptureJob
  GET  /api/capture/marker.pdf  printable A4 marker
Extras:
  GET  /api/capture/jobs?site_id=&kind=      recent CaptureJob[]
  GET  /api/capture/deliveries?site_id=      Delivery[] captured for the site
  GET  /api/capture/rooms?site_id=           RoomScan[] for the site (newest first)
  GET  /api/capture/sample.jpg?w=&d=&h=      synthetic photo with marker + crate (demo without a printed marker)
  GET  /api/capture/host                     {lan_ip, hostname} for the desktop QR code
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
import zlib
from pathlib import Path

import cv2
from fastapi import APIRouter, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import Response

from . import store
from .aruco import marker_pdf_bytes
from .dimension_check import check_delivery, describe_dims, space_label
from .image_to_3d import build_model
from .measure import classify_label, measure_photos
from .splat_job import align_file, generate_demo_splat, modal_available, room_context, summary_for, train_on_modal
from .synthetic import sample_jpeg
from .vision import analyze_photo
from .vision import available as vision_available

log = logging.getLogger("sitetwin.capture")
router = APIRouter(prefix="/api/capture", tags=["capture"])

MAX_PHOTOS = 4
MAX_PHOTO_BYTES = 30 * 1024 * 1024
MAX_UPLOAD_BYTES = 800 * 1024 * 1024
SPLAT_SUFFIXES = {".ply", ".spz", ".splat"}
_tasks: dict[str, asyncio.Task] = {}


# ---------------------------------------------------------------- helpers


def _float(value: str | None, name: str) -> float | None:
    if value is None or str(value).strip() == "":
        return None
    try:
        number = float(str(value).replace(",", "."))
    except ValueError as error:
        raise HTTPException(400, f"{name} must be a number in metres") from error
    if not 0.01 <= number <= 40:
        raise HTTPException(400, f"{name} must be between 0.01 and 40 m")
    return number


async def _site_map(site_id: str):
    try:
        return await asyncio.to_thread(store.get_building_map, site_id)
    except LookupError as error:
        raise HTTPException(404, str(error)) from error
    except Exception as error:  # noqa: BLE001
        raise HTTPException(404, f"Unknown site '{site_id}': {error}") from error


def _resolve_space(bm, reference: str | None) -> str | None:
    if not reference or not reference.strip():
        return None
    try:
        return bm.resolve_space(reference.strip())
    except Exception as error:  # noqa: BLE001 — MapError: unknown / ambiguous
        raise HTTPException(400, str(error)) from error


async def _save_upload(upload: UploadFile, path: Path, limit: int) -> int:
    size = 0
    with path.open("wb") as handle:
        while chunk := await upload.read(1024 * 1024):
            size += len(chunk)
            if size > limit:
                handle.close()
                path.unlink(missing_ok=True)
                raise HTTPException(413, f"{upload.filename or 'file'} is larger than {limit // (1024 * 1024)} MB")
            handle.write(chunk)
    return size


def _new_job(kind: str, site_id: str, message: str) -> dict:
    job_id = store.new_job_id(kind)
    return store.save_job({
        "id": job_id, "kind": kind, "site_id": site_id, "status": "queued", "progress": 0.0,
        "message": message, "created_at": store.now_iso(), "updated_at": store.now_iso(),
    })


async def _progress(job: dict, status: str, progress: float, message: str, result: dict | None = None) -> None:
    job.update(status=status, progress=round(max(job.get("progress", 0.0), progress) if status != "failed" else job.get("progress", 0.0), 3),
               message=message, updated_at=store.now_iso())
    if result is not None:
        job["result"] = result
    store.save_job(job)
    await store.broadcast({"type": "capture_progress", "job": store.public_job(job)})


def _start(job: dict, coroutine) -> None:
    task = asyncio.create_task(coroutine)
    _tasks[job["id"]] = task
    task.add_done_callback(lambda _: _tasks.pop(job["id"], None))


def _existing_deliveries(site_id: str) -> list[dict]:
    twin = store._server_twin()
    if twin is not None and hasattr(twin, "list_deliveries"):
        try:
            return twin.list_deliveries(site_id)
        except Exception:  # noqa: BLE001
            pass
    return store.list_deliveries(site_id)


def _imwrite(path: Path, image) -> None:
    cv2.imwrite(str(path), image, [cv2.IMWRITE_JPEG_QUALITY, 88])


# ---------------------------------------------------------------- delivery job


async def _run_delivery(job: dict, photo_paths: list[Path], options: dict) -> None:
    started = time.monotonic()
    folder = store.job_dir(job["id"])
    site_id = job["site_id"]
    try:
        photos = [path.read_bytes() for path in photo_paths]
        vision = None
        if vision_available():
            await _progress(job, "measuring", 0.05, "Claude is looking at the photo…")
            vision = await asyncio.to_thread(analyze_photo, photos[0])
        await _progress(job, "measuring", 0.12, "Finding the 150 mm marker and the item outline…")
        measured = await asyncio.to_thread(measure_photos, photos, options.get("bboxes"), options.get("declared"), vision)
        dims, tolerance = measured.dims, measured.tolerance_m
        await _progress(job, "measuring", 0.45, f"{describe_dims(dims)} (±{round(tolerance * 100)} cm) — {measured.message}")
        overlay_url = None
        if measured.overlay is not None:
            await asyncio.to_thread(_imwrite, folder / "overlay.jpg", measured.overlay)
            overlay_url = store.storage_url(folder / "overlay.jpg")

        await _progress(job, "modeling", 0.5, "Building the 3D model…")

        async def model_progress(fraction: float, message: str) -> None:
            await _progress(job, "modeling", 0.5 + 0.3 * fraction, message)

        model_path, model_method = await build_model(dims, measured.crop, folder / "model.glb", on_progress=model_progress)

        await _progress(job, "modeling", 0.85, "Checking doors, route and floor space…")
        bm = await asyncio.to_thread(store.get_building_map, site_id)
        existing = await asyncio.to_thread(_existing_deliveries, site_id)
        checked = await asyncio.to_thread(check_delivery, bm, dims, tolerance, options.get("declared"),
                                          options.get("target_space"), existing)
        label = options.get("label") or (vision or {}).get("label") or classify_label(dims)
        delivery = {
            "id": "dl-" + job["id"].split("-")[-1],
            "site_id": site_id,
            "ts": store.now_iso(),
            "label": label,
            "dims_m": dims,
            "tolerance_m": tolerance,
            "floor_id": checked["floor_id"],
            "space_id": checked["space_id"],
            "position": checked["position"],
            "rotation_deg": checked["rotation_deg"],
            "photo_url": store.storage_url(photo_paths[0]),
            "model_url": store.storage_url(model_path),
            "status": checked["status"],
            "check": checked["check"],
            # extras (not in the contract, safe to ignore)
            "overlay_url": overlay_url,
            "receiving_space_id": checked["receiving"]["space_id"],
            "measure": {"method": measured.method, "message": measured.message, "model": model_method,
                        "photos": len(photos), "seconds": round(time.monotonic() - started, 1)},
        }
        if options.get("note"):
            delivery["note"] = options["note"]
        if options.get("declared"):
            delivery["declared_dims_m"] = options["declared"]
        if checked.get("target_space_id"):
            delivery["target_space_id"] = checked["target_space_id"]
        await _progress(job, "done", 1.0, checked["check"]["summary"], result=delivery)

        where = space_label(bm, checked["space_id"])
        if checked["status"] == "blocked" and checked.get("target_space_id"):
            title = f"{label} at {where} — can't reach {space_label(bm, checked['target_space_id'])}"
        else:
            title = f"{label} delivered to {where}"
        await store.record_delivery(delivery, title)
    except Exception as error:  # noqa: BLE001
        log.exception("delivery capture %s failed", job["id"])
        await _progress(job, "failed", 0.0, f"Capture failed: {error}")


@router.post("/delivery")
async def capture_delivery(
    site_id: str = Form(...),
    photos: list[UploadFile] = File(...),
    declared_w: str | None = Form(None),
    declared_d: str | None = Form(None),
    declared_h: str | None = Form(None),
    target_space: str | None = Form(None),
    label: str | None = Form(None),
    note: str | None = Form(None),
    bboxes: str | None = Form(None),
) -> dict:
    bm = await _site_map(site_id)
    target = _resolve_space(bm, target_space)
    photos = [photo for photo in photos if photo is not None and (photo.filename or photo.size)]
    if not photos:
        raise HTTPException(400, "Add at least one photo of the item with the marker next to it.")
    if len(photos) > MAX_PHOTOS:
        raise HTTPException(400, f"At most {MAX_PHOTOS} photos per delivery.")
    declared_values = [_float(declared_w, "declared_w"), _float(declared_d, "declared_d"), _float(declared_h, "declared_h")]
    declared = None
    if any(v is not None for v in declared_values):
        if not all(v is not None for v in declared_values):
            raise HTTPException(400, "Give all three declared dimensions (W, D, H) or none.")
        declared = dict(zip(("w", "d", "h"), declared_values))
    parsed_bboxes = None
    if bboxes:
        try:
            parsed_bboxes = json.loads(bboxes)
            assert isinstance(parsed_bboxes, list)
        except (ValueError, AssertionError) as error:
            raise HTTPException(400, "bboxes must be a JSON list of [x0, y0, x1, y1] (0..1) or null per photo") from error

    job = _new_job("delivery", site_id, "Uploading photos…")
    folder = store.job_dir(job["id"])
    paths = []
    for index, photo in enumerate(photos):
        suffix = Path(photo.filename or "").suffix.lower() if Path(photo.filename or "").suffix.lower() in (
            ".jpg", ".jpeg", ".png", ".webp", ".heic") else ".jpg"
        path = folder / f"photo_{index}{suffix}"
        await _save_upload(photo, path, MAX_PHOTO_BYTES)
        paths.append(path)
    job["input"] = {"target_space": target, "declared": declared, "label": label, "note": note, "photos": len(paths)}
    await _progress(job, "queued", 0.02, "Queued")
    options = {"declared": declared, "target_space": target, "label": (label or "").strip() or None,
               "note": (note or "").strip() or None, "bboxes": parsed_bboxes}
    _start(job, _run_delivery(job, paths, options))
    return store.public_job(job)


# ---------------------------------------------------------------- room job


async def _run_room(job: dict, space_id: str, video_path: Path | None, splat_path: Path | None,
                    up_axis: str | None, corners: list | None) -> None:
    folder = store.job_dir(job["id"])
    site_id = job["site_id"]
    try:
        bm = await asyncio.to_thread(store.get_building_map, site_id)
        context = room_context(bm, space_id)
        demo, metric, source = False, True, "upload"
        if splat_path is None and video_path is not None and modal_available():
            await _progress(job, "modeling", 0.1, "Training a Gaussian splat on a Modal GPU (≈10 min)…")
            trained = await train_on_modal(video_path, folder / "scan.ply")
            if trained is not None:
                splat_path, metric, source = trained, False, "modal"
        if splat_path is None:
            demo, source = True, "demo"
            reason = "No GPU worker configured" if video_path is not None else "No scan uploaded"
            await _progress(job, "modeling", 0.3, f"{reason} — using the demo scan for {context['space']['name']}…")
            splat_path = folder / "scan.ply"
            await asyncio.to_thread(generate_demo_splat, context["polygon"], splat_path, assets=context["assets"],
                                    door_positions=context["doors"], room_height_m=context["height_m"],
                                    seed=zlib.crc32(space_id.encode()) % 1000)
        await _progress(job, "aligning", 0.6, "Fitting the scan into the floor-plan walls…")
        alignment = await align_file(splat_path, context, up_axis=up_axis, corners=corners) if metric else \
            await asyncio.to_thread(_align_nonmetric, splat_path, context, up_axis, corners)
        summary = summary_for(context, alignment, demo)
        scan = {
            "id": "scan-" + job["id"].split("-")[-1],
            "site_id": site_id,
            "space_id": space_id,
            "splat_url": store.storage_url(splat_path),
            "transform": alignment["transform"],
            "deviations": alignment["deviations"],
            "summary": summary,
            # extras
            "floor_id": context["space"]["floor_id"],
            "source": source,
            "rms_m": round(alignment["rms_m"], 3) if alignment["rms_m"] is not None else None,
            "ts": store.now_iso(),
        }
        await _progress(job, "done", 1.0, summary, result=scan)
        await store.record_capture_event(site_id, f"Room scan of {context['space']['name']}", scan)
    except Exception as error:  # noqa: BLE001
        log.exception("room capture %s failed", job["id"])
        await _progress(job, "failed", 0.0, f"Room scan failed: {error}")


def _align_nonmetric(splat_path: Path, context: dict, up_axis, corners) -> dict:
    from .align import align_scan
    from .splat_io import read_points

    return align_scan(read_points(splat_path), context["polygon"], context["elevation_m"], context["doors"],
                      up_axis, corners, metric=False)


@router.post("/room")
async def capture_room(
    site_id: str = Form(...),
    space_id: str = Form(...),
    video: UploadFile | None = File(None),
    splat: UploadFile | None = File(None),
    up_axis: str | None = Form(None),
    corners: str | None = Form(None),
) -> dict:
    bm = await _site_map(site_id)
    space = _resolve_space(bm, space_id)
    if space is None:
        raise HTTPException(400, "Pick the room that was scanned.")
    parsed_corners = None
    if corners:
        try:
            parsed_corners = json.loads(corners)
        except ValueError as error:
            raise HTTPException(400, "corners must be JSON: [{\"splat\": [x,y,z], \"plan\": [x,y]}, …]") from error
    if up_axis and up_axis not in ("+x", "-x", "+y", "-y", "+z", "-z"):
        raise HTTPException(400, "up_axis must be one of +x -x +y -y +z -z")

    job = _new_job("room", site_id, "Uploading…")
    folder = store.job_dir(job["id"])
    video_path = splat_path = None
    if splat is not None and splat.filename:
        suffix = Path(splat.filename).suffix.lower()
        if suffix not in SPLAT_SUFFIXES:
            raise HTTPException(400, "Splat must be a .ply, .spz or .splat file")
        splat_path = folder / f"upload{suffix}"
        await _save_upload(splat, splat_path, MAX_UPLOAD_BYTES)
    if video is not None and video.filename:
        video_path = folder / ("video" + (Path(video.filename).suffix.lower() or ".mp4"))
        await _save_upload(video, video_path, MAX_UPLOAD_BYTES)
    job["input"] = {"space_id": space, "video": bool(video_path), "splat": bool(splat_path)}
    await _progress(job, "queued", 0.02, "Queued")
    _start(job, _run_room(job, space, video_path, splat_path, up_axis, parsed_corners))
    return store.public_job(job)


# ---------------------------------------------------------------- reads


@router.get("/jobs/{job_id}")
async def get_job(job_id: str) -> dict:
    job = store.load_job(job_id)
    if job is None:
        raise HTTPException(404, f"Unknown capture job '{job_id}'.")
    if job.get("status") not in ("done", "failed") and job_id not in _tasks:
        age = time.time() - _iso_seconds(job.get("updated_at"))
        if age > 120:  # the worker died with the server process
            job.update(status="failed", message="Interrupted (server restarted) — please capture again.")
            store.save_job(job)
    return store.public_job(job)


def _iso_seconds(value: str | None) -> float:
    from datetime import datetime

    try:
        return datetime.fromisoformat((value or "").replace("Z", "+00:00")).timestamp()
    except ValueError:
        return 0.0


@router.get("/jobs")
async def list_jobs(site_id: str | None = None, kind: str | None = None, limit: int = 20) -> list[dict]:
    return [store.public_job(job) for job in store.list_jobs(site_id, kind)[: max(1, min(limit, 200))]]


@router.get("/deliveries")
async def deliveries(site_id: str) -> list[dict]:
    return store.list_deliveries(site_id)


@router.get("/rooms")
async def room_scans(site_id: str) -> list[dict]:
    return store.list_room_scans(site_id)


@router.get("/marker.pdf")
async def marker_pdf() -> Response:
    data = await asyncio.to_thread(marker_pdf_bytes)
    return Response(data, media_type="application/pdf",
                    headers={"Content-Disposition": 'inline; filename="sitetwin-marker-A4.pdf"'})


@router.get("/sample.jpg")
async def sample_photo(w: float = Query(1.32, gt=0.1, lt=4), d: float = Query(1.05, gt=0.1, lt=4),
                       h: float = Query(1.40, gt=0.1, lt=4), seed: int = 3) -> Response:
    data = await asyncio.to_thread(sample_jpeg, (w, d, h), seed)
    return Response(data, media_type="image/jpeg", headers={"Cache-Control": "no-store"})


@router.get("/host")
async def lan_host() -> dict:
    """The server machine's LAN IP, so the desktop QR can point phones at it instead of localhost."""
    import socket

    ip = None
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as probe:
            probe.connect(("10.255.255.255", 1))  # no packet is sent; picks the outbound interface
            ip = probe.getsockname()[0]
    except OSError:
        pass
    return {"lan_ip": ip if ip and not ip.startswith("127.") else None, "hostname": socket.gethostname()}
