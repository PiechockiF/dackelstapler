// Animated floor stack shared by every twin component. A plain mutable object (not React state):
// the driver updates it once per frame, everything else reads it inside useFrame.
import { createContext, useContext } from 'react'
import type { Building, Floor, XY } from '../lib/types'
import { allSpacePoints, bbox, type BBox, sortedFloors } from './geom'

export interface FloorAnim {
  floor: Floor
  index: number
  /** Index relative to the ground floor (level 0 or the lowest floor >= 0). */
  rel: number
  bbox: BBox
  wallH: number
  y: number
  rise: number
  dim: number
  dimTarget: number
}

const RISE_DEPTH = 14
const RISE_DUR = 0.9
const RISE_STAGGER = 0.22

export class TwinLayout {
  floors: FloorAnim[]
  byId = new Map<string, FloorAnim>()
  cx: number
  cy: number
  extent: number
  gap: number
  explode = 0
  explodeV = 0
  explodeTarget = 1
  time = 0
  introDone = false
  /** Bumped whenever any floor moved this frame. */
  version = 0
  constructor(building: Building, skipIntro = false) {
    const all = bbox(allSpacePoints(building.spaces))
    this.cx = all.cx
    this.cy = all.cy
    this.extent = Math.max(all.w, all.h, 10)
    this.gap = Math.min(22, Math.max(5, this.extent * 0.13))
    const sorted = sortedFloors(building)
    const groundIdx = Math.max(0, sorted.findIndex((f) => f.level >= 0))
    this.floors = sorted.map((floor, index) => {
      const spaces = building.spaces.filter((s) => s.floor_id === floor.id)
      const fb = spaces.length ? bbox(allSpacePoints(spaces)) : all
      const anim: FloorAnim = {
        floor, index, rel: index - groundIdx, bbox: fb,
        wallH: Math.max(1.2, Math.min(floor.height_m || 3, 3)),
        y: floor.elevation_m - RISE_DEPTH, rise: skipIntro ? 1 : 0, dim: skipIntro ? 1 : 0, dimTarget: 1,
      }
      this.byId.set(floor.id, anim)
      return anim
    })
    if (skipIntro) {
      this.introDone = true
      this.explode = 1
    }
  }

  /** Local building metres → world x/z (the y axis is the floor stack). */
  toXZ(p: XY): [number, number] {
    return [p[0] - this.cx, -(p[1] - this.cy)]
  }

  stackY(f: FloorAnim, explode: number) {
    return f.floor.elevation_m + f.rel * this.gap * explode
  }

  /** Where the floor will settle with the current explode target (for camera framing). */
  targetY(floorId: string): number {
    const f = this.byId.get(floorId)
    return f ? this.stackY(f, this.explodeTarget) : 0
  }

  y(floorId: string): number {
    return this.byId.get(floorId)?.y ?? 0
  }

  minY() {
    return Math.min(0, ...this.floors.map((f) => this.stackY(f, this.explodeTarget))) - 0.6
  }

  update(dt: number, exploded: boolean, focusFloorId: string | null, routeFloors: Set<string> | null = null) {
    dt = Math.min(dt, 1 / 20)
    this.time += dt
    const n = this.floors.length
    // Intro: floors rise one after another, then the stack explodes.
    if (!this.introDone) {
      let all = true
      for (const f of this.floors) {
        const t = (this.time - 0.35 - f.index * RISE_STAGGER) / RISE_DUR
        f.rise = Math.max(0, Math.min(1, t))
        if (f.rise < 1) all = false
      }
      if (all && this.time > 0.35 + n * RISE_STAGGER + RISE_DUR) this.introDone = true
    }
    const target = this.introDone && exploded ? 1 : 0
    this.explodeTarget = exploded ? 1 : 0
    // Critically damped spring with a little overshoot feel.
    const w = 7
    const a = -2 * 0.8 * w * this.explodeV - w * w * (this.explode - target)
    this.explodeV += a * dt
    this.explode += this.explodeV * dt
    let moved = false
    for (const f of this.floors) {
      const e = easeOutBack(f.rise)
      const y = this.stackY(f, this.explode) - (1 - e) * RISE_DEPTH
      if (Math.abs(y - f.y) > 1e-4) moved = true
      f.y = y
      f.dimTarget = focusFloorId != null ? (focusFloorId === f.floor.id ? 1 : 0.12) : routeFloors && !routeFloors.has(f.floor.id) ? 0.3 : 1
      const rise = Math.min(1, f.rise * 1.6)
      const d = f.dim + (f.dimTarget - f.dim) * Math.min(1, dt * 6)
      f.dim = Math.min(d, rise)
    }
    if (moved) this.version++
  }
}

function easeOutBack(t: number) {
  if (t <= 0) return 0
  if (t >= 1) return 1
  const c1 = 1.2
  const c3 = c1 + 1
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2)
}

export const LayoutContext = createContext<TwinLayout | null>(null)
export function useLayout(): TwinLayout {
  const l = useContext(LayoutContext)
  if (!l) throw new Error('useLayout outside TwinScene')
  return l
}
