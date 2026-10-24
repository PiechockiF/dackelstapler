import type { SiteTwinDataProvider } from '../lib/provider'
import type { BookableRoom, Booking, Delivery, Dims, SiteState, XY } from '../lib/types'
import { pointInPolygon } from '../twin/geom'
import { loadCatalog, loadMobileBuilding } from './catalog'
import { addAsset, assetRooms, deleteAsset, deleteDelivery, equipmentTypes, logDelivery, updateAsset, updateDelivery, withRecord } from './edits'
import { deletePhoto, photoUrl, savePhoto } from './media'
import { resolveSpace } from './router'
import { reachableInWorker, routeInWorker } from './routingClient'
import { makeEvent, mutateRecord, newId, readRecord, type LocalRecord } from './storage'
import type { MobileBuilding, RouteRequest } from './types'

const unavailable = async (): Promise<never> => { throw new Error('This feature requires the online backend. It is not available in local mode.') }
export async function hydrateDelivery(delivery: Delivery): Promise<Delivery> {
  return delivery.photo_id ? { ...delivery, photo_url: await photoUrl(delivery.photo_id) } : delivery
}
async function hydrateState(state: SiteState): Promise<SiteState> {
  return { ...state, deliveries: await Promise.all(state.deliveries.map(hydrateDelivery)) }
}
export function validateRange(start: string, end: string) {
  if (!Number.isFinite(Date.parse(start)) || !Number.isFinite(Date.parse(end)) || Date.parse(end) <= Date.parse(start)) throw new Error('Choose a valid start time and an end time after it.')
}
const overlaps = (a: Booking, start: string, end: string) => Date.parse(a.start) < Date.parse(end) && Date.parse(a.end) > Date.parse(start)
export function roomAvailability(data: MobileBuilding, record: LocalRecord, start: string, end: string, people: number): BookableRoom[] {
  validateRange(start, end)
  if (!Number.isInteger(people) || people < 1) throw new Error('Enter a positive whole number of people.')
  const bookable = new Set(data.bookable), floors = new Map(data.building.floors.map((f) => [f.id, f]))
  return data.building.spaces.filter((s) => bookable.has(s.id) && !record.state.closed.includes(s.id) && data.capacities[s.id] >= people).map((s) => {
    const bookings = record.bookings.filter((b) => b.space_id === s.id)
    return { space_id: s.id, name: s.name, floor_id: s.floor_id, level: floors.get(s.floor_id)!.level,
      capacity: data.capacities[s.id], area_m2: data.areas[s.id], free: !bookings.some((b) => overlaps(b, start, end)), bookings }
  }).sort((a, b) => Number(b.free) - Number(a.free) || a.capacity - b.capacity || a.name.localeCompare(b.name))
}
export function commitBooking(record: LocalRecord, data: MobileBuilding, body: Omit<Booking, 'id' | 'site_id'>): Booking {
  validateRange(body.start, body.end)
  const roomId = resolveSpace(data, body.space_id)
  if (!data.bookable.includes(roomId)) throw new Error('This space is not a bookable room.')
  if (record.state.closed.includes(roomId)) throw new Error('This room is closed.')
  if (record.bookings.some((b) => b.space_id === roomId && overlaps(b, body.start, body.end))) throw new Error('This room is already booked during that time.')
  const booking: Booking = { ...body, space_id: roomId, start: new Date(body.start).toISOString(), end: new Date(body.end).toISOString(), who: body.who.slice(0, 200), title: body.title.slice(0, 200), id: newId('booking'), site_id: record.id }
  record.bookings.push(booking)
  return booking
}
export const localProvider: SiteTwinDataProvider = {
  sites: async () => (await loadCatalog()).sites,
  building: async (id) => withRecord(await loadMobileBuilding(id), await readRecord(id)).building,
  state: async (id) => { await loadMobileBuilding(id); return hydrateState((await readRecord(id)).state) },
  route: async (id, body) => {
    const data = await loadMobileBuilding(id)
    for (let attempt = 0; attempt < 3; attempt++) {
      const record = await readRecord(id)
      // Resolve here: the worker only knows the bundled assets, not ones added or edited on this device.
      const view = withRecord(data, record), rooms = assetRooms(record), resolve = (ref: string) => resolveSpace(view, ref, rooms)
      const resolved = { ...body, from: resolve(body.from), to: resolve(body.to), via: body.via?.map(resolve) }
      if (resolved.from === resolved.to && !resolved.via?.length) throw new Error(`You are already in ${view.building.spaces.find((s) => s.id === resolved.from)?.name ?? resolved.from}.`)
      const route = await routeInWorker(data, resolved, record.state.closed, rooms)
      if ((await readRecord(id)).revision === record.revision) return route
    }
    throw new Error('The building changed while calculating the route. Please retry.')
  },
  reachable: async (id, from, opts = {}) => {
    const data = await loadMobileBuilding(id), record = await readRecord(id)
    const start = resolveSpace(withRecord(data, record), from, assetRooms(record))
    const space_ids = await reachableInWorker(data, start, record.state.closed, opts)
    return { from_space_id: start, step_free: !!opts.step_free || opts.min_width_m != null, min_width_m: opts.min_width_m ?? null, space_ids }
  },
  setClosed: async (id, element, closed) => {
    const data = await loadMobileBuilding(id)
    const item = [...data.building.spaces, ...data.building.openings, ...data.building.vertical_connectors].find((e) => e.id === element)
    if (!item) throw new Error('Unknown room, door, or connector.')
    await mutateRecord(id, (record) => {
      const was_closed = record.state.closed.includes(element)
      record.state.closed = closed ? [...new Set([...record.state.closed, element])] : record.state.closed.filter((e) => e !== element)
      return { value: undefined, event: makeEvent(record, 'closure', `${'name' in item ? item.name : item.id} ${closed ? 'closed' : 'reopened'}`, { element_id: element, closed, was_closed }) }
    })
    return localProvider.state(id)
  },
  moveAsset: async (id, assetId, target, position) => {
    const data = withRecord(await loadMobileBuilding(id), await readRecord(id))
    const asset = data.building.assets.find((a) => a.id === assetId)
    if (!asset) throw new Error('Unknown asset.')
    const spaceId = resolveSpace(data, target), space = data.building.spaces.find((s) => s.id === spaceId)!
    const point: XY = position ?? data.anchors[spaceId]
    if (point.length !== 2 || point.some((n) => !Number.isFinite(n)) || !pointInPolygon(point, space.polygon)) throw new Error('Choose a point inside the destination room.')
    await mutateRecord(id, (record) => {
      if (record.state.closed.includes(spaceId)) throw new Error('The destination room is closed.')
      const previous = record.state.asset_overrides[assetId]
      const next = { space_id: spaceId, floor_id: space.floor_id, position: point }
      record.state.asset_overrides[assetId] = next
      return { value: undefined, event: makeEvent(record, 'asset_moved', `${asset.name} moved to ${space.name}`, { asset_id: assetId, from: previous, to: next }) }
    })
    return localProvider.state(id)
  },
  equipmentTypes,
  addAsset,
  updateAsset,
  deleteAsset,
  logDelivery: async (id, body) => hydrateDelivery(await logDelivery(id, body)),
  updateDelivery: async (id, deliveryId, body) => hydrateDelivery(await updateDelivery(id, deliveryId, body)),
  deleteDelivery: async (id, deliveryId) => {
    const removed = await deleteDelivery(id, deliveryId)
    if (removed.photo_id) await deletePhoto(removed.photo_id).catch(() => console.warn('The removed delivery photo could not be deleted.'))
    return { ok: true }
  },
  events: async (id, since, limit = 1000) => {
    await loadMobileBuilding(id)
    const events = (await readRecord(id)).events.filter((e) => !since || e.ts > since).slice(0, limit)
    return Promise.all(events.map(async (e) => e.type === 'delivery' ? { ...e, payload: await hydrateDelivery(e.payload as Delivery) } : e))
  },
  bookableRooms: async (id, start, end, people) => roomAvailability(await loadMobileBuilding(id), await readRecord(id), start, end, people),
  bookings: async (id) => { await loadMobileBuilding(id); return (await readRecord(id)).bookings },
  book: async (id, body) => {
    const data = await loadMobileBuilding(id)
    return mutateRecord(id, (record) => {
      const value = commitBooking(record, data, body)
      const name = data.building.spaces.find((s) => s.id === value.space_id)!.name
      return { value, event: makeEvent(record, 'booking', `${name} booked: ${value.title}`, value) }
    })
  },
  previewSite: unavailable, restitchSite: unavailable, createSite: unavailable, geocode: unavailable, reverseGeocode: unavailable, captureDelivery: unavailable, captureRoom: unavailable, captureJob: unavailable,
  roomScans: async () => [], health: async () => ({ ok: true, voice: false, llm: false }), captureHost: async () => ({ lan_ip: null }),
}

export interface ManualDeliveryInput { photo: File; dimensions: Dims; spaceId: string; label: string; note: string }
export async function saveManualDelivery(siteId: string, input: ManualDeliveryInput): Promise<Delivery> {
  if ([input.dimensions.w, input.dimensions.d, input.dimensions.h].some((v) => !Number.isFinite(v) || v <= 0 || v >= 40)) throw new Error('All dimensions must be greater than zero and smaller than 40 metres.')
  const data = await loadMobileBuilding(siteId)
  const spaceId = resolveSpace(data, input.spaceId), space = data.building.spaces.find((s) => s.id === spaceId)!
  const entrance = data.building.openings.find((o) => o.space_ids.includes('outside') && o.step_free)
  const from = entrance?.space_ids.find((s) => s !== 'outside') ?? data.building.spaces[0].id
  const photoId = await savePhoto(input.photo)
  let committed = false
  try {
    const snapshot = await readRecord(siteId)
    const body: RouteRequest = { from, to: spaceId, min_width_m: Math.min(input.dimensions.w, input.dimensions.d) } // the narrow side goes through the door first
    const route = await routeInWorker(data, body, snapshot.state.closed, assetRooms(snapshot))
    const placed = route.reachable ? space : data.building.spaces.find((s) => s.id === from)!
    const delivery = await mutateRecord(siteId, (record) => {
      if (record.revision !== snapshot.revision) throw new Error('The building changed while checking the delivery. Please save again.')
      if (record.state.closed.includes(spaceId)) throw new Error('The destination room is closed.')
      const value: Delivery = { id: newId('delivery'), site_id: siteId, ts: makeEvent(record, 'delivery', '', {}).ts, label: input.label.trim().slice(0, 120) || 'Local delivery', note: input.note.slice(0, 2000),
        dims_m: input.dimensions, tolerance_m: 0, floor_id: placed.floor_id, space_id: placed.id, target_space_id: spaceId,
        position: data.anchors[placed.id], rotation_deg: 0, photo_id: photoId, measurement_source: 'manual',
        status: route.reachable ? 'unassessed' : 'blocked', check: { declared: null, floor_fit: null,
          route_fit: { ok: route.reachable, route, blocking_openings: route.blocking_openings ?? [] },
          summary: route.reachable ? 'Doorway width check passed. Turning clearance, height and floor fit are not assessed.' : 'No route meets the entered width and step-free constraints. Full physical fit is not assessed.' } }
      record.state.deliveries.push(value)
      return { value, event: makeEvent(record, 'delivery', `${value.label} saved in ${placed.name}`, value) }
    })
    committed = true
    return await hydrateDelivery(delivery)
  } finally {
    if (!committed) await deletePhoto(photoId).catch(() => console.warn('An uncommitted local photo could not be removed.'))
  }
}
