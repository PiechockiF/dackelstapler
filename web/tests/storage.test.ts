import 'fake-indexeddb/auto'
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { localProvider } from '../src/local/provider'
import { closeDatabase, exportRecords, makeEvent, mutateRecord, readRecord, resetRecords } from '../src/local/storage'
import { subscribeLocal } from '../src/local/events'
import { runLocalCommand } from '../src/local/assistant'
import { snapshotAt } from '../src/twin/timeline'

vi.mock('../src/local/routingClient', () => ({ routeInWorker: async (data, body, closed, rooms) => {
  const { LocalRouter } = await import('../src/local/router')
  return new LocalRouter(data).route(body, closed, rooms)
} }))
const site = 'proc-factory-dev-003'
beforeEach(async () => {
  vi.stubGlobal('fetch', async (url: string) => new Response(readFileSync(new URL(`../public${url}`, import.meta.url), 'utf8'), { headers: { 'Content-Type': 'application/json' } }))
  await resetRecords()
})
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })
describe('persistent local provider', () => {
  it('commits state and events together and survives closing/reopening the database', async () => {
    const building = await localProvider.building(site), id = building.vertical_connectors[0].id
    await localProvider.setClosed(site, id, true)
    await closeDatabase()
    expect((await localProvider.state(site)).closed).toContain(id)
    expect((await localProvider.events(site))[0].payload.element_id).toBe(id)
    await localProvider.setClosed(site, id, false)
    expect((await localProvider.state(site)).closed).not.toContain(id)
    expect((await exportRecords()).sites[0].revision).toBe(2)
  })
  it('rolls back partial writes and emits nothing after a failed transaction', async () => {
    const listener = vi.fn(), unsubscribe = subscribeLocal(listener)
    await expect(mutateRecord(site, (record) => {
      record.state.closed.push('should-not-save')
      throw new Error('Disk write simulation')
    })).rejects.toThrow('Disk write simulation')
    expect((await readRecord(site)).state.closed).toEqual([])
    expect(listener).not.toHaveBeenCalled()
    unsubscribe()
  })
  it('serializes conflicting bookings, uses real availability, and allows adjacent time slots', async () => {
    const start = '2026-10-25T10:00:00Z', end = '2026-10-25T11:00:00Z'
    const rooms = await localProvider.bookableRooms(site, start, end, 1)
    expect(rooms.length).toBeGreaterThan(0)
    expect(rooms.every((r) => r.free)).toBe(true)
    const body = { space_id: rooms[0].space_id, start, end, who: 'Test', title: 'Test booking' }
    const outcomes = await Promise.allSettled([localProvider.book(site, body), localProvider.book(site, body)])
    expect(outcomes.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(await localProvider.bookings(site)).toHaveLength(1)
    expect((await localProvider.bookableRooms(site, start, end, 1)).find((r) => r.space_id === body.space_id)?.free).toBe(false)
    await localProvider.book(site, { ...body, start: end, end: '2026-10-25T12:00:00Z' })
    expect(await localProvider.bookings(site)).toHaveLength(2)
    await expect(localProvider.book(site, { ...body, end: start })).rejects.toThrow(/valid/)
    await localProvider.setClosed(site, body.space_id, true)
    await expect(localProvider.book(site, { ...body, start: '2026-10-26T10:00:00Z', end: '2026-10-26T11:00:00Z' })).rejects.toThrow(/closed/)
  })
  it('persists asset moves with undo information, and keeps sites isolated', async () => {
    const building = await localProvider.building(site), asset = building.assets[0], room = building.spaces.at(-1)!
    await localProvider.moveAsset(site, asset.id, room.id)
    await closeDatabase()
    expect((await localProvider.state(site)).asset_overrides[asset.id].space_id).toBe(room.id)
    expect((await localProvider.events(site))[0].type).toBe('asset_moved')
    expect((await readRecord('other-site')).revision).toBe(0)
  })
  it('notifies listeners only after a committed mutation is readable', async () => {
    const revisions: Promise<number>[] = []
    const unsubscribe = subscribeLocal(() => { revisions.push(readRecord(site).then((r) => r.revision)) })
    await mutateRecord(site, (record) => ({ value: null, event: makeEvent(record, 'capture', 'Saved', {}) }))
    expect(await Promise.all(revisions)).toEqual([1])
    unsubscribe()
  })
  it('keeps persisted state intact after a database write error', async () => {
    await localProvider.setClosed(site, 'proc-factory-dev-003-V02', true)
    const before = await readRecord(site), listener = vi.fn(), unsubscribe = subscribeLocal(listener)
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementationOnce(() => { throw new DOMException('Storage full', 'QuotaExceededError') })
    await expect(localProvider.setClosed(site, 'proc-factory-dev-003-V02', false)).rejects.toThrow('Storage full')
    expect(await readRecord(site)).toEqual(before)
    expect(listener).not.toHaveBeenCalled()
    unsubscribe()
  })
  it('executes assistant commands against real local state and explains unsupported requests', async () => {
    const building = await localProvider.building(site), room = building.spaces.find((s) => s.name === 'Office 1.04')!
    expect((await runLocalCommand(site, `area of ${room.id}`, room.id)).text).toMatch(/m²/)
    const connector = building.vertical_connectors[0]
    await runLocalCommand(site, `close ${connector.id}`, room.id)
    expect((await localProvider.state(site)).closed).toContain(connector.id)
    expect((await runLocalCommand(site, 'what changed?', room.id)).text).toContain('closed')
    const route = await runLocalCommand(site, `route to ${building.spaces[0].id} without stairs`, room.id)
    expect(route.actions.find((a) => a.type === 'show_route')).toBeDefined()
    expect((await runLocalCommand(site, 'reconstruct my room', room.id)).text).toContain('online app')
    await expect(runLocalCommand(site, 'free rooms at 25:60', room.id)).rejects.toThrow(/valid/)
  })
  it('replays repeated closures to their previous state instead of inventing a reopen', async () => {
    const building = await localProvider.building(site), connector = building.vertical_connectors[0].id
    await localProvider.setClosed(site, connector, true)
    const first = (await readRecord(site)).events[0]
    await localProvider.setClosed(site, connector, true)
    const record = await readRecord(site)
    expect(snapshotAt(record.state, record.events, first.ts).closed.has(connector)).toBe(true)
  })
})
