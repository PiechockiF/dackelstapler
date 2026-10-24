// Local (on-device) versions of the server's hand-entered data: equipment added/edited/deleted and
// deliveries logged/edited/deleted without a photo. Mirrors server/twin.py and capture/dimension_check.py:
// same defaults, placement, checks, event types and payloads, so the feed and timeline behave identically.
import type { AssetChanges, DeliveryChanges, NewAsset, NewDelivery } from '../lib/provider'
import type { Asset, Delivery, DimensionCheck, Dims, EquipmentType, Opening, Space, XY } from '../lib/types'
import { loadCatalog, loadMobileBuilding } from './catalog'
import { footprintFits, round3, type Fit, type Footprint } from './placement'
import { resolveSpace } from './router'
import { routeInWorker } from './routingClient'
import { makeEvent, mutateRecord, newId, readRecord, type LocalRecord } from './storage'
import type { MobileBuilding } from './types'

export const EURO_PALLET: Dims = { w: 1.2, d: 0.8, h: 1.0 }
const CATEGORIES = ['machine', 'equipment', 'furniture', 'fixture']
const ACRONYMS: Record<string, string> = { cnc: 'CNC', ups: 'UPS', hvac: 'HVAC', '3d': '3D', it: 'IT' }
const CLEARANCE_M = 0.15

// ---------------------------------------------------------------- the building as edited on this device

export const assetRooms = (r: LocalRecord) => Object.fromEntries(Object.entries(r.state.asset_overrides).map(([id, value]) => [id, value.space_id]))

/** The bundled building with this device's added, edited and deleted assets applied. */
export function withRecord(data: MobileBuilding, record: LocalRecord): MobileBuilding {
  const edits = record.asset_edits
  if (!record.added_assets.length && !Object.keys(edits).length) return data
  const assets = data.building.assets.flatMap((a) => (a.id in edits ? (edits[a.id] ? [edits[a.id]!] : []) : [a]))
  return { ...data, building: { ...data.building, assets: [...assets, ...record.added_assets] } }
}

/** Where an asset stands now (moves live in asset_overrides). */
function placed(asset: Asset, record: LocalRecord): Footprint | null {
  const o = record.state.asset_overrides[asset.id], fp = asset.footprint
  if (!fp?.width_m || !fp.depth_m) return null
  return { position: o?.position ?? asset.position, width_m: fp.width_m, depth_m: fp.depth_m, rotation_deg: fp.rotation_deg ?? 0 }
}

function obstacles(view: MobileBuilding, record: LocalRecord, spaceId: string, ignore: { asset?: string; delivery?: string } = {}): Footprint[] {
  const assets = view.building.assets
    .filter((a) => a.id !== ignore.asset && (record.state.asset_overrides[a.id]?.space_id ?? a.space_id) === spaceId)
    .map((a) => placed(a, record))
  const deliveries = record.state.deliveries
    .filter((d) => d.id !== ignore.delivery && d.space_id === spaceId)
    .map((d): Footprint => ({ position: d.position, width_m: d.dims_m.w, depth_m: d.dims_m.d, rotation_deg: d.rotation_deg ?? 0 }))
  return [...assets.filter((a): a is Footprint => a !== null), ...deliveries]
}

/** A free spot (15 cm from other equipment, else tight), like capture.dimension_check.floor_fit. */
function floorFit(view: MobileBuilding, record: LocalRecord, space: Space, w: number, d: number, ignore: { asset?: string; delivery?: string } = {}): Fit {
  const around = obstacles(view, record, space.id, ignore), anchor = view.anchors[space.id]
  const fit = footprintFits(space.polygon, space.name, anchor, around, w, d, CLEARANCE_M)
  if (fit.ok) return fit
  const tight = footprintFits(space.polygon, space.name, anchor, around, w, d)
  return tight.ok ? { ...tight, reason: `${tight.reason} (tight: under 15 cm clearance)` } : fit
}

function spaceOf(view: MobileBuilding, id: string): Space {
  return view.building.spaces.find((s) => s.id === id)!
}

// ---------------------------------------------------------------- equipment

const slug = (text: string) => text.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
function typeLabel(type: string): string {
  const text = type.split('_').filter(Boolean).map((w) => ACRONYMS[w] ?? w).join(' ')
  return text.charAt(0).toUpperCase() + text.slice(1)
}
function uniqueName(assets: Asset[], name: string, exclude?: string): string {
  const taken = new Set(assets.filter((a) => a.id !== exclude).map((a) => a.name.toLowerCase()))
  if (!taken.has(name.toLowerCase())) return name
  let n = 2
  while (taken.has(`${name} ${n}`.toLowerCase())) n++
  return `${name} ${n}`
}
function metres(value: number | undefined, fallback: number, what: string): number {
  const v = value ?? fallback
  if (!Number.isFinite(v) || v < 0.05 || v > 40) throw new Error(`${what} must be between 0.05 and 40 m.`)
  return round3(v)
}

export async function equipmentTypes(): Promise<EquipmentType[]> {
  return (await loadCatalog()).equipment ?? []
}

export async function addAsset(siteId: string, body: NewAsset): Promise<Asset> {
  const [data, types] = await Promise.all([loadMobileBuilding(siteId), equipmentTypes()])
  const type = slug(body.type || body.name || '')
  if (!type) throw new Error("Say what kind of equipment it is, e.g. 'coffee machine' or 'cnc mill'.")
  const known = types.find((t) => t.type === type)
  const width = metres(body.width_m, known?.width_m ?? 1, 'Width'), depth = metres(body.depth_m, known?.depth_m ?? 1, 'Depth')
  return mutateRecord(siteId, (record) => {
    const view = withRecord(data, record)
    const space = spaceOf(view, resolveSpace(view, body.space_id, assetRooms(record)))
    const fit = floorFit(view, record, space, width, depth)
    const name = uniqueName(view.building.assets, body.name?.trim() || `${known?.label ?? typeLabel(type)} ${space.ref ?? space.name}`)
    const asset: Asset = {
      id: `${siteId}-A-new-${newId('a').replace(/-/g, '').slice(1, 11)}`, name, category: known?.category ?? 'equipment', type,
      space_id: space.id, floor_id: space.floor_id, position: fit.position ?? view.anchors[space.id],
      footprint: { width_m: width, depth_m: depth, rotation_deg: fit.ok ? fit.rotation_deg : 0 }, source: 'manual',
    }
    record.added_assets.push(asset)
    return { value: asset, event: makeEvent(record, 'asset_added', `${asset.name} added to ${space.name}`, { asset_id: asset.id, name, space_id: space.id, asset }) }
  })
}

export async function updateAsset(siteId: string, assetId: string, changes: AssetChanges & { category?: string }): Promise<Asset> {
  const data = await loadMobileBuilding(siteId)
  return mutateRecord(siteId, (record) => {
    const view = withRecord(data, record)
    const current = view.building.assets.find((a) => a.id === assetId)
    if (!current) throw new Error(`No asset matches '${assetId}'.`)
    const asset: Asset = structuredClone(current)
    if (changes.type !== undefined) {
      asset.type = slug(changes.type)
      if (!asset.type) throw new Error('Say what kind of equipment it is.')
    }
    if (changes.category !== undefined) {
      if (!CATEGORIES.includes(changes.category.trim().toLowerCase())) throw new Error(`Category must be one of: ${CATEGORIES.join(', ')}.`)
      asset.category = changes.category.trim().toLowerCase()
    }
    if (changes.name !== undefined) {
      if (!changes.name.trim()) throw new Error("The name can't be empty.")
      asset.name = uniqueName(view.building.assets, changes.name.trim(), assetId)
    }
    const fp = asset.footprint ?? { width_m: 0.5, depth_m: 0.5, rotation_deg: 0 }
    asset.footprint = { ...fp, width_m: metres(changes.width_m, fp.width_m, 'Width'), depth_m: metres(changes.depth_m, fp.depth_m, 'Depth') }
    const before = record.state.asset_overrides[assetId]
    const room = before?.space_id ?? asset.space_id
    const target = changes.space_id ? resolveSpace(view, changes.space_id, assetRooms(record)) : room
    const edited = JSON.stringify(asset) !== JSON.stringify(current)
    if (!edited && target === room) return { value: current, event: [] }

    const events = []
    if (edited) {
      const added = record.added_assets.findIndex((a) => a.id === assetId)
      if (added >= 0) record.added_assets[added] = asset
      else record.asset_edits[assetId] = asset
      const changed = (['name', 'type', 'category', 'footprint'] as const).filter((k) => JSON.stringify(asset[k]) !== JSON.stringify(current[k]))
        .map((k) => (k === 'footprint' ? 'size' : k))
      const title = changed.length === 1 && changed[0] === 'name' ? `${current.name} renamed to ${asset.name}` : `${asset.name} edited: ${changed.join(', ')}`
      events.push(makeEvent(record, 'asset_updated', title, { asset_id: assetId, name: asset.name, space_id: room, before: current, after: asset }))
    }
    let result = { ...asset, ...(before ?? {}) }
    if (target !== room) {
      const space = spaceOf(view, target), fit = floorFit(view, record, space, asset.footprint.width_m, asset.footprint.depth_m, { asset: assetId })
      const next = { space_id: space.id, floor_id: space.floor_id, position: fit.position ?? view.anchors[space.id] }
      record.state.asset_overrides[assetId] = next
      events.push(makeEvent(record, 'asset_moved', `${asset.name} moved to ${space.name}`, { asset_id: assetId, from: before, to: next }, events[0]))
      result = { ...asset, ...next }
    }
    return { value: result, event: events }
  })
}

export async function deleteAsset(siteId: string, assetId: string): Promise<{ ok: boolean }> {
  const data = await loadMobileBuilding(siteId)
  return mutateRecord(siteId, (record) => {
    const view = withRecord(data, record)
    const asset = view.building.assets.find((a) => a.id === assetId)
    if (!asset) throw new Error(`No asset matches '${assetId}'.`)
    const added = record.added_assets.findIndex((a) => a.id === assetId)
    if (added >= 0) record.added_assets.splice(added, 1)
    else record.asset_edits[assetId] = null
    const room = record.state.asset_overrides[assetId]?.space_id ?? asset.space_id
    delete record.state.asset_overrides[assetId]
    const where = view.building.spaces.find((s) => s.id === room)?.name ?? room
    return { value: { ok: true }, event: makeEvent(record, 'asset_removed', `${asset.name} removed from ${where}`, { asset_id: assetId, name: asset.name, space_id: room, asset }) }
  })
}

// ---------------------------------------------------------------- deliveries

function validDims(dims: Dims): Dims {
  const out = { w: 0, d: 0, h: 0 }
  for (const k of ['w', 'd', 'h'] as const) {
    if (!Number.isFinite(dims[k]) || dims[k] < 0.05 || dims[k] > 40) throw new Error(`Size ${k.toUpperCase()} must be between 0.05 and 40 m.`)
    out[k] = round3(dims[k])
  }
  return out
}

/** 'door 0.21', 'entrance of Main aisle H-B5', 'opening A / B' (capture.dimension_check.opening_label). */
function openingLabel(view: MobileBuilding, opening: Opening | undefined, id: string): string {
  if (!opening) return id
  const spaces = opening.space_ids.map((s) => view.building.spaces.find((x) => x.id === s)).filter((s): s is Space => !!s)
  if (opening.space_ids.includes('outside') || opening.kind === 'entrance') return spaces[0] ? `entrance of ${spaces[0].name}` : 'entrance'
  const room = spaces.find((s) => s.type === 'room' && s.ref)
  if (opening.kind === 'door' && room) return `door ${room.ref}`
  return `${opening.kind} ${spaces.map((s) => s.name).join(' / ')}`.trim()
}

interface Checked { status: Delivery['status']; check: DimensionCheck; space_id: string; floor_id: string; position: XY; rotation_deg: number }

/** capture.dimension_check.check_delivery for an item already standing in `at` (no photo, no PO). */
async function checkDelivery(view: MobileBuilding, record: LocalRecord, dims: Dims, at: string, target: string | undefined, deliveryId?: string): Promise<Checked> {
  const w = Math.max(dims.w, dims.d), d = Math.min(dims.w, dims.d)
  let fit: DimensionCheck['route_fit'] = null
  if (target) {
    // The narrow side goes through the door first; loads may drive round the building.
    const route = await routeInWorker(view, { from: at, to: target, min_width_m: d }, record.state.closed, assetRooms(record))
    fit = route.reachable ? { ok: true, route, blocking_openings: [] } : { ok: false, blocking_openings: route.blocking_openings ?? [] }
  }
  const atSpace = spaceOf(view, at), floorSpace = spaceOf(view, target ?? at)
  const floor = floorFit(view, record, floorSpace, w, d, { delivery: deliveryId })
  const placement = floorSpace.id === at && floor.ok ? floor : floorFit(view, record, atSpace, w, d, { delivery: deliveryId })

  const f2 = (n: number) => n.toFixed(2)
  const parts = [`${f2(dims.w)} × ${f2(dims.d)} × ${f2(dims.h)} m.`]
  if (fit && target) {
    const name = floorSpace.name
    if (fit.ok) {
      parts.push(`Fits every door to ${name}${fit.route?.length_m ? `, ${fit.route.length_m.toFixed(0)} m.` : '.'}`)
    } else if (fit.blocking_openings.length) {
      const first = fit.blocking_openings[0], label = openingLabel(view, view.building.openings.find((o) => o.id === first.id), first.id)
      const more = fit.blocking_openings.length > 1 ? ` +${fit.blocking_openings.length - 1} more` : ''
      parts.push(`⚠ Won't pass ${label} (${first.width_m.toFixed(2)} m)${more} to ${name} — no route wide enough.`)
    } else parts.push(`⚠ No step-free route to ${name} — no route wide enough.`)
  }
  if (!floor.ok) parts.push(`⚠ ${floor.reason}`)
  if (!target) parts.push(`Placed in ${atSpace.name}.`)
  return {
    status: (fit && !fit.ok) || !floor.ok ? 'blocked' : 'ok',
    check: { declared: null, route_fit: fit, floor_fit: { ok: floor.ok, reason: floor.reason }, summary: parts.join(' ') },
    space_id: at, floor_id: atSpace.floor_id,
    position: placement.position ?? view.anchors[at], rotation_deg: placement.ok ? placement.rotation_deg : 0,
  }
}

/** Run an async check against a snapshot, then commit only if nothing changed meanwhile. */
async function commitChecked<P, T>(siteId: string, prepare: (snapshot: LocalRecord) => Promise<P>, commit: (record: LocalRecord, prepared: P) => { value: T; event: ReturnType<typeof makeEvent> | ReturnType<typeof makeEvent>[] }): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const snapshot = await readRecord(siteId)
    const prepared = await prepare(snapshot)
    const stale = Symbol('stale')
    try {
      return await mutateRecord(siteId, (record) => {
        if (record.revision !== snapshot.revision) throw stale
        return commit(record, prepared)
      })
    } catch (error) {
      if (error !== stale) throw error
    }
  }
  throw new Error('The building changed while checking the delivery. Please save again.')
}

export async function logDelivery(siteId: string, body: NewDelivery): Promise<Delivery> {
  const data = await loadMobileBuilding(siteId)
  const label = body.label.trim().slice(0, 120) || 'Delivery'
  const assumed = !body.dims_m, dims = assumed ? EURO_PALLET : validDims(body.dims_m!)
  return commitChecked(siteId, async (snapshot) => {
    const view = withRecord(data, snapshot), rooms = assetRooms(snapshot)
    const at = resolveSpace(view, body.space_id, rooms)
    const target = body.target_space_id?.trim() ? resolveSpace(view, body.target_space_id, rooms) : undefined
    return { view, at, target: target === at ? undefined : target, checked: await checkDelivery(view, snapshot, dims, at, target === at ? undefined : target) }
  }, (record, { view, target, checked }) => {
    const event = makeEvent(record, 'delivery', '', {})
    const delivery: Delivery = {
      id: newId('delivery'), site_id: siteId, ts: event.ts, label, dims_m: dims, tolerance_m: 0, ...checked,
      check: assumed ? { ...checked.check, summary: `Size not given, assumed a Euro pallet. ${checked.check.summary}` } : checked.check,
      measurement_source: 'manual',
      ...(target ? { target_space_id: target } : {}), ...(body.note?.trim() ? { note: body.note.trim().slice(0, 2000) } : {}),
    }
    record.state.deliveries.push(delivery)
    const where = spaceOf(view, delivery.space_id).name
    const title = target && delivery.status === 'blocked' ? `${label} at ${where}: can't reach ${spaceOf(view, target).name}` : `${label} delivered to ${where}`
    return { value: delivery, event: { ...event, title, payload: delivery } }
  })
}

export async function updateDelivery(siteId: string, deliveryId: string, changes: DeliveryChanges): Promise<Delivery> {
  const data = await loadMobileBuilding(siteId)
  const find = (record: LocalRecord) => {
    const found = record.state.deliveries.find((d) => d.id === deliveryId)
    if (!found) throw new Error(`Unknown delivery '${deliveryId}'.`)
    return found
  }
  if (changes.label !== undefined && !changes.label.trim()) throw new Error('Say what was delivered.')
  return commitChecked(siteId, async (snapshot) => {
    const current = find(snapshot), view = withRecord(data, snapshot), rooms = assetRooms(snapshot)
    const at = changes.space_id ? resolveSpace(view, changes.space_id, rooms) : current.space_id
    let target = changes.target_space_id === undefined ? current.target_space_id : changes.target_space_id ? resolveSpace(view, changes.target_space_id, rooms) : undefined
    if (target === at) target = undefined
    const dims = changes.dims_m ? validDims(changes.dims_m) : current.dims_m
    const recheck = at !== current.space_id || JSON.stringify(dims) !== JSON.stringify(current.dims_m) || target !== current.target_space_id
    return { view, at, target, dims, checked: recheck ? await checkDelivery(view, snapshot, dims, at, target, deliveryId) : null }
  }, (record, { view, target, dims, checked }) => {
    const current = find(record)
    const next: Delivery = structuredClone(current)
    if (changes.label !== undefined) next.label = changes.label.trim().slice(0, 120)
    if (changes.note !== undefined) {
      if (changes.note.trim()) next.note = changes.note.trim().slice(0, 2000)
      else delete next.note
    }
    if (checked) {
      Object.assign(next, checked, { dims_m: dims })
      if (JSON.stringify(dims) !== JSON.stringify(current.dims_m)) Object.assign(next, { tolerance_m: 0, measurement_source: 'manual' })
      if (target) next.target_space_id = target
      else delete next.target_space_id
    }
    if (JSON.stringify(next) === JSON.stringify(current)) return { value: current, event: [] }
    record.state.deliveries[record.state.deliveries.indexOf(current)] = next
    const where = spaceOf(view, next.space_id).name
    const title = next.space_id !== current.space_id ? `${next.label} moved to ${where}` : `${next.label} edited`
    return { value: next, event: makeEvent(record, 'delivery_updated', title, { delivery_id: deliveryId, space_id: next.space_id, before: current, after: next }) }
  })
}

export async function deleteDelivery(siteId: string, deliveryId: string): Promise<Delivery> {
  const data = await loadMobileBuilding(siteId)
  return mutateRecord(siteId, (record) => {
    const index = record.state.deliveries.findIndex((d) => d.id === deliveryId)
    if (index < 0) throw new Error(`Unknown delivery '${deliveryId}'.`)
    const [delivery] = record.state.deliveries.splice(index, 1)
    const where = data.building.spaces.find((s) => s.id === delivery.space_id)?.name
    return { value: delivery, event: makeEvent(record, 'delivery_removed', `${delivery.label} removed${where ? ` from ${where}` : ''}`, { delivery_id: deliveryId, space_id: delivery.space_id, delivery }) }
  })
}
