import type { Route } from '../lib/types'
import type { WorkerRequest } from './routing.worker'
import type { MobileBuilding, RouteRequest } from './types'

type Job = { kind: 'route'; body: RouteRequest; assetRooms: Record<string, string> } | { kind: 'reachable'; from: string; opts: { step_free?: boolean; min_width_m?: number } }

let worker: Worker | undefined, loaded: string | undefined, sequence = 0
const pending = new Map<number, { resolve: (r: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>()
export function disposeRouter() {
  worker?.terminate(); worker = undefined; loaded = undefined
  for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('Routing worker stopped. Please retry.')) }
  pending.clear()
}
export function routeInWorker(data: MobileBuilding, body: RouteRequest, closed: string[], assetRooms: Record<string, string>): Promise<Route> {
  return callWorker<Route>(data, closed, { kind: 'route', body, assetRooms })
}
/** Space ids reachable from `from` under the constraints and closures (core.reachability parity). */
export function reachableInWorker(data: MobileBuilding, from: string, closed: string[], opts: { step_free?: boolean; min_width_m?: number }): Promise<string[]> {
  return callWorker<string[]>(data, closed, { kind: 'reachable', from, opts })
}
function callWorker<T>(data: MobileBuilding, closed: string[], job: Job): Promise<T> {
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
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => disposeRouter(), 30_000)
    pending.set(id, { resolve: resolve as (r: unknown) => void, reject, timer })
    try {
      worker!.postMessage({ id, building, closed, ...job } satisfies WorkerRequest)
      loaded = key
    } catch (e) {
      clearTimeout(timer); pending.delete(id); reject(e)
    }
  })
}
