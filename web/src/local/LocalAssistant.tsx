import { Send, Sparkles } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { api } from '../lib/api'
import { useTwin } from '../lib/store'
import { adoptRouteMode, originOf, refreshRoute } from '../twin/actions'
import { useTwinUi } from '../twin/uiStore'
import { openChatThread, useChat } from '../chat/chatStore'
import { runLocalCommand } from './assistant'

export default function LocalAssistant({ siteId }: { siteId: string }) {
  const { messages, setMessages, busy, setBusy } = useChat<{ role: string; text: string }>(siteId)
  const [input, setInput] = useState('')
  const bottom = useRef<HTMLDivElement>(null)
  useEffect(() => openChatThread(siteId), [siteId])
  useEffect(() => { bottom.current?.scrollIntoView({ block: 'nearest' }) }, [messages, busy])
  const send = async (text = input) => {
    if (!text.trim() || busy) return
    setInput(''); setBusy(true); setMessages((m) => [...m, { role: 'you', text }])
    try {
      const b = useTwin.getState().building
      const result = await runLocalCommand(siteId, text, b ? originOf(b) : null, useTwin.getState().route?.to_space_id)
      if (useTwin.getState().siteId !== siteId) return
      for (const action of result.actions) {
        const twin = useTwin.getState()
        if (action.type === 'show_route') { adoptRouteMode(action.route); twin.setRoute(action.route); twin.setFocusFloor(null) }
        if (action.type === 'highlight') twin.setHighlight({ ids: action.ids, label: action.label })
        if (action.type === 'focus_floor') twin.setFocusFloor(action.floor_id)
        if (action.type === 'set_location') useTwinUi.getState().setOrigin(action.space_id)
        if (action.type === 'understood') twin.setUnderstood(action.chips)
        if (action.type === 'state_changed') {
          const state = await api.state(siteId)
          if (useTwin.getState().siteId === siteId) useTwin.getState().setState(state)
          await refreshRoute(siteId)
        }
      }
      setMessages((m) => [...m, { role: 'assistant', text: result.text }])
    } catch (e) { setMessages((m) => [...m, { role: 'assistant', text: (e as Error).message }]) }
    finally { setBusy(false) }
  }
  const b = useTwin((s) => s.building)
  const room = b?.spaces.find((s) => /quality|meeting|lecture/i.test(s.name)) ?? b?.spaces[0]
  const suggestions = ['What changed?', 'Free rooms for 6', ...(room ? [`Route to ${room.name}`, `Area of ${room.name}`] : []), ...(b?.vertical_connectors[0] ? [`Close ${b.vertical_connectors[0].name}`] : []), 'Help']
  return <section className="flex h-full min-h-0 flex-col">
    <header className="border-b border-white/10 px-4 py-3"><h2 className="flex items-center gap-2 text-sm font-semibold text-slate-100"><Sparkles size={15} className="text-sky-300" /> Local assistant</h2><p className="mt-1 text-[11px] leading-relaxed text-slate-400">Building commands on this phone. No cloud AI or voice. Use exact names or IDs.</p></header>
    <div className="min-h-0 flex-1 overflow-y-auto p-3 text-sm">
      {!messages.length && <div className="flex flex-col gap-2">{suggestions.map((s) => <button key={s} onClick={() => void send(s)} className="rounded-xl border border-white/10 bg-slate-900/60 p-3 text-left text-xs text-slate-300 hover:border-sky-300/40">{s}</button>)}</div>}
      {messages.map((m, i) => <div key={i} className={`mb-3 whitespace-pre-wrap wrap-break-word rounded-xl p-3 text-[12px] leading-relaxed ${m.role === 'you' ? 'ml-5 bg-sky-500/15 text-sky-100' : 'mr-3 bg-white/5 text-slate-300'}`}>{m.text}</div>)}
      {busy && <p className="text-xs text-sky-300">Working locally…</p>}<div ref={bottom} />
    </div>
    <form className="flex gap-2 border-t border-white/10 p-3" onSubmit={(e) => { e.preventDefault(); void send() }}><input aria-label="Local assistant command" value={input} onChange={(e) => setInput(e.target.value)} placeholder="Route to… / find… / help" className="min-w-0 flex-1 rounded-lg border border-white/10 bg-slate-900 px-3 py-2 text-base outline-none focus:border-sky-400" /><button aria-label="Send command" disabled={busy || !input.trim()} className="rounded-lg bg-sky-400/20 px-3 text-sky-100 disabled:opacity-40"><Send size={16} /></button></form>
  </section>
}
