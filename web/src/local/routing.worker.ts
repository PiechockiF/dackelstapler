/// <reference lib="webworker" />
import { LocalRouter } from './router'
import type { MobileBuilding, RouteRequest } from './types'

export type WorkerRequest = { id: number; building?: MobileBuilding; closed: string[] } & (
  | { kind: 'route'; body: RouteRequest; assetRooms: Record<string, string> }
  | { kind: 'reachable'; from: string; opts: { step_free?: boolean; min_width_m?: number } }
)

let router: LocalRouter | undefined
self.onmessage = ({ data }: MessageEvent<WorkerRequest>) => {
  try {
    if (data.building) router = new LocalRouter(data.building)
    if (!router) throw new Error('Routing graph not loaded.')
    const result = data.kind === 'route' ? router.route(data.body, data.closed, data.assetRooms) : router.reachable(data.from, data.closed, data.opts)
    self.postMessage({ id: data.id, result })
  } catch (e) {
    self.postMessage({ id: data.id, error: (e as Error).message })
  }
}
