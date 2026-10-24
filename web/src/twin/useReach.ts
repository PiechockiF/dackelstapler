import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { api } from '../lib/api'
import { useTwin } from '../lib/store'
import type { Reachable } from '../lib/types'
import { useTwinUi } from './uiStore'

const toSet = (r: Reachable) => new Set(r.space_ids)

/** Spaces reachable from "I'm here" under the Route panel's options and the live closures (server rules);
 * null while the overlay is off or no origin is set. */
export function useReach(): Set<string> | null {
  const siteId = useTwin((s) => s.siteId)
  const closed = useTwin((s) => s.state?.closed)
  const addedDoors = useTwin((s) => s.state?.added_openings.length)
  const originId = useTwinUi((s) => s.originId)
  const stepFree = useTwinUi((s) => s.stepFree)
  const minWidth = Number(useTwinUi((s) => s.minWidth)) || undefined
  const on = useTwinUi((s) => s.showReach) && !!siteId && !!originId
  const { data } = useQuery({
    queryKey: ['reachable', siteId, originId, stepFree, minWidth, closed, addedDoors],
    queryFn: () => api.reachable(siteId!, originId!, { step_free: stepFree, min_width_m: minWidth }),
    enabled: on,
    placeholderData: keepPreviousData,
    select: toSet,
  })
  return on ? data ?? null : null
}
