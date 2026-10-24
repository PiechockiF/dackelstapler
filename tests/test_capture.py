"""Capture pipeline (agent C): marker, measurement, 3D model, dimension check, room scan alignment, router."""

from __future__ import annotations

import json
import math
import time
from pathlib import Path

import cv2
import numpy as np
import pytest

from capture.aruco import MARKER_SIZE_M, detect_marker, marker_page, marker_pdf_bytes
from capture.measure import measure_photos
from capture.synthetic import render_scene, sample_jpeg

ROOT = Path(__file__).resolve().parent.parent
FACTORY = ROOT / "data" / "dev" / "proc-factory-dev-003"
SITE = "proc-factory-dev-003"


def jpeg(image: np.ndarray) -> bytes:
    ok, data = cv2.imencode(".jpg", image, [cv2.IMWRITE_JPEG_QUALITY, 92])
    assert ok
    return data.tobytes()


def factory_map():
    from core.building_map import BuildingMap

    return BuildingMap(json.loads((FACTORY / "building.json").read_text()))


# ---------------------------------------------------------------- marker


def test_marker_pdf_is_a4():
    data = marker_pdf_bytes()
    assert data.startswith(b"%PDF")
    assert b"MediaBox [ 0 0 595.27" in data and b"841.88" in data  # 210 x 297 mm in points


def test_printed_marker_is_150_mm():
    page = np.array(marker_page())  # 10 px per mm
    detection = detect_marker(cv2.cvtColor(page, cv2.COLOR_GRAY2BGR))
    assert detection is not None
    edges = [np.linalg.norm(detection.corners[i] - detection.corners[(i + 1) % 4]) for i in range(4)]
    assert all(abs(edge - MARKER_SIZE_M * 1000 * 10) < 3 for edge in edges)


def test_marker_detection_and_pose_on_synthetic_photo():
    scene = render_scene(dims=(1.2, 0.8, 1.0))
    detection = detect_marker(scene["image"], focal_px=scene["focal_px"])
    assert detection is not None
    assert np.abs(detection.corners - scene["corners"]).max() < 1.5
    true_camera = np.array([0.6, -2.4, 1.7])
    assert np.linalg.norm(detection.camera_position - true_camera) < 0.05
    # Floor homography maps the marker's own corners back to ±7.5 cm.
    floor = detection.image_to_floor(detection.corners)
    assert np.allclose(np.abs(floor), MARKER_SIZE_M / 2, atol=0.003)


def test_no_marker_returns_none():
    assert detect_marker(np.full((480, 640, 3), 128, np.uint8)) is None


# ---------------------------------------------------------------- measurement


@pytest.mark.parametrize("case", [
    dict(dims=(1.2, 0.8, 1.0)),
    dict(dims=(1.32, 1.05, 1.40), box_center=(0.15, 1.25), box_yaw_deg=8, camera=(1.1, -2.6, 1.75)),
    dict(dims=(0.6, 0.4, 0.5), box_center=(0.5, 0.6), box_yaw_deg=30, camera=(-0.8, -1.6, 1.5)),
    dict(dims=(2.0, 1.7, 0.9), box_center=(-0.4, 1.6), box_yaw_deg=-15, camera=(1.5, -2.2, 2.0)),
])
def test_single_photo_measurement_within_tolerance(case):
    scene = render_scene(**case)
    result = measure_photos([jpeg(scene["image"])])
    assert result.ok and result.method == "marker+silhouette"
    w, d, h = case["dims"]
    true = {"w": max(w, d), "d": min(w, d), "h": h}
    for axis in "wdh":
        assert abs(result.dims[axis] - true[axis]) <= result.tolerance_m, (axis, result.dims, result.tolerance_m)
    assert result.tolerance_m <= 0.1 * max(case["dims"]) + 0.02
    assert result.overlay is not None and result.crop is not None


def test_manual_bbox_and_multi_photo_tighten_tolerance():
    dims = (1.32, 1.05, 1.40)
    views = [(1.1, -2.6, 1.75), (-1.6, -2.0, 1.8), (2.4, -0.6, 1.9)]
    photos, boxes = [], []
    for camera in views:
        scene = render_scene(dims=dims, box_center=(0.15, 1.25), box_yaw_deg=8, camera=camera, seed=len(photos))
        photos.append(jpeg(scene["image"]))
        x0, y0, x1, y1 = scene["bbox"]
        boxes.append([x0 / 1600, y0 / 1200, x1 / 1600, y1 / 1200])
    single = measure_photos(photos[:1], boxes[:1])
    combined = measure_photos(photos, boxes)
    assert combined.ok and len([p for p in combined.photos if p.ok]) == 3
    assert combined.tolerance_m <= single.tolerance_m
    for axis, value in zip("wdh", dims):
        assert abs(combined.dims[axis] - value) <= combined.tolerance_m


def test_measurement_without_marker_falls_back_to_declared():
    blank = np.full((900, 1200, 3), 140, np.uint8)
    cv2.rectangle(blank, (400, 300), (800, 700), (40, 90, 160), -1)
    result = measure_photos([jpeg(blank)], declared={"w": 1.2, "d": 0.8, "h": 1.1})
    assert not result.ok and result.method == "declared"
    assert result.dims == {"w": 1.2, "d": 0.8, "h": 1.1}
    assert "marker" in result.message


# ---------------------------------------------------------------- 3D model


def test_procedural_glb_has_measured_extents(tmp_path):
    import trimesh

    from capture.image_to_3d import procedural_glb, rescale_glb

    crop = render_scene()["image"][300:700, 580:1040]
    path = procedural_glb({"w": 1.32, "d": 1.05, "h": 1.4}, crop, tmp_path / "model.glb")
    bounds = trimesh.load(path).bounds
    assert np.allclose(bounds[0], [-0.66, 0.0, -0.525], atol=1e-3)
    assert np.allclose(bounds[1], [0.66, 1.4, 0.525], atol=1e-3)
    rescaled = rescale_glb(path.read_bytes(), {"w": 2.0, "d": 1.0, "h": 0.5}, tmp_path / "scaled.glb")
    assert np.allclose(trimesh.load(rescaled).bounds, [[-1, 0, -0.5], [1, 0.5, 0.5]], atol=1e-3)


# ---------------------------------------------------------------- dimension check


def test_receiving_space_is_the_logistics_zone():
    from capture.dimension_check import receiving_space

    receiving = receiving_space(factory_map())
    assert receiving["space_id"] == f"{SITE}-F0-S015"  # Logistics zone H-C5, next to the 5 m aisle entrance


def test_matching_item_fits_and_is_placed_in_target():
    from capture.dimension_check import check_delivery

    bm = factory_map()
    result = check_delivery(bm, {"w": 1.32, "d": 1.05, "h": 1.4}, 0.04, {"w": 1.3, "d": 1.0, "h": 1.4}, "Quality lab 0.21")
    check = result["check"]
    assert result["status"] == "ok"
    assert check["declared"]["ok"] and check["route_fit"]["ok"] and check["floor_fit"]["ok"]
    assert check["route_fit"]["route"]["reachable"] and check["route_fit"]["route"]["floors"]
    assert result["space_id"] == f"{SITE}-F0-S021"
    from shapely.geometry import Point, Polygon
    assert Polygon(bm.spaces[result["space_id"]]["polygon"]).contains(Point(result["position"]))
    assert check["summary"].startswith("1.32 × 1.05 × 1.40 m (±4 cm). Matches PO")


def test_too_wide_item_is_blocked_with_blocking_openings():
    from capture.dimension_check import check_delivery

    bm = factory_map()
    result = check_delivery(bm, {"w": 1.8, "d": 1.7, "h": 1.0}, 0.04, None, "Quality lab 0.21")
    fit = result["check"]["route_fit"]
    assert result["status"] == "blocked" and not fit["ok"]
    assert [o["id"] for o in fit["blocking_openings"]] == [f"{SITE}-F0-O0026"]
    assert fit["blocking_openings"][0]["width_m"] == 1.6
    assert "alternative" not in fit
    assert result["space_id"] == f"{SITE}-F0-S015"  # stays at the dock
    assert "Won't pass door 0.21 (1.60 m)" in result["check"]["summary"]


def test_blocked_direct_route_offers_alternative():
    from capture.dimension_check import check_delivery

    bm = factory_map()
    bm.openings[f"{SITE}-F0-O0054"]["width_m"] = 1.2  # narrow the office-corridor entrance
    result = check_delivery(bm, {"w": 1.5, "d": 1.4, "h": 1.2}, 0.04, None, "Office corridor 0.16")
    fit = result["check"]["route_fit"]
    assert not fit["ok"] and result["status"] == "ok"
    assert [o["id"] for o in fit["blocking_openings"]] == [f"{SITE}-F0-O0054"]
    alternative = fit["alternative"]
    assert alternative["reachable"] and f"{SITE}-F0-S033" in alternative["space_path"]
    assert "alternative via Hall access 0.33" in result["check"]["summary"]


def test_declared_mismatch():
    from capture.dimension_check import check_delivery

    result = check_delivery(factory_map(), {"w": 1.2, "d": 0.8, "h": 1.0}, 0.03, {"w": 1.2, "d": 0.8, "h": 1.5}, None)
    assert result["status"] == "mismatch"
    assert result["check"]["declared"]["deviation_m"]["h"] == pytest.approx(-0.5)
    assert result["check"]["route_fit"] is None


# ---------------------------------------------------------------- room scan


@pytest.mark.parametrize("space", ["F0-S020", "F0-S021", "F1-S004"])
def test_demo_scan_alignment_finds_the_offset_wall(tmp_path, space):
    import asyncio

    from capture.splat_io import read_points
    from capture.splat_job import align_file, generate_demo_splat, room_context

    bm = factory_map()
    context = room_context(bm, f"{SITE}-{space}")
    truth = generate_demo_splat(context["polygon"], tmp_path / "scan.ply", assets=context["assets"],
                                door_positions=context["doors"], room_height_m=context["height_m"], seed=5)
    alignment = asyncio.run(align_file(tmp_path / "scan.ply", context))
    offsets = {d["wall_index"]: d["offset_m"] for d in alignment["deviations"]}
    assert offsets[truth["deviation_wall"]] == pytest.approx(0.4, abs=0.05)
    assert all(abs(v) < 0.06 for k, v in offsets.items() if k != truth["deviation_wall"])
    # The transform puts the scan's floor at the floor elevation and inside the room.
    M = np.array(alignment["transform"]).reshape(4, 4, order="F")
    points = read_points(tmp_path / "scan.ply")
    building = (M[:3, :3] @ points.T).T + M[:3, 3]
    assert abs(np.percentile(building[:, 2], 5) - context["elevation_m"]) < 0.05
    from capture.align import inside_fraction
    assert inside_fraction(building[:, :2], context["polygon"], margin_m=0.5) > 0.97


# ---------------------------------------------------------------- router


@pytest.fixture()
def client(tmp_path, monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    monkeypatch.setenv("SITETWIN_STORAGE", str(tmp_path))
    for key in ("ANTHROPIC_API_KEY", "FAL_KEY", "MODAL_TOKEN_ID"):
        monkeypatch.delenv(key, raising=False)
    try:
        from server import db
        db.reset_engine()
    except Exception:  # noqa: BLE001
        pass
    from capture.router import router

    app = FastAPI()
    app.include_router(router)
    with TestClient(app) as test_client:
        yield test_client


def wait_for(client, job_id: str, timeout: float = 90.0) -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        job = client.get(f"/api/capture/jobs/{job_id}").json()
        if job["status"] in ("done", "failed"):
            return job
        time.sleep(0.25)
    raise AssertionError(f"job {job_id} did not finish: {job}")


def test_router_delivery_flow(client, tmp_path):
    photo = sample_jpeg((1.32, 1.05, 1.40))
    response = client.post(
        "/api/capture/delivery",
        data={"site_id": SITE, "declared_w": "1.30", "declared_d": "1.00", "declared_h": "1.40",
              "target_space": "Quality lab 0.21", "label": "Pallet with steel drum", "note": "LS-4711"},
        files=[("photos", ("pallet.jpg", photo, "image/jpeg"))],
    )
    assert response.status_code == 200, response.text
    job = response.json()
    assert job["kind"] == "delivery" and job["status"] in ("queued", "measuring", "modeling", "done")
    job = wait_for(client, job["id"])
    assert job["status"] == "done", job["message"]
    delivery = job["result"]
    for key in ("id", "site_id", "ts", "label", "dims_m", "tolerance_m", "floor_id", "space_id", "position",
                "rotation_deg", "photo_url", "model_url", "status", "check"):
        assert key in delivery
    assert delivery["label"] == "Pallet with steel drum" and delivery["note"] == "LS-4711"
    assert abs(delivery["dims_m"]["w"] - 1.32) <= delivery["tolerance_m"]
    assert delivery["check"]["declared"]["ok"] and delivery["status"] == "ok"
    assert delivery["target_space_id"] == f"{SITE}-F0-S021"
    assert (tmp_path / delivery["model_url"].removeprefix("/storage/")).exists()
    assert (tmp_path / delivery["photo_url"].removeprefix("/storage/")).exists()
    from capture.store import list_deliveries
    assert [d["id"] for d in list_deliveries(SITE)] == [delivery["id"]]
    listed = client.get("/api/capture/jobs", params={"site_id": SITE}).json()
    assert listed[0]["id"] == job["id"]


def test_router_room_scan_demo(client):
    response = client.post("/api/capture/room", data={"site_id": SITE, "space_id": "Meeting room 0.20"})
    assert response.status_code == 200, response.text
    job = wait_for(client, response.json()["id"])
    assert job["status"] == "done", job["message"]
    scan = job["result"]
    assert scan["space_id"] == f"{SITE}-F0-S020" and len(scan["transform"]) == 16
    assert scan["splat_url"].endswith(".ply") and "demo scan" in scan["summary"]
    assert any(abs(d["offset_m"]) > 0.3 for d in scan["deviations"])
    assert client.get("/api/capture/rooms", params={"site_id": SITE}).json()[0]["id"] == scan["id"]


def test_router_errors_and_marker(client):
    assert client.get("/api/capture/marker.pdf").content.startswith(b"%PDF")
    assert client.get("/api/capture/sample.jpg").headers["content-type"] == "image/jpeg"
    photo = ("p.jpg", sample_jpeg(), "image/jpeg")
    missing = client.post("/api/capture/delivery", data={"site_id": "no-such-site"}, files=[("photos", photo)])
    assert missing.status_code == 404
    bad_target = client.post("/api/capture/delivery", data={"site_id": SITE, "target_space": "Narnia 9.99"},
                             files=[("photos", photo)])
    assert bad_target.status_code == 400
    partial = client.post("/api/capture/delivery", data={"site_id": SITE, "declared_w": "1.2"}, files=[("photos", photo)])
    assert partial.status_code == 400
    assert client.get("/api/capture/jobs/cap-del-nope").status_code == 404
    assert math.isfinite(1.0)
