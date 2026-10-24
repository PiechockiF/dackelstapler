import { describe, expect, it } from 'vitest'
import type { Route, XY } from '../src/lib/types'
import { bearingAt, buildNavPath, calibratedStep, maneuvers, pointAt, PdrTracker, wrap, type NavPath } from '../src/nav/pdr'

const DEG = Math.PI / 180

function route(floors: { id: string; points: XY[] }[], connectors: Route['connectors'] = []): Route {
  return {
    reachable: true, length_m: 0, step_free: false, min_width_m: null, space_path: [], steps: [],
    floors: floors.map((f, i) => ({ floor_id: f.id, level: i, elevation_m: i * 4, points: f.points })), connectors,
  }
}

/** East 30 m, then north 20 m (a left turn). */
const L_SHAPE = route([{ id: 'F0', points: [[0, 0], [30, 0], [30, 20]] }])

/** A simulated walker: true stride, a gyro with an arbitrary zero and drift, and per-step sway. */
function walk(path: NavPath, t: PdrTracker, opts: { stride: number; driftDegPerMin: number; zero?: number; legs?: number[] }) {
  const zero = opts.zero ?? 2.3
  let time = 0
  const legs = opts.legs ?? path.legs.map((_, i) => i)
  let sway = 1
  for (const li of legs) {
    const leg = path.legs[li]
    for (let s = 0; s < leg.length; s += opts.stride) {
      time += 0.55
      sway = -sway
      const heading = bearingAt(leg, s) + sway * 3 * DEG
      t.step({ yaw: wrap(heading - zero + (opts.driftDegPerMin * DEG * time) / 60) })
      if (t.status === 'floorChange' || t.status === 'arrived') break
    }
    if (t.status === 'floorChange') t.confirmFloor()
  }
  return t
}

describe('route geometry', () => {
  it('builds legs with running distances', () => {
    const p = buildNavPath(L_SHAPE)
    expect(p.total).toBeCloseTo(50)
    expect(pointAt(p.legs[0], 40)).toEqual([30, 10])
    expect(bearingAt(p.legs[0], 30)).toBeCloseTo(Math.PI / 2) // a vertex already counts as the next segment
  })

  it('derives turns, floor changes and the arrival in order', () => {
    const r = route(
      [{ id: 'F0', points: [[0, 0], [10, 0], [10, -10]] }, { id: 'F1', points: [[10, -10], [10, 0], [20, 0]] }],
      [{ id: 'st', kind: 'stairs', from_floor_id: 'F0', to_floor_id: 'F1', position: [10, -10] }],
    )
    const m = maneuvers(buildNavPath(r), r)
    expect(m.map((x) => x.kind)).toEqual(['start', 'right', 'stairs', 'right', 'arrive'])
    expect(m.map((x) => x.s)).toEqual([0, 10, 20, 30, 40])
  })

  it('cuts straight across a corridor instead of visiting its centre', () => {
    const building = {
      spaces: [{ id: 'c', floor_id: 'F0', type: 'corridor', name: 'Corridor', polygon: [[0, -2], [30, -2], [30, 2], [0, 2]] as XY[] }],
      openings: [], floors: [], vertical_connectors: [], assets: [],
    } as unknown as Parameters<typeof buildNavPath>[1]
    const p = buildNavPath(route([{ id: 'F0', points: [[2, 0], [15, 1.5], [28, 0]] }]), building)
    expect(p.legs[0].pts).toEqual([[2, 0], [28, 0]])
  })
})

describe('PdrTracker', () => {
  it('follows an L-shaped route despite a 6% long stride and 3°/min gyro drift', () => {
    const path = buildNavPath(L_SHAPE)
    const t = new PdrTracker(path, { stepLengthM: 0.7 })
    t.align(wrap(0 - 2.3)) // facing east with the fake gyro's zero
    walk(path, t, { stride: 0.74, driftDegPerMin: 3 })
    expect(t.status).toBe('arrived')
    expect(Math.hypot(t.pos[0] - 30, t.pos[1] - 20)).toBeLessThan(2)
  })

  it('cancels a short stride at the corner', () => {
    const path = buildNavPath(L_SHAPE)
    const t = new PdrTracker(path, { stepLengthM: 0.7 })
    t.align(wrap(0 - 2.3))
    // Walk the first 30 m with a stride 15% longer than assumed: the tracker lags ~4 m behind.
    let truth = 0
    for (; truth < 30; truth += 0.8) t.step({ yaw: wrap(0 - 2.3) })
    expect(t.globalS).toBeLessThan(28)
    for (let i = 0; i < 4; i++, truth += 0.8) t.step({ yaw: wrap(Math.PI / 2 - 2.3) })
    expect(Math.abs(t.globalS - truth)).toBeLessThan(1)
  })

  it('learns the gyro offset back on long straights', () => {
    const path = buildNavPath(route([{ id: 'F0', points: [[0, 0], [60, 0]] }]))
    const t = new PdrTracker(path, { stepLengthM: 0.7 })
    t.align(0)
    for (let i = 0; i < 30; i++) t.step({ yaw: 10 * DEG }) // the gyro drifted 10° since aligning
    expect(Math.abs(t.headingOf(10 * DEG))).toBeLessThan(3 * DEG)
  })

  it('flags walking away from the route', () => {
    const path = buildNavPath(L_SHAPE)
    const t = new PdrTracker(path, { stepLengthM: 0.7 })
    t.align(0)
    for (let i = 0; i < 6; i++) t.step({ yaw: 0 })
    for (let i = 0; i < 14 && t.status !== 'offRoute'; i++) t.step({ yaw: -Math.PI / 2 }) // south, no corridor there
    expect(t.status).toBe('offRoute')
    t.anchorAt(5)
    expect(t.status).toBe('active')
    expect(t.pos).toEqual([5, 0])
  })

  it('stops at the stairs until the floor change is confirmed', () => {
    const r = route(
      [{ id: 'F0', points: [[0, 0], [12, 0]] }, { id: 'F1', points: [[12, 0], [12, 12]] }],
      [{ id: 'st', kind: 'stairs', from_floor_id: 'F0', to_floor_id: 'F1', position: [12, 0] }],
    )
    const path = buildNavPath(r)
    const t = new PdrTracker(path, { stepLengthM: 0.7 })
    t.align(0)
    for (let i = 0; i < 30 && t.status === 'active'; i++) t.step({ yaw: 0 })
    expect(t.status).toBe('floorChange')
    expect(t.floorId).toBe('F0')
    const s = t.globalS
    t.step({ yaw: 0 }) // climbing: ignored
    expect(t.globalS).toBe(s)
    t.confirmFloor()
    expect(t.floorId).toBe('F1')
    expect(t.status).toBe('active')
    for (let i = 0; i < 30 && t.status === 'active'; i++) t.step({ yaw: Math.PI / 2 })
    expect(t.status).toBe('arrived')
  })

  it('rebases onto a new route from where the walker is', () => {
    const t = new PdrTracker(buildNavPath(L_SHAPE), { stepLengthM: 0.7 })
    t.align(0)
    for (let i = 0; i < 10; i++) t.step({ yaw: 0 })
    const next = t.rebase(buildNavPath(route([{ id: 'F0', points: [[0, 0], [20, 0]] }])))
    expect(next.globalS).toBeCloseTo(7, 0)
    expect(next.yawOffset).toBe(t.yawOffset)
  })

  it('anchors "just off the stairs" on the next floor', () => {
    const r = route(
      [{ id: 'F0', points: [[0, 0], [12, 0]] }, { id: 'F1', points: [[12, 0], [12, 12]] }],
      [{ id: 'st', kind: 'stairs', from_floor_id: 'F0', to_floor_id: 'F1', position: [12, 0] }],
    )
    const t = new PdrTracker(buildNavPath(r), { stepLengthM: 0.7 })
    t.anchorAt(12)
    expect(t.floorId).toBe('F1')
    expect(t.status).toBe('active')
  })

  it('arrives at once when rerouted from inside the destination', () => {
    const t = new PdrTracker(buildNavPath(L_SHAPE), { stepLengthM: 0.7 })
    const one = route([{ id: 'F0', points: [[0, 0]] }])
    const building = { spaces: [], openings: [{ id: 'd', floor_id: 'F0', space_ids: [], kind: 'door', position: [0, 0], width_m: 1, step_free: true }], floors: [], vertical_connectors: [], assets: [] } as unknown as Parameters<typeof buildNavPath>[1]
    const path = buildNavPath(one, building)
    expect(maneuvers(path, one, building).map((m) => m.kind)).toEqual(['start', 'arrive'])
    expect(t.rebase(path).status).toBe('arrived')
  })

  it('calibrates the stride from a clean walk', () => {
    expect(calibratedStep(0.7, 50, 10)).toBe(0.7) // too short to trust
    expect(calibratedStep(0.7, 80, 100)).toBeCloseTo(0.73)
    expect(calibratedStep(0.7, 200, 100)).toBe(0.9)
  })
})

describe('on a bundled building', () => {
  it('walks a two-floor factory route to the destination', async () => {
    const { readFileSync } = await import('node:fs')
    const { LocalRouter } = await import('../src/local/router')
    const data = JSON.parse(readFileSync(new URL('../public/offline/proc-factory-dev-003.json', import.meta.url), 'utf8'))
    const r = new LocalRouter(data).route({ from: 'proc-factory-dev-003-F0-S014', to: 'proc-factory-dev-003-F1-S023' }, [])
    const path = buildNavPath(r, data.building)
    expect(path.legs.length).toBe(2)
    expect(path.total).toBeLessThanOrEqual(r.length_m) // shortcuts never make it longer
    const t = new PdrTracker(path, { stepLengthM: 0.7 })
    t.align(wrap(bearingAt(path.legs[0], 0) - 2.3))
    walk(path, t, { stride: 0.74, driftDegPerMin: 3 })
    expect(t.status).toBe('arrived')
    expect(t.floorId).toBe(path.legs[1].floorId)
    const kinds = maneuvers(path, r, data.building).map((m) => m.kind)
    expect(kinds[0]).toBe('start')
    expect(kinds).toContain('stairs')
    expect(kinds.at(-1)).toBe('arrive')
  })
})
