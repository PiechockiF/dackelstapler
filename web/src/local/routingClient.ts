import type { Route } from '../lib/types'
import type { MobileBuilding, RouteRequest } from './types'

let worker: Worker | undefined, loaded: string | undefined, sequence = 0
const pending = new Map<number, { resolve: (r: Route) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>()
export function disposeRouter() {
  worker?.terminate(); worker = undefined; loaded = undefined
  for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('Routing worker stopped. Please retry.')) }
  pending.clear()
}
export function routeInWorker(data: MobileBuilding, body: RouteRequest, closed: string[], assetRooms: Record<string, string>): Promise<Route> {
  if (!worker) {
    worker = new Worker(new URL('./routing.worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = ({ data: response }) => {
      const request = pending.get(response.id)
      if (!request) return
      clearTimeout(request.timer); pending.delete(response.id)
      if (response.error) request.reject(new Error(response.error)); else request.resolve(response.result)
    }
    worker.onerror = () => disposeRouter()
  }
  const id = ++sequence
  const key = `${data.building.building.id}:${data.sourceHash}`
  const building = loaded === key ? undefined : data
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => disposeRouter(), 30_000)
    pending.set(id, { resolve, reject, timer })
    try {
      worker!.postMessage({ id, building, body, closed, assetRooms })
      loaded = key
    } catch (e) {
      clearTimeout(timer); pending.delete(id); reject(e)
    }
  })
}
