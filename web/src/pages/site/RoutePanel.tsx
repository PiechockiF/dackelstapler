import clsx from 'clsx'
import { ArrowUpDown, Footprints, LocateFixed, Navigation, X } from 'lucide-react'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useTwin } from '../../lib/store'
import { useNav } from '../../nav/navStore'
import { walkingRoute } from '../../nav/pdr'
import type { Building } from '../../lib/types'
import { navigate, originOf } from '../../twin/actions'
import { indexBuilding } from '../../twin/geom'
import { useTwinUi } from '../../twin/uiStore'
import { Btn, Field, inputCls } from './ui'

/** A sideways-scrolling row of places for one field; narrows to what's typed. */
function PlaceChips({ options, value, onPick, lead }: { options: string[]; value: string; onPick: (v: string) => void; lead?: ReactNode }) {
  const q = value.trim().toLowerCase()
  const picked = options.includes(value.trim()) ? value.trim() : null
  // A picked place leads the row so it stays visible; otherwise narrow to what's typed.
  const shown = (picked ? [picked, ...options.filter((o) => o !== picked)] : q ? options.filter((o) => o.toLowerCase().includes(q)) : options).slice(0, 40)
  if (!shown.length && !lead) return null
  return (
    <div className="-mx-1 mt-0.5 flex gap-1.5 overflow-x-auto px-1 pb-0.5 normal-case tracking-normal [scrollbar-width:none]">
      {lead}
      {shown.map((o) => (
        <button
          key={o}
          type="button"
          onClick={() => onPick(o)}
          className={clsx(
            'shrink-0 whitespace-nowrap rounded-full border px-2.5 py-1 text-[11px] font-normal transition',
            o === value.trim() ? 'border-sky-400/50 bg-sky-500/20 text-sky-100' : 'border-white/10 bg-white/[0.04] text-slate-300 hover:border-sky-300/40',
          )}
        >
          {o}
        </button>
      ))}
    </div>
  )
}

export function RoutePanel({ building, siteId }: { building: Building; siteId: string }) {
  const route = useTwin((s) => s.route)
  const originId = useTwinUi((s) => s.originId)
  const idx = indexBuilding(building)
  const defaultFrom = originId ?? originOf(building)
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const stepFree = useTwinUi((s) => s.stepFree)
  const setStepFree = useTwinUi((s) => s.setStepFree)
  const minWidth = useTwinUi((s) => s.minWidth)
  const setMinWidth = useTwinUi((s) => s.setMinWidth)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  // Names → ids where the name is unique; everything else goes to the server as typed (it resolves refs/names).
  const byName = useMemo(() => {
    const m = new Map<string, string | null>()
    for (const s of building.spaces) {
      if (s.type === 'corridor') continue
      m.set(s.name, m.has(s.name) ? null : s.id)
    }
    return m
  }, [building])
  const options = useMemo(() => [...byName.keys()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).slice(0, 2000), [byName])
  const resolve = (v: string) => byName.get(v.trim()) ?? v.trim()
  // Show the room's name when no other space shares it (the server resolves it back), otherwise its id.
  const nameCount = useMemo(() => {
    const m = new Map<string, number>()
    for (const s of building.spaces) m.set(s.name, (m.get(s.name) ?? 0) + 1)
    return m
  }, [building])
  const label = (id: string) => {
    const name = idx.spaces.get(id)?.name
    return name && nameCount.get(name) === 1 ? name : id
  }

  // Routes picked on the map (or anywhere else) fill in their endpoints, so they can be tweaked here.
  const routeFrom = route?.from_space_id ?? route?.space_path[0]
  const routeTo = route?.to_space_id ?? route?.space_path[route.space_path.length - 1]
  useEffect(() => {
    if (routeFrom) setFrom(label(routeFrom))
    if (routeTo) setTo(label(routeTo))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeFrom, routeTo])

  const go = async () => {
    setBusy(true)
    setErr(null)
    try {
      await navigate(siteId, resolve(to), {
        from: from.trim() ? resolve(from) : undefined,
        step_free: stepFree,
        min_width_m: minWidth ? Number(minWidth) : undefined,
      })
    } catch (e) {
      setErr(String((e as Error).message))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <datalist id="twin-spaces">
        {options.map((o) => (
          <option key={o} value={o} />
        ))}
      </datalist>
      <Field label="From" as="div">
        <input list="twin-spaces" value={from} onChange={(e) => setFrom(e.target.value)} placeholder={defaultFrom ? `${idx.spaces.get(defaultFrom)?.name ?? defaultFrom} (you are here)` : 'Room, ref or id'} className={inputCls} />
        <PlaceChips
          options={options}
          value={from}
          onPick={setFrom}
          lead={defaultFrom && (
            <button type="button" onClick={() => setFrom('')} className={clsx('flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border px-2.5 py-1 text-[11px] font-normal', !from.trim() ? 'border-emerald-400/50 bg-emerald-500/15 text-emerald-100' : 'border-white/10 bg-white/[0.04] text-slate-300')}>
              <LocateFixed size={11} /> You are here
            </button>
          )}
        />
      </Field>
      <div className="-my-1.5 flex justify-center">
        <button className="rounded-full p-1 text-slate-400 hover:bg-white/10 hover:text-white" onClick={() => { setFrom(to); setTo(from) }} title="Swap">
          <ArrowUpDown size={14} />
        </button>
      </div>
      <Field label="To" as="div">
        <input list="twin-spaces" value={to} onChange={(e) => setTo(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && to && go()} placeholder="Room, ref, asset or id" className={inputCls} />
        <PlaceChips options={options} value={to} onPick={setTo} />
      </Field>
      <div className="flex items-center gap-3">
        <label className="flex cursor-pointer items-center gap-2 whitespace-nowrap text-xs text-slate-300">
          <input type="checkbox" checked={stepFree} onChange={(e) => setStepFree(e.target.checked)} className="accent-violet-400" />
          Step-free
        </label>
        <label className="ml-auto flex items-center gap-2 whitespace-nowrap text-xs text-slate-300">
          Min width
          <input type="number" step={0.1} min={0} value={minWidth} onChange={(e) => setMinWidth(e.target.value)} placeholder="m" className={`${inputCls.replace('w-full ', '')} w-20 py-1`} />
        </label>
      </div>
      <div className="flex gap-2">
        <Btn tone="accent" className="flex-1" disabled={busy || !to.trim()} onClick={go}>
          <Navigation size={14} /> Route
        </Btn>
        {route && (
          <Btn onClick={() => useTwin.getState().setRoute(null)}>
            <X size={14} /> Clear
          </Btn>
        )}
      </div>
      {route?.reachable && (
        <Btn tone="ok" className="py-2" onClick={() => void useNav.getState().begin(siteId, route)}>
          <Footprints size={14} /> Start navigation
        </Btn>
      )}
      {err && <div className="text-xs text-rose-300">{err}</div>}
      {route && !route.reachable && <div className="text-xs text-rose-300">{route.message ?? 'No route is available with these constraints.'}</div>}
      {route?.reachable && (
        <div className="rounded-xl border border-white/10 bg-white/[0.03] p-3">
          <div className="flex items-baseline gap-2">
            <span className="text-2xl font-semibold text-sky-200">{walkingRoute(route, building).total.toFixed(0)}</span>
            <span className="text-sm text-slate-400">m</span>
            {route.step_free && <span className="ml-auto flex items-center gap-1 rounded-full bg-violet-500/20 px-2 py-0.5 text-[11px] text-violet-200"><Footprints size={11} /> step-free</span>}
          </div>
          <ol className="mt-2 flex flex-col gap-1.5 text-[12px] text-slate-300">
            {route.steps.map((s, i) => (
              <li key={i} className="flex gap-2">
                <span className="mt-px grid size-4 shrink-0 place-items-center rounded-full bg-sky-500/20 text-[10px] text-sky-200">{i + 1}</span>
                <span>{s}</span>
              </li>
            ))}
          </ol>
          {(route as { message?: string }).message && <div className="mt-2 text-[11px] text-amber-200">{(route as { message?: string }).message}</div>}
          {!!route.blocking_openings?.length && (
            <div className="mt-2 text-[11px] text-rose-300">{route.blocking_openings.length} door(s) too narrow on the direct way.</div>
          )}
        </div>
      )}
    </div>
  )
}
