import type { WsMessage } from '../lib/types'

const listeners = new Set<(message: WsMessage) => void>()
export const subscribeLocal = (listener: (message: WsMessage) => void) => {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
export function emitLocal(message: WsMessage) {
  for (const listener of listeners) {
    try { listener(message) } catch (error) { console.error('Local event listener failed', error) }
  }
}
