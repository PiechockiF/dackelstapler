import { useCallback } from 'react'
import { create } from 'zustand'

// The conversation lives here, not in the chat panel: the panel unmounts whenever it is hidden
// (on the phone: every switch to the 3D view or another tab), and the thread must survive that.
// One thread at a time; opening the chat for another site starts a new one.
interface ChatThread {
  siteId: string | null
  sessionId: string
  messages: unknown[]
  busy: boolean
}

const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2))
const EMPTY: unknown[] = []

export const useChatThread = create<ChatThread>(() => ({ siteId: null, sessionId: '', messages: [], busy: false }))

/** Make `siteId` the current thread; keeps the existing one if it already is. */
export function openChatThread(siteId: string) {
  if (useChatThread.getState().siteId === siteId) return
  useChatThread.setState({ siteId, sessionId: `${siteId}-${uid()}`, messages: [], busy: false })
}

/** Messages + busy flag of the site's thread. Updates for a site that is no longer current are dropped. */
export function useChat<M>(siteId: string) {
  const messages = useChatThread((s) => (s.siteId === siteId ? s.messages : EMPTY)) as M[]
  const busy = useChatThread((s) => s.siteId === siteId && s.busy)
  const setMessages = useCallback(
    (update: (list: M[]) => M[]) =>
      useChatThread.setState((s) => (s.siteId === siteId ? { messages: update(s.messages as M[]) } : s)),
    [siteId],
  )
  const setBusy = useCallback(
    (busy: boolean) => useChatThread.setState((s) => (s.siteId === siteId ? { busy } : s)),
    [siteId],
  )
  return { messages, setMessages, busy, setBusy }
}
