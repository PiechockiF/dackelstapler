// Delivery flows between sites: arc geometry + data from recent delivery events (or synthetic).
import { api } from '../lib/api'
import type { Site } from '../lib/types'
import { hashString } from '../twin/geom'

export interface Flow {
  id: string
  from: Site
  to: Site
  color: [number, number, number]
  /** phase offset 0..1 so comets don't move in lockstep */
  phase: number
  path: [number, number, number][]
  label?: string
}

const toRad = (d: number) => (d * Math.PI) / 180

function distanceM(a: Site, b: Site) {
  const R = 6371000
  const dLat = toRad(b.lat - a.lat)
  const dLon = toRad(b.lon - a.lon)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}

export function arcPath(a: Site, b: Site, n = 64): [number, number, number][] {
  const d = distanceM(a, b)
  const h = Math.min(6000, d * 0.12)
  const out: [number, number, number][] = []
  for (let i = 0; i <= n; i++) {
    const t = i / n
    out.push([a.lon + (b.lon - a.lon) * t, a.lat + (b.lat - a.lat) * t, Math.sin(Math.PI * t) * h + 20])
  }
  return out
}

const FLOW_COLORS: [number, number, number][] = [
  [56, 189, 248],
  [167, 139, 250],
  [251, 191, 36],
  [52, 211, 153],
]

function hub(sites: Site[]): Site {
  return sites.find((s) => s.kind === 'airport') ?? sites.find((s) => s.kind === 'factory') ?? sites[0]
}

export function syntheticFlows(sites: Site[]): Flow[] {
  if (sites.length < 2) return []
  const h = hub(sites)
  const flows: Flow[] = []
  const pool = sites.slice(0, 24)
  pool.forEach((s, i) => {
    if (s.id === h.id) return
    const k = hashString(s.id)
    const other = k % 3 === 0 ? h : pool[(k >>> 3) % pool.length]
    if (other.id === s.id) return
    const [from, to] = k % 2 ? [other, s] : [s, other]
    flows.push({ id: `syn-${i}`, from, to, color: FLOW_COLORS[k % FLOW_COLORS.length], phase: (k % 1000) / 1000, path: arcPath(from, to) })
  })
  return flows
}

/** Delivery events of the last 7 days become flows from a supplier hub (or a sister site) to the site. */
export async function eventFlows(sites: Site[]): Promise<Flow[]> {
  if (sites.length < 2) return []
  const since = new Date(Date.now() - 7 * 86400_000).toISOString()
  const h = hub(sites)
  const sample = sites.slice(0, 16)
  const results = await Promise.allSettled(sample.map((s) => api.events(s.id, since, 20)))
  const flows: Flow[] = []
  results.forEach((r, i) => {
    if (r.status !== 'fulfilled') return
    const site = sample[i]
    for (const e of r.value.filter((x) => x.type === 'delivery').slice(0, 3)) {
      const k = hashString(e.id)
      let from = k % 2 === 0 ? h : sites[k % sites.length]
      if (from.id === site.id) from = sites[(k + 1) % sites.length]
      if (from.id === site.id) continue
      flows.push({
        id: e.id, from, to: site, color: FLOW_COLORS[k % FLOW_COLORS.length], phase: (k % 997) / 997,
        path: arcPath(from, site), label: e.title,
      })
    }
  })
  return flows
}
