import 'fake-indexeddb/auto'
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { localProvider } from '../src/local/provider'
import { closeDatabase, readRecord, resetRecords } from '../src/local/storage'

vi.mock('../src/local/routingClient', () => ({
  routeInWorker: async (data, body, closed, rooms) => new (await import('../src/local/router')).LocalRouter(data).route(body, closed, rooms),
  reachableInWorker: async (data, from, closed, opts) => new (await import('../src/local/router')).LocalRouter(data).reachable(from, closed, opts),
}))
const site = 'proc-factory-dev-003', S = (n: string) => `${site}-${n}`
const OFFICE = S('F1-S004'), KITCHEN = S('F1-S027'), LAB = S('F0-S021')
beforeEach(async () => {
  vi.stubGlobal('fetch', async (url: string) => new Response(readFileSync(new URL(`../public${url}`, import.meta.url), 'utf8'), { headers: { 'Content-Type': 'application/json' } }))
  await resetRecords()
})
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('local equipment (parity with server/twin.py)', () => {
  it('adds equipment with catalog defaults on a free spot, unique names, and persists it', async () => {
    expect((await localProvider.equipmentTypes()).find((t) => t.type === 'cnc_mill')?.label).toBe('CNC mill')
    const coffee = await localProvider.addAsset(site, { type: 'Coffee machine', space_id: 'Office 1.04' })
    expect(coffee).toMatchObject({ name: 'Coffee machine 1.04', type: 'coffee_machine', category: 'equipment', space_id: OFFICE, source: 'manual' })
    expect(coffee.footprint).toMatchObject({ width_m: 0.4, depth_m: 0.4 })
    const second = await localProvider.addAsset(site, { type: 'coffee_machine', space_id: OFFICE })
    expect(second.name).toBe('Coffee machine 1.04 2')
    expect(second.position).not.toEqual(coffee.position)
    await closeDatabase()
    const building = await localProvider.building(site)
    expect(building.assets.filter((a) => a.source === 'manual').map((a) => a.id)).toEqual([coffee.id, second.id])
    expect((await localProvider.events(site))[0]).toMatchObject({ type: 'asset_added', payload: { asset_id: second.id } })
    await expect(localProvider.addAsset(site, { type: 'desk', space_id: 'Nowhere 9.99' })).rejects.toThrow(/No place matches/)
  })
  it('edits, moves and deletes added and bundled assets', async () => {
    const coffee = await localProvider.addAsset(site, { type: 'coffee machine', space_id: OFFICE })
    const renamed = await localProvider.updateAsset(site, coffee.id, { name: 'Espresso bar', width_m: 0.6 })
    expect(renamed).toMatchObject({ name: 'Espresso bar', footprint: { width_m: 0.6, depth_m: 0.4 } })
    const moved = await localProvider.updateAsset(site, coffee.id, { space_id: 'Kitchen 1.27' })
    expect(moved.space_id).toBe(KITCHEN)
    expect((await localProvider.state(site)).asset_overrides[coffee.id].space_id).toBe(KITCHEN)
    expect((await localProvider.events(site)).slice(0, 2).map((e) => e.type)).toEqual(['asset_moved', 'asset_updated'])
    // Routes and the assistant resolve assets added on this device.
    expect((await localProvider.route(site, { from: OFFICE, to: coffee.id })).to_space_id).toBe(KITCHEN)

    await localProvider.updateAsset(site, S('A00001'), { name: 'CNC mill Big Bertha' })
    await localProvider.deleteAsset(site, S('A00002'))
    await localProvider.deleteAsset(site, coffee.id)
    await closeDatabase()
    const assets = new Map((await localProvider.building(site)).assets.map((a) => [a.id, a]))
    expect(assets.get(S('A00001'))?.name).toBe('CNC mill Big Bertha')
    expect(assets.has(S('A00002'))).toBe(false)
    expect(assets.has(coffee.id)).toBe(false)
    expect((await localProvider.state(site)).asset_overrides[coffee.id]).toBeUndefined()
    expect((await localProvider.events(site))[0].type).toBe('asset_removed')
    await expect(localProvider.deleteAsset(site, 'nonexistent')).rejects.toThrow(/No asset/)
  })
  it('upgrades records saved before equipment existed', async () => {
    const { database } = await import('../src/local/storage')
    await (await database()).put('sites', { id: site, revision: 3, state: { closed: [], asset_overrides: {}, deliveries: [], added_openings: [] }, bookings: [], events: [] } as never)
    await localProvider.addAsset(site, { type: 'plant', space_id: OFFICE })
    expect((await readRecord(site)).added_assets).toHaveLength(1)
  })
})

describe('local deliveries by hand (parity with capture/dimension_check.py)', () => {
  it('logs a delivery where it stands, assuming a Euro pallet without a size', async () => {
    const delivery = await localProvider.logDelivery(site, { label: 'Steel sheets', space_id: 'Quality lab 0.21' })
    expect(delivery).toMatchObject({ space_id: LAB, status: 'ok', dims_m: { w: 1.2, d: 0.8, h: 1 }, measurement_source: 'manual' })
    expect(delivery.check.summary).toMatch(/^Size not given, assumed a Euro pallet\. .*Placed in Quality lab 0\.21\./)
    expect((await localProvider.events(site))[0]).toMatchObject({ type: 'delivery', title: 'Steel sheets delivered to Quality lab 0.21' })
    expect((await localProvider.state(site)).deliveries.map((d) => d.id)).toEqual([delivery.id])
  })
  it('checks doors to the destination, stays put when blocked, and re-checks on edit', async () => {
    const ok = await localProvider.logDelivery(site, { label: 'Crate', space_id: LAB, dims_m: { w: 1, d: 0.8, h: 1.2 }, target_space_id: 'Office 1.04' })
    expect(ok.status).toBe('ok')
    expect(ok.check.summary).toMatch(/Fits every door to Office 1\.04/)
    const wide = await localProvider.updateDelivery(site, ok.id, { dims_m: { w: 2.2, d: 1.6, h: 1.8 } })
    expect(wide).toMatchObject({ status: 'blocked', space_id: LAB, target_space_id: OFFICE })
    expect(wide.check.route_fit?.blocking_openings.length).toBeGreaterThan(0)
    expect(wide.check.summary).toMatch(/Won't pass .* to Office 1\.04/)
    const cleared = await localProvider.updateDelivery(site, ok.id, { target_space_id: null, label: 'Big crate', note: 'PO 4711' })
    expect(cleared).toMatchObject({ status: 'ok', label: 'Big crate', note: 'PO 4711' })
    expect(cleared.target_space_id).toBeUndefined()
    expect((await localProvider.events(site))[0]).toMatchObject({ type: 'delivery_updated', payload: { delivery_id: ok.id } })
    await localProvider.deleteDelivery(site, ok.id)
    expect((await localProvider.state(site)).deliveries).toEqual([])
    expect((await localProvider.events(site))[0].type).toBe('delivery_removed')
    await expect(localProvider.deleteDelivery(site, ok.id)).rejects.toThrow(/Unknown delivery/)
    await expect(localProvider.logDelivery(site, { label: 'x', space_id: LAB, dims_m: { w: 0, d: 1, h: 1 } })).rejects.toThrow(/between 0.05 and 40/)
  })
})

describe('local assistant commands for equipment and deliveries', () => {
  it('adds, finds and removes equipment and logs a delivery', async () => {
    const { runLocalCommand } = await import('../src/local/assistant')
    expect((await runLocalCommand(site, 'add a coffee machine to Office 1.04', OFFICE)).text).toMatch(/Coffee machine 1\.04 added to Office 1\.04/)
    expect((await runLocalCommand(site, 'find coffee machine 1.04', OFFICE)).text).toContain('Coffee machine 1.04')
    expect((await runLocalCommand(site, 'remove Coffee machine 1.04', OFFICE)).text).toContain('removed')
    expect((await localProvider.building(site)).assets.some((a) => a.name === 'Coffee machine 1.04')).toBe(false)
    expect((await runLocalCommand(site, 'delivery steel drums at Quality lab 0.21', OFFICE)).text).toMatch(/Euro pallet/)
    expect((await localProvider.state(site)).deliveries[0].label).toBe('steel drums')
  })
})

describe('local routes (parity with server/twin.py)', () => {
  it('rejects a route to the room you are already in, unless it has stops', async () => {
    await expect(localProvider.route(site, { from: 'Office 1.04', to: OFFICE })).rejects.toThrow('You are already in Office 1.04.')
    expect((await localProvider.route(site, { from: OFFICE, to: OFFICE, via: [LAB] })).reachable).toBe(true)
  })
})

describe('local reachability', () => {
  it('returns the spaces reachable from a room and honours closures', async () => {
    const all = await localProvider.reachable(site, OFFICE)
    expect(all).toMatchObject({ from_space_id: OFFICE, step_free: false, min_width_m: null })
    expect(all.space_ids).toContain(LAB)
    const lifts = (await localProvider.building(site)).vertical_connectors
    for (const c of lifts) await localProvider.setClosed(site, c.id, true)
    const upstairsOnly = await localProvider.reachable(site, OFFICE)
    expect(upstairsOnly.space_ids).not.toContain(LAB)
    expect((await localProvider.reachable(site, OFFICE, { min_width_m: 1.2 })).step_free).toBe(true)
  })
})
