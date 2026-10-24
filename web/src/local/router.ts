import type { Route, XY } from '../lib/types'
import type { GraphEdge, MobileBuilding, RouteRequest } from './types'

class Heap {
  items: [number, string][] = []
  push(value: [number, string]) {
    let i = this.items.push(value) - 1
    while (i > 0) {
      const p = (i - 1) >> 1
      if (this.items[p][0] <= value[0]) break
      this.items[i] = this.items[p]; i = p
    }
    this.items[i] = value
  }
  pop(): [number, string] | undefined {
    const top = this.items[0], last = this.items.pop()
    if (this.items.length && last) {
      let i = 0
      while (i * 2 + 1 < this.items.length) {
        let c = i * 2 + 1
        if (c + 1 < this.items.length && this.items[c + 1][0] < this.items[c][0]) c++
        if (this.items[c][0] >= last[0]) break
        this.items[i] = this.items[c]; i = c
      }
      this.items[i] = last
    }
    return top
  }
}

export function resolveSpace(data: MobileBuilding, ref: string, assetRooms: Record<string, string> = {}): string {
  const b = data.building
  if (Object.hasOwn(data.anchors, ref)) return ref
  const asset = b.assets.find((a) => a.id === ref)
  if (asset) return assetRooms[asset.id] ?? asset.space_id
  const low = ref.trim().toLowerCase()
  if (!low) throw new Error('Choose a room or asset.')
  const exact = b.spaces.filter((s) => s.name.toLowerCase() === low || s.ref?.toLowerCase() === low)
  if (exact.length === 1) return exact[0].id
  const assets = b.assets.filter((a) => a.name.toLowerCase() === low)
  if (assets.length === 1) return assetRooms[assets[0].id] ?? assets[0].space_id
  const words = low.split(/\s+/)
  const candidates = [...b.spaces, ...b.assets].filter((s) => words.every((w) => `${s.id} ${s.name} ${'ref' in s ? s.ref : ''}`.toLowerCase().includes(w))).slice(0, 8)
  if (!candidates.length) throw new Error(`No place matches “${ref}”. Try a room name or ID.`)
  throw new Error(`“${ref}” is ambiguous or not exact. Choose: ${candidates.map((s) => `${s.name} (${s.id})`).join('; ')}`)
}

export class LocalRouter {
  data: MobileBuilding
  adjacency = new Map<string, { to: string; edge: GraphEdge }[]>()
  spaces: Map<string, MobileBuilding['building']['spaces'][number]>
  openings: Map<string, MobileBuilding['building']['openings'][number]>
  connectors: Map<string, MobileBuilding['building']['vertical_connectors'][number]>
  floors: Map<string, MobileBuilding['building']['floors'][number]>
  constructor(data: MobileBuilding) {
    this.data = data
    this.spaces = new Map(data.building.spaces.map((s) => [s.id, s]))
    this.openings = new Map(data.building.openings.map((o) => [o.id, o]))
    this.connectors = new Map(data.building.vertical_connectors.map((c) => [c.id, c]))
    this.floors = new Map(data.building.floors.map((f) => [f.id, f]))
    for (const edge of data.edges) {
      for (const [from, to] of [[edge.a, edge.b], [edge.b, edge.a]]) {
        if (!this.adjacency.has(from)) this.adjacency.set(from, [])
        this.adjacency.get(from)!.push({ to, edge })
      }
    }
  }
  private shortest(from: string, to: string, closed: Set<string>, stepFree: boolean, width?: number) {
    if (closed.has(from) || closed.has(to)) return null
    const distance = new Map<string, number>([[from, 0]])
    const prev = new Map<string, { node: string; via: string }>()
    const heap = new Heap(); heap.push([0, from])
    while (heap.items.length) {
      const [d, node] = heap.pop()!
      if (d !== distance.get(node)) continue
      if (node === to) {
        const nodes = [node], vias: string[] = []
        let cur = node
        while (cur !== from) {
          const p = prev.get(cur)!
          nodes.unshift(p.node); vias.unshift(p.via); cur = p.node
        }
        return { length: d, nodes, vias }
      }
      for (const { to: next, edge } of this.adjacency.get(node) ?? []) {
        if (closed.has(next) || closed.has(edge.via) || (stepFree && !edge.stepFree)) continue
        if (width != null && edge.width != null && edge.width < width - 1e-6) continue
        const value = d + edge.w
        if (value < (distance.get(next) ?? Infinity)) {
          distance.set(next, value); prev.set(next, { node, via: edge.via }); heap.push([value, next])
        }
      }
    }
    return null
  }
  route(body: RouteRequest, closedIds: string[], assetRooms: Record<string, string> = {}): Route {
    if (body.min_width_m != null && (!Number.isFinite(body.min_width_m) || body.min_width_m <= 0)) throw new Error('Load width must be a positive number.')
    const stops = [body.from, ...(body.via ?? []), body.to].map((ref) => resolveSpace(this.data, ref, assetRooms))
    const closed = new Set(closedIds)
    const stepFree = !!body.step_free || body.min_width_m != null
    const result: Route = { reachable: true, length_m: 0, step_free: stepFree, min_width_m: body.min_width_m ?? null,
      from_space_id: stops[0], to_space_id: stops.at(-1), via: stops.slice(1, -1), space_path: [], steps: [], floors: [], connectors: [] }
    let nodes: string[] = [], vias: string[] = [], length = 0
    for (let i = 0; i < stops.length - 1; i++) {
      const leg = this.shortest(stops[i], stops[i + 1], closed, stepFree, body.min_width_m)
      if (!leg) {
        result.reachable = false
        result.space_path = [stops[0], stops.at(-1)!]
        result.message = 'No route satisfies the current closures and accessibility/width constraints.'
        result.steps = [result.message]
        if (body.min_width_m != null) {
          const unrestricted = this.shortest(stops[i], stops[i + 1], closed, false)
          result.blocking_openings = [...new Set(unrestricted?.vias ?? [])].flatMap((id) => {
            const o = this.openings.get(id)
            return o && o.width_m < body.min_width_m! - 1e-6 ? [{ id, width_m: o.width_m, position: o.position, floor_id: o.floor_id }] : []
          })
        }
        return result
      }
      length += leg.length; nodes.push(...(nodes.length ? leg.nodes.slice(1) : leg.nodes)); vias.push(...leg.vias)
    }
    result.length_m = Math.round((length + Number.EPSILON) * 100) / 100
    result.space_path = nodes.filter((n) => !n.startsWith('door:'))
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i]
      const door = this.openings.get(node.slice(5))
      const floorId = node.startsWith('door:') ? door?.floor_id : this.spaces.get(node)?.floor_id
      const point: XY | undefined = node.startsWith('door:') ? door?.position : this.data.anchors[node]
      if (!floorId || !point) continue
      const last = result.floors.at(-1)
      const connector = i ? this.connectors.get(vias[i - 1]) : undefined
      if (connector && last && last.floor_id !== floorId) {
        result.connectors.push({ id: connector.id, kind: connector.kind as 'stairs' | 'lift', from_floor_id: last.floor_id, to_floor_id: floorId, position: point })
      }
      if (!last || last.floor_id !== floorId) {
        const f = this.floors.get(floorId)!
        result.floors.push({ floor_id: floorId, level: f.level, elevation_m: f.elevation_m, points: [point] })
      } else last.points.push(point)
    }
    result.steps = [`Start in ${this.spaces.get(stops[0])?.name}.`, ...result.connectors.map((c) => `Take ${this.connectors.get(c.id)?.name} to ${this.floors.get(c.to_floor_id)?.name}.`), `Arrive at ${this.spaces.get(stops.at(-1)!)?.name}.`]
    return result
  }
}
