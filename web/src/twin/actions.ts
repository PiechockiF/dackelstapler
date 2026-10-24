// Imperative helpers shared by the HUD panels and in-scene popovers.
import { api } from '../lib/api'
import { useTwin } from '../lib/store'
import type { Building } from '../lib/types'
import { indexBuilding } from './geom'
import { useTwinUi } from './uiStore'

/** Match the server's default: upstairs office for the demo, otherwise a lobby/entrance. */
export function defaultOrigin(b: Building): string | null {
  const idx = indexBuilding(b)
  if (b.building.id === 'proc-factory-dev-003') {
    const office = b.spaces.find((s) => s.name === 'Office 1.04')
    if (office) return office.id
  }
  const lobby = b.spaces.find((s) => s.room_type === 'lobby' && idx.floors.get(s.floor_id)?.level === 0)
  if (lobby) return lobby.id
  const entrance = b.openings.find((o) => o.space_ids.includes('outside') && o.step_free !== false)
  return entrance?.space_ids.find((id) => id !== 'outside') ?? b.spaces[0]?.id ?? null
}

export function originOf(b: Building): string | null {
  return useTwinUi.getState().originId ?? defaultOrigin(b)
}

export async function navigate(
  siteId: string,
  to: string,
  opts: { from?: string; step_free?: boolean; min_width_m?: number } = {},
) {
  const b = useTwin.getState().building
  const from = opts.from || (b ? originOf(b) : null)
  if (!from) throw new Error('No start point')
  const body: { from: string; to: string; step_free?: boolean; min_width_m?: number } = { from, to }
  if (opts.step_free) body.step_free = true
  if (opts.min_width_m) body.min_width_m = opts.min_width_m
  const route = await api.route(siteId, body)
  if (useTwin.getState().siteId === siteId) {
    useTwin.getState().setRoute(route)
    useTwin.getState().setFocusFloor(null)
  }
  return route
}

export async function toggleClosed(siteId: string, id: string, closed: boolean) {
  const state = await api.setClosed(siteId, id, closed)
  if (useTwin.getState().siteId === siteId) useTwin.getState().setState(state)
  await refreshRoute(siteId)
  return state
}

/** Keep the requested endpoints and waypoints even while a closure makes the route unreachable. */
let refreshVersion = 0
export async function refreshRoute(siteId: string) {
  const version = ++refreshVersion
  const store = useTwin.getState()
  const route = store.route
  if (store.siteId !== siteId || !route || route.space_path.length < 2) return
  const next = await api.route(siteId, {
    from: route.from_space_id ?? route.space_path[0],
    to: route.to_space_id ?? route.space_path[route.space_path.length - 1],
    step_free: route.step_free, min_width_m: route.min_width_m ?? undefined, via: route.via,
  })
  // A slow request must not replace a newer route or another site's view.
  if (version === refreshVersion && useTwin.getState().siteId === siteId && useTwin.getState().route === route) {
    useTwin.getState().setRoute(next)
  }
}
