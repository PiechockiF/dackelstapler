import { useTwin } from '../lib/store'
import { snapshotMemo, type TwinSnapshot } from './timeline'

export function useSnapshot(): TwinSnapshot {
  const state = useTwin((s) => s.state)
  const events = useTwin((s) => s.events)
  const ts = useTwin((s) => s.timelineTs)
  return snapshotMemo(state, events, ts)
}
