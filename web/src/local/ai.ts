// The full AI assistant for the offline app: Claude, called straight from the phone with the user's own API
// key (stored on this device only), with tools that read and change the phone's local building data.
import Anthropic from '@anthropic-ai/sdk'
import type { ChatAction } from '../lib/types'
import { loadMobileBuilding } from './catalog'
import { withRecord } from './edits'
import { localProvider } from './provider'
import { resolveSpace } from './router'
import { readRecord } from './storage'
import { walkingRoute } from '../nav/pdr'

const KEY_STORE = 'dackel.anthropic.key'
const MODEL = 'claude-opus-5-5'

/** Team key built into the iOS app from the repo-root .env (see vite.config.ts); empty in other builds. */
declare const __DACKEL_ANTHROPIC_KEY__: string
const builtInKey = typeof __DACKEL_ANTHROPIC_KEY__ === 'string' ? __DACKEL_ANTHROPIC_KEY__ : ''

/** A key pasted on this phone wins over the built-in one. */
export const ownKey = () => globalThis.localStorage?.getItem(KEY_STORE)?.trim() || ''
export const hasBuiltInKey = () => !!builtInKey
export const aiKey = () => ownKey() || builtInKey
export function setAiKey(key: string) {
  if (key.trim()) globalThis.localStorage?.setItem(KEY_STORE, key.trim())
  else globalThis.localStorage?.removeItem(KEY_STORE)
  client = null
}

let client: Anthropic | null = null
function anthropic(): Anthropic {
  // The key never leaves this phone except to api.anthropic.com.
  client ??= new Anthropic({ apiKey: aiKey(), dangerouslyAllowBrowser: true, maxRetries: 2 })
  return client
}

/** Conversation per site, including tool calls and results (the API is stateless). Append-only: earlier
 *  turns are never edited (that would invalidate thinking blocks); a very long chat starts over instead. */
const histories = new Map<string, Anthropic.Beta.BetaMessageParam[]>()
const MAX_HISTORY = 80
const keep = (siteId: string, messages: Anthropic.Beta.BetaMessageParam[]) =>
  messages.length > MAX_HISTORY ? histories.delete(siteId) : histories.set(siteId, messages)
export const resetAiChat = (siteId: string) => histories.delete(siteId)

const str = { type: 'string' } as const
const num = { type: 'number' } as const
const bool = { type: 'boolean' } as const
const obj = (properties: Record<string, unknown>, required: string[] = []) =>
  ({ type: 'object' as const, properties, required, additionalProperties: false })

const TOOLS: Anthropic.Beta.BetaTool[] = [
  { name: 'search_places', description: 'Find rooms, equipment/assets and saved deliveries in this building by name, ref, type or id. Use it whenever a name is unclear before calling other tools.', input_schema: obj({ query: str }, ['query']) },
  { name: 'room_info', description: 'Area, capacity, floor and type of one room. Also highlights it in the 3D view.', input_schema: obj({ room: str }, ['room']) },
  { name: 'plan_route', description: "Walking route inside the building, shown in the 3D view. 'from' defaults to where the user is. Use step_free for wheelchairs/trolleys and min_width_m for loads (pallets, forklifts).", input_schema: obj({ to: str, from: str, step_free: bool, min_width_m: num }, ['to']) },
  { name: 'find_free_rooms', description: 'Bookable rooms free for a time window, biggest fit first. start is HH:MM today or an ISO time; default now. minutes default 60.', input_schema: obj({ people: num, start: str, minutes: num }, ['people']) },
  { name: 'book_room', description: 'Book a room on this phone. start is HH:MM today or an ISO time.', input_schema: obj({ room: str, start: str, minutes: num, title: str }, ['room', 'start', 'minutes']) },
  { name: 'set_closed', description: 'Close or reopen a room, door or stairs/lift (routes then avoid closed elements). Use the exact name or id from search_places.', input_schema: obj({ element: str, closed: bool }, ['element', 'closed']) },
  { name: 'move_asset', description: 'Move a piece of equipment to another room.', input_schema: obj({ asset: str, room: str }, ['asset', 'room']) },
  { name: 'add_equipment', description: 'Add a piece of equipment (e.g. "forklift", "pallet rack") to a room.', input_schema: obj({ type: str, room: str }, ['type', 'room']) },
  { name: 'remove_asset', description: 'Remove a piece of equipment.', input_schema: obj({ asset: str }, ['asset']) },
  { name: 'log_delivery', description: 'Record a delivery that arrived in a room. Sizes in metres (default Euro pallet 1.2 x 0.8 x 1.0). Checks whether it fits through the doors to destination if given.', input_schema: obj({ what: str, room: str, width_m: num, depth_m: num, height_m: num, destination: str }, ['what', 'room']) },
  { name: 'recent_changes', description: 'The latest changes saved on this phone (closures, bookings, moves, deliveries).', input_schema: obj({}) },
  { name: 'set_my_location', description: 'Remember which room the user is in (the default start for routes).', input_schema: obj({ room: str }, ['room']) },
]

function clock(value: string | undefined): Date {
  if (!value) return new Date()
  const m = value.match(/^(\d{1,2}):(\d{2})$/)
  if (m) {
    const d = new Date()
    d.setHours(Number(m[1]), Number(m[2]), 0, 0)
    return d
  }
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) throw new Error(`Not a time: ${value}`)
  return d
}

async function context(siteId: string) {
  const data = withRecord(await loadMobileBuilding(siteId), await readRecord(siteId))
  const state = await localProvider.state(siteId)
  const assetRooms = Object.fromEntries(Object.entries(state.asset_overrides).map(([id, v]) => [id, v.space_id]))
  return { data, b: data.building, state, space: (ref: string) => resolveSpace(data, ref, assetRooms) }
}

function uniqueByName<T extends { id: string; name: string }>(items: T[], ref: string): T {
  const q = ref.trim().toLowerCase()
  const exact = items.filter((i) => i.id.toLowerCase() === q || i.name.toLowerCase() === q)
  const hits = exact.length ? exact : items.filter((i) => i.name.toLowerCase().includes(q))
  if (hits.length !== 1) throw new Error(hits.length ? `"${ref}" matches ${hits.length} items: ${hits.slice(0, 6).map((h) => h.name).join(', ')}. Be more specific.` : `Nothing called "${ref}". Try search_places.`)
  return hits[0]
}

/** Runs one tool; returns text for Claude and pushes UI actions (route, highlights...). */
async function runTool(siteId: string, name: string, input: Record<string, unknown>, origin: string | null, actions: ChatAction[]): Promise<string> {
  const { data, b, state, space } = await context(siteId)
  const nameOf = (id: string) => b.spaces.find((s) => s.id === id)?.name ?? id
  const floorOf = (id: string) => b.floors.find((f) => f.id === id)?.name ?? id
  const s = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : undefined)
  const n = (k: string) => (typeof input[k] === 'number' ? (input[k] as number) : undefined)
  switch (name) {
    case 'search_places': {
      const words = (s('query') ?? '').toLowerCase().split(/\s+/).filter(Boolean)
      const pool = [
        ...b.spaces.map((x) => ({ id: x.id, name: x.name, kind: x.room_type ?? x.type, floor: x.floor_id })),
        ...b.assets.map((x) => ({ id: x.id, name: x.name, kind: `equipment in ${nameOf(state.asset_overrides[x.id]?.space_id ?? x.space_id)}`, floor: x.floor_id })),
        ...b.vertical_connectors.map((x) => ({ id: x.id, name: x.name, kind: x.kind, floor: x.floor_ids[0] })),
        ...state.deliveries.map((x) => ({ id: x.id, name: x.label, kind: `delivery in ${nameOf(x.space_id)}`, floor: x.floor_id })),
      ]
      const hits = pool.filter((p) => words.every((w) => `${p.id} ${p.name} ${p.kind}`.toLowerCase().includes(w))).slice(0, 25)
      if (hits.length) actions.push({ type: 'highlight', ids: hits.slice(0, 12).map((h) => h.id), label: s('query') })
      return hits.length ? hits.map((h) => `${h.name} (${h.kind}, ${floorOf(h.floor)}, id ${h.id})`).join('\n') : 'No matches.'
    }
    case 'room_info': {
      const id = space(s('room') ?? ''), room = b.spaces.find((x) => x.id === id)!
      actions.push({ type: 'highlight', ids: [id], label: room.name }, { type: 'focus_floor', floor_id: room.floor_id })
      const closed = state.closed.includes(id) ? ' Currently closed.' : ''
      return `${room.name}: ${(room.room_type ?? room.type).replace(/_/g, ' ')}, ${floorOf(room.floor_id)}, ${data.areas[id]?.toFixed(1)} m², capacity ${data.capacities[id] ?? 'unknown'}.${closed}`
    }
    case 'plan_route': {
      const from = s('from') ?? origin
      if (!from) return 'The user has not set where they are. Ask them, or pass from.'
      const route = await localProvider.route(siteId, { from, to: s('to') ?? '', step_free: input.step_free === true, min_width_m: n('min_width_m') })
      actions.push({ type: 'show_route', route })
      if (!route.reachable) return route.message ?? 'No route meets these constraints.'
      const metres = Math.round(walkingRoute(route, b).total)
      const floors = route.floors.map((f) => floorOf(f.floor_id)).join(' → ')
      return `Route shown on the map: about ${metres} m walking (${Math.max(1, Math.round(metres / 1.2 / 60))} min), floors ${floors}${route.step_free ? ', step-free' : ''}${route.min_width_m ? `, at least ${route.min_width_m} m wide` : ''}. ${route.steps.join(' ')}${route.blocking_openings?.length ? ` ${route.blocking_openings.length} door(s) too narrow on the direct way.` : ''}`
    }
    case 'find_free_rooms': {
      const start = clock(s('start')), end = new Date(start.getTime() + (n('minutes') ?? 60) * 60_000)
      const rooms = (await localProvider.bookableRooms(siteId, start.toISOString(), end.toISOString(), Math.max(1, n('people') ?? 1))).filter((r) => r.free)
      if (rooms.length) actions.push({ type: 'highlight', ids: rooms.slice(0, 12).map((r) => r.space_id), label: 'Free rooms' })
      return rooms.length ? rooms.slice(0, 10).map((r) => `${r.name}: ${r.capacity} people, ${r.area_m2.toFixed(0)} m²`).join('\n') : 'No free rooms for that time and size.'
    }
    case 'book_room': {
      const id = space(s('room') ?? ''), start = clock(s('start')), minutes = n('minutes') ?? 60
      if (minutes <= 0 || minutes > 1440) return 'Duration must be 1 to 1440 minutes.'
      const booking = await localProvider.book(siteId, { space_id: id, start: start.toISOString(), end: new Date(start.getTime() + minutes * 60_000).toISOString(), who: 'You', title: s('title') ?? 'Meeting' })
      actions.push({ type: 'state_changed' }, { type: 'highlight', ids: [id], label: 'Booked' })
      return `Booked ${nameOf(id)} from ${new Date(booking.start).toLocaleString()} for ${minutes} min (saved on this phone).`
    }
    case 'set_closed': {
      const el = uniqueByName([...b.spaces, ...b.vertical_connectors, ...b.openings.map((o) => ({ ...o, name: o.id }))], s('element') ?? '')
      const closed = input.closed === true
      await localProvider.setClosed(siteId, el.id, closed)
      actions.push({ type: 'state_changed' })
      return `${el.name} ${closed ? 'closed' : 'reopened'}.`
    }
    case 'move_asset': {
      const asset = uniqueByName(b.assets, s('asset') ?? ''), room = space(s('room') ?? '')
      await localProvider.moveAsset(siteId, asset.id, room)
      actions.push({ type: 'state_changed' }, { type: 'highlight', ids: [asset.id], label: asset.name })
      return `${asset.name} moved to ${nameOf(room)}.`
    }
    case 'add_equipment': {
      const room = space(s('room') ?? '')
      const asset = await localProvider.addAsset(siteId, { type: s('type') ?? 'equipment', space_id: room })
      actions.push({ type: 'state_changed' }, { type: 'highlight', ids: [asset.id], label: asset.name }, { type: 'focus_floor', floor_id: asset.floor_id })
      return `${asset.name} added to ${nameOf(room)}.`
    }
    case 'remove_asset': {
      const asset = uniqueByName(b.assets, s('asset') ?? '')
      await localProvider.deleteAsset(siteId, asset.id)
      actions.push({ type: 'state_changed' })
      return `${asset.name} removed.`
    }
    case 'log_delivery': {
      const dims = n('width_m') && n('depth_m') && n('height_m') ? { w: n('width_m')!, d: n('depth_m')!, h: n('height_m')! } : undefined
      const delivery = await localProvider.logDelivery(siteId, {
        label: s('what') ?? 'Delivery', space_id: space(s('room') ?? ''), ...(dims ? { dims_m: dims } : {}),
        ...(s('destination') ? { target_space_id: space(s('destination')!) } : {}),
      })
      actions.push({ type: 'state_changed' }, { type: 'highlight', ids: [delivery.id], label: delivery.label }, { type: 'focus_floor', floor_id: delivery.floor_id })
      return delivery.check.summary
    }
    case 'recent_changes': {
      const events = await localProvider.events(siteId)
      return events.length ? events.slice(0, 12).map((e) => `${new Date(e.ts).toLocaleString()}: ${e.title}`).join('\n') : 'No changes saved on this phone yet.'
    }
    case 'set_my_location': {
      const id = space(s('room') ?? '')
      actions.push({ type: 'set_location', space_id: id })
      return `Location set to ${nameOf(id)}.`
    }
  }
  return `Unknown tool ${name}.`
}

/** Stable per building (cache-friendly): what Claude knows up front. */
async function systemPrompt(siteId: string): Promise<string> {
  const { b, data } = await context(siteId)
  const rooms = b.spaces.filter((s) => s.type !== 'corridor').slice(0, 600)
  return [
    `You are the assistant in Dackel, an app for people working in industrial buildings: navigation, rooms, equipment, deliveries and forklift routes. You are talking to someone on their phone inside "${b.building.name}".`,
    'Use the tools to look things up and to act. Everything you change is saved on this phone only. When the user asks you to do something, do it with the tools rather than describing how.',
    'Answer in short, plain sentences that read well on a phone screen and when spoken aloud; no markdown tables or headings. Use room names exactly as the tools return them.',
    `Floors: ${b.floors.map((f) => `${f.name} (level ${f.level})`).join(', ')}.`,
    `Rooms (name: type, area m²): ${rooms.map((s) => `${s.name}: ${(s.room_type ?? s.type).replace(/_/g, ' ')}, ${Math.round(data.areas[s.id] ?? 0)}`).join('; ')}.`,
  ].join('\n')
}

export interface AiReply { text: string; actions: ChatAction[] }

export async function askClaude(siteId: string, message: string, origin: string | null): Promise<AiReply> {
  const { b } = await context(siteId)
  const history = histories.get(siteId) ?? []
  const where = origin ? b.spaces.find((s) => s.id === origin)?.name ?? origin : 'unknown'
  // Volatile facts go in the user turn so the system prompt stays cacheable.
  const messages: Anthropic.Beta.BetaMessageParam[] = [...history, { role: 'user', content: `${message}\n\n(Now: ${new Date().toLocaleString()}. User location: ${where}.)` }]
  const system = await systemPrompt(siteId)
  const actions: ChatAction[] = []
  for (let turn = 0; turn < 10; turn++) {
    const response = await anthropic().beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      // Short chat turns: low effort keeps replies quick on a phone.
      output_config: { effort: 'low' },
      // If a safety classifier declines, the API retries on a fallback model in the same call.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      cache_control: { type: 'ephemeral' },
      system,
      tools: TOOLS,
      messages,
    })
    messages.push({ role: 'assistant', content: response.content })
    if (response.stop_reason === 'refusal') {
      histories.set(siteId, history) // don't keep a refused exchange
      return { text: "I can't help with that one.", actions }
    }
    const uses = response.content.filter((c): c is Anthropic.Beta.BetaToolUseBlock => c.type === 'tool_use')
    if (response.stop_reason !== 'tool_use' || !uses.length) {
      keep(siteId, messages)
      const text = response.content.filter((c): c is Anthropic.Beta.BetaTextBlock => c.type === 'text').map((c) => c.text).join('\n').trim()
      return { text: text || (response.stop_reason === 'max_tokens' ? 'That answer got too long. Ask me something narrower.' : 'Done.'), actions }
    }
    // Run every requested tool and send all results back in one user message.
    const results: Anthropic.Beta.BetaToolResultBlockParam[] = []
    for (const use of uses) {
      try {
        results.push({ type: 'tool_result', tool_use_id: use.id, content: await runTool(siteId, use.name, (use.input ?? {}) as Record<string, unknown>, origin, actions) })
      } catch (e) {
        results.push({ type: 'tool_result', tool_use_id: use.id, content: (e as Error).message, is_error: true })
      }
    }
    messages.push({ role: 'user', content: results })
  }
  keep(siteId, messages)
  return { text: 'I took too many steps on that. Try asking in a simpler way.', actions }
}

/** Plain-language reason for an API failure, plus whether the offline commands should take over. */
export function aiError(e: unknown): { message: string; offline: boolean } {
  if (e instanceof Anthropic.AuthenticationError) return { message: 'The API key was rejected. Check it in assistant settings.', offline: false }
  if (e instanceof Anthropic.RateLimitError) return { message: 'Too many requests right now. Try again in a moment.', offline: false }
  if (e instanceof Anthropic.APIConnectionError) return { message: 'No connection to Claude, so I used the offline commands.', offline: true }
  if (e instanceof Anthropic.APIError) return { message: `Claude error ${e.status}: ${e.message}`, offline: false }
  return { message: (e as Error).message, offline: false }
}
