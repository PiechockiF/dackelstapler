import type {
  Asset, BookableRoom, Booking, Building, CaptureJob, ChatAction, Delivery, Dims, EquipmentType, GeoResult, Reachable,
  Route, Site, SiteDraft, SiteEvent, SiteState,
} from './types'
import { isLocalMode } from './mode'
import { localProvider } from '../local/provider'
import type { RestitchRequest, SiteTwinDataProvider } from './provider'

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init)
  if (!response.ok) {
    const body = await response.json().catch(() => ({}))
    throw new Error(body.detail ?? `${response.status} ${response.statusText}`)
  }
  return response.json() as Promise<T>
}

const json = (body: unknown, method = 'POST'): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})

const remoteApi: SiteTwinDataProvider = {
  sites: () => request<Site[]>('/api/sites'),
  previewSite: (form: FormData) => {
    form.set('preview', 'true')
    return request<SiteDraft>('/api/sites', { method: 'POST', body: form })
  },
  restitchSite: (body: RestitchRequest) => request<SiteDraft>('/api/sites/restitch', json(body)),
  createSite: (form: FormData) => request<Site>('/api/sites', { method: 'POST', body: form }),
  geocode: (q: string, near?: { lat: number; lon: number }) =>
    request<GeoResult[]>(`/api/geocode?q=${encodeURIComponent(q)}${near ? `&lat=${near.lat}&lon=${near.lon}` : ''}`),
  reverseGeocode: (lat: number, lon: number) => request<GeoResult>(`/api/geocode/reverse?lat=${lat}&lon=${lon}`),
  building: (siteId: string) => request<Building>(`/api/sites/${siteId}/building`),
  state: (siteId: string) => request<SiteState>(`/api/sites/${siteId}/state`),
  route: (siteId: string, body: { from: string; to: string; step_free?: boolean; min_width_m?: number; via?: string[] }) =>
    request<Route>(`/api/sites/${siteId}/route`, json(body)),
  reachable: (siteId: string, from: string, opts: { step_free?: boolean; min_width_m?: number } = {}) => {
    const query = new URLSearchParams({ from })
    if (opts.step_free) query.set('step_free', 'true')
    if (opts.min_width_m) query.set('min_width_m', String(opts.min_width_m))
    return request<Reachable>(`/api/sites/${siteId}/reachable?${query}`)
  },
  setClosed: (siteId: string, element_id: string, closed: boolean) =>
    request<SiteState>(`/api/sites/${siteId}/closures`, json({ element_id, closed })),
  moveAsset: (siteId: string, assetId: string, space_id: string, position?: [number, number]) =>
    request<SiteState>(`/api/sites/${siteId}/assets/${assetId}/move`, json({ space_id, position })),
  equipmentTypes: () => request<EquipmentType[]>('/api/equipment-types'),
  addAsset: (siteId: string, body: { type: string; space_id: string; name?: string; width_m?: number; depth_m?: number }) =>
    request<Asset>(`/api/sites/${siteId}/assets`, json(body)),
  updateAsset: (siteId: string, assetId: string, body: { type?: string; space_id?: string; name?: string; width_m?: number; depth_m?: number }) =>
    request<Asset>(`/api/sites/${siteId}/assets/${assetId}`, json(body, 'PATCH')),
  deleteAsset: (siteId: string, assetId: string) =>
    request<{ ok: boolean }>(`/api/sites/${siteId}/assets/${assetId}`, { method: 'DELETE' }),
  logDelivery: (siteId: string, body: { label: string; space_id: string; dims_m?: Dims; target_space_id?: string; note?: string }) =>
    request<Delivery>(`/api/sites/${siteId}/deliveries`, json(body)),
  /** target_space_id: null clears the destination; leave it out to keep it. */
  updateDelivery: (siteId: string, deliveryId: string, body: { label?: string; space_id?: string; dims_m?: Dims; target_space_id?: string | null; note?: string }) =>
    request<Delivery>(`/api/sites/${siteId}/deliveries/${deliveryId}`, json(body, 'PATCH')),
  deleteDelivery: (siteId: string, deliveryId: string) =>
    request<{ ok: boolean }>(`/api/sites/${siteId}/deliveries/${deliveryId}`, { method: 'DELETE' }),
  events: (siteId: string, since?: string, limit = 200) =>
    request<SiteEvent[]>(`/api/sites/${siteId}/events?limit=${limit}${since ? `&since=${encodeURIComponent(since)}` : ''}`),
  bookableRooms: (siteId: string, start: string, end: string, people = 1, near?: string | null) =>
    request<BookableRoom[]>(`/api/sites/${siteId}/rooms/bookable?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}&people=${people}${near ? `&near=${encodeURIComponent(near)}` : ''}`),
  bookings: (siteId: string) => request<Booking[]>(`/api/sites/${siteId}/bookings`),
  book: (siteId: string, body: Omit<Booking, 'id' | 'site_id'>) => request<Booking>(`/api/sites/${siteId}/bookings`, json(body)),
  captureDelivery: (form: FormData) => request<CaptureJob>('/api/capture/delivery', { method: 'POST', body: form }),
  captureRoom: (form: FormData) => request<CaptureJob>('/api/capture/room', { method: 'POST', body: form }),
  captureJob: (jobId: string) => request<CaptureJob>(`/api/capture/jobs/${jobId}`),
  roomScans: (id: string) => request<import('./types').RoomScan[]>(`/api/capture/rooms?site_id=${encodeURIComponent(id)}`),
  health: () => request<{ ok?: boolean; voice?: boolean; llm?: boolean }>('/api/health'),
  captureHost: () => request<{ lan_ip: string | null }>('/api/capture/host'),
}
export const api: SiteTwinDataProvider = isLocalMode ? localProvider : remoteApi

/** POST /api/sites/{id}/chat and parse the SSE stream. */
export async function streamChat(
  siteId: string,
  sessionId: string,
  message: string,
  handlers: { onDelta?: (text: string) => void; onAction?: (action: ChatAction) => void; onDone?: (reply: string) => void },
  here?: string | null,
): Promise<void> {
  const response = await fetch(`/api/sites/${siteId}/chat`, json({ session_id: sessionId, message, here }))
  if (!response.ok || !response.body) throw new Error(`chat failed: ${response.status}`)
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let boundary: number
    while ((boundary = buffer.indexOf('\n\n')) >= 0) {
      const chunk = buffer.slice(0, boundary)
      buffer = buffer.slice(boundary + 2)
      const event = /^event: (.*)$/m.exec(chunk)?.[1]
      const data = /^data: (.*)$/m.exec(chunk)?.[1]
      if (!event || data === undefined) continue
      const payload = JSON.parse(data)
      if (event === 'delta') handlers.onDelta?.(payload.text)
      else if (event === 'action') handlers.onAction?.(payload)
      else if (event === 'done') handlers.onDone?.(payload.reply)
    }
  }
}
