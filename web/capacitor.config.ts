import type { CapacitorConfig } from '@capacitor/cli'

// Releases always use bundled assets and the local provider. Remote URLs are an
// explicit live-development option only; ios:archive clears both variables.
const url = process.env.CAP_LIVE_RELOAD === '1' ? process.env.CAP_SERVER_URL : undefined

const config: CapacitorConfig = {
  appId: 'com.sitetwin.app',
  appName: 'Dackel',
  webDir: 'dist',
  server: url ? { url, cleartext: url.startsWith('http://') } : undefined,
}

export default config
