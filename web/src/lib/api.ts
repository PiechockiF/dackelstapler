import type {
  BookableRoom, Booking, Building, CaptureJob, ChatAction, GeoResult, Route, Site, SiteDraft, SiteEvent, SiteState,
} from './types'

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init)
  if (!response.ok) {
    const body = await response.json().catch(() => ({}))
    throw new Error(body.detail ?? `${response.status} ${response.statusText}`)
  }
  return response.json() as Promise<T>
}

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})

export const api = {
  sites: () => request<Site[]>('/api/sites'),
  previewSite: (form: FormData) => {
    form.set('preview', 'true')
    return request<SiteDraft>('/api/sites', { method: 'POST', body: form })
  },
  restitchSite: (body: {
    extractions: unknown[]; matches?: Record<string, unknown> | null; level_overrides: Record<number, number>
    site_id?: string; name?: string; address?: string; lat?: number; lon?: number; width_m?: number
  }) => request<SiteDraft>('/api/sites/restitch', json(body)),
  createSite: (form: FormData) => request<Site>('/api/sites', { method: 'POST', body: form }),
  geocode: (q: string, near?: { lat: number; lon: number }) =>
    request<GeoResult[]>(`/api/geocode?q=${encodeURIComponent(q)}${near ? `&lat=${near.lat}&lon=${near.lon}` : ''}`),
  reverseGeocode: (lat: number, lon: number) => request<GeoResult>(`/api/geocode/reverse?lat=${lat}&lon=${lon}`),
  building: (siteId: string) => request<Building>(`/api/sites/${siteId}/building`),
  state: (siteId: string) => request<SiteState>(`/api/sites/${siteId}/state`),
  route: (siteId: string, body: { from: string; to: string; step_free?: boolean; min_width_m?: number; via?: string[] }) =>
    request<Route>(`/api/sites/${siteId}/route`, json(body)),
  setClosed: (siteId: string, element_id: string, closed: boolean) =>
    request<SiteState>(`/api/sites/${siteId}/closures`, json({ element_id, closed })),
  moveAsset: (siteId: string, assetId: string, space_id: string, position?: [number, number]) =>
    request<SiteState>(`/api/sites/${siteId}/assets/${assetId}/move`, json({ space_id, position })),
  events: (siteId: string, since?: string, limit = 200) =>
    request<SiteEvent[]>(`/api/sites/${siteId}/events?limit=${limit}${since ? `&since=${encodeURIComponent(since)}` : ''}`),
  bookableRooms: (siteId: string, start: string, end: string, people = 1) =>
    request<BookableRoom[]>(`/api/sites/${siteId}/rooms/bookable?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}&people=${people}`),
  bookings: (siteId: string) => request<Booking[]>(`/api/sites/${siteId}/bookings`),
  book: (siteId: string, body: Omit<Booking, 'id' | 'site_id'>) => request<Booking>(`/api/sites/${siteId}/bookings`, json(body)),
  captureDelivery: (form: FormData) => request<CaptureJob>('/api/capture/delivery', { method: 'POST', body: form }),
  captureRoom: (form: FormData) => request<CaptureJob>('/api/capture/room', { method: 'POST', body: form }),
  captureJob: (jobId: string) => request<CaptureJob>(`/api/capture/jobs/${jobId}`),
}

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
