import clsx from 'clsx'
import { Box, Calendar, Camera, DoorClosed, DoorOpen, MoveRight, PackageCheck, PackageX, Pencil, SquarePlus, Trash2 } from 'lucide-react'
import type { ReactNode } from 'react'
import { useTwin } from '../../lib/store'
import type { Building, EventType, SiteEvent } from '../../lib/types'
import { locate } from '../../twin/geom'
import { useTwinUi } from '../../twin/uiStore'
import { timeAgo } from './ui'

const ICON: Record<EventType, ReactNode> = {
  delivery: <PackageCheck size={15} />,
  delivery_updated: <Pencil size={15} />,
  delivery_removed: <PackageX size={15} />,
  asset_moved: <MoveRight size={15} />,
  asset_added: <SquarePlus size={15} />,
  asset_updated: <Pencil size={15} />,
  asset_removed: <Trash2 size={15} />,
  closure: <DoorClosed size={15} />,
  booking: <Calendar size={15} />,
  door_added: <DoorOpen size={15} />,
  capture: <Camera size={15} />,
}
const TONE: Record<EventType, string> = {
  delivery: 'text-amber-300 bg-amber-400/10',
  delivery_updated: 'text-amber-300 bg-amber-400/10',
  delivery_removed: 'text-slate-400 bg-white/5',
  asset_moved: 'text-sky-300 bg-sky-400/10',
  asset_added: 'text-teal-300 bg-teal-400/10',
  asset_updated: 'text-teal-300 bg-teal-400/10',
  asset_removed: 'text-slate-400 bg-white/5',
  closure: 'text-rose-300 bg-rose-400/10',
  booking: 'text-blue-300 bg-blue-400/10',
  door_added: 'text-emerald-300 bg-emerald-400/10',
  capture: 'text-violet-300 bg-violet-400/10',
}

/** Ids an event is about, most specific first. */
export function eventTargets(e: SiteEvent): string[] {
  const p = e.payload ?? {}
  if (e.type === 'asset_removed' || e.type === 'delivery_removed') return typeof p.space_id === 'string' ? [p.space_id] : []
  if (e.type === 'delivery_updated' && typeof p.delivery_id === 'string') return [p.delivery_id, p.space_id].filter(Boolean)
  const ids = [p.id && e.type === 'delivery' ? p.id : null, p.element_id, p.asset_id, p.space_id, p.opening_id, p.result?.space_id, p.result?.id]
  return ids.filter((x): x is string => typeof x === 'string')
}

export function focusEvent(e: SiteEvent, building: Building) {
  const store = useTwin.getState()
  const ids = eventTargets(e)
  if (!ids.length) return
  const delivery = store.state?.deliveries.find((d) => d.id === ids[0])
  const floor = delivery?.floor_id ?? ids.map((id) => locate(building, id)[0]?.floor_id).find(Boolean)
  if (floor) store.setFocusFloor(floor)
  store.setHighlight({ ids: [ids[0]], label: e.title })
  if (e.type === 'delivery' && e.payload?.status === 'blocked') {
    const block = (e.payload?.check?.route_fit?.blocking_openings ?? []).map((b: { id: string }) => b.id)
    useTwinUi.getState().flash(block)
  }
}

export function FeedPanel({ building }: { building: Building }) {
  const events = useTwin((s) => s.events)
  const ts = useTwin((s) => s.timelineTs)
  const cutoff = ts ? Date.parse(ts) : Infinity
  if (!events.length) return <Empty>No recent changes yet.</Empty>
  return (
    <ul className="flex flex-col gap-1">
      {events.map((e) => {
        const future = Date.parse(e.ts) > cutoff
        return (
          <li key={e.id}>
            <button
              onClick={() => focusEvent(e, building)}
              className={clsx('group flex w-full items-start gap-2.5 rounded-xl px-2 py-2 text-left transition hover:bg-white/5', future && 'opacity-30')}
            >
              <span className={clsx('mt-0.5 grid size-7 shrink-0 place-items-center rounded-lg', TONE[e.type] ?? 'bg-white/5')}>
                {ICON[e.type] ?? <Box size={15} />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] leading-snug text-slate-100 group-hover:text-white">{e.title}</span>
                <span className="text-[11px] text-slate-500">
                  {timeAgo(e.ts)} · {new Date(e.ts).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}
                </span>
              </span>
            </button>
          </li>
        )
      })}
    </ul>
  )
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="px-2 py-6 text-center text-sm text-slate-500">{children}</div>
}
