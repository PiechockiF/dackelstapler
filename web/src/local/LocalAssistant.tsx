import { KeyRound, Mic, Send, Sparkles, Square, Volume2, VolumeX } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { api } from '../lib/api'
import { useTwin } from '../lib/store'
import { adoptRouteMode, originOf, refreshRoute } from '../twin/actions'
import { useTwinUi } from '../twin/uiStore'
import { openChatThread, useChat } from '../chat/chatStore'
import { aiError, aiKey, askClaude, hasBuiltInKey, ownKey, setAiKey } from './ai'
import { runLocalCommand } from './assistant'
import { sayAloud, speakable, stopAloud, Voice } from './voice'

const MUTE_KEY = 'dackel.voice.muted'

export default function LocalAssistant({ siteId }: { siteId: string }) {
  const { messages, setMessages, busy, setBusy } = useChat<{ role: string; text: string }>(siteId)
  const [input, setInput] = useState('')
  const [voiceOk, setVoiceOk] = useState(false)
  const [listening, setListening] = useState(false)
  const [speaking, setSpeaking] = useState(false)
  const [muted, setMuted] = useState(() => globalThis.localStorage?.getItem(MUTE_KEY) === '1')
  const [voiceErr, setVoiceErr] = useState('')
  // Claude when a key is set on this phone, the offline command parser otherwise.
  const [aiOn, setAiOn] = useState(() => !!aiKey())
  const [keyForm, setKeyForm] = useState(false)
  const [keyDraft, setKeyDraft] = useState('')
  const heard = useRef('')
  const permitted = useRef(false)
  const bottom = useRef<HTMLDivElement>(null)
  useEffect(() => openChatThread(siteId), [siteId])
  useEffect(() => { bottom.current?.scrollIntoView({ block: 'nearest' }) }, [messages, busy])
  const send = async (text = input) => {
    if (!text.trim() || busy) return
    setInput(''); setBusy(true); setMessages((m) => [...m, { role: 'you', text }])
    try {
      const b = useTwin.getState().building
      const origin = b ? originOf(b) : null
      const offline = () => runLocalCommand(siteId, text, origin, useTwin.getState().route?.to_space_id)
      let result
      if (aiOn) {
        try { result = await askClaude(siteId, text, origin) }
        catch (e) {
          const err = aiError(e)
          if (!err.offline) throw new Error(err.message)
          result = await offline()
          result = { ...result, text: `${err.message}\n${result.text}` }
        }
      } else result = await offline()
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
      // Every answer is read aloud: the phone's silent switch (native side) or the in-app mute silences it.
      if (!muted) { setSpeaking(true); void sayAloud(speakable(result.text)).catch(() => setSpeaking(false)) }
    } catch (e) { setMessages((m) => [...m, { role: 'assistant', text: (e as Error).message }]) }
    finally { setBusy(false) }
  }
  const sendRef = useRef(send)
  useEffect(() => { sendRef.current = send })

  // Voice: live transcript into the input, sent when the user stops talking.
  useEffect(() => {
    let alive = true
    void Voice.isAvailable().then((r) => alive && setVoiceOk(r.available)).catch(() => undefined)
    const subs = [
      Voice.addListener('speech', (e) => { heard.current = e.text; setInput(e.text) }),
      Voice.addListener('speechError', (e) => setVoiceErr(/no speech|not detected|1110/i.test(e.message) ? 'Didn’t catch that. Try again.' : e.message)),
      Voice.addListener('speechEnd', () => {
        setListening(false)
        const text = heard.current.trim()
        heard.current = ''
        if (text) void sendRef.current(text)
      }),
      Voice.addListener('speakEnd', () => setSpeaking(false)),
    ]
    return () => {
      alive = false
      subs.forEach((p) => void p.then((h) => h.remove()))
      void Voice.stopListening().catch(() => undefined)
      void stopAloud().catch(() => undefined)
    }
  }, [])

  const toggleMic = async () => {
    setVoiceErr('')
    if (listening) return void Voice.stopListening()
    try {
      if (!permitted.current) {
        const { granted } = await Voice.requestPermission()
        if (!granted) return setVoiceErr('Allow microphone and speech recognition for Dackel in Settings to talk to the assistant.')
        permitted.current = true
      }
      heard.current = ''
      setInput('')
      void stopAloud()
      setSpeaking(false)
      // Building names help the recognizer with "Route to Office 1.04" and the like.
      const hints = (useTwin.getState().building?.spaces ?? []).filter((s) => s.type !== 'corridor').map((s) => s.name).slice(0, 100)
      await Voice.startListening({ hints })
      setListening(true)
    } catch (e) {
      setListening(false)
      setVoiceErr((e as Error).message)
    }
  }

  const toggleMute = () => {
    const next = !muted
    setMuted(next)
    globalThis.localStorage?.setItem(MUTE_KEY, next ? '1' : '0')
    if (next) { void stopAloud(); setSpeaking(false) }
  }
  const b = useTwin((s) => s.building)
  const room = b?.spaces.find((s) => /quality|meeting|lecture/i.test(s.name)) ?? b?.spaces[0]
  const suggestions = ['What changed?', 'Free rooms for 6', ...(room ? [`Route to ${room.name}`, `Area of ${room.name}`] : []), ...(b?.vertical_connectors[0] ? [`Close ${b.vertical_connectors[0].name}`] : []), 'Help']
  return <section className="flex h-full min-h-0 flex-col">
    <header className="border-b border-white/10 py-3 pl-4 pr-12"><h2 className="flex items-center gap-2 text-sm font-semibold text-slate-100"><Sparkles size={15} className="text-sky-300" /> Assistant
      <span className={`rounded px-1.5 py-px text-[10px] font-semibold ${aiOn ? 'bg-violet-400/15 text-violet-200' : 'bg-white/5 text-slate-400'}`}>{aiOn ? 'Claude' : 'Offline'}</span>
      <span className="ml-auto flex items-center gap-1"><button aria-label={muted ? 'Read answers aloud' : 'Mute spoken answers'} title={muted ? 'Read answers aloud' : 'Mute spoken answers'} onClick={toggleMute} className={`grid size-7 place-items-center rounded-lg ${speaking ? 'bg-sky-400/20 text-sky-200' : 'text-slate-400 hover:bg-white/5'}`}>{muted ? <VolumeX size={15} /> : <Volume2 size={15} />}</button><button aria-label="Claude API key" title="Claude API key" onClick={() => { setKeyDraft(''); setKeyForm(!keyForm) }} className={`grid size-7 place-items-center rounded-lg ${keyForm ? 'bg-white/10 text-white' : 'text-slate-400 hover:bg-white/5'}`}><KeyRound size={14} /></button></span></h2>
      <p className="mt-1 text-[11px] leading-relaxed text-slate-400">{aiOn ? 'Claude answers using this building and can act on it for you.' : 'Offline commands on this phone. Add a Claude API key for the full AI assistant.'}{voiceOk ? ' Tap the mic to talk.' : ''}</p>
      {keyForm && <form className="mt-2.5 flex flex-col gap-2" onSubmit={(e) => { e.preventDefault(); setAiKey(keyDraft); setAiOn(!!aiKey()); setKeyForm(false) }}>
        <input type="password" autoComplete="off" aria-label="Anthropic API key" value={keyDraft} onChange={(e) => setKeyDraft(e.target.value)} placeholder={ownKey() ? 'Your key is saved. Paste a new one to replace it' : hasBuiltInKey() ? 'Using the team key. Paste your own to replace it' : 'sk-ant-…'} className="w-full rounded-lg border border-white/10 bg-slate-900 px-3 py-2 text-base outline-none focus:border-sky-400" />
        <div className="flex gap-2"><button disabled={!keyDraft.trim()} className="flex-1 rounded-lg bg-sky-400/20 py-1.5 text-xs font-medium text-sky-100 disabled:opacity-40">Save key</button>{!!ownKey() && <button type="button" onClick={() => { setAiKey(''); setAiOn(!!aiKey()); setKeyForm(false) }} className="rounded-lg bg-white/5 px-3 py-1.5 text-xs text-slate-300">Remove</button>}</div>
        <p className="text-[10px] leading-snug text-slate-500">Stored only on this phone and sent only to Anthropic. Questions and building details go to Claude to answer.</p>
      </form>}</header>
    <div className="min-h-0 flex-1 overflow-y-auto p-3 text-sm">
      {!messages.length && <div className="flex flex-col gap-2">{suggestions.map((s) => <button key={s} onClick={() => void send(s)} className="rounded-xl border border-white/10 bg-slate-900/60 p-3 text-left text-xs text-slate-300 hover:border-sky-300/40">{s}</button>)}</div>}
      {messages.map((m, i) => <div key={i} className={`mb-3 whitespace-pre-wrap break-words rounded-xl p-3 text-[12px] leading-relaxed ${m.role === 'you' ? 'ml-5 bg-sky-500/15 text-sky-100' : 'mr-3 bg-white/5 text-slate-300'}`}>{m.text}</div>)}
      {busy && <p className="text-xs text-sky-300">{aiOn ? 'Thinking…' : 'Working…'}</p>}<div ref={bottom} />
    </div>
    {/* Suggestions stay one tap away after the first message. */}
    {!!messages.length && <div className="flex gap-2 overflow-x-auto border-t border-white/10 px-3 pt-2.5 [scrollbar-width:none]">{suggestions.map((s) => <button key={s} disabled={busy} onClick={() => void send(s)} className="shrink-0 whitespace-nowrap rounded-full border border-white/10 bg-slate-900/60 px-3 py-1.5 text-[11px] text-slate-300 hover:border-sky-300/40 disabled:opacity-40">{s}</button>)}</div>}
    {voiceErr && <p role="status" className="px-3 pt-2 text-[11px] text-amber-200">{voiceErr}</p>}
    <form className={`flex gap-2 p-3 ${messages.length ? '' : 'border-t border-white/10'}`} onSubmit={(e) => { e.preventDefault(); void send() }}>
      {voiceOk && <button type="button" aria-label={listening ? 'Stop listening' : 'Speak a command'} onClick={() => void toggleMic()} disabled={busy} className={`relative grid w-11 shrink-0 place-items-center rounded-lg disabled:opacity-40 ${listening ? 'bg-rose-500/25 text-rose-100' : 'bg-white/5 text-slate-200 hover:bg-white/10'}`}>{listening && <span className="absolute inset-0 animate-ping rounded-lg bg-rose-500/30" />}{listening ? <Square size={15} /> : <Mic size={16} />}</button>}
      <input aria-label="Assistant command" value={input} onChange={(e) => setInput(e.target.value)} placeholder={listening ? 'Listening…' : aiOn ? 'Ask about this building…' : 'Route to… / find… / help'} className="min-w-0 flex-1 rounded-lg border border-white/10 bg-slate-900 px-3 py-2 text-base outline-none focus:border-sky-400" />
      <button aria-label="Send command" disabled={busy || listening || !input.trim()} className="rounded-lg bg-sky-400/20 px-3 text-sky-100 disabled:opacity-40"><Send size={16} /></button>
    </form>
  </section>
}
