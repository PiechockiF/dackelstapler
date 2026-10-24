"""Fit a room scan (splat centres) into its floor-plan polygon and measure where reality differs.

Frames
  splat:    whatever the scan file uses (any up axis, any origin/yaw; metric for phone-app scans)
  building: plan metres x, y (building.json) and z = metres above the building datum (floor elevation_m)
The result transform is a 4x4, column-major, splat → building.

Steps: find the up axis and floor height → take wall-height points → try the 4 axis-aligned yaws that
put the scan's dominant direction on the room's → translate so the walls with doors (structural, known
from the plan) line up → per wall, the outermost dense layer of points gives the wall's real position.
With two user-picked corner correspondences the similarity transform comes from them instead.
"""

from __future__ import annotations

import math

import cv2
import numpy as np
from shapely.geometry import Point, Polygon

WALL_BAND = (0.3, 2.0)          # metres above the floor that count as "wall"
DEVIATION_REPORT_M = 0.15
AXES = {"+x": (1, 0, 0), "-x": (-1, 0, 0), "+y": (0, 1, 0), "-y": (0, -1, 0), "+z": (0, 0, 1), "-z": (0, 0, -1)}


def _basis(up: np.ndarray) -> np.ndarray:
    """Rows a, b, up: a right-handed basis with the given up vector."""
    helper = np.array([1.0, 0, 0]) if abs(up[0]) < 0.9 else np.array([0, 1.0, 0])
    a = helper - up * np.dot(helper, up)
    a /= np.linalg.norm(a)
    b = np.cross(up, a)
    return np.vstack([a, b, up])


def detect_up(points: np.ndarray) -> np.ndarray:
    """Smallest robust extent axis; sign towards the sparser end (floors are denser than ceilings)."""
    low, high = np.percentile(points, 2, axis=0), np.percentile(points, 98, axis=0)
    axis = int(np.argmin(high - low))
    values = points[:, axis]
    band = (high[axis] - low[axis]) * 0.12
    near_low = np.sum(values < low[axis] + band)
    near_high = np.sum(values > high[axis] - band)
    up = np.zeros(3)
    up[axis] = 1.0 if near_low >= near_high else -1.0
    return up


def _edges(polygon: Polygon) -> list[tuple[np.ndarray, np.ndarray, np.ndarray]]:
    """(a, b, outward unit normal) per wall, for a polygon of any orientation."""
    coords = np.array(polygon.exterior.coords)[:-1]
    ccw = polygon.exterior.is_ccw
    edges = []
    for i in range(len(coords)):
        a, b = coords[i], coords[(i + 1) % len(coords)]
        direction = b - a
        length = np.linalg.norm(direction)
        if length < 1e-6:
            continue
        normal = np.array([direction[1], -direction[0]]) / length  # right-hand normal
        if not ccw:
            normal = -normal
        edges.append((a, b, normal))
    return edges


def wall_offsets(points_2d: np.ndarray, polygon: Polygon, min_points: int = 25) -> list[dict]:
    """Per wall: signed offset (m) of the scan's wall layer from the plan wall (+ = outside the plan)."""
    results = []
    for index, (a, b, normal) in enumerate(_edges(polygon)):
        direction = b - a
        length = np.linalg.norm(direction)
        along = (points_2d - a) @ (direction / length)
        across = (points_2d - a) @ normal
        selected = across[(along > 0.1 * length) & (along < 0.9 * length) & (across > -0.8) & (across < 1.2)]
        if len(selected) < min_points:
            results.append({"wall_index": index, "offset_m": None, "segment": [a.tolist(), b.tolist()],
                            "normal": normal.tolist(), "length_m": float(length)})
            continue
        # The wall itself is the outermost dense layer; furniture sits inside it.
        histogram, bin_edges = np.histogram(selected, bins=np.arange(-0.8, 1.2001, 0.04))
        threshold = max(3, 0.25 * histogram.max())
        dense = np.nonzero(histogram >= threshold)[0]
        outer = dense.max()
        layer = selected[(selected >= bin_edges[max(outer - 1, 0)]) & (selected <= bin_edges[outer + 1])]
        results.append({"wall_index": index, "offset_m": float(np.median(layer)), "segment": [a.tolist(), b.tolist()],
                        "normal": normal.tolist(), "length_m": float(length)})
    return results


def _door_walls(polygon: Polygon, door_positions: list[tuple[float, float]]) -> set[int]:
    walls = set()
    for position in door_positions:
        point = np.array(position, float)
        best, best_distance = None, 0.6
        for index, (a, b, _) in enumerate(_edges(polygon)):
            ab = b - a
            t = np.clip(np.dot(point - a, ab) / np.dot(ab, ab), 0, 1)
            distance = np.linalg.norm(a + t * ab - point)
            if distance < best_distance:
                best, best_distance = index, distance
        if best is not None:
            walls.add(best)
    return walls


def _dominant_angle(points_2d: np.ndarray) -> float:
    rect = cv2.minAreaRect(points_2d.astype(np.float32))
    return math.radians(rect[2])


def _rotation(theta: float) -> np.ndarray:
    c, s = math.cos(theta), math.sin(theta)
    return np.array([[c, -s], [s, c]])


def _door_gap_penalty(points: np.ndarray, door_positions: list) -> float:
    """Doors are gaps in a scan: wall-height points right at a plan door mean the fit is rotated wrong."""
    if not door_positions or len(points) == 0:
        return 0.0
    extent = np.ptp(points, axis=0).sum() * 2  # ~ perimeter
    expected = len(points) / max(extent, 1.0) * 0.6  # points along 0.6 m of wall
    penalty = 0.0
    for door in door_positions:
        count = np.sum(np.linalg.norm(points - np.asarray(door, float), axis=1) < 0.3)
        penalty += min(1.0, count / max(expected, 1.0))
    return penalty / len(door_positions)


def _candidate_shifts(points: np.ndarray, polygon: Polygon, anchors: set[int], door_positions: list):
    """Translations that put pairs of non-parallel walls exactly on the plan, scored by how many walls
    end up off-plan (a real deviation is usually one wall, not two walls each half off)."""
    offsets = [w for w in wall_offsets(points, polygon) if w["offset_m"] is not None]
    if not offsets:
        yield 9.0 + _door_gap_penalty(points, door_positions), np.zeros(2)
        return
    normals = np.array([w["normal"] for w in offsets])
    values = np.array([w["offset_m"] for w in offsets])
    weights = np.array([2.0 if w["wall_index"] in anchors else 1.0 for w in offsets])
    candidates = [np.zeros(2)]
    for i in range(len(offsets)):
        for j in range(i + 1, len(offsets)):
            matrix = np.array([normals[i], normals[j]])
            if abs(np.linalg.det(matrix)) < 0.5:
                continue
            candidates.append(np.linalg.solve(matrix, -np.array([values[i], values[j]])))
    for shift in candidates:
        if np.linalg.norm(shift) > 1.0:
            continue
        moved = values + normals @ shift
        off = np.sum(weights * (np.abs(moved) > 0.08))
        score = off + 0.5 * float(np.mean(np.abs(moved))) + 2.0 * _door_gap_penalty(points + shift, door_positions)
        yield score, shift


def similarity_from_pairs(src: np.ndarray, dst: np.ndarray) -> tuple[float, float, np.ndarray]:
    """2 point pairs (2D) → scale, angle, translation with dst = s R src + t."""
    vs, vd = src[1] - src[0], dst[1] - dst[0]
    scale = np.linalg.norm(vd) / max(np.linalg.norm(vs), 1e-9)
    angle = math.atan2(vd[1], vd[0]) - math.atan2(vs[1], vs[0])
    t = dst[0] - scale * _rotation(angle) @ src[0]
    return scale, angle, t


def compass(normal: list[float]) -> str:
    angle = math.degrees(math.atan2(normal[1], normal[0])) % 360
    names = ["east", "north-east", "north", "north-west", "west", "south-west", "south", "south-east"]
    return names[int(((angle + 22.5) % 360) // 45)]


def align_scan(points: np.ndarray, polygon_xy: list, floor_elevation_m: float = 0.0,
               door_positions: list | None = None, up_axis: str | None = None,
               corners: list[dict] | None = None, metric: bool = True) -> dict:
    """Returns {"transform" (16, column-major), "deviations", "rms_m", "scale", "up", "summary_parts"}."""
    polygon = Polygon(polygon_xy)
    if not polygon.exterior.is_ccw:
        polygon = Polygon(list(polygon.exterior.coords)[::-1])
    up = np.array(AXES[up_axis], float) if up_axis in AXES else detect_up(points)
    B = _basis(up)
    level = points @ B.T                      # columns: a, b, height
    floor_height = float(np.percentile(level[:, 2], 1.5))
    heights = level[:, 2] - floor_height
    band = (heights > WALL_BAND[0]) & (heights < WALL_BAND[1])
    wall_points = level[band, :2]
    if len(wall_points) < 50:
        wall_points = level[:, :2]
    anchors = _door_walls(polygon, door_positions or [])

    scale = 1.0
    if corners and len(corners) >= 2:
        src = np.array([(np.array(c["splat"], float) @ B.T)[:2] for c in corners[:2]])
        dst = np.array([c["plan"] for c in corners[:2]], float)
        scale, angle, translation = similarity_from_pairs(src, dst)
        R2 = _rotation(angle)
        offsets = wall_offsets((wall_points @ R2.T) * scale + translation, polygon)
    else:
        trimmed = wall_points
        if len(trimmed) > 200:
            lo, hi = np.percentile(trimmed, 1, axis=0), np.percentile(trimmed, 99, axis=0)
            trimmed = trimmed[((trimmed >= lo) & (trimmed <= hi)).all(axis=1)]
        rect = polygon.minimum_rotated_rectangle
        room_angle = _dominant_angle(np.array(rect.exterior.coords)[:-1])
        scan_angle = _dominant_angle(trimmed)
        if not metric:
            scan_area = cv2.contourArea(cv2.convexHull(trimmed.astype(np.float32)))
            scale = math.sqrt(polygon.area / max(scan_area, 1e-6))
        else:
            hull = cv2.convexHull(trimmed.astype(np.float32))
            ratio = math.sqrt(polygon.area / max(cv2.contourArea(hull), 1e-6))
            if not 0.6 < ratio < 1.6:  # clearly not metric (e.g. a COLMAP reconstruction)
                scale = ratio
        best = None
        centroid = np.array(polygon.centroid.coords[0])
        for k in range(4):
            angle = room_angle - scan_angle + k * math.pi / 2
            R2 = _rotation(angle)
            rotated = (trimmed @ R2.T) * scale
            translation0 = centroid - (rotated.min(axis=0) + rotated.max(axis=0)) / 2
            for score, shift in _candidate_shifts(rotated + translation0, polygon, anchors, door_positions or []):
                if best is None or score < best[0]:
                    best = (score, angle, translation0 + shift)
        _, angle, translation = best
        R2 = _rotation(angle)
        offsets = wall_offsets(((wall_points @ R2.T) * scale) + translation, polygon)

    # Compose splat → building.
    M = np.eye(4)
    M[:2, :3] = scale * (R2 @ B[:2])
    M[2, :3] = scale * B[2]
    M[:2, 3] = translation
    M[2, 3] = floor_elevation_m - scale * floor_height
    measured = [w for w in offsets if w["offset_m"] is not None]
    rms = math.sqrt(np.mean([w["offset_m"] ** 2 for w in measured])) if measured else None
    deviations = [{"wall_index": w["wall_index"], "offset_m": round(w["offset_m"], 3),
                   "segment": [[round(v, 3) for v in w["segment"][0]], [round(v, 3) for v in w["segment"][1]]],
                   "direction": compass(w["normal"])} for w in measured]
    return {"transform": [round(float(v), 6) for v in M.flatten(order="F")], "matrix": M, "deviations": deviations,
            "rms_m": rms, "scale": scale, "up": up.tolist(), "anchored_on_doors": bool(anchors)}


def summarize_deviations(room_name: str, deviations: list[dict], demo: bool = False) -> str:
    off = sorted((d for d in deviations if abs(d["offset_m"]) >= DEVIATION_REPORT_M),
                 key=lambda d: -abs(d["offset_m"]))
    prefix = f"Scan fitted into {room_name}" + (" (demo scan)" if demo else "") + ". "
    if not deviations:
        return prefix + "Not enough wall points to compare with the plan."
    if not off:
        worst = max(abs(d["offset_m"]) for d in deviations)
        return prefix + f"All {len(deviations)} walls within {math.ceil(worst * 100)} cm of the plan."
    parts = [f"{d['direction']} wall {abs(d['offset_m']):.2f} m {'outside' if d['offset_m'] > 0 else 'inside'} the plan"
             for d in off[:3]]
    rest = len(deviations) - len(off)
    tail = f"; other {rest} wall{'s' if rest != 1 else ''} within {math.ceil(DEVIATION_REPORT_M * 100)} cm" if rest else ""
    return prefix + "⚠ " + ", ".join(parts) + tail + "."


def inside_fraction(points_building_xy: np.ndarray, polygon_xy: list, margin_m: float = 0.25) -> float:
    polygon = Polygon(polygon_xy).buffer(margin_m)
    sample = points_building_xy[:: max(1, len(points_building_xy) // 2000)]
    return float(np.mean([polygon.contains(Point(p)) for p in sample]))
