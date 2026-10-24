// Turn-by-turn walking navigation: wires the motion sensors to the PDR tracker and exposes the
// walker's position to the HUD, the 3D marker and the camera.
import type { PluginListenerHandle } from '@capacitor/core'
import { create } from 'zustand'
import { isNative } from '../lib/mode'
import { useTwin } from '../lib/store'
import type { Route, XY } from '../lib/types'
import { navigate } from '../twin/actions'
import { indexBuilding } from '../twin/geom'
import { useTwinUi } from '../twin/uiStore'
import { NavMotion, sim } from './motion'
import { buildNavPath, calibratedStep, maneuvers, PdrTracker, routeFromPath, spaceAt, type Maneuver, type NavPath, type NavStatus } from './pdr'

const STEP_KEY = 'sitetwin.nav.stepLength'
const WALK_SPEED = 1.2 // m/s, for the time estimate

function savedStep(): number {
  const v = Number(globalThis.localStorage?.getItem(STEP_KEY))
  return v >= 0.5 && v <= 0.9 ? v : 0.7
}

interface Nav {
  status: 'idle' | 'aligning' | NavStatus
  siteId: string | null
  /** The route being walked, with the simplified polylines the tracker snaps to. */
  route: Route | null
  path: NavPath | null
  maneuvers: Maneuver[]
  floorId: string | null
  xy: XY | null
  /** Live walking direction (plan bearing), updated ~10×/s. */
  heading: number
  /** Direction of the route where the walker is (the camera's "up"). */
  routeBearing: number
  uncertaintyM: number
  steps: number
  globalS: number
  remainingM: number
  /** Camera follows the walker until the user drags it. */
  follow: boolean
  stepLengthM: number
  error: string | null
  begin: (siteId: string, route: Route) => Promise<void>
  startWalking: () => void
  confirmFloor: () => void
  anchorAt: (globalS: number) => void
  reroute: () => Promise<void>
  end: () => void
  setFollow: (follow: boolean) => void
  setStepLength: (m: number) => void
}

let tracker: PdrTracker | null = null
let lastYaw: number | null = null
let handles: PluginListenerHandle[] = []

export const useNav = create<Nav>((set, get) => {
  const publish = () => {
    const t = tracker
    if (!t) return
    const prevFloor = get().floorId
    const status = get().status === 'aligning' ? 'aligning' : t.status
    set({
      status, floorId: t.floorId, xy: t.pos, routeBearing: t.routeBearing, uncertaintyM: t.uncertaintyM,
      steps: t.steps, globalS: t.globalS, remainingM: t.remaining,
      heading: status === 'aligning' ? t.routeBearing : t.lastHeading,
    })
    if (t.floorId !== prevFloor) useTwin.getState().setFocusFloor(t.floorId)
  }

  const onStep = (yaw: number, amplitude?: number) => {
    const t = tracker
    if (!t || get().status === 'aligning' || get().status === 'idle') return
    const before = t.status
    if (before !== 'arrived') t.step({ yaw, amplitude })
    if (t.status === 'arrived' && before !== 'arrived' && t.clean) {
      const stepLengthM = calibratedStep(t.stepLengthM, t.path.total, t.steps)
      globalThis.localStorage?.setItem(STEP_KEY, String(stepLengthM))
      set({ stepLengthM })
    }
    publish()
  }

  const stopSensors = () => {
    handles.forEach((h) => void h.remove())
    handles = []
    void NavMotion.stop().catch(() => undefined)
    sim.setWalking(false)
  }

  return {
    status: 'idle', siteId: null, route: null, path: null, maneuvers: [], floorId: null, xy: null,
    heading: 0, routeBearing: 0, uncertaintyM: 1, steps: 0, globalS: 0, remainingM: 0,
    follow: true, stepLengthM: savedStep(), error: null,

    begin: async (siteId, route) => {
      stopSensors()
      if (!route.reachable || !route.floors.length) return set({ error: 'No walkable route to follow.' })
      const building = useTwin.getState().building ?? undefined
      const path = buildNavPath(route, building)
      tracker = new PdrTracker(path, { stepLengthM: get().stepLengthM })
      lastYaw = null
      useTwinUi.getState().setPopover(null)
      set({
        status: 'aligning', siteId, route: routeFromPath(route, path), path, maneuvers: maneuvers(path, route, building),
        follow: true, error: null,
      })
      publish()
      if (!isNative) sim.setPath(path)
      try {
        const { available } = await NavMotion.isAvailable()
        if (!available) throw new Error('This device has no motion sensors.')
        handles = await Promise.all([
          NavMotion.addListener('heading', (e) => {
            lastYaw = e.yaw
            const t = tracker
            if (t && get().status !== 'aligning' && get().status !== 'idle') {
              const heading = t.headingOf(e.yaw)
              if (Math.abs(heading - get().heading) > 0.02) set({ heading })
            }
          }),
          NavMotion.addListener('step', (e) => onStep(e.yaw, e.amplitude)),
        ])
        await NavMotion.start()
      } catch (e) {
        stopSensors()
        set({ status: 'idle', error: String((e as Error).message ?? e) })
      }
    },

    startWalking: () => {
      if (!tracker || get().status !== 'aligning') return
      tracker.align(lastYaw ?? 0)
      set({ status: 'active', follow: true })
      sim.setWalking(true)
      publish()
    },

    confirmFloor: () => {
      tracker?.confirmFloor()
      if (!isNative) sim.nextLeg()
      publish()
    },

    anchorAt: (globalS) => {
      tracker?.anchorAt(globalS)
      publish()
    },

    reroute: async () => {
      const t = tracker, { siteId, route } = get()
      const building = useTwin.getState().building
      if (!t || !siteId || !route?.to_space_id || !building) return
      const from = spaceAt(building, t.floorId, t.free, indexBuilding(building).anchors)
      if (!from) return
      try {
        const next = await navigate(siteId, route.to_space_id, { from, step_free: route.step_free, min_width_m: route.min_width_m ?? undefined })
        if (!next.reachable || tracker !== t) return set({ error: next.message ?? 'No route from here.' })
        const path = buildNavPath(next, building)
        tracker = t.rebase(path)
        if (!isNative) sim.rejoin(path)
        set({ route: routeFromPath(next, path), path, maneuvers: maneuvers(path, next, building), status: 'active', error: null, follow: true })
        publish()
        useTwin.getState().setFocusFloor(tracker.floorId) // navigate() cleared it
      } catch (e) {
        set({ error: String((e as Error).message ?? e) })
      }
    },

    end: () => {
      stopSensors()
      tracker = null
      set({ status: 'idle', route: null, path: null, maneuvers: [], xy: null, floorId: null, error: null })
      useTwin.getState().setFocusFloor(null)
    },

    setFollow: (follow) => set({ follow }),

    setStepLength: (m) => {
      const stepLengthM = Math.round(Math.min(0.9, Math.max(0.5, m)) * 100) / 100
      globalThis.localStorage?.setItem(STEP_KEY, String(stepLengthM))
      if (tracker) tracker.stepLengthM = stepLengthM
      set({ stepLengthM })
    },
  }
})

export const navigating = (s: Pick<Nav, 'status'>) => s.status !== 'idle'

/** The next instruction after the walker's position and the metres to it. */
export function upcoming(s: Pick<Nav, 'maneuvers' | 'globalS'>): { m: Maneuver; inM: number } | null {
  const m = s.maneuvers.find((x) => x.kind !== 'start' && x.s > s.globalS + 0.5) ?? s.maneuvers.at(-1)
  return m ? { m, inM: Math.max(0, m.s - s.globalS) } : null
}

export const etaMin = (remainingM: number) => Math.max(1, Math.round(remainingM / WALK_SPEED / 60))
