"""Room scan → Gaussian splat → aligned RoomScan.

Paths, in order of preference:
  1. An uploaded splat (.ply / .splat / .spz from Polycam, Scaniverse, Luma, SuperSplat…) → align it.
  2. A walk-through video + Modal configured (MODAL_TOKEN_ID and the `modal` package, app deployed with
     `modal deploy capture/modal_app.py`) → GPU job: ffmpeg frames → COLMAP → gsplat → .ply → align.
  3. Otherwise → the demo scan: a synthetic splat generated from the plan of the chosen room (its real
     furniture from building.json, a deliberate 0.4 m wall offset) in a random scanner frame, then run
     through the same alignment. Results are clearly labelled "demo scan".
"""

from __future__ import annotations

import asyncio
import logging
import math
import os
from pathlib import Path

import numpy as np
from shapely.geometry import Point, Polygon

from .align import _edges, align_scan, summarize_deviations
from .splat_io import write_gaussian_ply

log = logging.getLogger(__name__)

MODAL_APP = os.environ.get("SITETWIN_MODAL_APP", "sitetwin-splat")
ASSET_HEIGHTS = {"furniture": 0.75, "fixture": 1.1, "machine": 1.6, "equipment": 1.2}
ASSET_COLORS = {"furniture": (0.55, 0.42, 0.30), "fixture": (0.70, 0.70, 0.72), "machine": (0.25, 0.45, 0.62),
                "equipment": (0.80, 0.55, 0.20)}


def modal_available() -> bool:
    if not (os.environ.get("MODAL_TOKEN_ID") and os.environ.get("MODAL_TOKEN_SECRET")):
        return False
    try:
        import modal  # noqa: F401
    except ImportError:
        return False
    return True


async def train_on_modal(video_path: Path, out_path: Path) -> Path | None:
    """Run the deployed Modal function; returns the .ply path or None."""
    try:
        import modal

        function = modal.Function.from_name(MODAL_APP, "train_splat")
        ply = await function.remote.aio(video_path.read_bytes())
        if not ply:
            return None
        out_path.write_bytes(ply)
        return out_path
    except Exception as error:  # noqa: BLE001 — fall back to the demo scan
        log.warning("Modal splat job failed: %s", error)
        return None


# ---------------------------------------------------------------- demo scan


def pick_deviation_wall(polygon: Polygon, door_positions: list) -> int:
    """The north-most doorless wall (falls back to the longest wall)."""
    edges = _edges(polygon)
    doored = set()
    for position in door_positions:
        point = np.array(position, float)
        distances = []
        for a, b, _ in edges:
            t = np.clip(np.dot(point - a, b - a) / np.dot(b - a, b - a), 0, 1)
            distances.append(np.linalg.norm(a + t * (b - a) - point))
        doored.add(int(np.argmin(distances)))
    candidates = [i for i in range(len(edges)) if i not in doored and np.linalg.norm(edges[i][1] - edges[i][0]) > 1.5]
    if not candidates:
        candidates = list(range(len(edges)))
    return max(candidates, key=lambda i: (edges[i][2][1], np.linalg.norm(edges[i][1] - edges[i][0])))


def generate_demo_splat(polygon_xy: list, out_path: Path, *, assets: list[dict] | None = None,
                        door_positions: list | None = None, room_height_m: float = 3.0,
                        deviation_m: float = 0.4, seed: int = 7) -> dict:
    """Write a synthetic room splat in a scanner frame (Y up, random yaw/origin). Returns ground truth."""
    rng = np.random.default_rng(seed)
    polygon = Polygon(polygon_xy)
    if not polygon.exterior.is_ccw:
        polygon = Polygon(list(polygon.exterior.coords)[::-1])
    door_positions = door_positions or []
    height = float(min(max(room_height_m, 2.4), 4.0))
    edges = _edges(polygon)
    wall = pick_deviation_wall(polygon, door_positions) if deviation_m else -1
    offsets = {i: (deviation_m if i == wall else float(rng.normal(0, 0.015))) for i in range(len(edges))}

    xyz, rgb, scale, rot, alpha = [], [], [], [], []

    def add(points, color, sizes, quats, opacity=0.95, jitter=0.04):
        n = len(points)
        if not n:
            return
        xyz.append(points)
        base = np.tile(np.array(color, float), (n, 1))
        rgb.append(np.clip(base + rng.normal(0, jitter, (n, 3)), 0, 1))
        scale.append(np.tile(np.array(sizes, float), (n, 1)) * rng.uniform(0.7, 1.3, (n, 1)))
        rot.append(np.tile(np.array(quats, float), (n, 1)) if np.ndim(quats) == 1 else quats)
        alpha.append(np.full(n, opacity))

    # Floor: the plan polygon grown to the shifted walls.
    minx, miny, maxx, maxy = polygon.buffer(deviation_m + 0.05).bounds
    grown = polygon.buffer(max(offsets.values()), join_style=2)
    area = grown.area
    count = int(min(16000, max(3000, area * 220)))
    candidates = rng.uniform((minx, miny), (maxx, maxy), (count * 3, 2))
    inside = np.array([grown.contains(Point(p)) for p in candidates])
    floor = candidates[inside][:count]
    tiles = ((np.floor(floor[:, 0] / 0.6) + np.floor(floor[:, 1] / 0.6)) % 2)[:, None] * 0.04
    add(np.column_stack([floor, np.zeros(len(floor))]), (0.56, 0.55, 0.52), (0.05, 0.05, 0.004), (1, 0, 0, 0))
    rgb[-1] = np.clip(rgb[-1] + tiles, 0, 1)

    # Walls (shifted by their offset), with gaps at doors.
    for index, (a, b, normal) in enumerate(edges):
        a2, b2 = a + normal * offsets[index], b + normal * offsets[index]
        length = np.linalg.norm(b2 - a2)
        n = int(max(200, length * height * 160))
        t = rng.uniform(0, 1, n)
        z = rng.uniform(0, height, n)
        points = a2 + np.outer(t, b2 - a2)
        keep = np.ones(n, bool)
        for door in door_positions:
            near = np.linalg.norm(points - np.array(door), axis=1) < 0.55
            keep &= ~(near & (z < 2.1))
        points, z = points[keep], z[keep]
        yaw = math.atan2(normal[1], normal[0])
        # Splat normal (local z) → wall normal: rotate about the wall direction.
        axis = np.array([-normal[1], normal[0], 0.0])
        q = np.array([math.cos(math.pi / 4), *(axis * math.sin(math.pi / 4))])
        shade = 0.86 + 0.06 * math.cos(yaw)
        add(np.column_stack([points, z]), (shade, shade * 0.98, shade * 0.94), (0.05, 0.05, 0.004), q, jitter=0.02)
        # Skirting board.
        skirting = np.column_stack([points[: len(points) // 6], rng.uniform(0, 0.1, len(points) // 6)])
        add(skirting, (0.3, 0.3, 0.32), (0.03, 0.03, 0.004), q, jitter=0.01)

    # Ceiling, sparse.
    ceiling = floor[:: 4]
    add(np.column_stack([ceiling, np.full(len(ceiling), height)]), (0.92, 0.92, 0.9), (0.08, 0.08, 0.004), (1, 0, 0, 0), 0.6)

    # Furniture / machines from the plan's assets: box surfaces.
    for asset in assets or []:
        footprint = asset.get("footprint") or {}
        w, d = footprint.get("width_m"), footprint.get("depth_m")
        if not w or not d:
            continue
        h = ASSET_HEIGHTS.get(asset.get("category"), 1.0)
        n = int(min(1500, max(120, (w * d + 2 * (w + d) * h) * 120)))
        local = rng.uniform(-0.5, 0.5, (n, 3)) * np.array([w, d, h])
        face = rng.integers(0, 5, n)
        local[face == 0, 2] = h / 2
        local[face == 1, 0] = w / 2
        local[face == 2, 0] = -w / 2
        local[face == 3, 1] = d / 2
        local[face == 4, 1] = -d / 2
        angle = math.radians(footprint.get("rotation_deg", 0) or 0)
        c, s = math.cos(angle), math.sin(angle)
        world = np.column_stack([local[:, 0] * c - local[:, 1] * s + asset["position"][0],
                                 local[:, 0] * s + local[:, 1] * c + asset["position"][1], local[:, 2] + h / 2])
        add(world, ASSET_COLORS.get(asset.get("category"), (0.6, 0.6, 0.6)), (0.035, 0.035, 0.01), (1, 0, 0, 0))

    plan = np.vstack(xyz)
    plan += rng.normal(0, 0.008, plan.shape)  # reconstruction noise
    colors, sizes, quats, alphas = np.vstack(rgb), np.vstack(scale), np.vstack(rot), np.concatenate(alpha)

    # Building (x, y, z-up) → scanner frame (X right, Y up, Z back), random yaw + origin like a phone scan.
    yaw = rng.uniform(-math.pi, math.pi)
    c, s = math.cos(yaw), math.sin(yaw)
    centre = np.array(polygon.centroid.coords[0])
    origin = rng.uniform(-1.5, 1.5, 2)
    local = plan[:, :2] - centre
    rotated = np.column_stack([local[:, 0] * c - local[:, 1] * s, local[:, 0] * s + local[:, 1] * c]) + origin
    scan = np.column_stack([rotated[:, 0], plan[:, 2] - 1.4, -rotated[:, 1]])  # phone held at 1.4 m = origin
    # Same rotation for the splat orientations: building→scan rotation matrix.
    R_bs = np.array([[c, -s, 0], [0, 0, 1], [-s, -c, 0]])
    quats_scan = _rotate_quaternions(quats, R_bs)
    write_gaussian_ply(out_path, scan, colors, sizes, quats_scan, alphas)
    return {"deviation_wall": wall, "deviation_m": deviation_m, "count": len(scan), "yaw": yaw,
            "origin": origin.tolist(), "centre": centre.tolist()}


def _rotate_quaternions(quats_wxyz: np.ndarray, R: np.ndarray) -> np.ndarray:
    """Left-multiply each orientation by rotation R."""
    trace = np.trace(R)
    if trace > 0:
        s = math.sqrt(trace + 1.0) * 2
        q = np.array([0.25 * s, (R[2, 1] - R[1, 2]) / s, (R[0, 2] - R[2, 0]) / s, (R[1, 0] - R[0, 1]) / s])
    else:
        i = int(np.argmax(np.diag(R)))
        j, k = (i + 1) % 3, (i + 2) % 3
        s = math.sqrt(1.0 + R[i, i] - R[j, j] - R[k, k]) * 2
        q = np.zeros(4)
        q[0] = (R[k, j] - R[j, k]) / s
        q[1 + i] = 0.25 * s
        q[1 + j] = (R[j, i] + R[i, j]) / s
        q[1 + k] = (R[k, i] + R[i, k]) / s
    w1, x1, y1, z1 = q
    w2, x2, y2, z2 = quats_wxyz.T
    return np.column_stack([
        w1 * w2 - x1 * x2 - y1 * y2 - z1 * z2,
        w1 * x2 + x1 * w2 + y1 * z2 - z1 * y2,
        w1 * y2 - x1 * z2 + y1 * w2 + z1 * x2,
        w1 * z2 + x1 * y2 - y1 * x2 + z1 * w2,
    ])


# ---------------------------------------------------------------- room context


def room_context(bm, space_id: str) -> dict:
    space = bm.spaces[space_id]
    floor = bm.floors[space["floor_id"]]
    doors = [o["position"] for o in bm.openings.values() if space_id in o["space_ids"]]
    assets = [a for a in bm.assets.values() if a.get("space_id") == space_id]
    return {"space": space, "polygon": space["polygon"], "elevation_m": float(floor.get("elevation_m", 0.0)),
            "height_m": float(floor.get("height_m", 3.0)), "doors": doors, "assets": assets}


async def align_file(splat_path: Path, context: dict, up_axis: str | None = None, corners=None) -> dict:
    from .splat_io import read_points

    points = await asyncio.to_thread(read_points, splat_path)
    if len(points) < 100:
        raise ValueError("the splat has too few points to align")
    return await asyncio.to_thread(align_scan, points, context["polygon"], context["elevation_m"],
                                   context["doors"], up_axis, corners)


def summary_for(context: dict, alignment: dict, demo: bool) -> str:
    return summarize_deviations(context["space"]["name"], alignment["deviations"], demo=demo)
