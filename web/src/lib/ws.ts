import { useEffect } from 'react'
import type { WsMessage } from './types'
import { isLocalMode } from './mode'
import { subscribeLocal } from '../local/events'

type Listener = (message: WsMessage) => void

const listeners = new Set<Listener>()
let socket: WebSocket | null = null

function connect() {
  const protocol = location.protocol === 'https:' ? 'wss' : 'ws'
  socket = new WebSocket(`${protocol}://${location.host}/ws`)
  socket.onmessage = (message) => {
    const parsed = JSON.parse(message.data) as WsMessage
    listeners.forEach((listener) => listener(parsed))
  }
  socket.onclose = () => {
    socket = null
    if (listeners.size) setTimeout(connect, 1500)
  }
}

/** Subscribe to server pushes (events, capture progress) for the lifetime of a component. */
export function useLive(listener: Listener) {
  useEffect(() => {
    if (isLocalMode) return subscribeLocal(listener)
    listeners.add(listener)
    if (!socket) connect()
    return () => {
      listeners.delete(listener)
    }
  }, [listener])
}
