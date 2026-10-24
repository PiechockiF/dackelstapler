// Voice for the local assistant. On iOS: the Voice plugin (ios/App/App/VoicePlugin.swift), Apple's speech
// recognition (on-device where supported) and speech synthesis. In a browser: the Web Speech API.
import { registerPlugin, WebPlugin, type PluginListenerHandle } from '@capacitor/core'

export interface VoicePlugin {
  isAvailable(): Promise<{ available: boolean; onDevice?: boolean }>
  requestPermission(): Promise<{ granted: boolean }>
  /** Hints: names the recognizer should prefer (rooms, stairs…). */
  startListening(opts: { hints?: string[] }): Promise<void>
  stopListening(): Promise<void>
  speak(opts: { text: string }): Promise<void>
  /** Play base64 mp3 as a spoken answer (same silent-switch rules as speak). */
  playAudio(opts: { data: string }): Promise<void>
  stopSpeaking(): Promise<void>
  addListener(event: 'speech', fn: (e: { text: string; final: boolean }) => void): Promise<PluginListenerHandle>
  addListener(event: 'speechError', fn: (e: { message: string }) => void): Promise<PluginListenerHandle>
  addListener(event: 'speechEnd' | 'speakEnd', fn: () => void): Promise<PluginListenerHandle>
}

interface Recognition {
  lang: string
  interimResults: boolean
  continuous: boolean
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null
  onerror: ((e: { error: string }) => void) | null
  onend: (() => void) | null
  start(): void
  stop(): void
  abort(): void
}
type RecognitionCtor = new () => Recognition
const recognitionCtor = (): RecognitionCtor | null => {
  const w = globalThis as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

class WebVoice extends WebPlugin {
  private rec: Recognition | null = null

  async isAvailable() { return { available: !!recognitionCtor() } }
  async requestPermission() { return { granted: !!recognitionCtor() } }

  async startListening() {
    const Ctor = recognitionCtor()
    if (!Ctor) throw new Error('Voice input is not supported in this browser.')
    this.rec?.abort()
    const rec = new Ctor()
    rec.lang = 'en-US'
    rec.interimResults = true
    rec.continuous = false
    rec.onresult = (e) => {
      const results = Array.from(e.results)
      const text = results.map((r) => r[0]?.transcript ?? '').join('')
      this.notifyListeners('speech', { text, final: results.every((r) => r.isFinal) })
    }
    rec.onerror = (e) => this.notifyListeners('speechError', { message: e.error })
    rec.onend = () => {
      if (this.rec === rec) this.rec = null
      this.notifyListeners('speechEnd', {})
    }
    this.rec = rec
    rec.start()
  }

  async stopListening() { this.rec?.stop() }

  async speak({ text }: { text: string }) {
    if (!('speechSynthesis' in globalThis)) return
    const u = new SpeechSynthesisUtterance(text)
    u.lang = 'en-US'
    u.onend = () => this.notifyListeners('speakEnd', {})
    speechSynthesis.cancel()
    speechSynthesis.speak(u)
  }

  private audio: HTMLAudioElement | null = null

  async playAudio({ data }: { data: string }) {
    await this.stopSpeaking()
    const audio = new Audio(`data:audio/mpeg;base64,${data}`)
    audio.onended = () => this.notifyListeners('speakEnd', {})
    this.audio = audio
    await audio.play()
  }

  async stopSpeaking() {
    if ('speechSynthesis' in globalThis) speechSynthesis.cancel()
    this.audio?.pause()
    this.audio = null
  }
}

export const Voice = registerPlugin<VoicePlugin>('Voice', { web: () => new WebVoice() })

/** ElevenLabs voice built into the iOS app from the repo-root .env (see vite.config.ts); empty elsewhere. */
declare const __DACKEL_ELEVENLABS_KEY__: string
declare const __DACKEL_ELEVENLABS_VOICE__: string
const elevenKey = typeof __DACKEL_ELEVENLABS_KEY__ === 'string' ? __DACKEL_ELEVENLABS_KEY__ : ''
const elevenVoice = typeof __DACKEL_ELEVENLABS_VOICE__ === 'string' ? __DACKEL_ELEVENLABS_VOICE__ : ''

async function elevenLabsMp3(text: string): Promise<string> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 10_000)
  try {
    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${elevenVoice}?output_format=mp3_44100_64`, {
      method: 'POST',
      headers: { 'xi-api-key': elevenKey, 'content-type': 'application/json', accept: 'audio/mpeg' },
      body: JSON.stringify({ text, model_id: 'eleven_flash_v2_5' }),
      signal: ctrl.signal,
    })
    if (!res.ok) throw new Error(`ElevenLabs ${res.status}`)
    const bytes = new Uint8Array(await res.arrayBuffer())
    let bin = ''
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
    return btoa(bin)
  } finally {
    clearTimeout(timer)
  }
}

let speakSeq = 0

/** Read an answer aloud: the ElevenLabs voice when it's set up and reachable, Apple's voice otherwise. */
export async function sayAloud(text: string) {
  const seq = ++speakSeq
  if (elevenKey && elevenVoice) {
    try {
      const data = await elevenLabsMp3(text)
      if (seq !== speakSeq) return // a newer answer or the mic took over
      return await Voice.playAudio({ data })
    } catch {
      /* offline or API trouble: fall back to the built-in voice */
    }
  }
  if (seq === speakSeq) await Voice.speak({ text })
}

/** Stop speaking, including an answer whose audio is still loading. */
export function stopAloud() {
  speakSeq++
  return Voice.stopSpeaking()
}

/** What's worth reading out: the first lines of a reply, without symbols that sound odd. */
export function speakable(text: string): string {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean)
  let out = lines.slice(0, 3).join('. ')
  if (lines.length > 3) out += `. And ${lines.length - 3} more.`
  return out.replace(/[—–]/g, ', ').replace(/m²/g, ' square metres').replace(/\s+/g, ' ').slice(0, 400)
}
