// Dev-only router mirroring the starter cost model (space anchors + door nodes, stairs 12 m/floor,
// lift 15 m + 6 m/floor). Used by the mock API until server/ is up.
import type { Building, Route, RouteFloorSegment, XY } from '../lib/types'
import { indexBuilding } from '../twin/geom'

const OUTSIDE = 'outside'

interface Edge { to: string; w: number; via: string }

export class MapError extends Error {}

export function resolveSpace(b: Building, ref: string): string {
  const idx = indexBuilding(b)
  if (idx.spaces.has(ref)) return ref
  const asset = idx.assets.get(ref)
  if (asset) return asset.space_id
  const conn = idx.connectors.get(ref)
  if (conn) return conn.space_ids[0]
  const low = ref.trim().toLowerCase()
  const exact = b.spaces.filter((s) => (s.ref ?? '').toLowerCase() === low || s.name.toLowerCase() === low)
  if (exact.length) return exact[0].id
  const assetExact = b.assets.find((a) => a.name.toLowerCase() === low)
  if (assetExact) return assetExact.space_id
  const words = low.split(/\s+/).filter(Boolean)
  const fuzzy = b.spaces.find((s) => words.every((w) => `${s.name} ${s.ref ?? ''} ${s.room_type ?? ''}`.toLowerCase().includes(w)))
  if (fuzzy) return fuzzy.id
  const fuzzyAsset = b.assets.find((a) => words.every((w) => `${a.name} ${a.type.replace(/_/g, ' ')}`.toLowerCase().includes(w)))
  if (fuzzyAsset) return fuzzyAsset.space_id
  throw new MapError(`No place matches '${ref}'`)
}

function buildGraph(b: Building, opts: { stepFree: boolean; minWidth: number | null; closed: Set<string> }) {
  const idx = indexBuilding(b)
  const g = new Map<string, Edge[]>()
  const add = (a: string, c: string, w: number, via: string) => {
    if (!g.has(a)) g.set(a, [])
    if (!g.has(c)) g.set(c, [])
    g.get(a)!.push({ to: c, w, via })
    g.get(c)!.push({ to: a, w, via })
  }
  for (const o of b.openings) {
    if (opts.closed.has(o.id) || (opts.stepFree && !o.step_free)) continue
    if (opts.minWidth != null && o.width_m + 1e-9 < opts.minWidth) continue
    const door = `door:${o.id}`
    for (const sid of o.space_ids) {
      if (sid === OUTSIDE) {
        if (opts.minWidth != null) add(OUTSIDE, door, 0, o.id) // pedestrians stay inside; only loads go round
      } else if (idx.anchors.has(sid) && !opts.closed.has(sid)) {
        const a = idx.anchors.get(sid)!
        add(sid, door, Math.hypot(a[0] - o.position[0], a[1] - o.position[1]), o.id)
      }
    }
  }
  const levels = new Map(b.floors.map((f) => [f.id, f.level]))
  for (const c of b.vertical_connectors) {
    if (opts.closed.has(c.id) || (opts.stepFree && !c.step_free)) continue
    if (opts.minWidth != null && c.kind === 'stairs') continue
    const stops = c.floor_ids.map((f, i) => [f, c.space_ids[i]] as const).sort((x, y) => levels.get(x[0])! - levels.get(y[0])!)
    for (let i = 0; i + 1 < stops.length; i++) {
      const span = Math.abs(levels.get(stops[i + 1][0])! - levels.get(stops[i][0])!)
      const cost = c.kind === 'lift' ? 15 + 6 * span : 12 * span
      add(stops[i][1], stops[i + 1][1], cost, c.id)
    }
  }
  return g
}

function dijkstra(g: Map<string, Edge[]>, from: string, to: string) {
  const dist = new Map<string, number>([[from, 0]])
  const prev = new Map<string, { node: string; via: string }>()
  const done = new Set<string>()
  // Small graphs: a sorted frontier array is plenty fast.
  const frontier: [number, string][] = [[0, from]]
  while (frontier.length) {
    let bi = 0
    for (let i = 1; i < frontier.length; i++) if (frontier[i][0] < frontier[bi][0]) bi = i
    const [d, node] = frontier.splice(bi, 1)[0]
    if (done.has(node)) continue
    done.add(node)
    if (node === to) break
    for (const e of g.get(node) ?? []) {
      const nd = d + e.w
      if (nd < (dist.get(e.to) ?? Infinity)) {
        dist.set(e.to, nd)
        prev.set(e.to, { node, via: e.via })
        frontier.push([nd, e.to])
      }
    }
  }
  if (!dist.has(to) || !done.has(to)) return null
  const path: { node: string; via?: string }[] = [{ node: to }]
  let cur = to
  while (cur !== from) {
    const p = prev.get(cur)!
    path[0].via = p.via
    path.unshift({ node: p.node })
    cur = p.node
  }
  return { length: dist.get(to)!, path }
}

export function mockRoute(
  b: Building,
  body: { from: string; to: string; step_free?: boolean; min_width_m?: number; via?: string[] },
  closed: Set<string>,
): Route {
  const idx = indexBuilding(b)
  const stops = [body.from, ...(body.via ?? []), body.to].map((r) => resolveSpace(b, r))
  const g = buildGraph(b, { stepFree: !!body.step_free, minWidth: body.min_width_m ?? null, closed })
  let nodes: { node: string; via?: string }[] = []
  let length = 0
  for (let i = 0; i + 1 < stops.length; i++) {
    const leg = dijkstra(g, stops[i], stops[i + 1])
    if (!leg) {
      return {
        reachable: false, length_m: 0, step_free: !!body.step_free, min_width_m: body.min_width_m ?? null,
        space_path: [], steps: [`No route from ${stops[i]} to ${stops[i + 1]}.`], floors: [], connectors: [],
      }
    }
    length += leg.length
    nodes = nodes.length ? [...nodes, ...leg.path.slice(1)] : leg.path
  }
  const floors: RouteFloorSegment[] = []
  const connectors: Route['connectors'] = []
  const floorOf = (n: string) => (n.startsWith('door:') ? idx.openings.get(n.slice(5))!.floor_id : idx.spaces.get(n)?.floor_id)
  const pointOf = (n: string): XY | null =>
    n.startsWith('door:') ? idx.openings.get(n.slice(5))!.position : n === OUTSIDE ? null : idx.anchors.get(n)!
  for (const step of nodes) {
    const fid = floorOf(step.node)
    const pt = pointOf(step.node)
    if (!fid || !pt) continue
    const conn = step.via ? idx.connectors.get(step.via) : undefined
    const last = floors[floors.length - 1]
    if (conn && last && last.floor_id !== fid) {
      connectors.push({ id: conn.id, kind: conn.kind, from_floor_id: last.floor_id, to_floor_id: fid, position: pt })
    }
    if (!last || last.floor_id !== fid) {
      const f = idx.floors.get(fid)!
      floors.push({ floor_id: fid, level: f.level, elevation_m: f.elevation_m, points: [pt] })
    } else last.points.push(pt)
  }
  const spacePath = nodes.map((n) => n.node).filter((n) => !n.startsWith('door:'))
  const steps = [`Start in ${idx.spaces.get(spacePath[0])?.name ?? spacePath[0]}.`]
  for (const c of connectors) steps.push(`Take ${idx.connectors.get(c.id)?.name} to ${idx.floors.get(c.to_floor_id)?.name}.`)
  steps.push(`Arrive at ${idx.spaces.get(spacePath[spacePath.length - 1])?.name}.`)
  return {
    reachable: true, length_m: Math.round(length * 100) / 100, step_free: !!body.step_free, min_width_m: body.min_width_m ?? null,
    space_path: spacePath, steps, floors, connectors,
  }
}
