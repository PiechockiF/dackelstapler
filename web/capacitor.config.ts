import type { CapacitorConfig } from '@capacitor/cli'

// The app is backend-driven, so the iOS shell loads the UI from a server that also serves /api, /ws and
// /storage: `npm run preview` on the laptop (LAN), or a deployed HTTPS host. Set at `npx cap sync` time.
const url = process.env.CAP_SERVER_URL

const config: CapacitorConfig = {
  appId: 'com.sitetwin.app',
  appName: 'SiteTwin',
  webDir: 'dist',
  server: url ? { url, cleartext: url.startsWith('http://') } : undefined,
}

export default config
