// Replays the event log to show the twin at a past time (timelineTs). Best effort: the live
// SiteState is the truth for "now"; events after the scrub time are undone in reverse order.
import type { Delivery, SiteEvent, SiteState, XY } from '../lib/types'

export interface TwinSnapshot {
  closed: Set<string>
  overrides: Record<string, { position: XY; floor_id: string; space_id: string }>
  deliveries: Delivery[]
}

export function snapshotAt(state: SiteState | null, events: SiteEvent[], ts: string | null): TwinSnapshot {
  const closed = new Set(state?.closed ?? [])
  const overrides = { ...(state?.asset_overrides ?? {}) }
  let deliveries = state?.deliveries ?? []
  if (!ts) return { closed, overrides, deliveries }
  const t = Date.parse(ts)
  deliveries = deliveries.filter((d) => Date.parse(d.ts) <= t)
  const later = events.filter((e) => Date.parse(e.ts) > t).sort((a, b) => b.ts.localeCompare(a.ts))
  // `later` is newest first: undo from newest to oldest.
  for (const e of later) {
    const p = e.payload ?? {}
    if (e.type === 'closure' && p.element_id) {
      if (p.closed) closed.delete(p.element_id)
      else closed.add(p.element_id)
    } else if (e.type === 'asset_moved' && p.asset_id) {
      if (p.from?.position && p.from?.floor_id) overrides[p.asset_id] = p.from
      else delete overrides[p.asset_id]
    }
  }
  return { closed, overrides, deliveries }
}

let last: { state: SiteState | null; events: SiteEvent[]; ts: string | null; snap: TwinSnapshot } | null = null
/** Memoized across components so they share one snapshot object per (state, events, ts). */
export function snapshotMemo(state: SiteState | null, events: SiteEvent[], ts: string | null): TwinSnapshot {
  if (last && last.state === state && last.events === events && last.ts === ts) return last.snap
  const snap = snapshotAt(state, events, ts)
  last = { state, events, ts, snap }
  return snap
}
