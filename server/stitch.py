"""Turn per-image floor-plan extractions into one building.json.

Each extraction is what Claude vision read from one photo/scan (normalised 0..1000 image coordinates,
y down, plus storey, north arrow and a rough metric size). Images of the same storey are stitched into
one floor via rooms/landmarks that carry the same unique label in both images (similarity fit with
RANSAC, or point pairs from a matcher callback when there are too few shared labels). Storeys are then
stacked by aligning stairs, lifts and landmarks such as voids, and stair/lift spaces on consecutive
storeys become vertical connectors. Pure geometry: no network, no Claude."""

from __future__ import annotations

import itertools
import math
import re
from collections import Counter
from collections.abc import Callable
from dataclasses import dataclass, field

import numpy as np
from shapely import STRtree, affinity
from shapely.geometry import MultiPolygon, Polygon
from shapely.ops import unary_union

FLOOR_HEIGHT_M = 3.5
MIN_AREA_M2 = 0.5
CONNECTOR_DISTANCE_M = 4.0

# matcher(a, b) -> point pairs [[[ua, va], [ub, vb]], ...] in each image's normalised frame
Matcher = Callable[[int, int], list]


class StitchError(ValueError):
    pass


# ------------------------------------------------------------------ affine helpers (3x3 homogeneous)

def _translate(tx: float, ty: float) -> np.ndarray:
    return np.array([[1.0, 0, tx], [0, 1.0, ty], [0, 0, 1.0]])


def _rotate(deg: float, about: tuple[float, float] = (0.0, 0.0)) -> np.ndarray:
    r = math.radians(deg)
    c, s = math.cos(r), math.sin(r)
    rot = np.array([[c, -s, 0], [s, c, 0], [0, 0, 1.0]])
    return _translate(*about) @ rot @ _translate(-about[0], -about[1])


def _scale(k: float) -> np.ndarray:
    return np.array([[k, 0, 0], [0, k, 0], [0, 0, 1.0]])


def _apply(m: np.ndarray, points) -> np.ndarray:
    arr = np.asarray(points, dtype=float).reshape(-1, 2)
    return arr @ m[:2, :2].T + m[:2, 2]


def _scale_of(m: np.ndarray) -> float:
    return float(math.sqrt(abs(np.linalg.det(m[:2, :2]))))


def _angle_of(m: np.ndarray) -> float:
    return math.degrees(math.atan2(m[1, 0], m[0, 0]))


def _shapely(m: np.ndarray, geometry):
    return affinity.affine_transform(geometry, [m[0, 0], m[0, 1], m[1, 0], m[1, 1], m[0, 2], m[1, 2]])


def svg_matrix(m: np.ndarray) -> list[float]:
    """SVG matrix(a b c d e f): x' = a*u + c*v + e, y' = b*u + d*v + f."""
    return [round(float(v), 6) for v in (m[0, 0], m[1, 0], m[0, 1], m[1, 1], m[0, 2], m[1, 2])]


def similarity_fit(src, dst, allow_scale: bool = True) -> np.ndarray:
    """Least-squares similarity (Umeyama) mapping src points onto dst points."""
    src, dst = np.asarray(src, float).reshape(-1, 2), np.asarray(dst, float).reshape(-1, 2)
    mu_s, mu_d = src.mean(0), dst.mean(0)
    if len(src) == 1:
        return _translate(*(mu_d - mu_s))
    xs, xd = src - mu_s, dst - mu_d
    u, sing, vt = np.linalg.svd(xd.T @ xs / len(src))
    d = np.eye(2)
    if np.linalg.det(u) * np.linalg.det(vt) < 0:
        d[1, 1] = -1
    rot = u @ d @ vt
    var_s = (xs ** 2).sum() / len(src)
    k = float((sing * np.diag(d)).sum() / var_s) if allow_scale and var_s > 1e-9 else 1.0
    m = np.eye(3)
    m[:2, :2] = k * rot
    m[:2, 2] = mu_d - k * rot @ mu_s
    return m


def scale_translate_fit(src, dst, rotation_deg: float) -> np.ndarray:
    """Least-squares scale + translation mapping src onto dst with the rotation held fixed."""
    src, dst = np.asarray(src, float).reshape(-1, 2), np.asarray(dst, float).reshape(-1, 2)
    rot = _rotate(rotation_deg)[:2, :2]
    turned = src @ rot.T
    mu_s, mu_d = turned.mean(0), dst.mean(0)
    xs, xd = turned - mu_s, dst - mu_d
    var = (xs ** 2).sum()
    k = float((xs * xd).sum() / var) if var > 1e-9 else 1.0
    m = np.eye(3)
    m[:2, :2] = k * rot
    m[:2, 2] = mu_d - k * mu_s
    return m


def robust_fit(src, dst, tol: float, allow_scale: bool = True,
               scale_range: tuple[float, float] = (0.33, 3.0)) -> tuple[np.ndarray, list[int], float] | None:
    """RANSAC over 2-point samples, then refit on the inliers. None if fewer than 2 inliers agree."""
    src, dst = np.asarray(src, float).reshape(-1, 2), np.asarray(dst, float).reshape(-1, 2)
    best: list[int] = []
    best_err = math.inf
    for i, j in itertools.combinations(range(len(src)), 2):
        if np.linalg.norm(src[i] - src[j]) < 1e-6 or np.linalg.norm(dst[i] - dst[j]) < 1e-6:
            continue
        m = similarity_fit(src[[i, j]], dst[[i, j]], allow_scale)
        if not scale_range[0] <= _scale_of(m) <= scale_range[1]:
            continue
        err = np.linalg.norm(_apply(m, src) - dst, axis=1)
        inliers = [int(k) for k in np.flatnonzero(err < tol)]
        total = float(err[inliers].sum())
        if len(inliers) > len(best) or (len(inliers) == len(best) and total < best_err):
            best, best_err = inliers, total
    if len(best) < 2:
        return None
    m = similarity_fit(src[best], dst[best], allow_scale)
    residual = float(np.linalg.norm(_apply(m, src[best]) - dst[best], axis=1).mean())
    return m, best, residual


# ------------------------------------------------------------------ geometry helpers

def norm_name(name: str | None) -> str:
    lowered = (name or "").lower().replace("ä", "ae").replace("ö", "oe").replace("ü", "ue").replace("ß", "ss")
    return re.sub(r"[^a-z0-9]+", "", lowered)


def _polygon(points) -> Polygon | None:
    pts = [(float(p[0]), float(p[1])) for p in points if len(p) >= 2]
    if len(pts) < 3:
        return None
    poly = Polygon(pts)
    if not poly.is_valid:
        poly = poly.buffer(0)
    return _largest(poly)


def _largest(geometry) -> Polygon | None:
    if isinstance(geometry, MultiPolygon):
        geometry = max(geometry.geoms, key=lambda g: g.area)
    if not isinstance(geometry, Polygon) or geometry.is_empty or geometry.area < MIN_AREA_M2:
        return None
    return geometry


def _coords(poly: Polygon) -> list[list[float]]:
    return [[round(x, 3), round(y, 3)] for x, y in list(poly.exterior.coords)[:-1]]


def _center(geometries) -> tuple[float, float]:
    minx, miny, maxx, maxy = unary_union(list(geometries)).bounds
    return ((minx + maxx) / 2, (miny + maxy) / 2)


def _extent(geometries) -> float:
    minx, miny, maxx, maxy = unary_union(list(geometries)).bounds
    return max(maxx - minx, maxy - miny, 1.0)


# ------------------------------------------------------------------ per-image frame

@dataclass
class Image:
    index: int
    data: dict
    local: np.ndarray  # normalised image coords -> metres, north up (if known)

    @property
    def has_north(self) -> bool:
        return bool(self.data.get("has_north_arrow"))

    def items(self, landmarks: bool = True) -> list[dict]:
        out = list(self.data.get("spaces") or [])
        if landmarks:
            out += [{**lm, "type": "landmark"} for lm in self.data.get("landmarks") or []]
        return out


def image_local(extraction: dict) -> np.ndarray:
    """Normalised (0..1000, y down) -> metres (y up) using the image's own size estimate, rotated so
    the plan's north arrow points up."""
    aspect = float(extraction.get("aspect") or 1.0)
    width = float(extraction.get("plan_width_m") or 30.0)
    height = float(extraction.get("plan_height_m") or width * aspect)
    to_m = np.array([[width / 1000, 0, 0], [0, -height / 1000, height], [0, 0, 1.0]])
    if extraction.get("has_north_arrow"):
        return _rotate(float(extraction.get("north_deg") or 0.0)) @ to_m
    return to_m


# ------------------------------------------------------------------ one storey

@dataclass
class Level:
    level: int
    label: str
    has_north: bool
    transforms: dict[int, np.ndarray] = field(default_factory=dict)  # image index -> normalised to level frame
    methods: dict[int, dict] = field(default_factory=dict)
    spaces: list[dict] = field(default_factory=list)  # {poly, name, type, room_type, sources}
    openings: list[dict] = field(default_factory=list)  # {a, b (space index | 'outside'), pos, kind, ...}
    landmarks: list[dict] = field(default_factory=list)  # {poly, name}
    images: list["Image"] = field(default_factory=list)

    def apply(self, m: np.ndarray) -> None:
        for index in self.transforms:
            self.transforms[index] = m @ self.transforms[index]
        for space in self.spaces:
            space["poly"] = _shapely(m, space["poly"])
        for landmark in self.landmarks:
            landmark["poly"] = _shapely(m, landmark["poly"])
        for opening in self.openings:
            opening["pos"] = _apply(m, opening["pos"])[0]

    def features(self) -> list[tuple[str, str, np.ndarray]]:
        out = [(s["type"], norm_name(s["name"]), np.array(s["poly"].centroid.coords[0]))
               for s in self.spaces if s["type"] in ("stair", "lift")]
        out += [("landmark", norm_name(lm["name"]), np.array(lm["poly"].centroid.coords[0])) for lm in self.landmarks]
        return out

    def outline(self):
        return unary_union([s["poly"].buffer(0.05) for s in self.spaces])


def _pair_key(a: int, b: int) -> str:
    return f"{a}-{b}"


# ------------------------------------------------------------------ overlap search

# harmonize_scales() already makes all plans' scales agree, so alignment only fine-tunes the scale.
SCALE_STEPS = (0.9, 1.0, 1.11)
MAX_ICP_SCALE = 1.15
LOOSE_KINDS = ("corridor", "hall", "outdoor", "landmark")


@dataclass
class Item:
    """A space or landmark reduced to what overlap search needs."""
    label: str  # normalised name, or the space type when unnamed
    named: bool
    kind: str  # space type or 'landmark'
    poly: Polygon

    @property
    def generator(self) -> bool:
        """Good enough to propose an alignment on its own: a labelled room, a stair/lift or a landmark."""
        return self.named or self.kind in ("stair", "lift", "landmark")


def _items(raw: list[dict], m: np.ndarray) -> list[Item]:
    out = []
    for item in raw:
        poly = _polygon(_apply(m, item.get("polygon") or []))
        if poly is None:
            continue
        name = norm_name(item.get("name"))
        kind = item.get("type", "room")
        out.append(Item(label=name or kind, named=bool(name), kind=kind, poly=poly))
    return out


def _level_items(level: "Level") -> list[Item]:
    out = [Item(norm_name(s["name"]) or s["type"], bool(norm_name(s["name"])), s["type"], s["poly"]) for s in level.spaces]
    out += [Item(norm_name(lm["name"]) or "landmark", bool(norm_name(lm["name"])), "landmark", lm["poly"]) for lm in level.landmarks]
    return out


FLOW_KINDS = ("corridor", "hall")


ROOM_KINDS = ("room", "stair", "lift")


def _weight(a: Item, b: Item, stacked: bool) -> float:
    """How well two overlapping items agree: > 0 consistent, < 0 contradicting, 0 neutral.

    Only rooms (rooms, stairs, lifts) can contradict each other: Claude draws corridors, halls, terraces and
    voids coarsely (one corridor polygon often runs across half the rooms), so those only ever count when
    they agree. Same storey: two plans must label a room the same wherever both draw it. Stacked storeys:
    cores, stairs, lifts, shafts and voids sit on top of each other, the use of ordinary rooms may change."""
    if a.kind in ROOM_KINDS and b.kind in ROOM_KINDS:
        if a.named and b.named and a.label == b.label:
            return 1.0
        if a.kind != b.kind:
            return -0.3 if stacked else -1.0
        if a.kind in ("stair", "lift"):
            return 1.0
        if stacked:
            return 0.0  # a meeting room above an office is fine
        return -1.0 if a.named and b.named else 0.5
    if a.kind == b.kind or (a.kind in FLOW_KINDS and b.kind in FLOW_KINDS):
        if a.kind == "landmark" and a.named and b.named and a.label != b.label:
            return 0.0
        return 1.0 if a.kind == "landmark" else 0.5
    return 0.0


def _transform_items(items: list[Item], m: np.ndarray) -> list[Item]:
    return [Item(it.label, it.named, it.kind, _shapely(m, it.poly)) for it in items]


def _overlap_score(src: list[Item], dst: list[Item], tree: STRtree, stacked: bool) -> tuple[int, float, float]:
    """(matched items, agreeing area m², contradicting area m²) of src (already transformed) on dst."""
    matched, agree, contradict = 0, 0.0, 0.0
    for item in src:
        best = 0.0
        for j in tree.query(item.poly):
            other = dst[int(j)]
            inter = item.poly.intersection(other.poly).area
            if inter <= 0:
                continue
            weight = _weight(item, other, stacked)
            if weight > 0:
                agree += weight * inter
                if weight >= 1:
                    best = max(best, inter / (item.poly.area + other.poly.area - inter))
            else:
                contradict -= weight * inter
        matched += best > 0.25
    return matched, agree, contradict


def _icp(m: np.ndarray, src: list[Item], dst: list[Item], tree: STRtree, tol: float,
         stacked: bool) -> tuple[np.ndarray, float]:
    """Refine scale and translation of m on centroids and nearby corners of overlapping agreeing items.
    The rotation stays as proposed: snap_to_walls() already made all plans' walls parallel, so plans differ
    by exact multiples of 90°, and letting ICP turn them only lets storeys drift askew. Returns (m, residual)."""
    base_angle = _angle_of(m)
    residual = math.inf
    for _ in range(5):
        src_pts, dst_pts = [], []
        for item in src:
            moved = _shapely(m, item.poly)
            best, best_iou = None, 0.2
            for j in tree.query(moved):
                other = dst[int(j)]
                if _weight(item, other, stacked) < 1:
                    continue
                inter = moved.intersection(other.poly).area
                iou = inter / (moved.area + other.poly.area - inter) if inter > 0 else 0.0
                if iou > best_iou:
                    best, best_iou = other, iou
            if best is None:
                continue
            if 0.7 < moved.area / best.poly.area < 1.4:  # cut-off rooms have misleading centroids
                src_pts.append(item.poly.centroid.coords[0])
                dst_pts.append(best.poly.centroid.coords[0])
            corners = np.array(best.poly.exterior.coords[:-1])
            for corner, moved_corner in zip(item.poly.exterior.coords[:-1], moved.exterior.coords[:-1]):
                dist = np.linalg.norm(corners - moved_corner, axis=1)
                if dist.min() < min(1.0, tol):
                    src_pts.append(corner)
                    dst_pts.append(corners[int(dist.argmin())])
        if len(src_pts) < 4:
            break
        src_a, dst_a = np.array(src_pts), np.array(dst_pts)
        candidate = scale_translate_fit(src_a, dst_a, base_angle)
        err = np.linalg.norm(_apply(candidate, src_a) - dst_a, axis=1)
        keep = err <= max(np.percentile(err, 80), 0.3)
        candidate = scale_translate_fit(src_a[keep], dst_a[keep], base_angle)
        if not 1 / MAX_ICP_SCALE <= _scale_of(candidate) / _scale_of(m) <= MAX_ICP_SCALE:
            break
        new_residual = float(np.linalg.norm(_apply(candidate, src_a[keep]) - dst_a[keep], axis=1).mean())
        if new_residual > tol:
            break
        m, residual = candidate, new_residual
    return m, (residual if math.isfinite(residual) else 0.0)


@dataclass
class Fit:
    m: np.ndarray
    matched: int
    agree_m2: float
    contradict_m2: float
    residual: float

    @property
    def score(self) -> float:
        return self.agree_m2 - 1.5 * self.contradict_m2


def find_overlap(src: list[Item], dst: list[Item], rotations: list[float], stacked: bool = False) -> Fit | None:
    """Best similarity placing src onto dst, or None when they do not demonstrably overlap.

    Every pair of items with the same label (or stairs, lifts, landmarks of the same kind) proposes a
    translation for each candidate rotation and scale. Proposals are pre-ranked by how many centroids then
    land on an agreeing item; the best are refined by ICP and judged by area: wherever both sides have
    rooms they must agree, so contradicting overlap (a WC lying on an open office, a room on a corridor)
    counts against a proposal. That keeps two similar building cores from being stacked onto each other
    when the plans only share, say, a terrace."""
    if not src or not dst:
        return None
    tree = STRtree([it.poly for it in dst])
    extent = _extent([it.poly for it in dst])
    tol = max(1.5, 0.05 * extent)
    src_c = np.array([it.poly.centroid.coords[0] for it in src])
    dst_c = np.array([it.poly.centroid.coords[0] for it in dst])
    src_a = np.array([it.poly.area for it in src])
    dst_a = np.array([it.poly.area for it in dst])
    weights = np.array([[_weight(a, b, stacked) for b in dst] for a in src])
    proposer = np.array([[a.generator and b.generator and (a.label == b.label if a.named and b.named else a.kind == b.kind)
                          for b in dst] for a in src])
    hypotheses = []
    for rot in rotations:
        for k in SCALE_STEPS:
            base = _rotate(rot) @ _scale(k)
            moved_c = _apply(base, src_c)
            ratio = (src_a * k * k)[:, None] / dst_a[None, :]
            pairs = proposer & (ratio > 0.4) & (ratio < 2.5)
            for i, j in zip(*np.nonzero(pairs)):
                t = dst_c[j] - moved_c[i]
                dist = np.linalg.norm((moved_c + t)[:, None, :] - dst_c[None, :, :], axis=2)
                close = dist < tol
                score = float(((close & (weights >= 1)).any(1)).sum() - ((close & (weights < 0)).any(1)).sum())
                hypotheses.append((score, _translate(*t) @ base))
    if not hypotheses:
        return None
    hypotheses.sort(key=lambda h: -h[0])
    best: Fit | None = None
    tried: list[np.ndarray] = []
    for _, m in hypotheses:
        if len(tried) >= 24:
            break
        if any(np.linalg.norm(m[:2, 2] - other[:2, 2]) < tol and abs(_scale_of(m) - _scale_of(other)) < 0.05
               for other in tried):
            continue
        tried.append(m)
        m, residual = _icp(m, src, dst, tree, tol, stacked)
        matched, agree, contradict = _overlap_score(_transform_items(src, m), dst, tree, stacked)
        fit = Fit(m, matched, agree, contradict, residual)
        if best is None or fit.score > best.score:
            best = fit
    if best is None or best.matched < 2 or best.agree_m2 < 10 or best.contradict_m2 > 0.5 * best.agree_m2:
        return None
    return best


def _wall_angle(polys: list[Polygon]) -> tuple[float, float]:
    """Dominant wall direction modulo 90° (degrees) and its total edge length."""
    c = s = total = 0.0
    for poly in polys:
        coords = list(poly.exterior.coords)
        for (x0, y0), (x1, y1) in itertools.pairwise(coords):
            length = math.hypot(x1 - x0, y1 - y0)
            angle = 4 * math.atan2(y1 - y0, x1 - x0)
            c += length * math.cos(angle)
            s += length * math.sin(angle)
            total += length
    return math.degrees(math.atan2(s, c) / 4), total


def snap_to_walls(images: list[Image]) -> None:
    """North arrows read off a photo are only roughly right. All plans show one building whose walls run in
    the same two directions, so turn each image (by less than 45°) until its walls match the common
    direction; then plans of the same orientation differ by exact multiples of 90°."""
    angles = [(image, *_wall_angle(_image_polys(image))) for image in images]
    c = sum(w * math.cos(math.radians(4 * a)) for _, a, w in angles)
    s = sum(w * math.sin(math.radians(4 * a)) for _, a, w in angles)
    if not c and not s:
        return
    common = math.degrees(math.atan2(s, c) / 4)
    for image, angle, _ in angles:
        delta = (common - angle + 45) % 90 - 45
        if abs(delta) > 0.1:
            image.local = _rotate(delta) @ image.local


def harmonize_scales(images: list[Image]) -> None:
    """Claude estimates each photo's real-world size on its own, and the estimates for photos of the same
    sign series can differ by a factor of two. Same-named rooms (WC, EDV, stairs, meeting rooms ...) have
    similar sizes on every plan and storey, so solve for one scale correction per image that makes their
    areas agree (least squares on log ratios; the geometric mean of the estimates is kept)."""
    if len(images) < 2:
        return
    areas: list[dict[str, list[float]]] = []
    for image in images:
        by_label: dict[str, list[float]] = {}
        for item in _items(image.items(), image.local):
            if item.named and item.kind not in FLOW_KINDS and item.kind != "outdoor":
                by_label.setdefault(item.label, []).append(item.poly.area)
        areas.append(by_label)
    rows, rhs, weights = [], [], []
    n = len(images)
    for i, j in itertools.combinations(range(n), 2):
        logs, wts = [], []
        for label in set(areas[i]) & set(areas[j]):
            a_i, a_j = areas[i][label], areas[j][label]
            for x in a_i:
                for y in a_j:
                    logs.append(0.5 * math.log(y / x))
                    wts.append(1.0 / (len(a_i) * len(a_j)))
        if sum(wts) < 2:  # need at least two shared labels' worth of evidence
            continue
        order = np.argsort(logs)
        cumulative = np.cumsum(np.array(wts)[order])
        median = float(np.array(logs)[order][np.searchsorted(cumulative, cumulative[-1] / 2)])
        row = np.zeros(n)
        row[i], row[j] = 1.0, -1.0  # x_i - x_j = log(linear size of j / size of i)
        rows.append(row)
        rhs.append(median)
        weights.append(min(sum(wts), 6.0))
    if not rows:
        return
    rows.append(np.ones(n))  # gauge: keep the geometric mean of the estimates
    rhs.append(0.0)
    weights.append(10.0)
    w = np.sqrt(np.array(weights))[:, None]
    solution, *_ = np.linalg.lstsq(np.array(rows) * w, np.array(rhs) * w[:, 0], rcond=None)
    for image, x in zip(images, solution):
        k = float(np.clip(math.exp(x), 0.33, 3.0))
        if abs(k - 1) > 0.02:
            image.local = _scale(k) @ image.local


def cluster_level(images: list[Image], warnings: list[str]) -> list[Level]:
    """Stitch the plans of one storey into clusters of plans that demonstrably overlap. Plans that overlap
    nothing on their storey start their own cluster; align_clusters() places those via other storeys."""
    images = sorted(images, key=lambda im: -len(im.data.get("spaces") or []))
    labels = Counter((im.data.get("floor_label") or "").strip() for im in images)
    label = next((lab for lab, _ in labels.most_common() if lab), "")
    clusters: list[Level] = []
    pending = list(images)
    while pending:
        seed = pending.pop(0)
        cluster = Level(level=int(seed.data.get("level") or 0), label=label, has_north=seed.has_north)
        cluster.transforms[seed.index] = seed.local.copy()
        cluster.methods[seed.index] = {"method": "reference", "anchors": 0, "residual_m": 0.0}
        cluster.images = [seed]
        placed_items = _items(seed.items(), seed.local)
        while pending:
            candidates = []
            for image in pending:
                rotations = [0.0] if image.has_north and seed.has_north else [0.0, 90.0, 180.0, 270.0]
                fit = find_overlap(_items(image.items(), image.local), placed_items, rotations)
                if fit is not None:
                    candidates.append((fit.score, image, fit))
            if not candidates:
                break
            _, image, fit = max(candidates, key=lambda c: c[0])
            pending.remove(image)
            cluster.transforms[image.index] = fit.m @ image.local
            cluster.methods[image.index] = _fit_meta("anchors", fit)
            cluster.images.append(image)
            placed_items += _items(image.items(), cluster.transforms[image.index])
            warnings.append(f"{label or f'Level {cluster.level}'}: stitched {_image_name(image)} onto "
                            f"{_image_name(seed)} via {fit.matched} overlapping rooms (±{fit.residual:.1f} m).")
        _merge(cluster, cluster.images)
        clusters.append(cluster)
    return clusters


def _image_name(image: Image) -> str:
    return image.data.get("filename") or f"plan {image.index + 1}"


def _fit_meta(method: str, fit: "Fit") -> dict:
    return {"method": method, "anchors": fit.matched, "matched_rooms": fit.matched, "agree_m2": round(fit.agree_m2),
            "contradict_m2": round(fit.contradict_m2), "residual_m": round(fit.residual, 2)}


def align_clusters(clusters: list[Level], matcher: Matcher | None, known_matches: dict[str, list],
                   warnings: list[str]) -> None:
    """Bring all clusters (stitched parts of storeys) into one frame.

    Starting from the largest cluster, repeatedly place the cluster that best sits on top of / below an
    already placed cluster of another storey (cores, stairs, lifts, shafts and voids repeat vertically),
    as long as it does not contradict what is already placed on its own storey. Clusters that line up with
    nothing are matched point-by-point by Claude against their storey, else placed beside it."""
    if len(clusters) < 2:
        return
    ref = max(clusters, key=lambda c: len(c.spaces))
    aligned = [ref]
    pending = [c for c in clusters if c is not ref and c.spaces]
    while pending:
        best = None
        for cluster in pending:
            items = _level_items(cluster)
            for other in sorted(aligned, key=lambda a: abs(a.level - cluster.level)):
                if other.level == cluster.level:
                    continue
                rotations = [0.0] if cluster.has_north and other.has_north else [0.0, 90.0, 180.0, 270.0]
                fit = find_overlap(items, _level_items(other), rotations, stacked=True)
                if fit is None or not _fits_own_storey(cluster, fit.m, aligned):
                    continue
                score = fit.score / (1 + 0.25 * (abs(other.level - cluster.level) - 1))  # prefer neighbours
                if best is None or score > best[0]:
                    best = (score, cluster, other, fit)
        if best is not None:
            _, cluster, other, fit = best
            cluster.apply(fit.m)
            warnings.append(f"{_cluster_name(cluster)}: stacked onto {_cluster_name(other)} via {fit.matched} rooms "
                            f"on top of each other (±{fit.residual:.1f} m).")
            pending.remove(cluster)
            aligned.append(cluster)
            continue
        # Nothing lines up vertically any more: fall back for one cluster and try again.
        cluster = max(pending, key=lambda c: len(c.spaces))
        pending.remove(cluster)
        same = [a for a in aligned if a.level == cluster.level]
        if same:
            target = max(same, key=lambda a: len(a.spaces))
            fit = _match_with_points(cluster, target, matcher, known_matches, warnings)
            if fit is not None and _fits_own_storey(cluster, fit.m, aligned):
                cluster.apply(fit.m)
                for index in cluster.transforms:
                    cluster.methods[index] = _fit_meta("point_match", fit)
                warnings.append(f"{_cluster_name(cluster)}: placed by matching points against "
                                f"{_image_name(target.images[0])}.")
            else:
                _beside(cluster, target)
                for index in cluster.transforms:
                    cluster.methods[index] = {"method": "side_by_side", "anchors": 0, "residual_m": None}
                warnings.append(f"{_cluster_name(cluster)}: overlaps nothing on its storey or the storeys above and "
                                "below; placed it alongside — check alignment.")
        else:
            neighbour = min(aligned, key=lambda a: abs(a.level - cluster.level))
            _coarse_align(cluster, neighbour, warnings)
        aligned.append(cluster)


def _cluster_name(cluster: Level) -> str:
    plans = ", ".join(_image_name(im) for im in cluster.images[:2]) + ("…" if len(cluster.images) > 2 else "")
    return f"{cluster.label or f'Level {cluster.level}'} ({plans})"


def _fits_own_storey(cluster: Level, m: np.ndarray, aligned: list[Level]) -> bool:
    """A placement must not draw different rooms where its own storey already has rooms."""
    same = [it for a in aligned if a.level == cluster.level for it in _level_items(a)]
    if not same:
        return True
    _, agree, contradict = _overlap_score(_transform_items(_level_items(cluster), m), same,
                                          STRtree([it.poly for it in same]), stacked=False)
    return contradict <= 0.5 * agree + 15.0


def _beside(cluster: Level, target: Level) -> None:
    px = unary_union([s["poly"] for s in target.spaces]).bounds
    mx = unary_union([s["poly"] for s in cluster.spaces]).bounds
    cluster.apply(_translate(px[2] + 2.0 - mx[0], px[1] - mx[1]))


def _match_with_points(cluster: Level, target: Level, matcher: Matcher | None, known_matches: dict[str, list],
                       warnings: list[str]) -> "Fit | None":
    """Fallback: ask the matcher (Claude) for corresponding points between the first plans of two clusters."""
    image, other = cluster.images[0], target.images[0]
    key = _pair_key(image.index, other.index)
    pairs = known_matches.get(key)
    if pairs is None and matcher is not None:
        try:
            pairs = matcher(image.index, other.index)
        except Exception as error:  # noqa: BLE001 - fallback must never break the upload
            warnings.append(f"Could not match {_image_name(image)} to {_image_name(other)}: {error}")
            pairs = []
        known_matches[key] = pairs
    if not pairs or len(pairs) < 2:
        return None
    src = _apply(cluster.transforms[image.index], [p[0] for p in pairs])
    dst = _apply(target.transforms[other.index], [p[1] for p in pairs])
    extent = _extent([s["poly"] for s in cluster.spaces] or [Polygon()])
    found = robust_fit(src, dst, max(2.0, 0.09 * extent))
    if found is None:
        return None
    m, inliers, residual = found
    return Fit(m, len(inliers), 0.0, 0.0, residual)


def combine_clusters(clusters: list[Level]) -> list[Level]:
    """One Level per storey: concatenate the (now aligned) clusters of each storey."""
    by_level: dict[int, list[Level]] = {}
    for cluster in clusters:
        by_level.setdefault(cluster.level, []).append(cluster)
    levels = []
    for number, group in sorted(by_level.items()):
        level = Level(level=number, label=group[0].label, has_north=any(c.has_north for c in group))
        for cluster in group:
            offset = len(level.spaces)
            level.spaces += cluster.spaces
            level.landmarks += cluster.landmarks
            level.openings += [{**o, "a": o["a"] + offset, "b": o["b"] if o["b"] == "outside" else o["b"] + offset}
                               for o in cluster.openings]
            level.transforms.update(cluster.transforms)
            level.methods.update(cluster.methods)
            level.images += cluster.images
        levels.append(level)
    return levels


def _straighten(levels: list[Level]) -> float:
    """Rotate everything so most walls run along x/y (plans are north-up until now). Returns the angle
    applied, in degrees counter-clockwise."""
    c = s = 0.0
    for level in levels:
        for space in level.spaces:
            coords = list(space["poly"].exterior.coords)
            for (x0, y0), (x1, y1) in itertools.pairwise(coords):
                length = math.hypot(x1 - x0, y1 - y0)
                angle = 4 * math.atan2(y1 - y0, x1 - x0)
                c += length * math.cos(angle)
                s += length * math.sin(angle)
    if not c and not s:
        return 0.0
    rotation = -math.degrees(math.atan2(s, c) / 4)
    if abs(rotation) > 0.5:
        for level in levels:
            level.apply(_rotate(rotation))
    return rotation


def _image_polys(image: Image) -> list[Polygon]:
    out = []
    for item in image.items():
        poly = _polygon(_apply(image.local, item.get("polygon") or []))
        if poly is not None:
            out.append(poly)
    return out


def _merge(level: Level, images: list[Image]) -> None:
    """Union the spaces of all images of one storey; the same room seen in two images becomes one."""
    key_map: dict[tuple[int, str], int] = {}
    for image in images:
        t = level.transforms[image.index]
        for item in image.data.get("spaces") or []:
            poly = _polygon(_apply(t, item.get("polygon") or []))
            if poly is None:
                continue
            name = item.get("name") or ""
            best, best_score = None, 0.0
            for index, space in enumerate(level.spaces):
                if image.index in space["sources"] or not space["poly"].intersects(poly):
                    continue
                inter = space["poly"].intersection(poly).area
                smaller = min(space["poly"].area, poly.area)
                same_name = norm_name(name) and norm_name(name) == norm_name(space["name"])
                same_type = space["type"] == item.get("type", "room")
                score = inter / smaller if smaller else 0.0
                if (same_name and score > 0.2) or (same_type and score > 0.5):
                    if score > best_score:
                        best, best_score = index, score
            if best is not None:
                space = level.spaces[best]
                merged = _largest(unary_union([space["poly"], poly]).simplify(0.05))
                if merged is not None:
                    space["poly"] = merged
                space["sources"].add(image.index)
                if not space["name"] and name:
                    space["name"] = name
                key_map[(image.index, item["key"])] = best
            else:
                key_map[(image.index, item["key"])] = len(level.spaces)
                level.spaces.append({"poly": poly, "name": name, "type": item.get("type", "room"),
                                     "room_type": item.get("room_type", "generic_room"), "sources": {image.index}})
        for item in image.data.get("landmarks") or []:
            poly = _polygon(_apply(t, item.get("polygon") or []))
            if poly is None:
                continue
            same = next((lm for lm in level.landmarks if norm_name(lm["name"]) == norm_name(item.get("name"))
                         and lm["poly"].intersects(poly)), None)
            if same:
                same["poly"] = _largest(unary_union([same["poly"], poly])) or same["poly"]
            else:
                level.landmarks.append({"poly": poly, "name": item.get("name") or "Landmark"})
        for item in image.data.get("openings") or []:
            first = key_map.get((image.index, item.get("from_key")))
            second = "outside" if item.get("to_key") == "outside" else key_map.get((image.index, item.get("to_key")))
            if first is None or second is None or first == second:
                continue
            pos = _apply(t, [[item.get("x", 0), item.get("y", 0)]])[0]
            pair = {first, second}
            if any({o["a"], o["b"]} == pair and np.linalg.norm(o["pos"] - pos) < 0.8 for o in level.openings):
                continue
            level.openings.append({"a": first, "b": second, "pos": pos,
                                   "kind": "entrance" if second == "outside" else item.get("kind", "door"),
                                   "width_m": round(float(item.get("width_m") or 0.9), 2),
                                   "step_free": bool(item.get("step_free", True))})


# ------------------------------------------------------------------ stacking storeys

def _coarse_align(level: Level, ref: Level, warnings: list[str]) -> None:
    """Fallback when no rooms line up: centre the storey on its neighbour, trying the 90° turns when a
    north arrow is missing, scored by stairs/lifts/landmarks that coincide and by outline overlap."""
    name = level.label or f"Level {level.level}"
    ref_features = ref.features()
    ref_outline = ref.outline()
    rotations = [0] if (level.has_north and ref.has_north) else [0, 90, 180, 270]
    center = _center(s["poly"] for s in level.spaces)
    tol = max(2.5, 0.05 * _extent(s["poly"] for s in ref.spaces))
    best = None
    for rot in rotations:
        coarse_rot = _rotate(rot, center)
        feats = [(kind, nm, _apply(coarse_rot, p)[0]) for kind, nm, p in level.features()]
        candidates = [np.array(_center([ref_outline])) - np.array(center)]
        for kind, nm, point in feats:
            for rkind, rnm, rpoint in ref_features:
                if kind == rkind and (kind != "landmark" or nm == rnm):
                    candidates.append(rpoint - point)
        outline = _shapely(coarse_rot, level.outline())
        for t in candidates:
            hits = 0
            for kind, nm, point in feats:
                near = [np.linalg.norm(rpoint - (point + t)) for rkind, rnm, rpoint in ref_features
                        if rkind == kind and (kind != "landmark" or nm == rnm)]
                hits += bool(near) and min(near) < tol
            moved_outline = affinity.translate(outline, t[0], t[1])
            union = moved_outline.union(ref_outline).area
            iou = moved_outline.intersection(ref_outline).area / union if union else 0.0
            score = hits * 10 + iou * 5 + (0.5 if rot == 0 else 0.0)
            if best is None or score > best[0]:
                best = (score, rot, t, hits)
    _, rot, t, hits = best
    level.apply(_translate(*t) @ _rotate(rot, center))
    if hits:
        warnings.append(f"{name}: few rooms line up with {ref.label or f'level {ref.level}'}; aligned it by its "
                        "stairs and outline only — check the stacking.")
    else:
        warnings.append(f"{name}: nothing lines up with {ref.label or f'level {ref.level}'}; centred it on that "
                        "floor — check the stacking.")


def build_connectors(levels: list[Level], floor_ids: dict[int, str], space_ids: dict[tuple[int, int], str],
                     site_id: str, warnings: list[str]) -> list[dict]:
    """Chain stair/lift spaces that sit on top of each other into multi-storey connectors."""
    ordered = sorted(levels, key=lambda lv: lv.level)
    chains: list[dict] = []
    top_of: dict[tuple[int, int], dict] = {}
    for lower, upper in itertools.pairwise(ordered):
        pairs = []
        for i, a in enumerate(lower.spaces):
            if a["type"] not in ("stair", "lift"):
                continue
            for j, b in enumerate(upper.spaces):
                if b["type"] != a["type"]:
                    continue
                overlap = a["poly"].intersection(b["poly"]).area if a["poly"].intersects(b["poly"]) else 0.0
                dist = a["poly"].centroid.distance(b["poly"].centroid)
                if overlap > 0 or dist < CONNECTOR_DISTANCE_M:
                    pairs.append((-overlap, dist, i, j))
        used_low, used_up, linked = set(), set(), False
        for _, _, i, j in sorted(pairs):
            if i in used_low or j in used_up:
                continue
            used_low.add(i)
            used_up.add(j)
            _link(chains, top_of, lower, i, upper, j, synthetic=False)
            linked = True
        if not linked:
            fallback = _fallback_pair(lower, upper)
            if fallback is None:
                warnings.append(f"Could not connect {lower.label or lower.level} and {upper.label or upper.level}: "
                                "no stairs, lifts or corridors found.")
                continue
            i, j = fallback
            _link(chains, top_of, lower, i, upper, j, synthetic=True)
            warnings.append(f"No staircase lines up between {lower.label or f'level {lower.level}'} and "
                            f"{upper.label or f'level {upper.level}'}; assumed {lower.spaces[i]['name'] or 'a stair'} "
                            f"connects to {upper.spaces[j]['name'] or 'a stair'}.")
    connectors = []
    counts: Counter = Counter()
    for index, chain in enumerate(chains, start=1):
        kind = "lift" if chain["type"] == "lift" else "stairs"
        counts[kind] += 1
        label = next((lv.spaces[i]["name"] for lv, i in chain["stops"] if lv.spaces[i]["name"]), "")
        connectors.append({
            "id": f"{site_id}-V{index:02d}", "kind": kind,
            "name": label or f"{'Lift' if kind == 'lift' else 'Stairs'} {counts[kind]}",
            "floor_ids": [floor_ids[lv.level] for lv, _ in chain["stops"]],
            "space_ids": [space_ids[(lv.level, i)] for lv, i in chain["stops"]],
            "step_free": kind == "lift", "synthetic": chain["synthetic"],
        })
    return connectors


def _link(chains, top_of, lower: Level, i: int, upper: Level, j: int, synthetic: bool) -> None:
    chain = top_of.pop((lower.level, i), None)
    if chain is None or chain["type"] != upper.spaces[j]["type"]:
        chain = {"type": lower.spaces[i]["type"], "stops": [(lower, i)], "synthetic": synthetic}
        chains.append(chain)
    chain["stops"].append((upper, j))
    chain["synthetic"] = chain["synthetic"] or synthetic
    top_of[(upper.level, j)] = chain


def _fallback_pair(lower: Level, upper: Level) -> tuple[int, int] | None:
    def candidates(level: Level) -> list[int]:
        for types in (("stair",), ("lift",), ("corridor", "hall")):
            found = [i for i, s in enumerate(level.spaces) if s["type"] in types]
            if found:
                return found
        return list(range(len(level.spaces)))

    low, up = candidates(lower), candidates(upper)
    if not low or not up:
        return None
    return min(((i, j) for i in low for j in up),
               key=lambda ij: lower.spaces[ij[0]]["poly"].centroid.distance(upper.spaces[ij[1]]["poly"].centroid))


# ------------------------------------------------------------------ building

def build_from_extractions(extractions: list[dict], site_id: str, name: str, *, width_m: float | None = None,
                           address: str | None = None, matcher: Matcher | None = None,
                           matches: dict[str, list] | None = None,
                           level_overrides: dict[int, int] | None = None) -> tuple[dict, list[str], dict[str, list]]:
    """Extractions (one per uploaded image, in upload order) -> (building.json, warnings, point matches).

    `matches` caches matcher results by "a-b" image pair so re-stitching never calls Claude again."""
    warnings: list[str] = []
    matches = dict(matches or {})
    overrides = level_overrides or {}
    images: list[Image] = []
    plans_meta: list[dict] = []
    for index, data in enumerate(extractions):
        filename = data.get("filename") or f"plan {index + 1}"
        if data.get("error"):
            warnings.append(f"{filename}: {data['error']}")
            plans_meta.append({"index": index, "filename": filename, "error": data["error"]})
            continue
        if not data.get("spaces"):
            warnings.append(f"{filename}: no rooms recognised; skipped.")
            plans_meta.append({"index": index, "filename": filename, "error": "no rooms recognised"})
            continue
        data = {**data, "level": int(overrides.get(index, data.get("level") or 0))}
        images.append(Image(index=index, data=data, local=image_local(data)))
    if not images:
        raise StitchError("No rooms were recognised on any plan. Try sharper photos or a building.json.")

    snap_to_walls(images)
    harmonize_scales(images)
    by_level: dict[int, list[Image]] = {}
    for image in images:
        by_level.setdefault(image.data["level"], []).append(image)
    clusters = [c for _, group in sorted(by_level.items()) for c in cluster_level(group, warnings)]
    align_clusters(clusters, matcher, matches, warnings)
    levels = combine_clusters(clusters)
    rotation = _straighten(levels)
    if width_m:
        k = float(width_m) / _extent(s["poly"] for lv in levels for s in lv.spaces)
        for level in levels:
            level.apply(_scale(k))

    # Shift so the building starts near (0, 0).
    minx, miny, _, _ = unary_union([s["poly"] for lv in levels for s in lv.spaces]).bounds
    for level in levels:
        level.apply(_translate(-minx, -miny))

    floors, spaces, openings = [], [], []
    floor_ids: dict[int, str] = {}
    space_ids: dict[tuple[int, int], str] = {}
    for level in sorted(levels, key=lambda lv: lv.level):
        floor_id = f"{site_id}-F{level.level}"
        floor_ids[level.level] = floor_id
        default = "Ground floor" if level.level == 0 else (f"Basement {-level.level}" if level.level < 0
                                                            else f"Floor {level.level}")
        floors.append({"id": floor_id, "level": level.level, "name": level.label or default,
                       "elevation_m": round(level.level * FLOOR_HEIGHT_M, 2), "height_m": FLOOR_HEIGHT_M})
        for i, space in enumerate(level.spaces):
            space_id = f"{floor_id}-S{i + 1:03d}"
            space_ids[(level.level, i)] = space_id
            ref_match = re.search(r"\d+(?:\.\d+)?", space["name"])
            spaces.append({"id": space_id, "floor_id": floor_id, "type": space["type"],
                           "room_type": space["room_type"], "name": space["name"] or space_id,
                           "ref": ref_match.group(0) if ref_match else None,
                           "polygon": _coords(space["poly"]), "synthetic": False})
        for i, opening in enumerate(level.openings):
            b = "outside" if opening["b"] == "outside" else space_ids[(level.level, opening["b"])]
            openings.append({"id": f"{floor_id}-O{i + 1:04d}", "floor_id": floor_id,
                             "space_ids": [space_ids[(level.level, opening["a"])], b], "kind": opening["kind"],
                             "position": [round(float(opening["pos"][0]), 3), round(float(opening["pos"][1]), 3)],
                             "width_m": opening["width_m"], "step_free": opening["step_free"], "synthetic": False})
    connectors = build_connectors(levels, floor_ids, space_ids, site_id, warnings)

    lowest = min(levels, key=lambda lv: lv.level)
    if lowest.level > 0 and not any("outside" in o["space_ids"] and o["floor_id"] == floor_ids[lowest.level]
                                    for o in openings):
        exits = [i for i, s in enumerate(lowest.spaces) if s["type"] in ("stair", "lift")]
        for n, i in enumerate(exits, start=1):
            space = lowest.spaces[i]
            point = space["poly"].representative_point()
            openings.append({"id": f"{floor_ids[lowest.level]}-O-exit{n}", "floor_id": floor_ids[lowest.level],
                             "space_ids": [space_ids[(lowest.level, i)], "outside"], "kind": "entrance",
                             "position": [round(point.x, 3), round(point.y, 3)], "width_m": 1.2,
                             "step_free": space["type"] == "lift", "synthetic": True})
        if exits:
            names = ", ".join(lowest.spaces[i]["name"] or "stair" for i in exits[:4])
            warnings.append(f"Only upper floors uploaded: assumed {names} lead down to the street.")

    for image in images:
        method = next(lv.methods[image.index] for lv in levels if image.index in lv.methods)
        transform = next(lv.transforms[image.index] for lv in levels if image.index in lv.transforms)
        plans_meta.append({"index": image.index, "filename": image.data.get("filename") or f"plan {image.index + 1}",
                           "level": image.data["level"], "floor_label": image.data.get("floor_label") or "",
                           "detected_level": int(extractions[image.index].get("level") or 0),
                           "has_north_arrow": image.has_north, "transform": svg_matrix(transform), **method})
    plans_meta.sort(key=lambda p: p["index"])

    building = {
        "building": {"id": site_id, "name": name, "source": "floor_plan_upload", "license": "user",
                     "attribution": "Parsed from uploaded floor plans with Claude vision", "units": "m",
                     **({"address": address} if address else {}),
                     # direction of north in this frame, degrees clockwise from +y (only known from north arrows)
                     **({"north_deg": round((-rotation) % 360, 1)} if any(im.has_north for im in images) else {}),
                     "plans": plans_meta},
        "floors": floors,
        "spaces": spaces,
        "openings": openings,
        "vertical_connectors": connectors,
        "assets": [],
    }
    return building, warnings, matches
