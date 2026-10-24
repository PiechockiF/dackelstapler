/// <reference lib="webworker" />
import { LocalRouter } from './router'
import type { MobileBuilding, RouteRequest } from './types'

let router: LocalRouter | undefined
self.onmessage = ({ data }: MessageEvent<{ id: number; building?: MobileBuilding; body: RouteRequest; closed: string[]; assetRooms: Record<string, string> }>) => {
  try {
    if (data.building) router = new LocalRouter(data.building)
    if (!router) throw new Error('Routing graph not loaded.')
    self.postMessage({ id: data.id, result: router.route(data.body, data.closed, data.assetRooms) })
  } catch (e) {
    self.postMessage({ id: data.id, error: (e as Error).message })
  }
}
