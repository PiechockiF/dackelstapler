"""Printed ArUco marker: generation (A4 PDF) and detection (scale + floor-plane camera pose).

The marker is DICT_4X4_50 id 7, printed with an outer black edge of exactly 150 mm.
It lies flat on the floor next to the delivery. Its frame is the "world" for one photo:
origin at the marker centre, X along the marker's top edge, Y towards the top edge, Z up.

OpenCV 5.x API: cv2.aruco.ArucoDetector / cv2.aruco.generateImageMarker.
"""

from __future__ import annotations

import io
import math
import os
from dataclasses import dataclass

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageOps

MARKER_DICT = cv2.aruco.DICT_4X4_50
MARKER_ID = 7
MARKER_SIZE_M = 0.150

# Page raster: 254 dpi = exactly 10 px per mm, so millimetres map to whole pixels.
_PX_PER_MM = 10
_A4_MM = (210, 297)
_DPI = 25.4 * _PX_PER_MM


def dictionary() -> cv2.aruco.Dictionary:
    return cv2.aruco.getPredefinedDictionary(MARKER_DICT)


def marker_image(side_px: int, marker_id: int = MARKER_ID) -> np.ndarray:
    """Grayscale marker, black outer edge to black outer edge = side_px (no quiet zone)."""
    return cv2.aruco.generateImageMarker(dictionary(), marker_id, side_px, borderBits=1)


def _font(size: int) -> ImageFont.ImageFont:
    for name in ("Helvetica.ttc", "Arial.ttf", "DejaVuSans.ttf", "/System/Library/Fonts/Helvetica.ttc"):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    return ImageFont.load_default(size=size)


def marker_page() -> Image.Image:
    """A4 page (portrait) at 10 px/mm with the marker, instructions and a 10 cm check ruler."""
    mm = _PX_PER_MM
    page = Image.new("L", (_A4_MM[0] * mm, _A4_MM[1] * mm), 255)
    draw = ImageDraw.Draw(page)
    side = int(MARKER_SIZE_M * 1000 * mm)  # 1500 px = 150 mm
    left = (page.width - side) // 2
    top = 40 * mm
    page.paste(Image.fromarray(marker_image(side)), (left, top))

    title, body, small = _font(7 * mm), _font(4 * mm), _font(3 * mm)
    draw.text((page.width // 2, 14 * mm), "SiteTwin scale marker", font=title, fill=0, anchor="mm")
    draw.text(
        (page.width // 2, 26 * mm),
        "PRINT AT 100 % (\"actual size\", no fit-to-page)",
        font=body, fill=0, anchor="mm",
    )
    draw.text(
        (page.width // 2, top + side + 8 * mm),
        "ArUco DICT_4X4_50 · id 7 · black square = 150 mm",
        font=small, fill=0, anchor="mm",
    )

    # 10 cm check ruler.
    ruler_y = top + side + 30 * mm
    x0 = (page.width - 100 * mm) // 2
    draw.line([(x0, ruler_y), (x0 + 100 * mm, ruler_y)], fill=0, width=3)
    for millimetre in range(0, 101):
        length = 6 * mm if millimetre % 10 == 0 else (4 * mm if millimetre % 5 == 0 else 2 * mm)
        x = x0 + millimetre * mm
        draw.line([(x, ruler_y), (x, ruler_y - length)], fill=0, width=2 if millimetre % 10 else 3)
        if millimetre % 10 == 0:
            draw.text((x, ruler_y + 4 * mm), str(millimetre // 10), font=small, fill=0, anchor="mm")
    draw.text((x0 + 50 * mm, ruler_y + 10 * mm), "cm — this ruler must measure exactly 10 cm",
              font=small, fill=0, anchor="mm")

    steps = [
        "1. Lay the sheet flat on the floor right next to the item (parallel to an edge is best).",
        "2. Take 1–4 photos from about 2–3 m, slightly from above, item and marker fully in frame.",
        "3. Corners of the item should be visible; avoid covering the marker.",
    ]
    for index, line in enumerate(steps):
        draw.text((18 * mm, ruler_y + 24 * mm + index * 7 * mm), line, font=small, fill=0)
    return page


def marker_pdf_bytes() -> bytes:
    buffer = io.BytesIO()
    marker_page().convert("RGB").save(buffer, format="PDF", resolution=_DPI)
    return buffer.getvalue()


# ---------------------------------------------------------------- detection


@dataclass
class MarkerDetection:
    corners: np.ndarray        # (4, 2) image px: TL, TR, BR, BL of the marker
    image_size: tuple[int, int]  # (width, height)
    K: np.ndarray              # 3x3 intrinsics
    rvec: np.ndarray           # marker → camera
    tvec: np.ndarray
    focal_source: str          # "exif" | "homography" | "default" | "given"

    @property
    def R(self) -> np.ndarray:
        return cv2.Rodrigues(self.rvec)[0]

    @property
    def floor_homography(self) -> np.ndarray:
        """3x3 mapping floor metres (X, Y, 1) → image pixels."""
        R = self.R
        H = self.K @ np.column_stack([R[:, 0], R[:, 1], self.tvec.reshape(3)])
        return H / H[2, 2]

    @property
    def pixels_per_metre(self) -> float:
        """Mean marker edge length in pixels / marker size (scale at the marker, informative only)."""
        edges = [np.linalg.norm(self.corners[i] - self.corners[(i + 1) % 4]) for i in range(4)]
        return float(np.mean(edges) / MARKER_SIZE_M)

    @property
    def camera_position(self) -> np.ndarray:
        """Camera centre in marker/world coordinates (Z up)."""
        return (-self.R.T @ self.tvec.reshape(3)).reshape(3)

    def project(self, points_world: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        """World points (N,3) → (image px (N,2), camera depth (N,))."""
        cam = (self.R @ np.asarray(points_world, float).T + self.tvec.reshape(3, 1)).T
        depth = cam[:, 2]
        safe = np.where(depth > 1e-6, depth, 1e-6)
        pixels = (self.K @ (cam / safe[:, None]).T).T[:, :2]
        return pixels, depth

    def image_to_floor(self, pixels: np.ndarray) -> np.ndarray:
        """Image px (N,2) → floor metres (N,2) (only valid below the horizon)."""
        H_inv = np.linalg.inv(self.floor_homography)
        homog = np.column_stack([np.asarray(pixels, float), np.ones(len(pixels))])
        floor = (H_inv @ homog.T).T
        return floor[:, :2] / floor[:, 2:3]

    def to_json(self) -> dict:
        return {
            "corners": self.corners.round(2).tolist(),
            "pixels_per_metre": round(self.pixels_per_metre, 1),
            "focal_px": round(float(self.K[0, 0]), 1),
            "focal_source": self.focal_source,
            "camera_height_m": round(float(self.camera_position[2]), 3),
        }


def marker_object_points(size_m: float = MARKER_SIZE_M) -> np.ndarray:
    half = size_m / 2
    return np.array([[-half, half, 0], [half, half, 0], [half, -half, 0], [-half, -half, 0]], dtype=np.float64)


def _focal_from_homography(corners: np.ndarray, width: int, height: int) -> float | None:
    """Zhang-style single-plane focal estimate (square pixels, centred principal point)."""
    half = MARKER_SIZE_M / 2
    plane = np.array([[-half, half], [half, half], [half, -half], [-half, -half]], dtype=np.float64)
    shifted = corners - np.array([width / 2, height / 2])
    H, _ = cv2.findHomography(plane, shifted)
    if H is None:
        return None
    h11, h12, h21, h22, h31, h32 = H[0, 0], H[0, 1], H[1, 0], H[1, 1], H[2, 0], H[2, 1]
    candidates = []
    if abs(h31 * h32) > 1e-12:
        f2 = -(h11 * h12 + h21 * h22) / (h31 * h32)
        if f2 > 0:
            candidates.append(math.sqrt(f2))
    denominator = h31**2 - h32**2
    if abs(denominator) > 1e-12:
        f2 = (h12**2 + h22**2 - h11**2 - h21**2) / denominator
        if f2 > 0:
            candidates.append(math.sqrt(f2))
    long_side = max(width, height)
    plausible = [f for f in candidates if 0.45 * long_side < f < 2.5 * long_side]
    if not plausible:
        return None
    return float(np.median(plausible))


def default_focal(width: int, height: int) -> float:
    """Typical phone main camera, ~25 mm (35 mm-equivalent) → ≈0.58 × image diagonal."""
    return 25.0 / 43.27 * math.hypot(width, height)


def focal_from_exif(image: Image.Image) -> float | None:
    try:
        exif = image.getexif()
        f35 = exif.get_ifd(0x8769).get(0xA405) or exif.get(0xA405)  # FocalLengthIn35mmFilm
        if f35:
            return float(f35) / 43.27 * math.hypot(*image.size)
    except Exception:  # noqa: BLE001 — EXIF is best effort
        return None
    return None


def detect_marker(
    image_bgr: np.ndarray,
    marker_id: int = MARKER_ID,
    focal_px: float | None = None,
    focal_source: str = "given",
) -> MarkerDetection | None:
    gray = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2GRAY) if image_bgr.ndim == 3 else image_bgr
    parameters = cv2.aruco.DetectorParameters()
    parameters.cornerRefinementMethod = cv2.aruco.CORNER_REFINE_SUBPIX
    detector = cv2.aruco.ArucoDetector(dictionary(), parameters)
    corners, ids, _ = detector.detectMarkers(gray)
    if ids is None:
        return None
    found = [c.reshape(4, 2) for c, i in zip(corners, ids.flatten()) if int(i) == marker_id]
    if not found:
        return None
    marker = max(found, key=lambda c: cv2.contourArea(c.astype(np.float32)))
    height, width = gray.shape[:2]

    if focal_px is None:
        # A 15 cm marker gives a noisy self-calibration (±15 %); the phone prior is usually closer.
        # Floor-plane lengths do not depend on the focal length at all, only heights do.
        prior = default_focal(width, height)
        estimate = _focal_from_homography(marker, width, height)
        if os.environ.get("SITETWIN_FOCAL_SELF_CALIBRATE") and estimate and 0.6 * prior < estimate < 1.6 * prior:
            focal_px, focal_source = estimate, "homography"
        else:
            focal_px, focal_source = prior, "default"
    K = np.array([[focal_px, 0, width / 2], [0, focal_px, height / 2], [0, 0, 1]], dtype=np.float64)
    ok, rvec, tvec = cv2.solvePnP(
        marker_object_points(), marker.astype(np.float64), K, None, flags=cv2.SOLVEPNP_IPPE_SQUARE
    )
    if not ok:
        return None
    return MarkerDetection(marker.astype(np.float64), (width, height), K, rvec, tvec, focal_source)


def load_image(data: bytes, max_side: int = 1600) -> tuple[np.ndarray, float | None]:
    """Decode upload bytes with EXIF orientation applied; downscale; return (BGR, focal px or None)."""
    pil = Image.open(io.BytesIO(data))
    focal = focal_from_exif(pil)
    pil = ImageOps.exif_transpose(pil).convert("RGB")  # focal is diagonal-relative, so rotation-safe
    scale = min(1.0, max_side / max(pil.size))
    if scale < 1.0:
        pil = pil.resize((round(pil.width * scale), round(pil.height * scale)), Image.Resampling.LANCZOS)
        if focal is not None:
            focal *= scale
    return cv2.cvtColor(np.asarray(pil), cv2.COLOR_RGB2BGR), focal
