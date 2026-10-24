// Pure 2D helpers for building.json geometry (metres, x right, y up). No three.js here so the
// mock API and the twin can share them.
import type { Building, Floor, Space, XY } from '../lib/types'

export function polygonArea(poly: XY[]): number {
  let a = 0
  for (let i = 0, n = poly.length; i < n; i++) {
    const [x1, y1] = poly[i]
    const [x2, y2] = poly[(i + 1) % n]
    a += x1 * y2 - x2 * y1
  }
  return a / 2
}

export function centroid(poly: XY[]): XY {
  const a = polygonArea(poly)
  if (Math.abs(a) < 1e-9) {
    const sx = poly.reduce((s, p) => s + p[0], 0)
    const sy = poly.reduce((s, p) => s + p[1], 0)
    return [sx / poly.length, sy / poly.length]
  }
  let cx = 0
  let cy = 0
  for (let i = 0, n = poly.length; i < n; i++) {
    const [x1, y1] = poly[i]
    const [x2, y2] = poly[(i + 1) % n]
    const f = x1 * y2 - x2 * y1
    cx += (x1 + x2) * f
    cy += (y1 + y2) * f
  }
  return [cx / (6 * a), cy / (6 * a)]
}

export function pointInPolygon(p: XY, poly: XY[]): boolean {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]
    const [xj, yj] = poly[j]
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

/** A point guaranteed inside the polygon (close to shapely's representative_point). */
export function interiorPoint(poly: XY[]): XY {
  const c = centroid(poly)
  if (pointInPolygon(c, poly)) return c
  let minY = Infinity
  let maxY = -Infinity
  for (const [, y] of poly) {
    minY = Math.min(minY, y)
    maxY = Math.max(maxY, y)
  }
  const y = (minY + maxY) / 2 + 1e-6
  const xs: number[] = []
  for (let i = 0, n = poly.length; i < n; i++) {
    const [x1, y1] = poly[i]
    const [x2, y2] = poly[(i + 1) % n]
    if (y1 > y !== y2 > y) xs.push(x1 + ((y - y1) * (x2 - x1)) / (y2 - y1))
  }
  xs.sort((a, b) => a - b)
  let best: XY = c
  let bestWidth = -1
  for (let i = 0; i + 1 < xs.length; i += 2) {
    const width = xs[i + 1] - xs[i]
    if (width > bestWidth) {
      bestWidth = width
      best = [(xs[i] + xs[i + 1]) / 2, y]
    }
  }
  return best
}

export function bbox(points: Iterable<XY>) {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const [x, y] of points) {
    if (x < minX) minX = x
    if (y < minY) minY = y
    if (x > maxX) maxX = x
    if (y > maxY) maxY = y
  }
  return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 }
}

export type BBox = ReturnType<typeof bbox>

export function* allSpacePoints(spaces: Space[]): Generator<XY> {
  for (const s of spaces) for (const p of s.polygon) yield p
}

/** Closest point on segment ab to p, with the parameter t in metres along ab. */
export function projectOnSegment(p: XY, a: XY, b: XY) {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const len2 = dx * dx + dy * dy
  const len = Math.sqrt(len2)
  let t = len2 > 0 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2 : 0
  t = Math.max(0, Math.min(1, t))
  const q: XY = [a[0] + t * dx, a[1] + t * dy]
  return { q, t: t * len, len, dist: Math.hypot(p[0] - q[0], p[1] - q[1]) }
}

export const sortedFloors = (b: Building): Floor[] =>
  [...b.floors].sort((a, c) => a.elevation_m - c.elevation_m || a.level - c.level)

/** Index everything by id once per building. */
export interface BuildingIndex {
  spaces: Map<string, Space>
  floors: Map<string, Floor>
  anchors: Map<string, XY>
  assets: Map<string, Building['assets'][number]>
  openings: Map<string, Building['openings'][number]>
  connectors: Map<string, Building['vertical_connectors'][number]>
  areas: Map<string, number>
}

const indexCache = new WeakMap<Building, BuildingIndex>()

export function indexBuilding(b: Building): BuildingIndex {
  const cached = indexCache.get(b)
  if (cached) return cached
  const idx: BuildingIndex = {
    spaces: new Map(b.spaces.map((s) => [s.id, s])),
    floors: new Map(b.floors.map((f) => [f.id, f])),
    anchors: new Map(b.spaces.map((s) => [s.id, interiorPoint(s.polygon)])),
    assets: new Map(b.assets.map((a) => [a.id, a])),
    openings: new Map(b.openings.map((o) => [o.id, o])),
    connectors: new Map(b.vertical_connectors.map((c) => [c.id, c])),
    areas: new Map(b.spaces.map((s) => [s.id, Math.abs(polygonArea(s.polygon))])),
  }
  indexCache.set(b, idx)
  return idx
}

/** Where an id (space, asset, opening, connector) lives: floor + 2D point + a rough radius. */
export function locate(b: Building, id: string): { floor_id: string; point: XY; radius: number }[] {
  const idx = indexBuilding(b)
  const space = idx.spaces.get(id)
  if (space) {
    const bb = bbox(space.polygon)
    return [{ floor_id: space.floor_id, point: idx.anchors.get(id)!, radius: Math.max(1.2, Math.min(12, Math.max(bb.w, bb.h) / 2)) }]
  }
  const asset = idx.assets.get(id)
  if (asset) {
    const r = asset.footprint ? Math.max(asset.footprint.width_m, asset.footprint.depth_m) / 2 + 0.6 : 1
    return [{ floor_id: asset.floor_id, point: asset.position, radius: r }]
  }
  const opening = idx.openings.get(id)
  if (opening) return [{ floor_id: opening.floor_id, point: opening.position, radius: Math.max(0.8, opening.width_m) }]
  const conn = idx.connectors.get(id)
  if (conn) {
    return conn.space_ids
      .map((sid) => idx.spaces.get(sid))
      .filter((s): s is Space => !!s)
      .map((s) => ({ floor_id: s.floor_id, point: idx.anchors.get(s.id)!, radius: 1.8 }))
  }
  return []
}

export function fmtDims(d: { w: number; d: number; h: number }) {
  return `${d.w.toFixed(2)} × ${d.d.toFixed(2)} × ${d.h.toFixed(2)} m`
}

export function hashString(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/** Direction (radians, building frame) of the wall an opening sits in: nearest edge of its spaces. */
export function openingWallAngle(b: Building, openingId: string): number {
  const idx = indexBuilding(b)
  const o = idx.openings.get(openingId)
  if (!o) return 0
  let best = Infinity
  let angle = 0
  for (const sid of o.space_ids) {
    const poly = idx.spaces.get(sid)?.polygon
    if (!poly) continue
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i]
      const c = poly[(i + 1) % poly.length]
      const pr = projectOnSegment(o.position, a, c)
      if (pr.dist < best) {
        best = pr.dist
        angle = Math.atan2(c[1] - a[1], c[0] - a[0])
      }
    }
  }
  return angle
}
