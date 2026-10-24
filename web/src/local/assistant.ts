import type { ChatAction } from '../lib/types'
import { loadMobileBuilding } from './catalog'
import { withRecord } from './edits'
import { localProvider } from './provider'
import { resolveSpace } from './router'

const when = (d: Date | string) => new Date(d).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })
const time = (d: Date) => d.toLocaleTimeString([], { timeStyle: 'short' })
import { readRecord } from './storage'

export interface CommandReply { text: string; actions: ChatAction[] }
const help = 'I work locally with building data. Try “route to <room>”, “area of <room>”, “capacity of <room>”, “find <asset>”, “close <door/lift ID or name>”, “reopen <ID or name>”, “free rooms for 6”, “book <room> at 14:00 for 60 minutes”, “move <asset> to <room>”, “add <equipment> to <room>”, “remove <asset>”, “delivery <what> at <room>”, or “what changed?”. For general AI conversation, voice, and reconstruction use the online app.'
export async function runLocalCommand(siteId: string, message: string, origin: string | null, previousTarget?: string): Promise<CommandReply> {
  const data = withRecord(await loadMobileBuilding(siteId), await readRecord(siteId)), b = data.building
  const text = message.trim().replace(/[?!]+$/, ''), actions: ChatAction[] = []
  const reply = (text: string): CommandReply => ({ text, actions })
  const state = await localProvider.state(siteId)
  const assetRooms = Object.fromEntries(Object.entries(state.asset_overrides).map(([id, value]) => [id, value.space_id]))
  let match: RegExpMatchArray | null
  if (/^(help|hello|hi)$/i.test(text)) return reply(help)
  if (/what changed|recent changes|latest changes/i.test(text)) {
    const events = await localProvider.events(siteId)
    return reply(events.length ? events.slice(0, 8).map((e) => `${when(e.ts)}: ${e.title}`).join('\n') : 'No changes have been saved on this phone yet.')
  }
  if ((match = text.match(/^(?:area|capacity) (?:of )?(.+)$/i))) {
    const id = resolveSpace(data, match[1], assetRooms), room = b.spaces.find((s) => s.id === id)!
    actions.push({ type: 'highlight', ids: [id], label: room.name }, { type: 'focus_floor', floor_id: room.floor_id })
    return reply(/^area/i.test(text) ? `${room.name}: ${data.areas[id].toFixed(2)} m².` : `${room.name}: capacity ${data.capacities[id]} (from seating data, otherwise floor area / 2.5 m²).`)
  }
  if ((match = text.match(/^(?:close|reopen|open)\s+(.+)$/i))) {
    const name = match[1].trim().toLowerCase()
    const elements = [...b.spaces, ...b.openings, ...b.vertical_connectors].filter((e) => e.id.toLowerCase() === name || ('name' in e && e.name.toLowerCase() === name))
    if (elements.length !== 1) return reply('Use an exact room, door or lift ID/name. You can tap it in the viewer to see its details.')
    const closed = /^close/i.test(text)
    await localProvider.setClosed(siteId, elements[0].id, closed)
    actions.push({ type: 'state_changed' })
    return reply(`${'name' in elements[0] ? elements[0].name : elements[0].id} ${closed ? 'closed' : 'reopened'}. Saved on this phone.`)
  }
  if ((match = text.match(/^move (.+?) to (.+)$/i))) {
    const name = match[1].trim().toLowerCase()
    const assets = b.assets.filter((a) => a.id.toLowerCase() === name || a.name.toLowerCase() === name)
    if (assets.length !== 1) return reply('Use an exact, unique asset name or ID.')
    const room = resolveSpace(data, match[2], assetRooms)
    await localProvider.moveAsset(siteId, assets[0].id, room)
    actions.push({ type: 'state_changed' }, { type: 'highlight', ids: [assets[0].id], label: assets[0].name })
    return reply(`${assets[0].name} moved to ${b.spaces.find((s) => s.id === room)!.name}. Saved on this phone.`)
  }
  if ((match = text.match(/^add (?:an? )?(.+?) (?:to|in|into) (.+)$/i))) {
    const room = resolveSpace(data, match[2], assetRooms)
    const asset = await localProvider.addAsset(siteId, { type: match[1], space_id: room })
    actions.push({ type: 'state_changed' }, { type: 'highlight', ids: [asset.id], label: asset.name }, { type: 'focus_floor', floor_id: asset.floor_id })
    return reply(`${asset.name} added to ${b.spaces.find((s) => s.id === room)!.name}. Saved on this phone.`)
  }
  if ((match = text.match(/^(?:remove|delete) (.+)$/i))) {
    const name = match[1].trim().toLowerCase()
    const assets = b.assets.filter((a) => a.id.toLowerCase() === name || a.name.toLowerCase() === name)
    if (assets.length !== 1) return reply('Use an exact, unique asset name or ID.')
    await localProvider.deleteAsset(siteId, assets[0].id)
    actions.push({ type: 'state_changed' })
    return reply(`${assets[0].name} removed. Saved on this phone.`)
  }
  if ((match = text.match(/^(?:log )?delivery (?:of )?(.+?) (?:at|in|arrived at|arrived in) (.+)$/i))) {
    const delivery = await localProvider.logDelivery(siteId, { label: match[1], space_id: resolveSpace(data, match[2], assetRooms) })
    actions.push({ type: 'state_changed' }, { type: 'highlight', ids: [delivery.id], label: delivery.label }, { type: 'focus_floor', floor_id: delivery.floor_id })
    return reply(`${delivery.check.summary} Saved on this phone.`)
  }
  if ((match = text.match(/^book (.+?) at (\d{1,2}:\d{2}) for (\d+) (?:minutes?|mins?)$/i))) {
    const start = parseClock(match[2]), minutes = Number(match[3])
    if (minutes <= 0 || minutes > 1440) return reply('Choose a booking duration between 1 and 1440 minutes.')
    const id = resolveSpace(data, match[1], assetRooms)
    const booking = await localProvider.book(siteId, { space_id: id, start: start.toISOString(), end: new Date(start.getTime() + minutes * 60_000).toISOString(), who: 'Local user', title: 'Local meeting' })
    actions.push({ type: 'state_changed' }, { type: 'highlight', ids: [id], label: 'Booked on this phone' })
    return reply(`Booked ${b.spaces.find((s) => s.id === id)!.name}, ${when(booking.start)} for ${minutes} minutes. This booking is only on this device.`)
  }
  if ((match = text.match(/^(?:find )?free rooms?(?: for (\d+)(?: people)?)?(?: at (\d{1,2}:\d{2}))?$/i))) {
    const start = match[2] ? parseClock(match[2]) : new Date(), end = new Date(start.getTime() + 60 * 60_000)
    const rooms = (await localProvider.bookableRooms(siteId, start.toISOString(), end.toISOString(), Number(match[1] ?? 1))).filter((r) => r.free)
    actions.push({ type: 'highlight', ids: rooms.slice(0, 12).map((r) => r.space_id), label: 'Free on this device' })
    return reply(`Local availability ${when(start)}–${time(end)}:\n${rooms.slice(0, 8).map((r) => `${r.name} — ${r.capacity} people, ${r.area_m2.toFixed(1)} m²`).join('\n') || 'No matching free rooms.'}`)
  }
  if (/^(route|take me|navigate|how do i get)/i.test(text)) {
    const stepFree = /without stairs|step[- ]free|no stairs/i.test(text)
    const width = text.match(/(?:width|min width)\s+(\d+(?:\.\d+)?)\s*m?/i)?.[1]
    const cleaned = text.replace(/\s*(?:without stairs|step[- ]free|no stairs|(?:min )?width\s+\d+(?:\.\d+)?\s*m?)/gi, '').trim()
    const explicit = cleaned.match(/^(?:route|navigate|take me) from (.+?) to (.+)$/i)
    const target = explicit?.[2] ?? cleaned.match(/^(?:route|take me|navigate|how do i get) (?:to )?(.+)$/i)?.[1]
    const to = target?.toLowerCase() === 'there' ? previousTarget : target
    if (!to || !origin && !explicit) return reply('Choose a start point in the viewer and give an exact destination room or asset.')
    const route = await localProvider.route(siteId, { from: explicit?.[1] ?? origin!, to, step_free: stepFree, min_width_m: width ? Number(width) : undefined })
    actions.push({ type: 'show_route', route }, { type: 'understood', chips: [stepFree ? 'step-free' : 'standard route', ...(width ? [`width ${width} m`] : [])] })
    return reply(route.reachable ? `${route.length_m.toFixed(2)} m. ${route.steps.join(' ')}` : route.message ?? 'No route meets these constraints.')
  }
  if ((match = text.match(/^(?:find|where is|where's) (.+)$/i))) {
    const words = match[1].toLowerCase().split(/\s+/)
    const items = [...b.spaces, ...b.assets, ...state.deliveries.map((d) => ({ ...d, name: d.label }))].filter((item) => words.every((word) => `${item.id} ${item.name}`.toLowerCase().includes(word))).slice(0, 12)
    actions.push({ type: 'highlight', ids: items.map((i) => i.id), label: match[1] })
    return reply(items.map((i) => `${i.name} (${i.id})`).join('\n') || 'No matching room, asset or saved delivery.')
  }
  return reply(help)
}
function parseClock(clock: string): Date {
  const [h, m] = clock.split(':').map(Number)
  if (h > 23 || m > 59) throw new Error('Use a valid 24-hour time, e.g. 14:00.')
  const date = new Date(); date.setHours(h, m, 0, 0)
  return date
}
