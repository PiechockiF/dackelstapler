"""Render a synthetic phone photo: printed marker + a box of known size on a tiled floor.

Used by the tests (ground truth for marker detection and measurement) and by the capture
page's "sample photo" button so the whole flow can be demoed without a printed marker.
"""

from __future__ import annotations

import math

import cv2
import numpy as np

from .aruco import MARKER_SIZE_M, marker_image

FLOOR_TEXTURE_M = 12.0       # floor texture covers [-6, 6] m around the marker
FLOOR_PX_PER_M = 400         # 2.5 mm per texel


def look_at(camera: np.ndarray, target: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """World (Z up) → OpenCV camera (x right, y down, z forward). Returns (R, t)."""
    forward = target - camera
    forward /= np.linalg.norm(forward)
    right = np.cross(forward, np.array([0.0, 0.0, 1.0]))
    right /= np.linalg.norm(right)
    down = np.cross(forward, right)
    R = np.vstack([right, down, forward])
    return R, -R @ camera


def _floor_texture(rng: np.random.Generator) -> np.ndarray:
    side = int(FLOOR_TEXTURE_M * FLOOR_PX_PER_M)
    base = np.full((side, side, 3), (148, 152, 156), np.uint8)
    noise = rng.normal(0, 6, (side // 8, side // 8, 1)).astype(np.float32)
    noise = cv2.resize(noise, (side, side), interpolation=cv2.INTER_LINEAR)[..., None]
    texture = np.clip(base.astype(np.float32) + noise, 0, 255).astype(np.uint8)
    step = int(0.6 * FLOOR_PX_PER_M)  # 60 cm concrete slabs
    for offset in range(0, side, step):
        cv2.line(texture, (offset, 0), (offset, side), (118, 120, 124), 3)
        cv2.line(texture, (0, offset), (side, offset), (118, 120, 124), 3)
    # Marker, printed on a white A4 sheet, centred at the world origin, top edge towards +Y.
    def to_px(x: float, y: float) -> tuple[int, int]:
        return int(round((x + FLOOR_TEXTURE_M / 2) * FLOOR_PX_PER_M)), int(round((FLOOR_TEXTURE_M / 2 - y) * FLOOR_PX_PER_M))

    x0, y0 = to_px(-0.105, 0.115)   # same layout as the printed page: marker 40 mm below the top edge
    x1, y1 = to_px(0.105, -0.182)
    texture[y0:y1, x0:x1] = 250
    side_px = int(round(MARKER_SIZE_M * FLOOR_PX_PER_M))
    mx, my = to_px(-MARKER_SIZE_M / 2, MARKER_SIZE_M / 2)
    texture[my:my + side_px, mx:mx + side_px] = cv2.cvtColor(marker_image(side_px), cv2.COLOR_GRAY2BGR)
    return texture


def render_scene(
    dims: tuple[float, float, float] = (1.2, 0.8, 1.0),
    box_center: tuple[float, float] = (0.0, 1.0),
    box_yaw_deg: float = 0.0,
    camera: tuple[float, float, float] = (0.6, -2.4, 1.7),
    target: tuple[float, float, float] | None = None,
    size: tuple[int, int] = (1600, 1200),
    focal_px: float | None = None,
    seed: int = 0,
) -> dict:
    """Returns {"image": BGR, "K", "R", "t", "bbox": [x0,y0,x1,y1] px of the box, "corners": marker px}."""
    rng = np.random.default_rng(seed)
    width, height = size
    focal = focal_px or 25.0 / 43.27 * math.hypot(width, height)
    K = np.array([[focal, 0, width / 2], [0, focal, height / 2], [0, 0, 1]])
    w, d, h = dims
    cam = np.array(camera, float)
    aim = np.array(target if target is not None else (box_center[0] * 0.6, box_center[1] * 0.6, h * 0.25), float)
    R, t = look_at(cam, aim)

    # Floor via homography texture → image.
    texture = _floor_texture(rng)
    T_world_from_tex = np.array([
        [1 / FLOOR_PX_PER_M, 0, -FLOOR_TEXTURE_M / 2],
        [0, -1 / FLOOR_PX_PER_M, FLOOR_TEXTURE_M / 2],
        [0, 0, 1],
    ])
    H_img_from_world = K @ np.column_stack([R[:, 0], R[:, 1], t])
    H = H_img_from_world @ T_world_from_tex
    image = cv2.warpPerspective(texture, H, (width, height), flags=cv2.INTER_AREA, borderValue=(150, 152, 156))
    # Above the horizon: a wall.
    us, vs = np.meshgrid(np.arange(width), np.arange(height))
    rays = np.linalg.inv(K) @ np.vstack([us.ravel(), vs.ravel(), np.ones(us.size)])
    world_dz = (R.T @ rays)[2].reshape(height, width)
    image[world_dz > -0.02] = (196, 188, 178)

    # Box faces with back-face culling (convex, so no depth sort needed).
    yaw = math.radians(box_yaw_deg)
    c, s = math.cos(yaw), math.sin(yaw)
    local = np.array([[sx * w / 2, sy * d / 2, z] for z in (0, h) for sx, sy in ((-1, -1), (1, -1), (1, 1), (-1, 1))])
    rot = np.array([[c, -s, 0], [s, c, 0], [0, 0, 1]])
    corners = local @ rot.T + np.array([box_center[0], box_center[1], 0])
    faces = {
        "bottom": [0, 1, 2, 3], "top": [4, 5, 6, 7],
        "front": [0, 1, 5, 4], "right": [1, 2, 6, 5], "back": [2, 3, 7, 6], "left": [3, 0, 4, 7],
    }
    shade = {"top": (95, 160, 205), "front": (58, 112, 160), "right": (48, 96, 140),
             "back": (52, 104, 150), "left": (44, 88, 128), "bottom": (30, 60, 90)}
    cam_points = (R @ corners.T + t.reshape(3, 1)).T
    projected = (K @ (cam_points / cam_points[:, 2:3]).T).T[:, :2]
    centre = corners.mean(axis=0)
    for name, index in faces.items():
        quad = corners[index]
        normal = quad.mean(axis=0) - centre
        if np.dot(normal, cam - quad.mean(axis=0)) <= 0:
            continue
        polygon = projected[index].round().astype(np.int32)
        cv2.fillConvexPoly(image, polygon, shade[name], lineType=cv2.LINE_AA)
        # Slats / cardboard seams for a bit of texture.
        for k in range(1, 4):
            a = quad[0] + (quad[3] - quad[0]) * k / 4
            b = quad[1] + (quad[2] - quad[1]) * k / 4
            pa, pb = [(K @ (R @ p + t) / (R @ p + t)[2])[:2] for p in (a, b)]
            cv2.line(image, tuple(np.round(pa).astype(int)), tuple(np.round(pb).astype(int)),
                     tuple(int(v * 0.8) for v in shade[name]), 2, cv2.LINE_AA)
    image = cv2.GaussianBlur(image, (3, 3), 0)
    image = np.clip(image.astype(np.int16) + rng.normal(0, 3, image.shape).astype(np.int16), 0, 255).astype(np.uint8)

    x0, y0 = projected.min(axis=0)
    x1, y1 = projected.max(axis=0)
    marker_world = np.array([[-0.075, 0.075, 0], [0.075, 0.075, 0], [0.075, -0.075, 0], [-0.075, -0.075, 0]])
    marker_cam = (R @ marker_world.T + t.reshape(3, 1)).T
    marker_px = (K @ (marker_cam / marker_cam[:, 2:3]).T).T[:, :2]
    return {"image": image, "K": K, "R": R, "t": t, "bbox": [float(x0), float(y0), float(x1), float(y1)],
            "corners": marker_px, "focal_px": focal}


def sample_jpeg(dims: tuple[float, float, float] = (1.32, 1.05, 1.40), seed: int = 3) -> bytes:
    scene = render_scene(dims=dims, box_center=(0.15, 1.25), box_yaw_deg=15, camera=(2.2, -2.0, 2.0), seed=seed)
    ok, data = cv2.imencode(".jpg", scene["image"], [cv2.IMWRITE_JPEG_QUALITY, 90])
    assert ok
    return data.tobytes()
