import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'

const backend = process.env.SITETWIN_API_URL || 'http://localhost:8000'
const proxy = {
  '/api': backend,
  '/ws': { target: backend.replace(/^http/, 'ws'), ws: true },
  '/storage': backend,
}

// The offline iOS app calls Claude directly with the team key from the repo-root .env, read at build time.
// Only local-mode bundles (the iOS app, dev:local) get it; the server-mode web build never does.
const localMode = process.env.VITE_DATA_MODE === 'local'
const rootEnv = localMode ? loadEnv('production', '..', '') : {}
const anthropicKey = rootEnv.ANTHROPIC_API_KEY ?? ''
// ElevenLabs voice for spoken answers (the app's own entries, separate from the server's).
const elevenKey = rootEnv.DACKEL_ELEVENLABS_API_KEY ?? ''
const elevenVoice = rootEnv.DACKEL_ELEVENLABS_VOICE_ID ?? ''

// The FastAPI server runs on :8000; host: true lets a phone on the same Wi-Fi open /capture.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: {
    __DACKEL_ANTHROPIC_KEY__: JSON.stringify(anthropicKey),
    __DACKEL_ELEVENLABS_KEY__: JSON.stringify(elevenKey),
    __DACKEL_ELEVENLABS_VOICE__: JSON.stringify(elevenVoice),
  },
  preview: { host: true, proxy },
  server: {
    host: true,
    proxy,
  },
})
