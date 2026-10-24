// Dev-only mock of the FastAPI server (docs/CONTRACT.md). It patches window.fetch for /api/* when
// the page is opened with ?mock=1, or automatically when GET /api/sites fails (server not running).
// Buildings are read straight from ../data/dev through Vite (dev server only).
import type { BookableRoom, Booking, Building, Delivery, Site, SiteEvent, SiteState } from '../lib/types'
import { hashString, indexBuilding, polygonArea } from '../twin/geom'
import { mockReachable, mockRoute } from './mockRouter'

type Loader = () => Promise<Building>
// Dev only (tree-shaken from production builds): building.json files as lazily imported JSON modules.
const buildingUrls: Record<string, Loader> = import.meta.env.DEV
  ? (import.meta.glob('../../../data/dev/*/building.json', { import: 'default' }) as Record<string, Loader>)
  : {}

const SITE_SEEDS: [id: string, name: string | null, lat: number, lon: number, kind: Site['kind']][] = [
  ['proc-factory-dev-003', null, 48.1872, 11.6015, 'factory'],
  ['proc-factory-dev-004', null, 48.1948, 11.4612, 'factory'],
  ['proc-factory-dev-005', null, 48.0912, 11.6493, 'factory'],
  ['proc-factory-dev-007', null, 48.2392, 11.6402, 'factory'],
  ['proc-factory-dev-008', null, 48.1104, 11.5072, 'factory'],
  ['proc-factory-dev-010', null, 48.1785, 11.5203, 'factory'],
  ['proc-factory-dev-011', null, 48.1329, 11.6862, 'factory'],
  ['proc-factory-dev-012', null, 48.2121, 11.6851, 'factory'],
  ['proc-campus-dev-000', null, 48.2648, 11.6712, 'campus'],
  ['proc-campus-dev-009', null, 48.1508, 11.5806, 'campus'],
  ['proc-campus-dev-001', null, 48.1488, 11.5671, 'campus'],
  ['osm-way22744230', null, 48.1497, 11.5683, 'campus'],
  ['osm-way27917482', null, 48.2625, 11.6683, 'campus'],
  ['osm-way27326387', null, 48.2659, 11.6709, 'campus'],
  ['osm-way360544293', null, 48.3535, 11.7861, 'airport'],
  ['swiss-1689', null, 48.1361, 11.5442, 'office'],
  ['swiss-5097', null, 48.1597, 11.5492, 'office'],
  ['resplan-1465', null, 48.1209, 11.5934, 'other'],
]

const buildings = new Map<string, Promise<Building>>()
async function loadBuilding(id: string): Promise<Building> {
  if (!buildings.has(id)) {
    const loader = buildingUrls[`../../../data/dev/${id}/building.json`]
    if (!loader) throw new MockError(404, `unknown site ${id}`)
    buildings.set(id, loader())
  }
  return buildings.get(id)!
}

class MockError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

let sitesCache: Site[] | null = null
async function sites(): Promise<Site[]> {
  if (sitesCache) return sitesCache
  sitesCache = await Promise.all(
    SITE_SEEDS.filter(([id]) => buildingUrls[`../../../data/dev/${id}/building.json`]).map(async ([id, name, lat, lon, kind]) => {
      const b = await loadBuilding(id)
      return {
        id, name: name ?? b.building.name, lat, lon, source: b.building.source, building_id: id,
        data_path: `dev/${id}`, floors: b.floors.length, demo_location: !id.startsWith('osm'), kind,
      } satisfies Site
    }),
  )
  return sitesCache
}

// ---- per-site mutable state ----
interface MockSite { closed: Set<string>; deliveries: Delivery[]; events: SiteEvent[]; bookings: Booking[] }
const siteStates = new Map<string, MockSite>()

function rand(seed: number) {
  let s = seed || 1
  return () => {
    s = (Math.imul(s ^ (s >>> 15), 2246822507) + 0x9e3779b9) >>> 0
    return (s % 100000) / 100000
  }
}

async function siteState(id: string): Promise<MockSite> {
  if (siteStates.has(id)) return siteStates.get(id)!
  const b = await loadBuilding(id)
  const r = rand(hashString(id))
  const now = Date.now()
  const big = b.spaces
    .filter((s) => ['hall', 'room'].includes(s.type))
    .sort((a, c) => Math.abs(polygonArea(c.polygon)) - Math.abs(polygonArea(a.polygon)))
  const events: SiteEvent[] = []
  const deliveries: Delivery[] = []
  const labels = ['Pallet with steel drums', 'CNC spindle crate', 'Server rack (42U)', 'Coil of copper wire', 'Spare parts pallet', 'Robot arm crate']
  for (let i = 0; i < 4 && big.length; i++) {
    const space = big[Math.floor(r() * Math.min(big.length, 8))]
    const anchor = indexBuilding(b).anchors.get(space.id)!
    const ts = new Date(now - (i * 38 + r() * 20) * 3600_000).toISOString()
    const dims = { w: +(0.8 + r() * 0.6).toFixed(2), d: +(0.8 + r() * 0.4).toFixed(2), h: +(0.6 + r() * 1).toFixed(2) }
    const blocked = i === 1
    const d: Delivery = {
      id: `dlv-${id}-${i}`, site_id: id, ts, label: labels[i % labels.length], dims_m: dims, tolerance_m: 0.03,
      declared_dims_m: { w: Math.round(dims.w * 10) / 10, d: Math.round(dims.d * 10) / 10, h: Math.round(dims.h * 10) / 10 },
      floor_id: space.floor_id, space_id: space.id, position: [anchor[0] + (r() - 0.5) * 2, anchor[1] + (r() - 0.5) * 2],
      rotation_deg: Math.round(r() * 90), status: blocked ? 'blocked' : 'ok',
      check: {
        declared: { ok: true, deviation_m: { w: 0.02, d: 0.01, h: 0.03 } },
        route_fit: { ok: !blocked, blocking_openings: blocked ? b.openings.filter((o) => o.floor_id === space.floor_id).slice(0, 1).map((o) => ({ id: o.id, width_m: o.width_m, position: o.position, floor_id: o.floor_id })) : [] },
        floor_fit: { ok: true, reason: 'fits' },
        summary: blocked ? `Won't pass the door on the way to ${space.name}.` : `Matches PO, fits in ${space.name}.`,
      },
    }
    deliveries.push(d)
    events.push({ id: `ev-d-${d.id}`, ts, site_id: id, type: 'delivery', title: `${d.label} delivered to ${space.name}`, payload: d })
  }
  const lift = b.vertical_connectors.find((c) => c.kind === 'lift')
  if (lift) {
    const ts = new Date(now - 30 * 3600_000).toISOString()
    events.push({ id: `ev-c-${lift.id}`, ts, site_id: id, type: 'closure', title: `${lift.name} closed for maintenance`, payload: { element_id: lift.id, closed: true } })
    events.push({ id: `ev-r-${lift.id}`, ts: new Date(now - 26 * 3600_000).toISOString(), site_id: id, type: 'closure', title: `${lift.name} reopened`, payload: { element_id: lift.id, closed: false } })
  }
  const machine = b.assets.find((a) => a.category === 'machine') ?? b.assets[0]
  if (machine) {
    const ts = new Date(now - 72 * 3600_000).toISOString()
    events.push({ id: `ev-m-${machine.id}`, ts, site_id: id, type: 'asset_moved', title: `${machine.name} moved`, payload: { asset_id: machine.id, space_id: machine.space_id } })
  }
  const meeting = b.spaces.find((s) => s.room_type === 'meeting_room' || s.room_type === 'seminar_room')
  if (meeting) {
    const ts = new Date(now - 5 * 3600_000).toISOString()
    events.push({ id: `ev-b-${meeting.id}`, ts, site_id: id, type: 'booking', title: `${meeting.name} booked for Team sync`, payload: { space_id: meeting.id } })
  }
  events.sort((a, c) => c.ts.localeCompare(a.ts))
  const st: MockSite = { closed: new Set(), deliveries, events, bookings: [] }
  siteStates.set(id, st)
  return st
}

const stateOf = (st: MockSite): SiteState => ({ closed: [...st.closed], asset_overrides: {}, deliveries: st.deliveries, added_openings: [] })

const BOOKABLE = new Set(['meeting_room', 'seminar_room', 'lecture_hall', 'office', 'library', 'lab', 'canteen', 'living_room', 'generic_room'])

async function handle(method: string, url: URL, body: unknown): Promise<unknown> {
  const p = url.pathname
  let m: RegExpMatchArray | null
  if (p === '/api/sites' && method === 'GET') return sites()
  if ((m = p.match(/^\/api\/sites\/([^/]+)\/(.+)$/))) {
    const [, id, rest] = m
    const st = await siteState(id)
    const b = await loadBuilding(id)
    if (rest === 'building') return b
    if (rest === 'state') return stateOf(st)
    if (rest === 'events') return st.events
    if (rest === 'route') return mockRoute(b, body as never, st.closed)
    if (rest === 'reachable') {
      const width = Number(url.searchParams.get('min_width_m'))
      return mockReachable(b, { from: url.searchParams.get('from') ?? '', step_free: url.searchParams.get('step_free') === 'true', min_width_m: width > 0 ? width : undefined }, st.closed)
    }
    if (rest === 'closures') {
      const { element_id, closed } = body as { element_id: string; closed: boolean }
      if (closed) st.closed.add(element_id)
      else st.closed.delete(element_id)
      const name = indexBuilding(b).connectors.get(element_id)?.name ?? element_id
      st.events.unshift({ id: `ev-${Date.now()}`, ts: new Date().toISOString(), site_id: id, type: 'closure', title: `${name} ${closed ? 'closed' : 'reopened'}`, payload: { element_id, closed } })
      return stateOf(st)
    }
    if (rest === 'rooms/bookable') {
      const start = url.searchParams.get('start') ?? ''
      const end = url.searchParams.get('end') ?? ''
      const people = Number(url.searchParams.get('people') ?? 1)
      const idx = indexBuilding(b)
      const chairs = new Map<string, number>()
      for (const a of b.assets) if (a.type.includes('chair')) chairs.set(a.space_id, (chairs.get(a.space_id) ?? 0) + 1)
      const rooms: BookableRoom[] = b.spaces
        .filter((s) => BOOKABLE.has(s.room_type ?? ''))
        .map((s) => {
          const area = idx.areas.get(s.id)!
          const capacity = chairs.get(s.id) ?? Math.floor(area / 2.5)
          const bookings = st.bookings.filter((k) => k.space_id === s.id && k.start < end && k.end > start)
          const busy = bookings.length > 0 || hashString(s.id + start) % 4 === 0
          return { space_id: s.id, name: s.name, floor_id: s.floor_id, level: idx.floors.get(s.floor_id)!.level, capacity, area_m2: Math.round(area * 10) / 10, free: !busy, bookings }
        })
        .filter((r) => r.capacity >= people)
        .sort((a, c) => Number(c.free) - Number(a.free) || a.capacity - c.capacity)
        .slice(0, 30)
      return rooms
    }
    if (rest === 'bookings') {
      if (method === 'GET') return st.bookings
      const bk = { ...(body as Booking), id: `bk-${Date.now()}`, site_id: id }
      st.bookings.push(bk)
      st.events.unshift({ id: `ev-${bk.id}`, ts: new Date().toISOString(), site_id: id, type: 'booking', title: `${indexBuilding(b).spaces.get(bk.space_id)?.name} booked: ${bk.title}`, payload: bk })
      return bk
    }
  }
  throw new MockError(404, `mock: no handler for ${method} ${p}`)
}

function mockChat(siteId: string, message: string): Response {
  const enc = new TextEncoder()
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
      const b = await loadBuilding(siteId)
      const st = await siteState(siteId)
      const target = message.match(/(?:to|zu|nach)\s+(.+?)[?.!]*$/i)?.[1]
      let reply = `(mock) I heard: "${message}".`
      if (target) {
        try {
          const entrance = b.openings.find((o) => o.space_ids.includes('outside'))
          const from = entrance?.space_ids.find((s) => s !== 'outside') ?? b.spaces[0].id
          const route = mockRoute(b, { from, to: target, step_free: /stairs|stufen|step/i.test(message) }, st.closed)
          send('action', { type: 'understood', chips: [`to: ${target}`, ...(route.step_free ? ['step-free'] : [])] })
          send('action', { type: 'show_route', route })
          reply = `Route to ${target}: ${route.length_m} m.`
        } catch (e) {
          reply = String(e)
        }
      }
      for (const word of reply.split(' ')) {
        send('delta', { text: word + ' ' })
        await new Promise((r) => setTimeout(r, 25))
      }
      send('done', { reply })
      controller.close()
    },
  })
  return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } })
}

// ---- fetch patch ----
const fetchReal: typeof fetch = window.fetch.bind(window)
const params = new URLSearchParams(location.search)
if (params.has('mock')) sessionStorage.setItem('sitetwin-mock', params.get('mock') === '0' ? '0' : '1')
let active = import.meta.env.DEV && sessionStorage.getItem('sitetwin-mock') === '1'
const subscribers = new Set<(v: boolean) => void>()

export const isMockActive = () => active
export function onMockChange(fn: (v: boolean) => void) {
  subscribers.add(fn)
  return () => void subscribers.delete(fn)
}
function activate() {
  if (active) return
  active = true
  console.warn('[SiteTwin] API unreachable, using the dev mock (data/dev).')
  subscribers.forEach((fn) => fn(true))
}

async function mockResponse(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.origin)
  const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
  let body: unknown
  if (typeof init?.body === 'string') body = JSON.parse(init.body)
  const chat = url.pathname.match(/^\/api\/sites\/([^/]+)\/chat$/)
  if (chat) return mockChat(chat[1], (body as { message: string }).message)
  try {
    const result = await handle(method, url, body)
    return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } })
  } catch (e) {
    const status = e instanceof MockError ? e.status : 400
    return new Response(JSON.stringify({ detail: String((e as Error).message) }), { status, headers: { 'Content-Type': 'application/json' } })
  }
}

if (import.meta.env.DEV) {
  window.fetch = async (input, init) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const url = new URL(raw, location.origin)
    if (url.origin !== location.origin || !url.pathname.startsWith('/api/') || url.pathname.startsWith('/api/capture') || url.pathname.startsWith('/api/voice')) {
      return fetchReal(input, init)
    }
    if (active) return mockResponse(input, init)
    // "Server down" = network error or a proxy 5xx without a JSON body (real FastAPI errors are JSON).
    let down = false
    let response: Response | undefined
    try {
      response = await fetchReal(input, init)
      down = response.status >= 500 && !(response.headers.get('content-type') ?? '').includes('json')
    } catch {
      down = true
    }
    if (down) {
      activate()
      return mockResponse(input, init)
    }
    return response!
  }
}
