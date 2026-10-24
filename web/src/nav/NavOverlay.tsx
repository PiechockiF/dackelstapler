// Walking navigation HUD: line-up sheet, next-instruction card, progress bar and the floor-change,
// off-route and arrival prompts.
import clsx from 'clsx'
import {
  ArrowUp, ArrowUpDown, ArrowUpLeft, ArrowUpRight, Compass, CornerUpLeft, CornerUpRight, Crosshair, Flag,
  Footprints, LocateFixed, Minus, Plus, TriangleAlert, Undo2, X,
} from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { isNative } from '../lib/mode'
import type { Building } from '../lib/types'
import { Btn, Glass } from '../pages/site/ui'
import { etaMin, upcoming, useNav } from './navStore'
import type { Maneuver, ManeuverKind } from './pdr'

const ICONS: Record<ManeuverKind, ReactNode> = {
  start: <ArrowUp size={26} />,
  left: <CornerUpLeft size={26} />,
  right: <CornerUpRight size={26} />,
  'slight-left': <ArrowUpLeft size={26} />,
  'slight-right': <ArrowUpRight size={26} />,
  uturn: <Undo2 size={26} />,
  stairs: <ArrowUpDown size={26} />,
  lift: <ArrowUpDown size={26} />,
  arrive: <Flag size={26} />,
}

const fmtM = (m: number) => (m < 10 ? `${Math.max(1, Math.round(m))} m` : `${Math.round(m / 5) * 5} m`)
const isTurn = (k: ManeuverKind) => k === 'left' || k === 'right' || k === 'slight-left' || k === 'slight-right' || k === 'uturn'

type Tone = 'sky' | 'amber' | 'emerald'
const TONES: Record<Tone, string> = {
  sky: 'bg-sky-500/20 text-sky-100',
  amber: 'bg-amber-500/20 text-amber-100',
  emerald: 'bg-emerald-500/20 text-emerald-100',
}

function Instruction({ icon, tone = 'sky', kicker, title, detail, children }: { icon: ReactNode; tone?: Tone; kicker?: string; title: string; detail?: string; children?: ReactNode }) {
  return (
    <Glass className={clsx('pointer-events-auto flex flex-col gap-3 p-3', tone === 'amber' && 'border-amber-400/30', tone === 'emerald' && 'border-emerald-400/30')}>
      <div className="flex items-center gap-3">
        <div className={clsx('grid size-14 shrink-0 place-items-center rounded-xl', TONES[tone])}>{icon}</div>
        <div className="min-w-0 flex-1">
          {kicker && <div className="text-[11px] font-medium uppercase tracking-wide text-slate-400">{kicker}</div>}
          <div className="text-lg font-semibold leading-tight text-white">{title}</div>
          {detail && <div className="mt-0.5 truncate text-xs text-slate-300">{detail}</div>}
        </div>
      </div>
      {children}
    </Glass>
  )
}

const TURN_WORD: Partial<Record<ManeuverKind, string>> = { left: 'left turn', right: 'right turn', 'slight-left': 'bend left', 'slight-right': 'bend right', uturn: 'turnaround' }

/** "Where are you?" answer for a route landmark. */
function anchorLabel(m: Maneuver): string {
  if (m.kind === 'start') return 'Where I started'
  if (m.kind === 'arrive') return 'At the destination'
  if (m.kind === 'stairs' || m.kind === 'lift') return `Just off the ${m.kind}`
  return `At the ${TURN_WORD[m.kind]}${m.landmark ? ` ${m.landmark}` : ''}`
}

export function NavOverlay({ building, compact }: { building: Building; compact: boolean }) {
  const nav = useNav(useShallow((s) => ({
    status: s.status, maneuvers: s.maneuvers, globalS: s.globalS, remainingM: s.remainingM, steps: s.steps,
    follow: s.follow, stepLengthM: s.stepLengthM, error: s.error, uncertaintyM: s.uncertaintyM, route: s.route,
  })))
  const actions = useNav.getState()
  const [recal, setRecal] = useState(false)
  if (nav.status === 'idle') return null

  const next = upcoming(nav)
  const destination = nav.route?.to_space_id ? building.spaces.find((s) => s.id === nav.route!.to_space_id)?.name : undefined
  const start = nav.maneuvers[0]
  const origin = nav.route?.from_space_id ? building.spaces.find((s) => s.id === nav.route!.from_space_id)?.name : undefined

  let top: ReactNode
  if (nav.status === 'aligning') {
    top = (
      <Instruction icon={<Compass size={26} />} kicker="Line up" title="Face along the blue line" detail={[origin && `From ${origin}`, start?.landmark && `first through the door ${start.landmark}`].filter(Boolean).join(', ') || undefined}>
        <p className="text-xs leading-relaxed text-slate-300">
          Hold the phone flat in front of you, top edge pointing ahead, and turn until the way you face matches the line on the map. Then tap Start walking.
        </p>
      </Instruction>
    )
  } else if (nav.status === 'floorChange') {
    const hop = nav.maneuvers.find((m) => (m.kind === 'stairs' || m.kind === 'lift') && m.s >= nav.globalS - 3.5)
    const floor = hop?.text.split(' to ').at(-1)
    top = (
      <Instruction icon={ICONS[hop?.kind ?? 'stairs']} kicker="Change floor" title={hop?.text ?? 'Change floor'}>
        <Btn tone="ok" className="py-2.5 text-sm" onClick={actions.confirmFloor}>I'm on {floor ?? 'the next floor'}</Btn>
      </Instruction>
    )
  } else if (nav.status === 'offRoute') {
    top = (
      <Instruction icon={<TriangleAlert size={26} />} tone="amber" kicker="Off the route?" title="Your steps lead away from the line">
        <div className="grid grid-cols-2 gap-2">
          <Btn tone="accent" className="py-2" onClick={() => void actions.reroute()}>Reroute from here</Btn>
          <Btn className="py-2" onClick={() => actions.anchorAt(nav.globalS)}>I'm on the line</Btn>
        </div>
      </Instruction>
    )
  } else if (nav.status === 'arrived') {
    top = (
      <Instruction icon={<Flag size={26} />} tone="emerald" kicker="You have arrived" title={destination ?? 'Destination'} detail={`${nav.steps} steps · stride ${nav.stepLengthM.toFixed(2)} m`}>
        <Btn tone="ok" className="py-2.5 text-sm" onClick={actions.end}>Done</Btn>
      </Instruction>
    )
  } else if (next) {
    const far = isTurn(next.m.kind) && next.inM > 30
    top = (
      <Instruction
        icon={far ? ICONS.start : ICONS[next.m.kind]}
        kicker={far ? `for ${fmtM(next.inM)}` : next.m.kind === 'arrive' && next.inM < 3 ? 'Now' : `In ${fmtM(next.inM)}`}
        title={far ? 'Continue straight' : next.m.text}
        detail={far ? `then ${next.m.text.toLowerCase()}${next.m.landmark ? ` ${next.m.landmark}` : ''}` : next.m.landmark}
      />
    )
  }

  // Recalibration targets: route corners/floor changes around the walker.
  const anchors: Maneuver[] = nav.maneuvers.filter((m) => m.s >= nav.globalS - 15 && m.s <= nav.globalS + 30).slice(0, 4)
  const walking = nav.status === 'active' || nav.status === 'offRoute' || nav.status === 'floorChange'

  return (
    <>
      <div className="pointer-events-none absolute inset-x-4 top-4 z-30 mx-auto max-w-md">{top}</div>

      <div className={clsx('pointer-events-none absolute inset-x-4 z-30 mx-auto flex max-w-md flex-col gap-2', compact ? 'bottom-4' : 'bottom-6')}>
        {nav.error && <Glass className="pointer-events-auto px-3 py-2 text-xs text-rose-300">{nav.error}</Glass>}

        {recal && walking && (
          <Glass className="pointer-events-auto flex flex-col gap-1 p-2">
            <div className="px-1 pb-1 text-[11px] font-medium uppercase tracking-wide text-slate-400">Where are you?</div>
            {anchors.map((m) => (
              <button key={`${m.kind}-${m.s}`} className="flex items-center gap-2 rounded-lg px-2 py-2 text-left text-sm text-slate-200 hover:bg-white/5" onClick={() => { actions.anchorAt(m.s); setRecal(false) }}>
                <span className="text-sky-300">{ICONS[m.kind]}</span>
                <span className="min-w-0 flex-1 truncate">{anchorLabel(m)}</span>
                <span className="shrink-0 text-[11px] text-slate-500">{m.s >= nav.globalS ? `${Math.round(m.s - nav.globalS)} m ahead` : `${Math.round(nav.globalS - m.s)} m back`}</span>
              </button>
            ))}
            {!anchors.length && <div className="px-2 py-1 text-xs text-slate-400">No landmarks nearby on the route.</div>}
          </Glass>
        )}

        {nav.status === 'aligning' && (
          <Glass className="pointer-events-auto flex flex-col gap-3 p-3">
            <div className="flex items-center gap-3">
              <span className="text-[11px] font-medium uppercase tracking-wide text-slate-400">Stride</span>
              <div className="ml-auto flex items-center gap-1">
                <Btn tone="ghost" aria-label="Shorter stride" onClick={() => actions.setStepLength(nav.stepLengthM - 0.05)}><Minus size={14} /></Btn>
                <span className="w-16 text-center text-sm tabular-nums text-slate-100">{nav.stepLengthM.toFixed(2)} m</span>
                <Btn tone="ghost" aria-label="Longer stride" onClick={() => actions.setStepLength(nav.stepLengthM + 0.05)}><Plus size={14} /></Btn>
              </div>
            </div>
            <div className="flex gap-2">
              <Btn tone="ok" className="flex-1 py-2.5 text-sm" onClick={actions.startWalking}><Footprints size={16} /> Start walking</Btn>
              <Btn tone="ghost" className="py-2.5" onClick={actions.end}>Cancel</Btn>
            </div>
          </Glass>
        )}

        {walking && (
          <Glass className="pointer-events-auto flex items-center gap-3 px-3 py-2.5">
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2">
                <span className="text-xl font-semibold tabular-nums text-sky-200">{Math.round(nav.remainingM)}</span>
                <span className="text-xs text-slate-400">m · ~{etaMin(nav.remainingM)} min</span>
              </div>
              <div className="truncate text-[11px] text-slate-500">
                {nav.steps} steps · ±{nav.uncertaintyM.toFixed(0)} m{!isNative && ' · simulated (← → veer, space pause)'}
              </div>
            </div>
            {!nav.follow && <Btn aria-label="Recenter" title="Recenter" onClick={() => actions.setFollow(true)}><LocateFixed size={16} /></Btn>}
            <Btn tone={recal ? 'accent' : 'default'} aria-label="Recalibrate position" title="Recalibrate position" onClick={() => setRecal(!recal)}><Crosshair size={16} /></Btn>
            <Btn tone="danger" aria-label="End navigation" title="End navigation" onClick={actions.end}><X size={16} /></Btn>
          </Glass>
        )}
      </div>
    </>
  )
}
