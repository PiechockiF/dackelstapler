// Port of core.geometry.footprint_fits: find a free spot for a width x depth footprint in a room, between
// the walls and the existing equipment. Same search as Python (grid nearest the room anchor first, rotations
// aligned to the longest walls); Shapely's polygon difference becomes rectangle-in-polygon + SAT tests.
import type { XY } from '../lib/types'
import { pointInPolygon, polygonArea } from '../twin/geom'

export interface Footprint { position: XY; width_m: number; depth_m: number; rotation_deg: number }
export interface Fit { ok: boolean; reason: string; position: XY | null; rotation_deg: number }

export function corners({ position: [x, y], width_m, depth_m, rotation_deg }: Footprint): XY[] {
  const a = (rotation_deg * Math.PI) / 180, cos = Math.cos(a), sin = Math.sin(a)
  return ([[-1, -1], [1, -1], [1, 1], [-1, 1]] as const).map(([sx, sy]) => {
    const dx = (sx * width_m) / 2, dy = (sy * depth_m) / 2
    return [x + dx * cos - dy * sin, y + dx * sin + dy * cos] as XY
  })
}

/** Separating-axis test for two convex quads; touching edges do not count as overlap. */
function overlaps(a: XY[], b: XY[]): boolean {
  for (const shape of [a, b]) {
    for (let i = 0; i < shape.length; i++) {
      const [x1, y1] = shape[i], [x2, y2] = shape[(i + 1) % shape.length]
      const nx = y1 - y2, ny = x2 - x1
      const project = (pts: XY[]) => pts.map(([x, y]) => x * nx + y * ny)
      const pa = project(a), pb = project(b)
      if (Math.max(...pa) <= Math.min(...pb) + 1e-9 || Math.max(...pb) <= Math.min(...pa) + 1e-9) return false
    }
  }
  return true
}

function segmentsCross([a, b]: [XY, XY], [c, d]: [XY, XY]): boolean {
  const cross = (o: XY, p: XY, q: XY) => (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0])
  const d1 = cross(c, d, a), d2 = cross(c, d, b), d3 = cross(a, b, c), d4 = cross(a, b, d)
  return ((d1 > 1e-9 && d2 < -1e-9) || (d1 < -1e-9 && d2 > 1e-9)) && ((d3 > 1e-9 && d4 < -1e-9) || (d3 < -1e-9 && d4 > 1e-9))
}

/** The quad lies inside the room: all corners inside and no wall crosses an edge (concave rooms). */
function inside(quad: XY[], room: XY[]): boolean {
  if (!quad.every((p) => pointInPolygon(p, room))) return false
  for (let i = 0; i < quad.length; i++) {
    const edge: [XY, XY] = [quad[i], quad[(i + 1) % quad.length]]
    for (let j = 0; j < room.length; j++) if (segmentsCross(edge, [room[j], room[(j + 1) % room.length]])) return false
  }
  return true
}

/** 0°, 90° and the directions of the two longest walls (core.geometry._wall_angles). */
function wallAngles(room: XY[]): number[] {
  const edges = room.map((a, i) => {
    const b = room[(i + 1) % room.length]
    return { length: Math.hypot(b[0] - a[0], b[1] - a[1]), angle: (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI }
  }).sort((x, y) => y.length - x.length)
  const angles = [0, 90]
  for (const { angle } of edges.slice(0, 2)) {
    const a = ((angle % 180) + 180) % 180
    if (angles.every((known) => Math.abs(a - known) > 1)) angles.push(a, (a + 90) % 180)
  }
  return angles
}

/** Free spot for width x depth in the room, keeping `clearance_m` from the obstacles. */
export function footprintFits(room: XY[], name: string, anchor: XY, obstacles: Footprint[], width_m: number, depth_m: number, clearance_m = 0): Fit {
  const area = width_m * depth_m, roomArea = Math.abs(polygonArea(room))
  const fail = (reason: string): Fit => ({ ok: false, reason, position: null, rotation_deg: 0 })
  if (area > roomArea) return fail(`${width_m.toFixed(2)} x ${depth_m.toFixed(2)} m (${area.toFixed(1)} m²) is larger than the room (${roomArea.toFixed(1)} m²).`)
  const blocked = obstacles.map((o) => corners({ ...o, width_m: o.width_m + 2 * clearance_m, depth_m: o.depth_m + 2 * clearance_m }))
  const xs = room.map((p) => p[0]), ys = room.map((p) => p[1])
  const step = Math.max(0.15, Math.sqrt(roomArea) / 50)
  const candidates: XY[] = []
  for (let x = Math.min(...xs); x <= Math.max(...xs) + 1e-9; x += step) {
    for (let y = Math.min(...ys); y <= Math.max(...ys) + 1e-9; y += step) candidates.push([x, y])
  }
  candidates.sort((a, b) => Math.hypot(a[0] - anchor[0], a[1] - anchor[1]) - Math.hypot(b[0] - anchor[0], b[1] - anchor[1]))
  for (const angle of wallAngles(room)) {
    for (const position of candidates) {
      const quad = corners({ position, width_m, depth_m, rotation_deg: angle })
      if (inside(quad, room) && !blocked.some((o) => overlaps(quad, o))) {
        return { ok: true, reason: `Fits in ${name} at (${position[0].toFixed(1)}, ${position[1].toFixed(1)}), rotated ${angle.toFixed(0)}°.`,
          position: [round3(position[0]), round3(position[1])], rotation_deg: Math.round(angle * 10) / 10 }
      }
    }
  }
  return fail(`No free spot of ${width_m.toFixed(2)} x ${depth_m.toFixed(2)} m in ${name} between the walls and the existing equipment.`)
}

export const round3 = (n: number) => Math.round(n * 1000) / 1000
