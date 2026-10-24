// Twin-local UI state owned by workstream B (the shared store lives in lib/store.ts).
import { create } from 'zustand'
import type { XY } from '../lib/types'

export type RoomGlow = 'free' | 'busy' | 'booked'

export interface Popover {
  kind: 'opening' | 'connector' | 'space'
  id: string
  floorId: string
  point: XY
}

interface TwinUi {
  roomGlow: Record<string, RoomGlow>
  popover: Popover | null
  /** "You are here" space used as the default route origin. */
  originId: string | null
  /** Element ids that should flash red (e.g. blocking doors from a delivery check). */
  flashIds: string[]
  /** Bumped to ask the camera to frame the whole building again. */
  frameAllTick: number
  /** Bumped when the user asks for a route, so the HUD can show its directions. */
  directionsTick: number
  /** Route panel options; the reachable-area overlay follows them too. */
  stepFree: boolean
  minWidth: string
  /** Shade what can't be reached from originId (only while an origin is set). */
  showReach: boolean
  setRoomGlow: (g: Record<string, RoomGlow>) => void
  setPopover: (p: Popover | null) => void
  setOrigin: (id: string | null) => void
  flash: (ids: string[]) => void
  frameAll: () => void
  showDirections: () => void
  setStepFree: (stepFree: boolean) => void
  setMinWidth: (minWidth: string) => void
  setShowReach: (showReach: boolean) => void
}

export const useTwinUi = create<TwinUi>((set) => ({
  roomGlow: {},
  popover: null,
  originId: null,
  flashIds: [],
  frameAllTick: 0,
  directionsTick: 0,
  stepFree: false,
  minWidth: '',
  showReach: true,
  setRoomGlow: (roomGlow) => set({ roomGlow }),
  setPopover: (popover) => set({ popover }),
  setOrigin: (originId) => set({ originId }),
  flash: (flashIds) => set({ flashIds }),
  frameAll: () => set((s) => ({ frameAllTick: s.frameAllTick + 1 })),
  showDirections: () => set((s) => ({ directionsTick: s.directionsTick + 1 })),
  setStepFree: (stepFree) => set({ stepFree }),
  setMinWidth: (minWidth) => set({ minWidth }),
  setShowReach: (showReach) => set({ showReach }),
}))
