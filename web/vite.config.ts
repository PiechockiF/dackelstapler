import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const backend = process.env.SITETWIN_API_URL || 'http://localhost:8000'
const proxy = {
  '/api': backend,
  '/ws': { target: backend.replace(/^http/, 'ws'), ws: true },
  '/storage': backend,
}

// The FastAPI server runs on :8000; host: true lets a phone on the same Wi-Fi open /capture.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  preview: { host: true, proxy },
  server: {
    host: true,
    proxy,
  },
})
