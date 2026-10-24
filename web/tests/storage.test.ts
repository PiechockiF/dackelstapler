import 'fake-indexeddb/auto'
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { localProvider } from '../src/local/provider'
import { closeDatabase, exportRecords, makeEvent, mutateRecord, readRecord, resetRecords } from '../src/local/storage'
import { subscribeLocal } from '../src/local/events'

vi.mock('../src/local/routingClient', () => ({ routeInWorker: async (data, body, closed, rooms) => {
  const { LocalRouter } = await import('../src/local/router')
  return new LocalRouter(data).route(body, closed, rooms)
} }))
const site = 'proc-factory-dev-003'
beforeEach(async () => {
  vi.stubGlobal('fetch', async (url: string) => new Response(readFileSync(new URL(`../public${url}`, import.meta.url), 'utf8'), { headers: { 'Content-Type': 'application/json' } }))
  await resetRecords()
})
afterEach(() => vi.unstubAllGlobals())
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
})
