import { Capacitor } from '@capacitor/core'

// Explicit local browser preview; native apps always use packaged local content.
export const isLocalMode = Capacitor.isNativePlatform() || import.meta.env.VITE_DATA_MODE === 'local'
export const isNative = Capacitor.isNativePlatform()
export const mobileGraphics = isLocalMode
