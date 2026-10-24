"""Photo → GLB of the delivered item, in metres, origin at the base centre (glTF: Y up, W along X, D along Z).

With FAL_KEY: fal.ai queue REST API (default model fal-ai/hunyuan3d/v2, override with FAL_IMAGE_TO_3D_MODEL),
download the GLB and rescale it to the measured W × D × H.
Without a key (or on any failure): a procedural pallet + load box textured with the cropped photo.
"""

from __future__ import annotations

import asyncio
import base64
import io
import logging
import os
from pathlib import Path

import cv2
import httpx
import numpy as np
import trimesh
from PIL import Image

log = logging.getLogger(__name__)

FAL_MODEL = os.environ.get("FAL_IMAGE_TO_3D_MODEL", "fal-ai/hunyuan3d/v2")
FAL_QUEUE = "https://queue.fal.run"
PALLET_HEIGHT_M = 0.144


# ---------------------------------------------------------------- procedural fallback


def _material(color: tuple[int, int, int, int] | None = None, image: Image.Image | None = None,
              roughness: float = 0.85) -> trimesh.visual.material.PBRMaterial:
    return trimesh.visual.material.PBRMaterial(
        baseColorFactor=color, baseColorTexture=image, metallicFactor=0.0, roughnessFactor=roughness,
    )


def _colored_box(extents, center, color) -> trimesh.Trimesh:
    box = trimesh.creation.box(extents=extents)
    box.apply_translation(center)
    box.visual = trimesh.visual.TextureVisuals(material=_material(color))
    return box


def _textured_box(extents, center, image: Image.Image) -> trimesh.Trimesh:
    """Box with per-face UVs so every side shows the photo crop (top a darker crop)."""
    w, h, d = extents
    corners = {
        "+z": [(-w, -h, d), (w, -h, d), (w, h, d), (-w, h, d)],     # front
        "-z": [(w, -h, -d), (-w, -h, -d), (-w, h, -d), (w, h, -d)],  # back
        "+x": [(w, -h, d), (w, -h, -d), (w, h, -d), (w, h, d)],
        "-x": [(-w, -h, -d), (-w, -h, d), (-w, h, d), (-w, h, -d)],
        "+y": [(-w, h, d), (w, h, d), (w, h, -d), (-w, h, -d)],      # top
        "-y": [(-w, -h, -d), (w, -h, -d), (w, -h, d), (-w, -h, d)],
    }
    vertices, faces, uvs = [], [], []
    for name, quad in corners.items():
        base = len(vertices)
        vertices += [(x / 2, y / 2, z / 2) for x, y, z in quad]
        # Sides use the full photo; top/bottom a small central patch (reads as cardboard/wrap).
        uv = [(0, 0), (1, 0), (1, 1), (0, 1)] if name not in ("+y", "-y") else [(0.4, 0.8), (0.6, 0.8), (0.6, 0.95), (0.4, 0.95)]
        uvs += uv
        faces += [(base, base + 1, base + 2), (base, base + 2, base + 3)]
    mesh = trimesh.Trimesh(vertices=np.array(vertices) , faces=np.array(faces), process=False)
    mesh.apply_translation(center)
    mesh.visual = trimesh.visual.TextureVisuals(uv=np.array(uvs, float), material=_material(image=image))
    return mesh


def _pallet(w: float, d: float, height: float) -> list[trimesh.Trimesh]:
    wood, dark = (196, 160, 112, 255), (150, 118, 80, 255)
    deck = 0.022
    parts = []
    slats = max(3, int(round(w / 0.25)))
    slat_w = min(0.145, w / slats * 0.8)
    for i in range(slats):  # top deck boards along D
        x = -w / 2 + slat_w / 2 + i * (w - slat_w) / (slats - 1)
        parts.append(_colored_box((slat_w, deck, d), (x, height - deck / 2, 0), wood))
    block_h = height - 2 * deck
    for x in (-w / 2 + 0.05, 0, w / 2 - 0.05):  # 9 blocks
        for z in (-d / 2 + 0.05, 0, d / 2 - 0.05):
            parts.append(_colored_box((0.1, block_h, 0.1), (x, deck + block_h / 2, z), dark))
    for z in (-d / 2 + 0.05, 0, d / 2 - 0.05):  # bottom runners along W
        parts.append(_colored_box((w, deck, 0.1), (0, deck / 2, z), wood))
    return parts


def procedural_glb(dims: dict, crop_bgr: np.ndarray | None, path: Path) -> Path:
    w, d, h = float(dims["w"]), float(dims["d"]), float(dims["h"])
    scene = trimesh.Scene()
    has_pallet = h > 0.35 and min(w, d) > 0.5
    pallet_h = PALLET_HEIGHT_M if has_pallet else 0.0
    if has_pallet:
        for index, part in enumerate(_pallet(w, d, pallet_h)):
            scene.add_geometry(part, node_name=f"pallet_{index}")
    load_w, load_d, load_h = (w * 0.97, d * 0.97, h - pallet_h) if has_pallet else (w, d, h)
    if crop_bgr is not None and crop_bgr.size:
        rgb = cv2.cvtColor(crop_bgr, cv2.COLOR_BGR2RGB)
        image = Image.fromarray(rgb)
        image.thumbnail((512, 512))
        load = _textured_box((load_w, load_h, load_d), (0, pallet_h + load_h / 2, 0), image)
    else:
        load = _colored_box((load_w, load_h, load_d), (0, pallet_h + load_h / 2, 0), (176, 132, 82, 255))
    scene.add_geometry(load, node_name="load")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(scene.export(file_type="glb"))
    return path


# ---------------------------------------------------------------- fal.ai


def rescale_glb(data: bytes, dims: dict, path: Path) -> Path:
    """Rescale any GLB to W × H × D metres (glTF Y up), origin at the base centre."""
    loaded = trimesh.load(io.BytesIO(data), file_type="glb", force="scene")
    bounds = loaded.bounds
    size = np.maximum(bounds[1] - bounds[0], 1e-6)
    target = np.array([dims["w"], dims["h"], dims["d"]], float)
    # Generated meshes have arbitrary horizontal orientation; match the longer footprint side to W.
    if (size[0] < size[2]) != (target[0] < target[2]):
        loaded.apply_transform(trimesh.transformations.rotation_matrix(np.pi / 2, [0, 1, 0]))
        bounds = loaded.bounds
        size = np.maximum(bounds[1] - bounds[0], 1e-6)
    centre_base = np.array([(bounds[0][0] + bounds[1][0]) / 2, bounds[0][1], (bounds[0][2] + bounds[1][2]) / 2])
    transform = np.eye(4)
    transform[:3, :3] = np.diag(target / size)
    transform[:3, 3] = -centre_base * (target / size)
    loaded.apply_transform(transform)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(loaded.export(file_type="glb"))
    return path


def _find_glb_url(payload) -> str | None:
    if isinstance(payload, dict):
        for key in ("model_mesh", "model_glb", "glb", "mesh", "model"):
            value = payload.get(key)
            if isinstance(value, dict) and isinstance(value.get("url"), str):
                return value["url"]
        for value in payload.values():
            found = _find_glb_url(value)
            if found:
                return found
    elif isinstance(payload, list):
        for value in payload:
            found = _find_glb_url(value)
            if found:
                return found
    elif isinstance(payload, str) and payload.startswith("http") and ".glb" in payload:
        return payload
    return None


async def fal_image_to_3d(photo_jpeg: bytes, timeout_s: float = 240.0, on_progress=None) -> bytes | None:
    key = os.environ.get("FAL_KEY")
    if not key:
        return None
    headers = {"Authorization": f"Key {key}"}
    data_uri = "data:image/jpeg;base64," + base64.b64encode(photo_jpeg).decode()
    body = {"input_image_url": data_uri, "image_url": data_uri, "textured_mesh": True}
    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            submit = await client.post(f"{FAL_QUEUE}/{FAL_MODEL}", json=body, headers=headers)
            submit.raise_for_status()
            job = submit.json()
            request_id = job["request_id"]
            status_url = job.get("status_url") or f"{FAL_QUEUE}/{FAL_MODEL}/requests/{request_id}/status"
            response_url = job.get("response_url") or f"{FAL_QUEUE}/{FAL_MODEL}/requests/{request_id}"
            elapsed = 0.0
            while elapsed < timeout_s:
                status = (await client.get(status_url, headers=headers)).json()
                state = status.get("status")
                if on_progress:
                    await on_progress(min(0.95, elapsed / 90.0), f"fal.ai {FAL_MODEL}: {state.lower() if state else '…'}")
                if state == "COMPLETED":
                    break
                if state in ("FAILED", "ERROR"):
                    log.warning("fal job failed: %s", status)
                    return None
                await asyncio.sleep(2.0)
                elapsed += 2.0
            else:
                log.warning("fal job timed out")
                return None
            result = (await client.get(response_url, headers=headers)).json()
            url = _find_glb_url(result)
            if not url:
                log.warning("fal result without GLB: %s", str(result)[:300])
                return None
            glb = await client.get(url, timeout=120.0)
            glb.raise_for_status()
            return glb.content
    except Exception as error:  # noqa: BLE001 — fall back to the procedural model
        log.warning("fal.ai image-to-3D failed: %s", error)
        return None


async def build_model(dims: dict, crop_bgr: np.ndarray | None, out_path: Path, on_progress=None) -> tuple[Path, str]:
    """Returns (glb path, method) where method is 'fal:<model>' or 'procedural'."""
    if os.environ.get("FAL_KEY") and crop_bgr is not None and crop_bgr.size:
        ok, jpeg = cv2.imencode(".jpg", crop_bgr, [cv2.IMWRITE_JPEG_QUALITY, 92])
        if ok:
            glb = await fal_image_to_3d(jpeg.tobytes(), on_progress=on_progress)
            if glb:
                try:
                    return await asyncio.to_thread(rescale_glb, glb, dims, out_path), f"fal:{FAL_MODEL}"
                except Exception as error:  # noqa: BLE001
                    log.warning("could not rescale fal GLB: %s", error)
    return await asyncio.to_thread(procedural_glb, dims, crop_bgr, out_path), "procedural"
