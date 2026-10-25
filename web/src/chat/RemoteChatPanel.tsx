import { adoptRouteMode, originOf } from '../twin/actions'
import { useTwinUi } from '../twin/uiStore'
// Owner: agent D. Chat + voice panel, rendered by SitePage.
// Streams /api/sites/{id}/chat (SSE), shows "what I understood" chips, dispatches actions into useTwin,
// push-to-talk (ElevenLabs STT via the server, Web Speech fallback) and spoken replies (TTS, fallback speechSynthesis).
import { useCallback, useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { ChevronRight, Loader2, Mic, Send, Sparkles, Square, Volume2, VolumeX } from 'lucide-react'
import { api, streamChat } from '../lib/api'
import { useTwin } from '../lib/store'
import type { ChatAction } from '../lib/types'
import { openChatThread, useChat, useChatThread } from './chatStore'

interface Message {
  id: string
  role: 'user' | 'assistant'
  text: string
  chips: string[]
  pending?: boolean
  error?: boolean
}

type VoiceMode = 'server' | 'browser' | 'none'

const SUGGESTIONS: Record<string, string[]> = {
  factory: [
    "Where's the steel drum that came in yesterday?",
    'Take me there without stairs',
    'Close the office lift',
    'Free room for 6 people at 14:00?',
    'What changed this week?',
  ],
  default: [
    'Where do I get coffee?',
    'How do I get to the lecture hall without stairs?',
    'Free room for 6 people at 14:00?',
    'What changed this week?',
  ],
}

// Minimal Web Speech API typing (not in lib.dom for all browsers).
interface SpeechRecognitionLike {
  lang: string
  interimResults: boolean
  continuous: boolean
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null
  onerror: ((event: unknown) => void) | null
  onend: (() => void) | null
  start: () => void
  stop: () => void
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike

function speechRecognitionCtor(): SpeechRecognitionCtor | null {
  const w = window as unknown as { SpeechRecognition?: SpeechRecognitionCtor; webkitSpeechRecognition?: SpeechRecognitionCtor }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

// A short silent WAV; playing it inside a click "unlocks" the shared <audio> for later replies (Safari autoplay rule).
const SILENT_WAV = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA='

const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2))

/** Text worth speaking: no parenthetical notes, no markdown, max ~600 chars. */
function speakable(text: string): string {
  return text
    .replace(/\([^)]*\)/g, '')
    .replace(/[*_#`>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 600)
}

function looksGerman(text: string): boolean {
  return /[äöüß]|\b(der|die|das|ist|wo|bitte|ich|nicht|zum|zur)\b/i.test(text)
}

export default function ChatPanel({ siteId, onClose }: { siteId: string; onClose?: () => void }) {
  const { messages, setMessages, busy, setBusy } = useChat<Message>(siteId)
  const [input, setInput] = useState('')
  const [muted, setMuted] = useState(() => {
    try {
      return localStorage.getItem('sitetwin.muted') === '1'
    } catch {
      return false
    }
  })
  const [voiceMode, setVoiceMode] = useState<VoiceMode>('none')
  const [serverTts, setServerTts] = useState(true)
  const [voiceNote, setVoiceNote] = useState<string | null>(null)
  const [recording, setRecording] = useState(false)
  const [transcribing, setTranscribing] = useState(false)
  const [speaking, setSpeaking] = useState(false)
  const [siteKind, setSiteKind] = useState<string>('default')

  const scrollRef = useRef<HTMLDivElement>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const holdingRef = useRef(false)
  const mutedRef = useRef(muted)
  mutedRef.current = muted

  const setRoute = useTwin((s) => s.setRoute)
  const setHighlight = useTwin((s) => s.setHighlight)
  const setFocusFloor = useTwin((s) => s.setFocusFloor)
  const setUnderstood = useTwin((s) => s.setUnderstood)
  const setTwinState = useTwin((s) => s.setState)

  // New site → new conversation; reopening the panel on the same site keeps it.
  useEffect(() => {
    openChatThread(siteId)
    api
      .sites()
      .then((sites) => setSiteKind(sites.find((s) => s.id === siteId)?.kind ?? 'default'))
      .catch(() => undefined)
  }, [siteId])

  // Which voice backends exist? An unreachable server is not "no voice": we keep trying it per request.
  useEffect(() => {
    let cancelled = false
    fetch('/api/health')
      .then((r) => (r.ok ? r.json() : {}))
      .catch(() => ({}))
      .then((health: { voice?: boolean }) => {
        if (cancelled) return
        const serverVoice = health.voice !== false
        const canRecord = typeof MediaRecorder !== 'undefined' && Boolean(navigator.mediaDevices?.getUserMedia)
        setServerTts(serverVoice)
        setVoiceMode(serverVoice && canRecord ? 'server' : speechRecognitionCtor() ? 'browser' : 'none')
        if (serverVoice && !canRecord && !window.isSecureContext) setVoiceNote('Mic needs https or localhost')
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages])

  useEffect(() => {
    try {
      localStorage.setItem('sitetwin.muted', muted ? '1' : '0')
    } catch {
      /* private mode */
    }
    if (muted) stopSpeaking()
  }, [muted])

  const sharedAudio = () => (audioRef.current ??= new Audio())

  // Call from a click/tap so the later (async) reply is allowed to play.
  const primeAudio = () => {
    if (muted) return
    const audio = sharedAudio()
    if (!audio.paused) return
    audio.src = SILENT_WAV
    audio.play().catch(() => undefined)
  }

  const stopSpeaking = () => {
    audioRef.current?.pause()
    if ('speechSynthesis' in window) window.speechSynthesis.cancel()
    setSpeaking(false)
  }

  const speakWithBrowser = (text: string) => {
    if (!('speechSynthesis' in window)) return
    const utterance = new SpeechSynthesisUtterance(text)
    utterance.lang = looksGerman(text) ? 'de-DE' : 'en-US'
    utterance.rate = 1.05
    utterance.onend = () => setSpeaking(false)
    utterance.onerror = () => setSpeaking(false)
    window.speechSynthesis.cancel()
    setSpeaking(true)
    window.speechSynthesis.speak(utterance)
  }

  const speak = useCallback(
    async (raw: string) => {
      const text = speakable(raw)
      // ref, not state: a reply already in flight when mute was pressed must stay silent
      if (mutedRef.current || !text) return
      stopSpeaking()
      if (serverTts) {
        try {
          const response = await fetch('/api/voice/tts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text }),
          })
          if (response.status === 501) setServerTts(false)
          if (response.ok) {
            const url = URL.createObjectURL(await response.blob())

            if (mutedRef.current) return URL.revokeObjectURL(url)
            const audio = new Audio(url)
            audioRef.current = audio

            audio.onended = () => {
              setSpeaking(false)
              URL.revokeObjectURL(url)
            }
            setSpeaking(true)
            await audio.play()
            setVoiceNote(null)
            return
          }
          if (response.status !== 501) setVoiceNote(`ElevenLabs voice failed (${response.status})`)
        } catch (error) {
          setSpeaking(false)
          setVoiceNote((error as Error).name === 'NotAllowedError' ? 'Browser blocked audio; click the chat once' : 'ElevenLabs voice unreachable')
        }
      }
      speakWithBrowser(text)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [serverTts],
  )

  const handleAction = useCallback(
    (action: ChatAction, messageId: string) => {
      if (useTwin.getState().siteId !== siteId) return
      switch (action.type) {
        case 'set_location':
          useTwinUi.getState().setOrigin(action.space_id)
          break
        case 'show_route':
          adoptRouteMode(action.route)
          setFocusFloor(null)
          setRoute(action.route)
          break
        case 'highlight':
          setHighlight({ ids: action.ids, label: action.label })
          break
        case 'focus_floor':
          setFocusFloor(action.floor_id)
          break
        case 'understood':
          setUnderstood(action.chips)
          setMessages((list) =>
            list.map((m) => (m.id === messageId ? { ...m, chips: [...m.chips, ...action.chips.filter((c) => !m.chips.includes(c))] } : m)),
          )
          break
        case 'state_changed':
          api.state(siteId).then((state) => { if (useTwin.getState().siteId === siteId) setTwinState(state) }).catch(() => undefined)
          break
      }
    },
    [siteId, setMessages, setRoute, setHighlight, setFocusFloor, setUnderstood, setTwinState],
  )

  const send = useCallback(
    async (raw: string) => {
      const text = raw.trim()
      if (!text || busy) return
      stopSpeaking()
      setInput('')
      setBusy(true)
      const userMessage: Message = { id: uid(), role: 'user', text, chips: [] }
      const reply: Message = { id: uid(), role: 'assistant', text: '', chips: [], pending: true }
      setMessages((list) => [...list, userMessage, reply])
      let finalText = ''
      try {
        const building = useTwin.getState().building
        await streamChat(siteId, useChatThread.getState().sessionId, text, {
          onDelta: (delta) => {
            finalText += delta
            setMessages((list) => list.map((m) => (m.id === reply.id ? { ...m, text: m.text + delta } : m)))
          },
          onAction: (action) => handleAction(action, reply.id),
          onDone: (full) => {
            finalText = full || finalText
            setMessages((list) => list.map((m) => (m.id === reply.id ? { ...m, text: finalText, pending: false } : m)))
          },
        }, building ? originOf(building) : null)
        setMessages((list) => list.map((m) => (m.id === reply.id ? { ...m, pending: false } : m)))
        speak(finalText)
      } catch (error) {
        setMessages((list) =>
          list.map((m) =>
            m.id === reply.id
              ? { ...m, pending: false, error: true, text: `I couldn't reach the server (${(error as Error).message}).` }
              : m,
          ),
        )
      } finally {
        setBusy(false)
      }
    },
    [busy, siteId, setMessages, setBusy, handleAction, speak],
  )

  // ---------------------------------------------------------------- push-to-talk

  const startBrowserRecognition = () => {
    const Ctor = speechRecognitionCtor()
    if (!Ctor) return
    const recognition = new Ctor()
    recognition.lang = navigator.language || 'en-US'
    recognition.interimResults = true
    recognition.continuous = false
    let transcript = ''
    recognition.onresult = (event) => {
      transcript = Array.from(event.results as ArrayLike<ArrayLike<{ transcript: string }>>)
        .map((result) => result[0].transcript)
        .join(' ')
      setInput(transcript)
    }
    recognition.onerror = () => setRecording(false)
    recognition.onend = () => {
      setRecording(false)
      recognitionRef.current = null
      if (transcript.trim()) send(transcript)
    }
    recognitionRef.current = recognition
    setRecording(true)
    recognition.start()
  }

  const startRecording = async () => {
    if (recording || busy || transcribing) return
    holdingRef.current = true
    stopSpeaking()
    if (voiceMode === 'browser') {
      startBrowserRecognition()
      return
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      if (!holdingRef.current) {
        stream.getTracks().forEach((track) => track.stop()) // released before the mic opened
        return
      }
      const recorder = new MediaRecorder(stream)
      chunksRef.current = []
      recorder.ondataavailable = (event) => event.data.size && chunksRef.current.push(event.data)
      recorder.onstop = async () => {
        stream.getTracks().forEach((track) => track.stop())
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' })
        if (blob.size < 1200) return // a tap, not speech
        setTranscribing(true)
        try {
          const form = new FormData()
          form.append('audio', blob, `speech.${(recorder.mimeType || 'audio/webm').includes('mp4') ? 'mp4' : 'webm'}`)
          const response = await fetch('/api/voice/stt', { method: 'POST', body: form })
          if (response.status === 501) {
            setVoiceMode(speechRecognitionCtor() ? 'browser' : 'none')
            return
          }
          const body = await response.json().catch(() => ({}))
          if (response.ok && body.text) {
            setVoiceNote(null)
            send(body.text)
          } else {
            setVoiceNote(response.ok ? "Didn't catch that" : `Transcription failed (${response.status})`)
          }
        } catch {
          setVoiceNote('Transcription server unreachable')
        } finally {
          setTranscribing(false)
        }
      }
      recorderRef.current = recorder
      recorder.start()
      setRecording(true)
    } catch (error) {
      // Permission denied is the user's call for this attempt, not a reason to drop ElevenLabs for good.
      const name = (error as Error).name
      setVoiceNote(name === 'NotAllowedError' ? 'Microphone permission denied' : name === 'NotFoundError' ? 'No microphone found' : 'Microphone unavailable')
    }
  }

  const stopRecording = () => {
    holdingRef.current = false
    if (recognitionRef.current) {
      recognitionRef.current.stop()
      return
    }
    if (recorderRef.current && recorderRef.current.state !== 'inactive') recorderRef.current.stop()
    recorderRef.current = null
    setRecording(false)
  }

  const suggestions = SUGGESTIONS[siteKind] ?? SUGGESTIONS.default

  return (
    <div className="flex h-full w-full flex-col overflow-hidden rounded-2xl border border-white/10 bg-slate-950/60 text-slate-100 shadow-2xl shadow-black/40 backdrop-blur-xl">
      {/* header */}
      <div className="flex items-center gap-2 border-b border-white/10 px-4 py-3">
        <div className="flex h-7 w-7 items-center justify-center rounded-full bg-linear-to-br from-sky-400 to-violet-400 text-slate-950">
          <Sparkles size={15} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold tracking-tight">Ask the building</div>
          <div className="truncate text-[11px] text-slate-400">
            {speaking
              ? 'Speaking…'
              : recording
                ? 'Listening…'
                : transcribing
                  ? 'Transcribing…'
                  : voiceNote ?? `${serverTts && voiceMode === 'server' ? 'ElevenLabs voice' : 'Voice or text'} · routes, deliveries, rooms`}
          </div>
        </div>
        <button
          type="button"
          onClick={() => setMuted((m) => !m)}
          className="rounded-lg p-2 text-slate-300 transition hover:bg-white/10 hover:text-white"
          title={muted ? 'Unmute spoken replies' : 'Mute spoken replies'}
          aria-label={muted ? 'Unmute' : 'Mute'}
        >
          {muted ? <VolumeX size={16} /> : <Volume2 size={16} />}
        </button>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-2 text-slate-300 transition hover:bg-white/10 hover:text-white"
            title="Hide chat"
            aria-label="Hide chat"
          >
            <ChevronRight size={16} />
          </button>
        )}
      </div>

      {/* messages */}
      <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
        {messages.length === 0 && (
          <div className="mt-2 text-sm text-slate-400">
            <p className="mb-3">Hi! Ask me where things are, how to get somewhere, or tell me what changed.</p>
          </div>
        )}
        <AnimatePresence initial={false}>
          {messages.map((message) => (
            <motion.div
              key={message.id}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.18 }}
              className={message.role === 'user' ? 'flex justify-end' : 'flex flex-col items-start gap-1.5'}
            >
              {message.role === 'assistant' && message.chips.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  <span className="text-[10px] uppercase tracking-wider text-slate-500">understood</span>
                  {message.chips.map((chip) => (
                    <span
                      key={chip}
                      className="rounded-full border border-sky-400/40 bg-sky-400/10 px-2 py-0.5 text-[11px] text-sky-200"
                    >
                      {chip}
                    </span>
                  ))}
                </div>
              )}
              <div
                className={
                  message.role === 'user'
                    ? 'max-w-[85%] rounded-2xl rounded-br-md bg-sky-500/90 px-3.5 py-2 text-sm text-white'
                    : `max-w-[92%] whitespace-pre-wrap rounded-2xl rounded-bl-md border px-3.5 py-2 text-sm leading-relaxed ${
                        message.error ? 'border-red-400/40 bg-red-500/10 text-red-200' : 'border-white/10 bg-white/5 text-slate-100'
                      }`
                }
              >
                {message.text}
                {message.pending && !message.text && (
                  <span className="inline-flex items-center gap-1 text-slate-400">
                    <Loader2 size={13} className="animate-spin" /> thinking…
                  </span>
                )}
                {message.pending && message.text && <span className="ml-0.5 inline-block h-3 w-1.5 animate-pulse bg-sky-300/80 align-middle" />}
              </div>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>

      {/* suggestions */}
      <div className="flex gap-1.5 overflow-x-auto px-4 pb-2 scrollbar-none">
        {suggestions.map((suggestion) => (
          <button
            key={suggestion}
            type="button"
            disabled={busy}
            onClick={() => {
              primeAudio()
              send(suggestion)
            }}
            className="shrink-0 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-slate-300 transition hover:border-sky-400/50 hover:text-white disabled:opacity-40"
          >
            {suggestion}
          </button>
        ))}
      </div>

      {/* input */}
      <form
        className="flex items-center gap-2 border-t border-white/10 p-3"
        onSubmit={(event) => {
          event.preventDefault()
          primeAudio()
          send(input)
        }}
      >
        {voiceMode !== 'none' && (
          <button
            type="button"
            onPointerDown={(event) => {
              event.preventDefault()
              primeAudio()
              startRecording()
            }}
            onPointerUp={stopRecording}
            onPointerLeave={() => recording && stopRecording()}
            disabled={busy || transcribing}
            className={`relative flex h-10 w-10 shrink-0 items-center justify-center rounded-full transition ${
              recording ? 'bg-red-500 text-white' : 'bg-white/10 text-slate-200 hover:bg-white/20'
            } disabled:opacity-40`}
            title="Hold to talk"
            aria-label="Hold to talk"
          >
            {recording && <span className="absolute inset-0 animate-ping rounded-full bg-red-500/50" />}
            {transcribing ? <Loader2 size={17} className="animate-spin" /> : recording ? <Square size={14} /> : <Mic size={17} />}
          </button>
        )}
        <input
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder={recording ? 'Listening…' : 'Ask anything about this site…'}
          className="min-w-0 flex-1 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder:text-slate-500 focus:border-sky-400/60 focus:outline-none"
        />
        <button
          type="submit"
          disabled={busy || !input.trim()}
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-sky-500 text-white transition hover:bg-sky-400 disabled:opacity-40"
          aria-label="Send"
        >
          {busy ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
        </button>
      </form>
    </div>
  )
}
