"""Capture job persistence (JSON files in storage/captures/<job_id>/job.json) and the seams to D's server.

Public interface for the server (agent D):
    capture.store.list_deliveries(site_id) -> list[Delivery]     # merged into /api/sites/{id}/state
    capture.store.list_room_scans(site_id) -> list[RoomScan]
Completed deliveries are also pushed into D's store via server.twin.add_delivery (event + WS broadcast)
when the server package is importable; otherwise capture broadcasts the event itself.
"""

from __future__ import annotations

import asyncio
import importlib
import json
import logging
import os
import threading
import uuid
from datetime import UTC, datetime
from pathlib import Path

log = logging.getLogger("sitetwin.capture")

ROOT = Path(__file__).resolve().parent.parent
_lock = threading.RLock()
_jobs: dict[str, dict] = {}


def storage_dir() -> Path:
    path = Path(os.environ.get("SITETWIN_STORAGE", ROOT / "storage"))
    path.mkdir(parents=True, exist_ok=True)
    return path


def captures_dir() -> Path:
    path = storage_dir() / "captures"
    path.mkdir(parents=True, exist_ok=True)
    return path


def job_dir(job_id: str) -> Path:
    path = captures_dir() / job_id
    path.mkdir(parents=True, exist_ok=True)
    return path


def storage_url(path: Path) -> str:
    return "/storage/" + path.resolve().relative_to(storage_dir().resolve()).as_posix()


def now_iso() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")


def new_job_id(kind: str) -> str:
    return f"cap-{kind[:3]}-{uuid.uuid4().hex[:10]}"


# ---------------------------------------------------------------- jobs


def save_job(job: dict) -> dict:
    with _lock:
        _jobs[job["id"]] = job
        path = job_dir(job["id"]) / "job.json"
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(job, ensure_ascii=False, default=str), encoding="utf-8")
        tmp.replace(path)
    return job


def load_job(job_id: str) -> dict | None:
    with _lock:
        if job_id in _jobs:
            return _jobs[job_id]
    if "/" in job_id or ".." in job_id:
        return None
    path = captures_dir() / job_id / "job.json"
    if not path.exists():
        return None
    try:
        job = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    with _lock:
        _jobs[job_id] = job
    return job


def list_jobs(site_id: str | None = None, kind: str | None = None) -> list[dict]:
    jobs = []
    for path in captures_dir().glob("*/job.json"):
        job = load_job(path.parent.name)
        if job is None:
            continue
        if site_id and job.get("site_id") != site_id:
            continue
        if kind and job.get("kind") != kind:
            continue
        jobs.append(job)
    jobs.sort(key=lambda job: job.get("created_at", ""), reverse=True)
    return jobs


def public_job(job: dict) -> dict:
    """The contract's CaptureJob shape (internal bookkeeping fields stripped)."""
    return {key: job.get(key) for key in ("id", "kind", "site_id", "status", "progress", "message", "result")
            if key != "result" or job.get("result") is not None}


def list_deliveries(site_id: str) -> list[dict]:
    """Completed deliveries captured for this site, newest first (contract Delivery shape)."""
    return [job["result"] for job in list_jobs(site_id, "delivery") if job.get("status") == "done" and job.get("result")]


def list_room_scans(site_id: str) -> list[dict]:
    return [job["result"] for job in list_jobs(site_id, "room") if job.get("status") == "done" and job.get("result")]


# ---------------------------------------------------------------- seams to the server (agent D)


def _server_twin():
    try:
        return importlib.import_module("server.twin")
    except Exception:  # noqa: BLE001 — capture also runs (and is tested) without the server
        return None


_local_maps: dict[str, object] = {}


def _find_building_file(site_id: str) -> Path | None:
    candidates = [storage_dir() / "sites" / site_id / "building.json"]
    sites_json = ROOT / "data" / "sites.json"
    if sites_json.exists():
        try:
            sites = json.loads(sites_json.read_text(encoding="utf-8"))
            sites = sites.get("sites", sites) if isinstance(sites, dict) else sites
            for site in sites:
                if site.get("id") == site_id or site.get("building_id") == site_id:
                    data_path = Path(site.get("data_path", ""))
                    for base in (ROOT, ROOT / "data"):
                        path = data_path if data_path.is_absolute() else base / data_path
                        candidates.append(path if path.suffix == ".json" else path / "building.json")
        except (OSError, json.JSONDecodeError, AttributeError):
            pass
    candidates += sorted((ROOT / "data").glob(f"*/{site_id}/building.json"))
    return next((path for path in candidates if path.exists()), None)


def get_building_map(site_id: str):
    """The site's BuildingMap with live closures (D's cached map when the server is present)."""
    twin = _server_twin()
    if twin is not None:
        try:
            return twin.get_map(site_id)
        except Exception as error:  # noqa: BLE001 — unknown to D's DB: try the dataset directly
            log.info("server map for %s unavailable (%s); loading from data/", site_id, error)
    if site_id not in _local_maps:
        path = _find_building_file(site_id)
        if path is None:
            raise LookupError(f"Unknown site '{site_id}'.")
        from core.building_map import BuildingMap

        _local_maps[site_id] = BuildingMap.load(path)
    return _local_maps[site_id]


async def broadcast(message: dict) -> None:
    try:
        from server.ws import broadcast as server_broadcast
    except Exception:  # noqa: BLE001
        return
    try:
        await server_broadcast(message)
    except Exception as error:  # noqa: BLE001
        log.warning("broadcast failed: %s", error)


async def record_delivery(delivery: dict, title: str) -> None:
    """Make the delivery part of the site state + emit the 'delivery' event."""
    twin = _server_twin()
    if twin is not None and hasattr(twin, "add_delivery"):
        try:
            await asyncio.to_thread(twin.add_delivery, delivery, True, title)
            return
        except Exception as error:  # noqa: BLE001
            log.warning("server.twin.add_delivery failed (%s); broadcasting directly", error)
    await broadcast({"type": "event", "event": {
        "id": f"ev-{delivery['id']}", "ts": delivery["ts"], "site_id": delivery["site_id"],
        "type": "delivery", "title": title, "payload": delivery,
    }})


async def record_capture_event(site_id: str, title: str, payload: dict) -> None:
    twin = _server_twin()
    if twin is not None and hasattr(twin, "record_event"):
        try:
            await asyncio.to_thread(twin.record_event, site_id, "capture", title, payload)
            return
        except Exception as error:  # noqa: BLE001
            log.warning("server.twin.record_event failed: %s", error)
    await broadcast({"type": "event", "event": {
        "id": f"ev-{payload.get('id', uuid.uuid4().hex[:8])}", "ts": now_iso(), "site_id": site_id,
        "type": "capture", "title": title, "payload": payload,
    }})
