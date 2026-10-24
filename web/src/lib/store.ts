import { create } from 'zustand'
import type { Building, Route, SiteEvent, SiteState } from './types'

// Shared UI state: the chat (D) writes into it, the 3D twin (B) renders from it.
interface TwinStore {
  siteId: string | null
  building: Building | null
  state: SiteState | null
  route: Route | null
  highlight: { ids: string[]; label?: string } | null
  focusFloorId: string | null
  exploded: boolean
  /** ISO time the twin shows; null means live. */
  timelineTs: string | null
  events: SiteEvent[]
  selectedId: string | null
  understood: string[]

  setSite: (siteId: string, building: Building) => void
  setState: (state: SiteState) => void
  setRoute: (route: Route | null) => void
  setHighlight: (highlight: { ids: string[]; label?: string } | null) => void
  setFocusFloor: (floorId: string | null) => void
  setExploded: (exploded: boolean) => void
  setTimelineTs: (ts: string | null) => void
  setEvents: (events: SiteEvent[]) => void
  pushEvent: (event: SiteEvent) => void
  select: (id: string | null) => void
  setUnderstood: (chips: string[]) => void
}

export const useTwin = create<TwinStore>((set) => ({
  siteId: null,
  building: null,
  state: null,
  route: null,
  highlight: null,
  focusFloorId: null,
  exploded: true,
  timelineTs: null,
  events: [],
  selectedId: null,
  understood: [],

  setSite: (siteId, building) =>
    set({ siteId, building, state: null, route: null, highlight: null, focusFloorId: null, events: [], selectedId: null, understood: [], timelineTs: null }),
  setState: (state) => set({ state }),
  setRoute: (route) => set({ route }),
  setHighlight: (highlight) => set({ highlight }),
  setFocusFloor: (focusFloorId) => set({ focusFloorId }),
  setExploded: (exploded) => set({ exploded }),
  setTimelineTs: (timelineTs) => set({ timelineTs }),
  setEvents: (events) => set({ events }),
  pushEvent: (event) => set((store) => ({ events: [event, ...store.events.filter((e) => e.id !== event.id)] })),
  select: (selectedId) => set({ selectedId }),
  setUnderstood: (understood) => set({ understood }),
}))
