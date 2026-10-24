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
  setRoomGlow: (g: Record<string, RoomGlow>) => void
  setPopover: (p: Popover | null) => void
  setOrigin: (id: string | null) => void
  flash: (ids: string[]) => void
  frameAll: () => void
}

export const useTwinUi = create<TwinUi>((set) => ({
  roomGlow: {},
  popover: null,
  originId: null,
  flashIds: [],
  frameAllTick: 0,
  setRoomGlow: (roomGlow) => set({ roomGlow }),
  setPopover: (popover) => set({ popover }),
  setOrigin: (originId) => set({ originId }),
  flash: (flashIds) => set({ flashIds }),
  frameAll: () => set((s) => ({ frameAllTick: s.frameAllTick + 1 })),
}))
