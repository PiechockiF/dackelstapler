"""Measure a delivered item (W × D × H, metres) from 1–4 photos with the ArUco marker on the floor.

Per photo:
  1. Marker → camera pose relative to the floor (capture.aruco).
  2. Object silhouette: GrabCut seeded by a bbox (Claude vision, or one drawn on the phone), or,
     without a bbox, by a floor-colour model sampled around the marker sheet.
  3. Fit an upright box standing on the floor (x, y, yaw, W, D, H) whose projected outline best
     overlaps the silhouette (Nelder–Mead on 1 − IoU).
Photos are combined by the median; the tolerance is honest: model error + spread across photos.
"""

from __future__ import annotations

import logging
import math
from dataclasses import dataclass, field

import cv2
import numpy as np
from shapely.geometry import Polygon

from .aruco import MarkerDetection, detect_marker, load_image

log = logging.getLogger(__name__)

# The marker sits centred horizontally, 40 mm below the top edge of a portrait A4 sheet.
PAPER_WORLD = np.array([[-0.105, 0.115], [0.105, 0.115], [0.105, -0.182], [-0.105, -0.182]])
SEG_MAX_SIDE = 800

BBox = tuple[float, float, float, float]  # x0, y0, x1, y1 in pixels


@dataclass
class PhotoMeasurement:
    index: int
    ok: bool
    message: str
    dims: tuple[float, float, float] | None = None      # w ≥ d, h
    center: tuple[float, float] | None = None           # floor metres in the marker frame
    yaw_deg: float | None = None
    iou: float | None = None
    bbox_px: BBox | None = None
    marker: dict | None = None
    focal_source: str | None = None
    _det: MarkerDetection | None = field(default=None, repr=False)
    _params: np.ndarray | None = field(default=None, repr=False)


@dataclass
class MeasureResult:
    ok: bool
    dims: dict | None                     # {"w","d","h"} metres
    tolerance_m: float
    method: str                           # "marker+silhouette" | "declared" | "vision-estimate" | "default"
    message: str
    photos: list[PhotoMeasurement] = field(default_factory=list)
    crop: np.ndarray | None = None        # BGR crop of the item from the best photo (for textures)
    label_hint: str | None = None
    overlay: np.ndarray | None = None     # best photo with the marker and the fitted box drawn on it

    def to_json(self) -> dict:
        return {
            "ok": self.ok, "dims": self.dims, "tolerance_m": self.tolerance_m, "method": self.method,
            "message": self.message,
            "photos": [
                {k: v for k, v in p.__dict__.items() if not k.startswith("_")} for p in self.photos
            ],
        }


# ---------------------------------------------------------------- segmentation


def _paper_polygon_px(det: MarkerDetection, grow: float = 1.0) -> np.ndarray:
    centre = PAPER_WORLD.mean(axis=0)
    world = (PAPER_WORLD - centre) * grow + centre
    homog = np.column_stack([world, np.ones(4)])
    px = (det.floor_homography @ homog.T).T
    return (px[:, :2] / px[:, 2:3]).astype(np.float32)


def _horizon_mask(det: MarkerDetection, shape: tuple[int, int], scale: float) -> np.ndarray:
    """True where the pixel ray hits the floor (below the horizon)."""
    height, width = shape
    us, vs = np.meshgrid(np.arange(width) / scale, np.arange(height) / scale)
    rays = np.linalg.inv(det.K) @ np.vstack([us.ravel(), vs.ravel(), np.ones(us.size)])
    world_dz = (det.R.T @ rays)[2].reshape(height, width)
    return world_dz < -0.01


def _auto_seed(small: np.ndarray, det: MarkerDetection, scale: float) -> tuple[np.ndarray, np.ndarray] | None:
    """Floor-colour model around the sheet → (probable foreground mask, definite background mask)."""
    lab = cv2.cvtColor(small, cv2.COLOR_BGR2LAB).astype(np.float32)
    paper = _paper_polygon_px(det) * scale
    ring_outer = _paper_polygon_px(det, grow=3.2) * scale
    ring = np.zeros(small.shape[:2], np.uint8)
    cv2.fillPoly(ring, [ring_outer.astype(np.int32)], 1)
    cv2.fillPoly(ring, [(_paper_polygon_px(det, grow=1.25) * scale).astype(np.int32)], 0)
    samples = lab[ring.astype(bool)]
    if len(samples) < 50:
        return None
    mean = samples.mean(axis=0)
    cov = np.cov(samples.T) + np.eye(3) * 4.0
    inv = np.linalg.inv(cov)
    diff = lab.reshape(-1, 3) - mean
    distance = np.sqrt(np.einsum("ij,jk,ik->i", diff, inv, diff)).reshape(small.shape[:2])
    floor_like = distance < 4.0
    below = _horizon_mask(det, small.shape[:2], scale)

    candidate = (~floor_like).astype(np.uint8)
    cv2.fillPoly(candidate, [(_paper_polygon_px(det, grow=1.15) * scale).astype(np.int32)], 0)
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (7, 7))
    candidate = cv2.morphologyEx(candidate, cv2.MORPH_OPEN, kernel)
    candidate = cv2.morphologyEx(candidate, cv2.MORPH_CLOSE, kernel, iterations=2)
    count, labels, stats, _ = cv2.connectedComponentsWithStats(candidate, connectivity=8)
    best, best_score = None, 0.0
    height, width = candidate.shape
    for label in range(1, count):
        x, y, w, h, area = stats[label]
        if area < 0.004 * width * height:
            continue
        component = labels == label
        ground_contact = (component & below).sum() / max(area, 1)
        touches_top = y <= 1
        if ground_contact < 0.15 or (touches_top and w > 0.6 * width):
            continue  # a wall / the sky, not a thing standing on the floor
        score = area * (0.5 if touches_top else 1.0) * (0.5 + ground_contact)
        if score > best_score:
            best, best_score = component, score
    if best is None:
        return None
    definite_bg = floor_like & below & ~cv2.dilate(best.astype(np.uint8), kernel, iterations=3).astype(bool)
    return best, definite_bg


def segment(image: np.ndarray, det: MarkerDetection, bbox: BBox | None) -> tuple[np.ndarray | None, BBox | None]:
    """Binary mask (full resolution, uint8 0/1) of the item, plus its pixel bbox."""
    scale = min(1.0, SEG_MAX_SIDE / max(image.shape[:2]))
    small = cv2.resize(image, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA) if scale < 1 else image.copy()
    height, width = small.shape[:2]
    gc = np.full((height, width), cv2.GC_PR_BGD, np.uint8)
    if bbox is not None:
        x0, y0, x1, y1 = [v * scale for v in bbox]
        pad_x, pad_y = 0.03 * (x1 - x0), 0.03 * (y1 - y0)
        x0, y0 = max(0, int(x0 - pad_x)), max(0, int(y0 - pad_y))
        x1, y1 = min(width - 1, int(x1 + pad_x)), min(height - 1, int(y1 + pad_y))
        if x1 - x0 < 8 or y1 - y0 < 8:
            return None, None
        gc[:] = cv2.GC_BGD
        gc[y0:y1, x0:x1] = cv2.GC_PR_FGD
        # The centre of a drawn box is almost certainly the item.
        cx0, cy0 = x0 + (x1 - x0) // 3, y0 + (y1 - y0) // 3
        gc[cy0:y1 - (y1 - y0) // 3, cx0:x1 - (x1 - x0) // 3] = cv2.GC_FGD
    else:
        seed = _auto_seed(small, det, scale)
        if seed is None:
            return None, None
        foreground, background = seed
        gc[foreground] = cv2.GC_PR_FGD
        gc[background] = cv2.GC_BGD
    cv2.fillPoly(gc, [(_paper_polygon_px(det, grow=1.1) * scale).astype(np.int32)], cv2.GC_BGD)
    try:
        bgd, fgd = np.zeros((1, 65), np.float64), np.zeros((1, 65), np.float64)
        cv2.grabCut(small, gc, None, bgd, fgd, 5, cv2.GC_INIT_WITH_MASK)
    except cv2.error as error:  # degenerate seeds (e.g. no background pixels)
        log.warning("grabcut failed: %s", error)
    mask = np.isin(gc, (cv2.GC_FGD, cv2.GC_PR_FGD)).astype(np.uint8)
    count, labels, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
    if count <= 1:
        return None, None
    largest = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
    mask = (labels == largest).astype(np.uint8)
    if scale < 1:
        mask = cv2.resize(mask, (image.shape[1], image.shape[0]), interpolation=cv2.INTER_NEAREST)
    ys, xs = np.nonzero(mask)
    return mask, (float(xs.min()), float(ys.min()), float(xs.max()), float(ys.max()))


# ---------------------------------------------------------------- box fit


def _box_corners(params: np.ndarray) -> np.ndarray:
    cx, cy, yaw, log_w, log_d, log_h = params
    w, d, h = math.exp(log_w), math.exp(log_d), math.exp(log_h)
    c, s = math.cos(yaw), math.sin(yaw)
    local = np.array([[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2]])
    xy = local @ np.array([[c, s], [-s, c]]) + np.array([cx, cy])
    return np.vstack([np.column_stack([xy, np.zeros(4)]), np.column_stack([xy, np.full(4, h)])])


def _projected_hull(det: MarkerDetection, params: np.ndarray) -> Polygon | None:
    pixels, depth = det.project(_box_corners(params))
    if (depth < 0.05).any():
        return None
    hull = cv2.convexHull(pixels.astype(np.float32)).reshape(-1, 2)
    if len(hull) < 3:
        return None
    return Polygon(hull)


def nelder_mead(fn, x0: np.ndarray, steps: np.ndarray, iterations: int = 500, tol: float = 1e-6) -> tuple[np.ndarray, float]:
    n = len(x0)
    simplex = [x0.astype(float)] + [x0 + np.eye(n)[i] * steps[i] for i in range(n)]
    values = [fn(x) for x in simplex]
    for _ in range(iterations):
        order = np.argsort(values)
        simplex = [simplex[i] for i in order]
        values = [values[i] for i in order]
        if abs(values[-1] - values[0]) < tol:
            break
        centroid = np.mean(simplex[:-1], axis=0)
        reflected = centroid + (centroid - simplex[-1])
        fr = fn(reflected)
        if fr < values[0]:
            expanded = centroid + 2 * (centroid - simplex[-1])
            fe = fn(expanded)
            simplex[-1], values[-1] = (expanded, fe) if fe < fr else (reflected, fr)
        elif fr < values[-2]:
            simplex[-1], values[-1] = reflected, fr
        else:
            contracted = centroid + 0.5 * (simplex[-1] - centroid)
            fc = fn(contracted)
            if fc < values[-1]:
                simplex[-1], values[-1] = contracted, fc
            else:
                for i in range(1, n + 1):
                    simplex[i] = simplex[0] + 0.5 * (simplex[i] - simplex[0])
                    values[i] = fn(simplex[i])
    best = int(np.argmin(values))
    return simplex[best], values[best]


def fit_box(det: MarkerDetection, mask: np.ndarray) -> tuple[np.ndarray, float] | None:
    """Best upright box for the silhouette: params (cx, cy, yaw, logW, logD, logH) and IoU."""
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return None
    hull_px = cv2.convexHull(max(contours, key=cv2.contourArea)).reshape(-1, 2).astype(float)
    target = Polygon(hull_px).buffer(0)
    if target.area < 100:
        return None

    x0, y0, x1, y1 = hull_px[:, 0].min(), hull_px[:, 1].min(), hull_px[:, 0].max(), hull_px[:, 1].max()
    bottom = hull_px[np.argmax(hull_px[:, 1])]
    floor_points = det.image_to_floor(np.array([bottom, [x0, y1], [x1, y1]]))
    width0 = float(np.clip(np.linalg.norm(floor_points[2] - floor_points[1]), 0.2, 4.0))
    camera = det.camera_position
    away = floor_points[0] - camera[:2]
    away /= max(np.linalg.norm(away), 1e-6)
    centre0 = floor_points[0] + away * width0 * 0.35
    view_yaw = math.atan2(away[1], away[0]) + math.pi / 2

    def top_error(h: float) -> float:
        pixels, depth = det.project(np.array([[centre0[0], centre0[1], h]]))
        return abs(pixels[0, 1] - y0) if depth[0] > 0 else 1e9

    heights = np.linspace(0.05, 4.0, 80)
    height0 = float(heights[np.argmin([top_error(h) for h in heights])])

    def cost(params: np.ndarray) -> float:
        if not (-3.5 < params[3] < 2.5 and -3.5 < params[4] < 2.5 and -3.5 < params[5] < 2.5):
            return 2.0
        projected = _projected_hull(det, params)
        if projected is None or not projected.is_valid:
            return 2.0
        union = projected.union(target).area
        return 1.0 - (projected.intersection(target).area / union if union > 0 else 0.0)

    best, best_cost = None, 2.0
    steps = np.array([0.15, 0.15, 0.35, 0.25, 0.25, 0.2])
    for yaw_offset in (0.0, math.pi / 6, math.pi / 3):
        start = np.array([centre0[0], centre0[1], view_yaw + yaw_offset,
                          math.log(width0), math.log(width0 * 0.8), math.log(max(height0, 0.1))])
        params, value = nelder_mead(cost, start, steps, iterations=600)
        params, value = nelder_mead(cost, params, steps * 0.3, iterations=400)  # restart to escape collapse
        if value < best_cost:
            best, best_cost = params, value
    if best is None:
        return None
    return best, 1.0 - best_cost


# ---------------------------------------------------------------- public API


def draw_overlay(image: np.ndarray, det: MarkerDetection, params: np.ndarray, dims: dict, tolerance: float) -> np.ndarray:
    out = image.copy()
    cv2.polylines(out, [det.corners.round().astype(np.int32)], True, (80, 220, 255), 3, cv2.LINE_AA)
    corners = _box_corners(params)
    pixels, depth = det.project(corners)
    if (depth > 0).all():
        p = pixels.round().astype(np.int32)
        for a, b in [(0, 1), (1, 2), (2, 3), (3, 0), (4, 5), (5, 6), (6, 7), (7, 4), (0, 4), (1, 5), (2, 6), (3, 7)]:
            cv2.line(out, tuple(p[a]), tuple(p[b]), (153, 211, 52), 3, cv2.LINE_AA)
        text = f"{dims['w']:.2f} x {dims['d']:.2f} x {dims['h']:.2f} m  +/-{round(tolerance * 100)} cm"
        anchor = tuple(p[4:].min(axis=0) - np.array([0, 14]))
        scale = max(0.7, out.shape[1] / 1600)
        (tw, th), _ = cv2.getTextSize(text, cv2.FONT_HERSHEY_SIMPLEX, scale, 2)
        x, y = max(4, anchor[0]), max(th + 8, anchor[1])
        cv2.rectangle(out, (x - 6, y - th - 8), (x + tw + 6, y + 8), (20, 11, 7), -1)
        cv2.putText(out, text, (x, y), cv2.FONT_HERSHEY_SIMPLEX, scale, (153, 211, 52), 2, cv2.LINE_AA)
    return out



def measure_photo(index: int, data: bytes, bbox_norm: list[float] | None = None) -> tuple[PhotoMeasurement, np.ndarray | None]:
    image, focal = load_image(data)
    height, width = image.shape[:2]
    det = detect_marker(image, focal_px=focal, focal_source="exif") if focal else detect_marker(image)
    if det is None:
        return PhotoMeasurement(index, False, "marker not found"), image
    bbox = None
    if bbox_norm and len(bbox_norm) == 4:
        bx0, by0, bx1, by1 = bbox_norm
        bbox = (min(bx0, bx1) * width, min(by0, by1) * height, max(bx0, bx1) * width, max(by0, by1) * height)
    mask, bbox_px = segment(image, det, bbox)
    if mask is None:
        return PhotoMeasurement(index, False, "item not separated from the floor", marker=det.to_json(),
                                focal_source=det.focal_source), image
    fitted = fit_box(det, mask)
    if fitted is None:
        return PhotoMeasurement(index, False, "box fit failed", marker=det.to_json(), bbox_px=bbox_px), image
    params, iou = fitted
    w, d, h = (math.exp(v) for v in params[3:6])
    yaw = math.degrees(params[2])
    if d > w:
        w, d, yaw = d, w, yaw + 90
    return PhotoMeasurement(
        index, iou > 0.75, f"silhouette IoU {iou:.2f}" if iou > 0.75 else f"poor silhouette fit (IoU {iou:.2f})",
        dims=(w, d, h), center=(float(params[0]), float(params[1])), yaw_deg=(yaw + 90) % 180 - 90,
        iou=float(iou), bbox_px=bbox_px, marker=det.to_json(), focal_source=det.focal_source,
        _det=det, _params=params,
    ), image


def _round_up_cm(value: float) -> float:
    return math.ceil(value * 100 - 1e-6) / 100


def classify_label(dims: dict) -> str:
    w, d, h = dims["w"], dims["d"], dims["h"]
    if abs(w - 1.2) < 0.1 and abs(d - 0.8) < 0.1:
        return "EUR pallet load" if h > 0.3 else "EUR pallet"
    if abs(w - 1.2) < 0.1 and abs(d - 1.0) < 0.1:
        return "Industrial pallet load" if h > 0.3 else "Industrial pallet"
    if max(w, d, h) < 0.7:
        return "Parcel"
    if h > 1.6 and max(w, d) < 1.3:
        return "Tall crate"
    return "Crate"


def measure_photos(
    photos: list[bytes],
    bboxes: list[list[float] | None] | None = None,
    declared: dict | None = None,
    vision: dict | None = None,
) -> MeasureResult:
    """vision: optional Claude result {"label", "bbox" (normalised, first photo), "rough_dims_m"}."""
    results: list[PhotoMeasurement] = []
    images: list[np.ndarray | None] = []
    for index, data in enumerate(photos[:4]):
        bbox = (bboxes[index] if bboxes and index < len(bboxes) else None) or (
            vision.get("bbox") if vision and index == 0 else None
        )
        try:
            measurement, image = measure_photo(index, data, bbox)
        except Exception as error:  # noqa: BLE001 — one bad photo must not kill the job
            log.exception("photo %s failed", index)
            measurement, image = PhotoMeasurement(index, False, f"could not read photo: {error}"), None
        results.append(measurement)
        images.append(image)

    good = [r for r in results if r.ok and r.dims]
    usable = good or [r for r in results if r.dims and (r.iou or 0) > 0.55]
    crop = None
    label_hint = vision.get("label") if vision else None
    if usable:
        dims_array = np.array([r.dims for r in usable])
        median = np.median(dims_array, axis=0)
        # Model error: ~1 cm + 1.5 % (marker corners), plus fit residual; heights also carry
        # the focal-length uncertainty when it came from the phone prior, not EXIF.
        tolerances = []
        for r in usable:
            residual = 1.0 - (r.iou or 0.0)
            per_axis = [0.01 + 0.015 * v + residual * 0.35 * v for v in r.dims]
            if r.focal_source != "exif":
                per_axis[2] += 0.03 * r.dims[2]
            if len(usable) == 1:
                per_axis[1] += 0.06 * r.dims[1]  # depth is the weakest axis from a single viewpoint
            tolerances.append(max(per_axis))
        model_tol = float(np.median(tolerances)) / math.sqrt(len(usable))
        spread = float((dims_array.max(axis=0) - dims_array.min(axis=0)).max() / 2) if len(usable) > 1 else 0.0
        tolerance = max(0.02, _round_up_cm(max(model_tol, spread)))
        dims = {"w": round(float(median[0]), 2), "d": round(float(median[1]), 2), "h": round(float(median[2]), 2)}
        best = max(usable, key=lambda r: r.iou or 0)
        image = images[best.index]
        if image is not None and best.bbox_px:
            x0, y0, x1, y1 = (int(v) for v in best.bbox_px)
            crop = image[max(0, y0):y1 + 1, max(0, x0):x1 + 1].copy()
        overlay = draw_overlay(image, best._det, best._params, dims, tolerance) if image is not None and best._det is not None else None
        ok = bool(good)
        message = (
            f"Measured from {len(usable)} of {len(results)} photo(s) with the 150 mm marker"
            + ("" if ok else " (low-confidence silhouette)")
        )
        return MeasureResult(ok, dims, tolerance, "marker+silhouette", message, results, crop, label_hint, overlay)

    # No usable photo: fall back honestly.
    first_image = next((image for image in images if image is not None), None)
    if first_image is not None:
        h_img, w_img = first_image.shape[:2]
        if vision and vision.get("bbox"):
            x0, y0, x1, y1 = vision["bbox"]
            crop = first_image[int(y0 * h_img):int(y1 * h_img), int(x0 * w_img):int(x1 * w_img)].copy()
        else:
            crop = first_image[h_img // 6: h_img * 5 // 6, w_img // 6: w_img * 5 // 6].copy()
    reason = "; ".join(f"photo {r.index + 1}: {r.message}" for r in results) or "no photos"
    if declared:
        return MeasureResult(False, dict(declared), 0.1, "declared",
                             f"Could not measure ({reason}) — using the declared dimensions", results, crop, label_hint)
    if vision and vision.get("rough_dims_m"):
        rough = vision["rough_dims_m"]
        dims = {k: round(float(rough[k]), 2) for k in ("w", "d", "h")}
        return MeasureResult(False, dims, 0.15, "vision-estimate",
                             f"Marker not usable ({reason}) — rough estimate from Claude vision", results, crop, label_hint)
    return MeasureResult(False, {"w": 1.2, "d": 0.8, "h": 1.0}, 0.25, "default",
                         f"Marker not usable ({reason}) — assumed a EUR pallet", results, crop, label_hint)
