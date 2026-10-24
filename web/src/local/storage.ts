import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import type { Booking, SiteEvent, SiteState } from '../lib/types'
import { emitLocal } from './events'

export interface LocalRecord {
  id: string; revision: number; state: SiteState; bookings: Booking[]; events: SiteEvent[]
}
interface LocalDatabase extends DBSchema {
  sites: { key: string; value: LocalRecord }
  media: { key: string; value: Blob }
}
let opened: Promise<IDBPDatabase<LocalDatabase>> | undefined
export function database() {
  if (!opened) opened = openDB<LocalDatabase>('sitetwin-local', 1, {
    upgrade(db) {
      if (!db.objectStoreNames.contains('sites')) db.createObjectStore('sites', { keyPath: 'id' })
      if (!db.objectStoreNames.contains('media')) db.createObjectStore('media')
    },
    blocking() { void closeDatabase() },
    terminated() { opened = undefined },
  }).catch((error) => { opened = undefined; throw error })
  return opened
}
export async function closeDatabase() {
  const previous = opened; opened = undefined
  if (previous) (await previous).close()
}
export function emptyRecord(id: string): LocalRecord {
  return { id, revision: 0, state: { closed: [], asset_overrides: {}, deliveries: [], added_openings: [] }, bookings: [], events: [] }
}
export async function readRecord(id: string) { return (await (await database()).get('sites', id)) ?? emptyRecord(id) }
export const newId = (prefix: string) => `${prefix}-${typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : Array.from(crypto.getRandomValues(new Uint8Array(16)), (n) => n.toString(16).padStart(2, '0')).join('')}`

// The callback is synchronous so IndexedDB's write transaction remains alive.
// The state and its event commit atomically, including concurrent booking checks.
export async function mutateRecord<T>(id: string, change: (record: LocalRecord) => { value: T; event: SiteEvent }): Promise<T> {
  const db = await database()
  const tx = db.transaction('sites', 'readwrite')
  try {
    const record = (await tx.store.get(id)) ?? emptyRecord(id)
    const { value, event } = change(record)
    record.revision++
    record.events.unshift(event)
    await tx.store.put(record)
    await tx.done
    emitLocal({ type: 'event', event })
    return value
  } catch (error) {
    try { tx.abort() } catch { /* Already aborted/committed. */ }
    await tx.done.catch(() => undefined)
    throw error
  }
}
export function makeEvent(record: LocalRecord, type: SiteEvent['type'], title: string, payload: SiteEvent['payload']): SiteEvent {
  // Stable ordering even when two writes happen during the same millisecond.
  const ts = new Date(Math.max(Date.now(), Date.parse(record.events[0]?.ts ?? '') + 1 || 0)).toISOString()
  return { id: newId('event'), ts, site_id: record.id, type, title, payload }
}
export async function exportRecords() { return { version: 1, exportedAt: new Date().toISOString(), sites: await (await database()).getAll('sites') } }
export async function resetRecords() {
  const db = await database()
  const tx = db.transaction(['sites', 'media'], 'readwrite')
  await Promise.all([tx.objectStore('sites').clear(), tx.objectStore('media').clear()])
  await tx.done
}
