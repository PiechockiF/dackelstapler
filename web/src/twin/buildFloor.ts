// Builds merged geometries for one floor: room fills, glassy walls with door gaps, glowing top
// outlines and door markers. One draw call per layer per floor, so 1600-room OSM buildings stay fast.
import * as THREE from 'three'
import type { Building, Opening, Space, XY } from '../lib/types'
import { projectOnSegment } from './geom'
import { COLORS, roomColor } from './palette'

export interface DoorMarker {
  opening: Opening
  x: number
  z: number
  angle: number
}

export interface FloorGeometry {
  fills: THREE.BufferGeometry
  /** spaces[triSpace[faceIndex]] is the space under a raycast hit on `fills`. */
  triSpace: Int32Array
  spaces: Space[]
  walls: THREE.BufferGeometry
  lines: THREE.BufferGeometry
  doors: DoorMarker[]
}

const DOOR_H = 2.1
const EDGE_MATCH_M = 0.45

type ToXZ = (p: XY) => [number, number]

export function buildFloorGeometry(b: Building, floorId: string, toXZ: ToXZ, wallH: number): FloorGeometry {
  const spaces = b.spaces.filter((s) => s.floor_id === floorId && s.polygon.length >= 3)
  const spaceIndex = new Map(spaces.map((s, i) => [s.id, i]))
  const openings = b.openings.filter((o) => o.floor_id === floorId)

  // ---- fills ----
  const fPos: number[] = []
  const fCol: number[] = []
  const triSpace: number[] = []
  spaces.forEach((s, si) => {
    const contour = s.polygon.map(([x, y]) => new THREE.Vector2(x, y))
    let tris: number[][]
    try {
      tris = THREE.ShapeUtils.triangulateShape(contour, [])
    } catch {
      return
    }
    const c = roomColor(s.room_type, s.type)
    const lift = s.type === 'corridor' || s.room_type === 'corridor' ? 0.005 : 0.02
    for (const tri of tris) {
      for (const k of tri) {
        const [x, z] = toXZ(s.polygon[k])
        fPos.push(x, lift, z)
        fCol.push(c.r, c.g, c.b)
      }
      triSpace.push(si)
    }
  })
  const fills = new THREE.BufferGeometry()
  fills.setAttribute('position', new THREE.Float32BufferAttribute(fPos, 3))
  fills.setAttribute('color', new THREE.Float32BufferAttribute(fCol, 3))
  const fNorm = new Float32Array(fPos.length)
  for (let i = 1; i < fNorm.length; i += 3) fNorm[i] = 1
  fills.setAttribute('normal', new THREE.BufferAttribute(fNorm, 3))
  fills.computeBoundingSphere()

  // ---- edges (deduplicated), with door gaps ----
  interface Edge { a: XY; b: XY; len: number; gaps: [number, number, boolean][]; low: boolean }
  const edges = new Map<string, Edge>()
  const edgesBySpace = new Map<string, string[]>()
  const key = (p: XY) => `${Math.round(p[0] * 20)},${Math.round(p[1] * 20)}`
  for (const s of spaces) {
    const low = s.type === 'outdoor' || s.room_type === 'balcony'
    const ids: string[] = []
    for (let i = 0; i < s.polygon.length; i++) {
      const a = s.polygon[i]
      const c = s.polygon[(i + 1) % s.polygon.length]
      const len = Math.hypot(c[0] - a[0], c[1] - a[1])
      if (len < 0.05) continue
      const ka = key(a)
      const kc = key(c)
      const k = ka < kc ? `${ka}|${kc}` : `${kc}|${ka}`
      const existing = edges.get(k)
      if (existing) existing.low = existing.low && low
      else edges.set(k, { a, b: c, len, gaps: [], low })
      ids.push(k)
    }
    edgesBySpace.set(s.id, ids)
  }

  const doors: DoorMarker[] = []
  for (const o of openings) {
    let best: { k: string; t: number; dist: number; e: Edge } | null = null
    for (const sid of o.space_ids) {
      for (const k of edgesBySpace.get(sid) ?? []) {
        const e = edges.get(k)!
        const pr = projectOnSegment(o.position, e.a, e.b)
        if (pr.dist < EDGE_MATCH_M && (!best || pr.dist < best.dist)) best = { k, t: pr.t, dist: pr.dist, e }
      }
    }
    // Also cut any other coincident edge (rooms that share a wall without sharing vertices).
    if (best) {
      for (const sid of o.space_ids) {
        for (const k of edgesBySpace.get(sid) ?? []) {
          const e = edges.get(k)!
          const pr = projectOnSegment(o.position, e.a, e.b)
          if (pr.dist < EDGE_MATCH_M) e.gaps.push([pr.t - o.width_m / 2, pr.t + o.width_m / 2, o.kind !== 'opening'])
        }
      }
      const [ax, az] = toXZ(best.e.a)
      const [bx, bz] = toXZ(best.e.b)
      const [x, z] = toXZ(o.position)
      doors.push({ opening: o, x, z, angle: Math.atan2(-(bz - az), bx - ax) })
    } else {
      const [x, z] = toXZ(o.position)
      doors.push({ opening: o, x, z, angle: 0 })
    }
  }

  // ---- walls (quads with a vertical alpha gradient) + top outline ----
  const wPos: number[] = []
  const wCol: number[] = []
  const wNorm: number[] = []
  const lPos: number[] = []
  const lCol: number[] = []
  const wc = COLORS.wall
  const top = COLORS.outline
  const quad = (a: XY, c: XY, y0: number, y1: number, alpha0: number, alpha1: number) => {
    const [ax, az] = toXZ(a)
    const [cx, cz] = toXZ(c)
    const nx = -(cz - az)
    const nz = cx - ax
    const nl = Math.hypot(nx, nz) || 1
    const v = [
      [ax, y0, az, alpha0], [cx, y0, cz, alpha0], [cx, y1, cz, alpha1],
      [ax, y0, az, alpha0], [cx, y1, cz, alpha1], [ax, y1, az, alpha1],
    ]
    for (const [x, y, z, al] of v) {
      wPos.push(x, y, z)
      wCol.push(wc.r, wc.g, wc.b, al)
      wNorm.push(nx / nl, 0, nz / nl)
    }
  }
  const lerp = (a: XY, c: XY, t: number): XY => [a[0] + (c[0] - a[0]) * t, a[1] + (c[1] - a[1]) * t]
  for (const e of edges.values()) {
    const h = e.low ? 1.0 : wallH
    // merge gaps
    const gaps = e.gaps
      .map(([s, t, lintel]) => [Math.max(0, s), Math.min(e.len, t), lintel] as [number, number, boolean])
      .filter(([s, t]) => t > s)
      .sort((p, q) => p[0] - q[0])
    let cursor = 0
    const solid: [number, number][] = []
    for (const [s, t] of gaps) {
      if (s > cursor) solid.push([cursor, s])
      cursor = Math.max(cursor, t)
    }
    if (cursor < e.len) solid.push([cursor, e.len])
    for (const [s, t] of solid) {
      if (t - s < 0.02) continue
      quad(lerp(e.a, e.b, s / e.len), lerp(e.a, e.b, t / e.len), 0, h, 0.42, 0.06)
    }
    if (h > DOOR_H + 0.2) {
      for (const [s, t, lintel] of gaps) if (lintel) quad(lerp(e.a, e.b, s / e.len), lerp(e.a, e.b, t / e.len), DOOR_H, h, 0.12, 0.06)
    }
    // glowing top edge (continuous), faint base edge
    const [ax, az] = toXZ(e.a)
    const [bx, bz] = toXZ(e.b)
    lPos.push(ax, h, az, bx, h, bz)
    const k = e.low ? 0.6 : 1
    lCol.push(top.r * k, top.g * k, top.b * k, top.r * k, top.g * k, top.b * k)
    lPos.push(ax, 0.03, az, bx, 0.03, bz)
    lCol.push(0.25, 0.32, 0.45, 0.25, 0.32, 0.45)
  }
  const walls = new THREE.BufferGeometry()
  walls.setAttribute('position', new THREE.Float32BufferAttribute(wPos, 3))
  walls.setAttribute('color', new THREE.Float32BufferAttribute(wCol, 4))
  walls.setAttribute('normal', new THREE.Float32BufferAttribute(wNorm, 3))
  walls.computeBoundingSphere()
  const lines = new THREE.BufferGeometry()
  lines.setAttribute('position', new THREE.Float32BufferAttribute(lPos, 3))
  lines.setAttribute('color', new THREE.Float32BufferAttribute(lCol, 3))
  lines.computeBoundingSphere()

  void spaceIndex
  return { fills, triSpace: Int32Array.from(triSpace), spaces, walls, lines, doors }
}

/** Flat fill + outline for a single polygon (used for room glows / highlights). */
export function polygonFill(poly: XY[], toXZ: ToXZ, y = 0.06): THREE.BufferGeometry {
  const contour = poly.map(([x, y2]) => new THREE.Vector2(x, y2))
  const tris = THREE.ShapeUtils.triangulateShape(contour, [])
  const pos: number[] = []
  for (const tri of tris) for (const k of tri) {
    const [x, z] = toXZ(poly[k])
    pos.push(x, y, z)
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.computeVertexNormals()
  return g
}

export function polygonOutline(poly: XY[], toXZ: ToXZ, y = 0.08): THREE.BufferGeometry {
  const pts = poly.map((p) => {
    const [x, z] = toXZ(p)
    return new THREE.Vector3(x, y, z)
  })
  pts.push(pts[0].clone())
  return new THREE.BufferGeometry().setFromPoints(pts)
}
