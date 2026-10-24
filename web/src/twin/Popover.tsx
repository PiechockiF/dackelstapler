import { Html } from '@react-three/drei'
import { DoorClosed, DoorOpen, LocateFixed, Navigation, PackagePlus, Wrench, X } from 'lucide-react'
import { useState } from 'react'
import type { Building } from '../lib/types'
import { useTwin } from '../lib/store'
import { navigate, originOf, toggleClosed } from './actions'
import { FloorAnchor } from './FloorAnchor'
import { indexBuilding } from './geom'
import { useLayout } from './layout'
import { useTwinUi } from './uiStore'
import { useSnapshot } from './useSnapshot'

export function Popover({ building, siteId }: { building: Building; siteId: string }) {
  const pop = useTwinUi((s) => s.popover)
  const setPop = useTwinUi((s) => s.setPopover)
  const setOrigin = useTwinUi((s) => s.setOrigin)
  const snap = useSnapshot()
  const layout = useLayout()
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  if (!pop || !layout.byId.has(pop.floorId)) return null
  const idx = indexBuilding(building)
  const [x, z] = layout.toXZ(pop.point)
  const closed = snap.closed.has(pop.id)

  let title = pop.id
  let sub = ''
  if (pop.kind === 'opening') {
    const o = idx.openings.get(pop.id)
    const names = o?.space_ids.map((s) => (s === 'outside' ? 'Outside' : idx.spaces.get(s)?.name ?? s)) ?? []
    title = o?.space_ids.includes('outside') ? 'Entrance' : o?.kind === 'opening' ? 'Opening' : 'Door'
    sub = `${names.join(' ↔ ')} · ${o?.width_m.toFixed(2)} m${o?.step_free ? '' : ' · steps'}`
  } else if (pop.kind === 'connector') {
    const c = idx.connectors.get(pop.id)
    title = c?.name ?? pop.id
    sub = `${c?.kind === 'lift' ? 'Lift' : 'Stairs'} · ${c?.floor_ids.length} stops${c?.step_free ? ' · step-free' : ''}`
  } else {
    const s = idx.spaces.get(pop.id)
    title = s?.name ?? pop.id
    sub = `${(s?.room_type ?? s?.type ?? '').replace(/_/g, ' ')} · ${(idx.areas.get(pop.id) ?? 0).toFixed(1)} m²`
  }

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    setErr(null)
    try {
      await fn()
    } catch (e) {
      setErr(String((e as Error).message ?? e))
    } finally {
      setBusy(false)
    }
  }

  const btn = 'flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition disabled:opacity-50'
  return (
    <FloorAnchor floorId={pop.floorId}>
      <Html position={[x, 2.6, z]} zIndexRange={[60, 40]} style={{ pointerEvents: 'auto' }}>
        <div className="-translate-x-1/2 -translate-y-full pb-3">
          <div className="w-60 rounded-xl border border-white/15 bg-slate-950/80 p-3 text-slate-100 shadow-2xl shadow-sky-950/50 backdrop-blur-md">
            <div className="flex items-start justify-between gap-2">
              <div>
                <div className="text-sm font-semibold leading-tight">{title}</div>
                <div className="mt-0.5 text-[11px] text-slate-400">{sub.charAt(0).toUpperCase() + sub.slice(1)}</div>
              </div>
              <button className="rounded p-0.5 text-slate-400 hover:bg-white/10 hover:text-white" onClick={() => setPop(null)}>
                <X size={14} />
              </button>
            </div>
            {closed && <div className="mt-2 rounded-md bg-rose-500/15 px-2 py-1 text-[11px] font-medium text-rose-300">Closed</div>}
            <div className="mt-2.5 flex flex-wrap gap-1.5">
              {pop.kind !== 'space' ? (
                <button
                  disabled={busy}
                  className={`${btn} ${closed ? 'bg-emerald-500/20 text-emerald-200 hover:bg-emerald-500/30' : 'bg-rose-500/20 text-rose-200 hover:bg-rose-500/30'}`}
                  onClick={() => run(() => toggleClosed(siteId, pop.id, !closed))}
                >
                  {closed ? <DoorOpen size={14} /> : <DoorClosed size={14} />}
                  {closed ? 'Reopen' : 'Close'}
                </button>
              ) : (
                <>
                  <button
                    className={`${btn} bg-white/5 text-slate-200 hover:bg-white/10`}
                    onClick={() => {
                      setOrigin(pop.id)
                      useTwin.getState().setHighlight({ ids: [pop.id], label: 'You are here' })
                      setPop(null)
                      // Start picked after the target: route again from here.
                      const route = useTwin.getState().route
                      const to = route?.to_space_id ?? route?.space_path[route.space_path.length - 1]
                      if (route && to && to !== pop.id) {
                        void navigate(siteId, to, { from: pop.id, step_free: route.step_free, min_width_m: route.min_width_m ?? undefined }).catch(() => undefined)
                      }
                    }}
                  >
                    <LocateFixed size={14} /> I'm here
                  </button>
                  <button disabled={busy || pop.id === originOf(building)} className={`${btn} bg-sky-500/20 text-sky-100 hover:bg-sky-500/30`} onClick={() => run(() => navigate(siteId, pop.id))}>
                    <Navigation size={14} /> Navigate here
                  </button>
                  <button
                    className={`${btn} bg-white/5 text-slate-200 hover:bg-white/10`}
                    onClick={() => {
                      setPop(null)
                      useTwinUi.getState().openManualEntry({ mode: 'equipment', spaceId: pop.id })
                    }}
                  >
                    <Wrench size={14} /> Equipment
                  </button>
                  <button
                    className={`${btn} bg-white/5 text-slate-200 hover:bg-white/10`}
                    onClick={() => {
                      setPop(null)
                      useTwinUi.getState().openManualEntry({ mode: 'delivery', spaceId: pop.id })
                    }}
                  >
                    <PackagePlus size={14} /> Log delivery
                  </button>
                </>
              )}
            </div>
            {err && <div className="mt-2 text-[11px] text-rose-300">{err}</div>}
          </div>
        </div>
      </Html>
    </FloorAnchor>
  )
}
