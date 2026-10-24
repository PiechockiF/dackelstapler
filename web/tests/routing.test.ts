import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { LocalRouter, resolveSpace } from '../src/local/router'
import type { MobileBuilding, RouteRequest } from '../src/local/types'

const fixtures = JSON.parse(readFileSync(new URL('./fixtures/routes.json', import.meta.url), 'utf8')) as { site: string; body: RouteRequest; closed: string[]; expected: { reachable: boolean; length_m: number } }[]
const routers = new Map<string, LocalRouter>()
function router(id: string) {
  if (!routers.has(id)) routers.set(id, new LocalRouter(JSON.parse(readFileSync(new URL(`../public/offline/${id}.json`, import.meta.url), 'utf8'))))
  return routers.get(id)!
}
describe('Python/TypeScript routing parity across all 66 bundled sites', () => {
  it('matches reachability and costs for all generated golden/randomized cases', () => {
    for (const fixture of fixtures) {
      let route
      try { route = router(fixture.site).route(fixture.body, fixture.closed) }
      catch (error) {
        // Python resolves invalid/ambiguous endpoints with MapError too.
        if (fixture.expected.reachable) throw error
        continue
      }
      expect(route.reachable, JSON.stringify(fixture)).toBe(fixture.expected.reachable)
      if (route.reachable) expect(Math.abs(route.length_m - fixture.expected.length_m), JSON.stringify(fixture)).toBeLessThanOrEqual(0.010001)
      expect(route.from_space_id).toBeDefined()
      expect(route.to_space_id).toBeDefined()
    }
  })
  it('matches Python reachable_spaces for every generated case (closures, step-free, loads, from outside)', () => {
    const cases = JSON.parse(readFileSync(new URL('./fixtures/reachable.json', import.meta.url), 'utf8')) as { site: string; from: string; step_free?: boolean; min_width_m?: number; closed: string[]; expected: string[] }[]
    expect(cases.length).toBeGreaterThan(0)
    for (const c of cases) {
      expect(router(c.site).reachable(c.from, c.closed, { step_free: c.step_free, min_width_m: c.min_width_m }), JSON.stringify({ ...c, expected: undefined })).toEqual(c.expected)
    }
  })
  it('keeps pedestrians inside but lets loads go round the building', () => {
    const r = router('proc-factory-dev-003'), from = 'proc-factory-dev-003-F0-S014', to = 'proc-factory-dev-003-F1-S023'
    const walk = r.route({ from, to, step_free: true }, [])
    expect(walk.space_path).not.toContain('outside')
    expect(walk.length_m).toBeCloseTo(133.04, 2) // core.building_map, judges' route model (kit 1.1.0)
  })
  it('treats minimum width as step-free and preserves an unreachable request for rerouting', () => {
    const r = router('proc-factory-dev-003'), b = r.data.building
    const from = b.spaces[0].id, to = b.spaces.at(-1)!.id
    const route = r.route({ from, to, min_width_m: 1 }, [from])
    expect(route.step_free).toBe(true)
    expect(route.reachable).toBe(false)
    expect(route.from_space_id).toBe(from)
    expect(route.to_space_id).toBe(to)
    expect(route.space_path).toEqual([from, to])
  })
  it('rejects ambiguous names, supports moved assets, and rejects invalid widths', () => {
    const original = router('proc-factory-dev-003').data
    const data: MobileBuilding = structuredClone(original)
    data.building.spaces[0].name = data.building.spaces[1].name = 'Duplicate room'
    expect(() => resolveSpace(data, 'Duplicate room')).toThrow(/ambiguous/)
    const asset = data.building.assets[0], destination = data.building.spaces.at(-1)!.id
    expect(resolveSpace(data, asset.id, { [asset.id]: destination })).toBe(destination)
    expect(() => new LocalRouter(data).route({ from: destination, to: destination, min_width_m: NaN }, [])).toThrow(/positive/)
  })
})
