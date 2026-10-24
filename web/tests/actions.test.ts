import { readFileSync } from 'node:fs'
import { afterEach, expect, it, vi } from 'vitest'
import { api } from '../src/lib/api'
import type { Route } from '../src/lib/types'
import { useTwin } from '../src/lib/store'
import { navigate, refreshRoute } from '../src/twin/actions'
import type { MobileBuilding } from '../src/local/types'

const data: MobileBuilding = JSON.parse(readFileSync(new URL('../public/offline/proc-factory-dev-003.json', import.meta.url), 'utf8'))
const id = data.building.building.id, [a, b, c] = data.building.spaces
const route = (to: string): Route => ({ from_space_id: a.id, to_space_id: to, reachable: true, length_m: 10, step_free: false, min_width_m: null, space_path: [a.id, to], steps: [], floors: [], connectors: [] })
afterEach(() => vi.restoreAllMocks())
it('does not replace a newer route with a slow, older navigation request', async () => {
  useTwin.getState().setSite(id, data.building)
  let first!: (r: Route) => void, second!: (r: Route) => void
  vi.spyOn(api, 'route').mockImplementationOnce(() => new Promise((resolve) => { first = resolve })).mockImplementationOnce(() => new Promise((resolve) => { second = resolve }))
  const one = navigate(id, b.id, { from: a.id }), two = navigate(id, c.id, { from: a.id })
  second(route(c.id)); await two
  first(route(b.id)); await one
  expect(useTwin.getState().route?.to_space_id).toBe(c.id)
})
it('does not let a background refresh cancel a pending destination change', async () => {
  useTwin.getState().setSite(id, data.building)
  useTwin.getState().setRoute(route(b.id))
  let finish!: (r: Route) => void
  const spy = vi.spyOn(api, 'route').mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
  const pending = navigate(id, c.id, { from: a.id })
  await refreshRoute(id)
  expect(spy).toHaveBeenCalledTimes(1)
  finish(route(c.id)); await pending
  expect(useTwin.getState().route?.to_space_id).toBe(c.id)
})
it('retries a blocked route from its explicit endpoints even when its path is empty', async () => {
  useTwin.getState().setSite(id, data.building)
  useTwin.getState().setRoute({ ...route(b.id), reachable: false, space_path: [] })
  vi.spyOn(api, 'route').mockResolvedValue(route(b.id))
  await refreshRoute(id)
  expect(useTwin.getState().route?.reachable).toBe(true)
})
