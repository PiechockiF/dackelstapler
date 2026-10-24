// Pedestrian dead reckoning along a planned route. Pure (no React/three): steps + a gyro yaw in, a
// route-snapped position out. Plan coordinates: metres, x right, y up, bearings CCW from +x.
import type { Building, Route, XY } from '../lib/types'
import { pointInPolygon, projectOnSegment } from '../twin/geom'

export interface NavLeg {
  floorId: string
  pts: XY[]
  /** Running distance at each point (cum[0] = 0). */
  cum: number[]
  length: number
  /** Global distance where this leg starts. */
  start: number
  /** The stairs/lift that leads to the next leg. */
  connector?: { id: string; kind: 'stairs' | 'lift'; toFloorId: string }
}

export interface NavPath { legs: NavLeg[]; total: number }

export type ManeuverKind = 'start' | 'left' | 'right' | 'slight-left' | 'slight-right' | 'uturn' | 'stairs' | 'lift' | 'arrive'
export interface Maneuver { s: number; leg: number; kind: ManeuverKind; text: string; landmark?: string }

export type NavStatus = 'active' | 'floorChange' | 'offRoute' | 'arrived'

export const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a))
const bearing = (a: XY, b: XY) => Math.atan2(b[1] - a[1], b[0] - a[0])
const dist = (a: XY, b: XY) => Math.hypot(b[0] - a[0], b[1] - a[1])
const DEG = Math.PI / 180

/** Drop room/corridor anchors the walker would cut straight past (door → corridor centre → door zigzags). */
function simplify(pts: XY[], building: Building | undefined, floorId: string): XY[] {
  if (!building || pts.length < 3) return pts
  const spaces = building.spaces.filter((s) => s.floor_id === floorId)
  const insideOne = (a: XY, c: XY) =>
    spaces.some((s) => {
      for (let i = 1; i < 10; i++) {
        const t = i / 10
        if (!pointInPolygon([a[0] + (c[0] - a[0]) * t, a[1] + (c[1] - a[1]) * t], s.polygon)) return false
      }
      return true
    })
  const out: XY[] = [pts[0]]
  for (let i = 1; i < pts.length - 1; i++) {
    if (!insideOne(out[out.length - 1], pts[i + 1])) out.push(pts[i])
  }
  out.push(pts[pts.length - 1])
  return out
}

export function buildNavPath(route: Route, building?: Building): NavPath {
  const legs: NavLeg[] = []
  let total = 0
  route.floors.forEach((f, i) => {
    const raw = f.points.filter((p, j) => j === 0 || dist(p, f.points[j - 1]) > 0.05)
    const pts = simplify(raw.length ? raw : f.points, building, f.floor_id)
    const cum = [0]
    for (let j = 1; j < pts.length; j++) cum.push(cum[j - 1] + dist(pts[j - 1], pts[j]))
    const next = route.floors[i + 1]
    const conn = next && route.connectors.find((c) => c.from_floor_id === f.floor_id && c.to_floor_id === next.floor_id)
    legs.push({
      floorId: f.floor_id, pts, cum, length: cum[cum.length - 1], start: total,
      connector: next ? { id: conn?.id ?? '', kind: conn?.kind ?? 'stairs', toFloorId: next.floor_id } : undefined,
    })
    total += cum[cum.length - 1]
  })
  return { legs, total }
}

const walkCache = new WeakMap<Route, { building?: Building; route: Route; total: number }>()

/** The route as walked (straight between doors) and its real length, for drawing and display. */
export function walkingRoute(route: Route, building?: Building): { route: Route; total: number } {
  const hit = walkCache.get(route)
  if (hit && hit.building === building) return hit
  const path = buildNavPath(route, building)
  const out = { building, route: routeFromPath(route, path), total: path.total }
  walkCache.set(route, out)
  return out
}

/** Same route with the simplified polylines, so the drawn line matches what the tracker snaps to. */
export function routeFromPath(route: Route, path: NavPath): Route {
  return { ...route, floors: route.floors.map((f, i) => ({ ...f, points: path.legs[i]?.pts ?? f.points })) }
}

export function pointAt(leg: NavLeg, s: number): XY {
  if (leg.pts.length === 1) return leg.pts[0]
  s = Math.max(0, Math.min(leg.length, s))
  let i = 1
  while (i < leg.cum.length - 1 && leg.cum[i] < s) i++
  const a = leg.pts[i - 1], b = leg.pts[i]
  const len = leg.cum[i] - leg.cum[i - 1]
  const t = len > 0 ? (s - leg.cum[i - 1]) / len : 0
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
}

/** Index of the segment (pts[i] → pts[i+1]) containing s. */
function segmentAt(leg: NavLeg, s: number): number {
  let i = 0
  while (i < leg.cum.length - 2 && leg.cum[i + 1] <= s) i++
  return i
}

/** Direction of travel at s (looks a little ahead so a vertex counts as the next segment). */
export function bearingAt(leg: NavLeg, s: number): number {
  if (leg.pts.length < 2) return 0
  const i = segmentAt(leg, Math.min(leg.length, s + 0.01))
  return bearing(leg.pts[i], leg.pts[i + 1])
}

/** Turn-by-turn instructions from the polyline corners, plus floor changes and the arrival. */
export function maneuvers(path: NavPath, route: Route, building?: Building): Maneuver[] {
  const out: Maneuver[] = []
  const spaceName = (id: string) => building?.spaces.find((s) => s.id === id)?.name
  const floorName = (id: string) => {
    const f = building?.floors.find((x) => x.id === id)
    return f ? f.name || `level ${f.level}` : id
  }
  /** "the door to Office 1.04" when the corner is a door, otherwise nothing. */
  const doorLandmark = (leg: NavLeg, i: number) => {
    const p = leg.pts[i]
    if (!building || !p) return undefined
    const door = building.openings.find((o) => o.floor_id === leg.floorId && dist(o.position, p) < 0.5)
    if (!door) return undefined
    const ahead = leg.pts[i + 1]
    const probe: XY = ahead ? [p[0] + (ahead[0] - p[0]) * Math.min(1, 1.5 / dist(p, ahead)), p[1] + (ahead[1] - p[1]) * Math.min(1, 1.5 / dist(p, ahead))] : p
    const into = door.space_ids.find((id) => {
      const s = building.spaces.find((x) => x.id === id)
      return s && pointInPolygon(probe, s.polygon)
    })
    const name = into && spaceName(into)
    return name ? `into ${name}` : undefined
  }
  path.legs.forEach((leg, li) => {
    if (li === 0) out.push({ s: 0, leg: 0, kind: 'start', text: 'Head along the line', landmark: doorLandmark(leg, 1) })
    for (let i = 1; i < leg.pts.length - 1; i++) {
      const turn = wrap(bearing(leg.pts[i], leg.pts[i + 1]) - bearing(leg.pts[i - 1], leg.pts[i]))
      const a = Math.abs(turn)
      if (a < 35 * DEG) continue
      // y is up, so a positive (CCW) turn is a left turn.
      const kind: ManeuverKind = a > 150 * DEG ? 'uturn' : a < 60 * DEG ? (turn > 0 ? 'slight-left' : 'slight-right') : turn > 0 ? 'left' : 'right'
      const text = { uturn: 'Turn around', 'slight-left': 'Bear left', 'slight-right': 'Bear right', left: 'Turn left', right: 'Turn right' }[kind as 'left']
      out.push({ s: leg.start + leg.cum[i], leg: li, kind, text, landmark: doorLandmark(leg, i) })
    }
    if (leg.connector) {
      const name = building?.vertical_connectors.find((c) => c.id === leg.connector!.id)?.name
      out.push({
        s: leg.start + leg.length, leg: li, kind: leg.connector.kind,
        text: `Take ${name ?? `the ${leg.connector.kind}`} to ${floorName(leg.connector.toFloorId)}`,
      })
    } else {
      const to = route.to_space_id && spaceName(route.to_space_id)
      out.push({ s: leg.start + leg.length, leg: li, kind: 'arrive', text: to ? `Arrive at ${to}` : 'Arrive' })
    }
  })
  return out
}

export interface StepInput { yaw: number; amplitude?: number }

/** Window (metres behind / ahead of the current position) the snap may search. */
const BACK = 4
const AHEAD = 12
const OFF_ROUTE_M = 4
const OFF_ROUTE_STEPS = 4

export class PdrTracker {
  path: NavPath
  leg = 0
  /** Distance along the current leg. */
  s = 0
  /** Unsnapped dead-reckoned position. */
  free: XY
  yawOffset = 0
  stepLengthM: number
  status: NavStatus = 'active'
  steps = 0
  walkedSinceAnchor = 0
  /** Metres the snapped position is from the dead-reckoned one. */
  offset = 0
  /** False once the position was corrected by hand (calibrating step length would be wrong). */
  clean = true
  private offCount = 0
  private alignedSeg = -1
  private alignedCount = 0
  private history: number[] = []
  private usedCorners = new Set<string>()
  private turnCooldown = 0
  lastHeading = 0

  constructor(path: NavPath, opts: { stepLengthM: number; yawOffset?: number }) {
    this.path = path
    this.stepLengthM = opts.stepLengthM
    this.yawOffset = opts.yawOffset ?? 0
    this.free = path.legs[0]?.pts[0] ?? [0, 0]
    this.lastHeading = this.current ? bearingAt(this.current, 0) : 0
  }

  get current(): NavLeg | undefined { return this.path.legs[this.leg] }
  get pos(): XY { return this.current ? pointAt(this.current, this.s) : this.free }
  get floorId(): string { return this.current?.floorId ?? '' }
  get globalS(): number { return (this.current?.start ?? 0) + this.s }
  get remaining(): number { return Math.max(0, this.path.total - this.globalS) }
  get routeBearing(): number { return this.current ? bearingAt(this.current, this.s) : 0 }
  get uncertaintyM(): number { return Math.min(8, 1 + 0.05 * this.walkedSinceAnchor) }

  /** The user faces along the route with this raw yaw: from now on yaw + offset is the plan bearing. */
  align(yaw: number) {
    this.yawOffset = wrap(this.routeBearing - yaw)
    this.lastHeading = this.routeBearing
    this.history = []
  }

  headingOf(yaw: number) { return wrap(yaw + this.yawOffset) }

  stepLength(amplitude?: number) {
    if (amplitude == null || !(amplitude > 0)) return this.stepLengthM
    // Weinberg-style: stronger bounce, longer stride. 0.4 g peak-to-valley ≈ the calibrated length.
    return this.stepLengthM * Math.min(1.2, Math.max(0.8, Math.pow(amplitude / 0.4, 0.25)))
  }

  step({ yaw, amplitude }: StepInput): NavStatus {
    const leg = this.current
    this.steps++
    if (!leg || this.status === 'arrived' || this.status === 'floorChange') return this.status
    const theta = this.headingOf(yaw)
    this.lastHeading = theta
    const L = this.stepLength(amplitude)
    this.walkedSinceAnchor += L
    this.free = [this.free[0] + L * Math.cos(theta), this.free[1] + L * Math.sin(theta)]

    this.history.push(theta)
    if (this.history.length > 6) this.history.shift()
    if (this.turnCooldown > 0) this.turnCooldown--
    else this.snapToCorner(leg, theta)

    // Snap: closest point of the route within the search window.
    const lo = Math.max(0, this.s - BACK), hi = Math.min(leg.length, this.s + AHEAD)
    let best = { s: this.s, d: Infinity, seg: 0 }
    for (let i = 0; i < leg.pts.length - 1; i++) {
      if (leg.cum[i + 1] < lo || leg.cum[i] > hi) continue
      const pr = projectOnSegment(this.free, leg.pts[i], leg.pts[i + 1])
      const s = Math.max(lo, Math.min(hi, leg.cum[i] + pr.t))
      const q = pointAt(leg, s)
      // Slight preference for moving forward over doubling back.
      const d = dist(q, this.free) + 0.1 * Math.max(0, this.s - s)
      if (d < best.d) best = { s, d, seg: i }
    }
    if (leg.pts.length < 2) best = { s: 0, d: dist(leg.pts[0], this.free), seg: 0 }
    this.s = best.s
    const snapped = this.pos
    this.offset = dist(snapped, this.free)

    // Long straight stretch walked in roughly its direction: trust the map over the gyro.
    const segLen = leg.pts.length > 1 ? leg.cum[best.seg + 1] - leg.cum[best.seg] : 0
    const segBearing = leg.pts.length > 1 ? bearing(leg.pts[best.seg], leg.pts[best.seg + 1]) : theta
    const diff = wrap(segBearing - theta)
    if (segLen >= 5 && Math.abs(diff) < 25 * DEG && this.offset < OFF_ROUTE_M) {
      this.alignedCount = this.alignedSeg === best.seg ? this.alignedCount + 1 : 1
      this.alignedSeg = best.seg
      if (this.alignedCount >= 5) this.yawOffset = wrap(this.yawOffset + 0.15 * diff)
      if (this.alignedCount >= 2) {
        this.free = [this.free[0] + 0.3 * (snapped[0] - this.free[0]), this.free[1] + 0.3 * (snapped[1] - this.free[1])]
        this.offset = dist(snapped, this.free)
      }
    } else {
      this.alignedSeg = -1
      this.alignedCount = 0
    }

    this.offCount = this.offset > OFF_ROUTE_M ? this.offCount + 1 : 0
    if (this.offCount >= OFF_ROUTE_STEPS) this.status = 'offRoute'
    else if (this.status === 'offRoute' && this.offset < OFF_ROUTE_M / 2) this.status = 'active'
    return this.progress()
  }

  /** Reached the stairs/lift or the destination? */
  private progress(): NavStatus {
    const leg = this.current
    if (leg && this.status === 'active') {
      if (leg.connector && this.s >= leg.length - 3) this.status = 'floorChange'
      else if (!leg.connector && this.s >= leg.length - 2) {
        this.s = leg.length
        this.status = 'arrived'
      }
    }
    return this.status
  }

  /**
   * A sharp change of heading over the last few steps means the walker just took a corner. If the route
   * has a matching corner nearby, jump there: this cancels the step-length error accumulated so far.
   */
  private snapToCorner(leg: NavLeg, theta: number) {
    if (this.history.length < 4) return
    const before = this.history[0]
    const turn = wrap(theta - before)
    if (Math.abs(turn) < 50 * DEG) return
    let best: { i: number; d: number } | null = null
    for (let i = 1; i < leg.pts.length - 1; i++) {
      const key = `${this.leg}:${i}`
      if (this.usedCorners.has(key)) continue
      const d = Math.abs(leg.cum[i] - this.s)
      if (d > 8) continue
      const cornerTurn = wrap(bearing(leg.pts[i], leg.pts[i + 1]) - bearing(leg.pts[i - 1], leg.pts[i]))
      if (Math.sign(cornerTurn) !== Math.sign(turn) || Math.abs(wrap(cornerTurn - turn)) > 45 * DEG) continue
      if (!best || d < best.d) best = { i, d }
    }
    if (!best) return
    this.usedCorners.add(`${this.leg}:${best.i}`)
    // About two of the last steps were taken after the corner.
    const s = Math.min(leg.length, leg.cum[best.i] + this.stepLengthM * 1.5)
    this.s = s
    this.free = pointAt(leg, s)
    this.walkedSinceAnchor = Math.min(this.walkedSinceAnchor, 10)
    this.turnCooldown = 4
    this.history = []
  }

  /** The walker confirmed they reached the next floor. */
  confirmFloor() {
    if (!this.current?.connector) return
    this.leg++
    this.s = 0
    this.free = this.current!.pts[0]
    this.status = 'active'
    this.history = []
    this.alignedSeg = -1
    this.offCount = 0
  }

  /** Put the walker at a known point of the route (global distance), e.g. "I'm at this door". */
  anchorAt(globalS: number) {
    // The end of a leg is the start of the next one (just off the stairs).
    let li = this.path.legs.findIndex((l) => globalS < l.start + l.length - 1e-6)
    if (li < 0) li = this.path.legs.length - 1
    this.leg = li
    this.s = Math.max(0, Math.min(this.current!.length, globalS - this.current!.start))
    this.free = this.pos
    this.walkedSinceAnchor = 0
    this.offCount = 0
    this.offset = 0
    this.history = []
    this.clean = false
    this.status = 'active'
    this.progress()
  }

  /** Continue on a new route (after a reroute) from the current dead-reckoned position. */
  rebase(path: NavPath): PdrTracker {
    const next = new PdrTracker(path, { stepLengthM: this.stepLengthM, yawOffset: this.yawOffset })
    const leg = path.legs[0]
    if (leg && leg.pts.length > 1) {
      let best = { s: 0, d: Infinity }
      for (let i = 0; i < leg.pts.length - 1; i++) {
        if (leg.cum[i] > 15) break
        const pr = projectOnSegment(this.free, leg.pts[i], leg.pts[i + 1])
        if (pr.dist < best.d) best = { s: leg.cum[i] + pr.t, d: pr.dist }
      }
      next.s = best.s
    }
    next.free = next.pos
    next.steps = this.steps
    next.walkedSinceAnchor = this.walkedSinceAnchor
    next.clean = false
    next.lastHeading = this.lastHeading
    next.progress() // e.g. rerouted from inside the destination
    return next
  }
}

/** The space on `floorId` containing p (rooms before corridors), or the one whose anchor is closest. */
export function spaceAt(building: Building, floorId: string, p: XY, anchors?: Map<string, XY>): string | null {
  const spaces = building.spaces.filter((s) => s.floor_id === floorId)
  const hit = spaces.filter((s) => pointInPolygon(p, s.polygon))
  if (hit.length) return (hit.find((s) => s.type !== 'corridor') ?? hit[0]).id
  let best: { id: string; d: number } | null = null
  for (const s of spaces) {
    const a = anchors?.get(s.id) ?? s.polygon[0]
    if (!a) continue
    const d = dist(a, p)
    if (!best || d < best.d) best = { id: s.id, d }
  }
  return best?.id ?? null
}

/** Running average of the stride from a finished, uncorrected walk. */
export function calibratedStep(old: number, routeLength: number, steps: number): number {
  if (steps < 20) return old
  return Math.min(0.9, Math.max(0.5, 0.7 * old + 0.3 * (routeLength / steps)))
}
