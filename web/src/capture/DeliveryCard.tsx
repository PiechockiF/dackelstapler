// Owner: agent C. Result card for one delivery (dimensions + cross-check). Rendered by SitePage (agent B)
// and by the phone capture page.
import clsx from 'clsx'
import { Ban, Box, CircleCheck, DoorOpen, Layers, Route as RouteIcon, TriangleAlert } from 'lucide-react'
import type { ReactNode } from 'react'
import { useTwin } from '../lib/store'
import type { Delivery, Dims } from '../lib/types'

type Tone = 'ok' | 'warn' | 'danger' | 'muted'

const toneText: Record<Tone, string> = {
  ok: 'text-ok',
  warn: 'text-warn',
  danger: 'text-danger',
  muted: 'text-slate-400',
}

const toneBadge: Record<Tone, string> = {
  ok: 'bg-ok/15 text-ok ring-ok/30',
  warn: 'bg-warn/15 text-warn ring-warn/30',
  danger: 'bg-danger/15 text-danger ring-danger/30',
  muted: 'bg-white/5 text-slate-300 ring-white/10',
}

function badgeFor(delivery: Delivery): { tone: Tone; text: string } {
  const fit = delivery.check?.route_fit
  if (delivery.status === 'blocked') return { tone: 'danger', text: 'Blocked' }
  if (delivery.status === 'unassessed') return { tone: 'warn', text: 'Width checked only' }
  if (delivery.status === 'mismatch') return { tone: 'warn', text: 'PO mismatch' }
  if (fit && !fit.ok && fit.alternative) return { tone: 'warn', text: 'Reroute' }
  return { tone: 'ok', text: 'Cleared' }
}

const cm = (metres: number) => `${metres > 0 ? '+' : metres < 0 ? '−' : '±'}${Math.abs(Math.round(metres * 100))} cm`
const m2 = (value: number) => value.toFixed(2)

function relativeTime(ts: string): string {
  const seconds = (Date.now() - new Date(ts).getTime()) / 1000
  if (!Number.isFinite(seconds)) return ''
  if (seconds < 60) return 'just now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ago`
  return new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}

function DeltaChip({ axis, value, limit }: { axis: string; value: number; limit: number }) {
  const tone: Tone = Math.abs(value) <= limit ? 'ok' : 'warn'
  return (
    <span className={clsx('inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] tabular-nums ring-1', toneBadge[tone])}>
      <span className="font-semibold opacity-70">{axis}</span>
      {cm(value)}
    </span>
  )
}

function Line({ tone, icon, children }: { tone: Tone; icon: ReactNode; children: ReactNode }) {
  return (
    <div className={clsx('flex items-start gap-2 text-xs leading-snug', toneText[tone])}>
      <span className="mt-px shrink-0">{icon}</span>
      <span className="min-w-0 text-slate-300">{children}</span>
    </div>
  )
}

export default function DeliveryCard({ delivery }: { delivery: Delivery }) {
  const building = useTwin((s) => s.building)
  const name = (id?: string | null) => (id && building?.spaces.find((s) => s.id === id)?.name) || undefined
  const badge = badgeFor(delivery)
  const dims: Dims = delivery.dims_m
  const check = delivery.check
  const fit = check?.route_fit ?? null
  const declared = check?.declared ?? null
  const blocking = (fit?.blocking_openings ?? []) as (NonNullable<typeof fit>['blocking_openings'][number] & { label?: string; reason?: string })[]
  const target = name(delivery.target_space_id) ?? (delivery.target_space_id ? 'target' : undefined)
  const placedIn = name(delivery.space_id)
  const tolerance = Math.round((delivery.tolerance_m ?? 0) * 100)
  const declaredLimit = (delivery.tolerance_m ?? 0.03) + 0.03

  return (
    <div className="overflow-hidden rounded-xl border border-white/10 bg-slate-900/60 shadow-lg shadow-black/30">
      <div className="flex gap-3 p-3">
        <div className="relative size-16 shrink-0 overflow-hidden rounded-lg bg-slate-800 ring-1 ring-white/10">
          {delivery.photo_url ? (
            <img src={delivery.photo_url} alt="" className="size-full object-cover" loading="lazy" />
          ) : (
            <div className="grid size-full place-items-center text-slate-500">
              <Box size={22} />
            </div>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold text-slate-100" title={delivery.label}>
                {delivery.label}
              </div>
              <div className="truncate text-[11px] text-slate-400">
                {[delivery.note, placedIn, relativeTime(delivery.ts)].filter(Boolean).join(' · ')}
              </div>
            </div>
            <span className={clsx('shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ring-1', toneBadge[badge.tone])}>
              {badge.text}
            </span>
          </div>
          <div className="mt-1.5 flex items-baseline gap-1.5">
            <span className="text-lg font-semibold tabular-nums tracking-tight text-white">
              {m2(dims.w)} <span className="text-slate-500">×</span> {m2(dims.d)} <span className="text-slate-500">×</span> {m2(dims.h)}
            </span>
            <span className="text-xs text-slate-400">m</span>
            {tolerance > 0 && <span className="text-[11px] tabular-nums text-sky-300/80">±{tolerance} cm</span>}
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-1.5 border-t border-white/5 px-3 py-2.5">
        {declared && delivery.declared_dims_m && (
          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            <span className={clsx('mr-0.5 font-medium', declared.ok ? 'text-ok' : 'text-warn')}>
              {declared.ok ? 'Matches PO' : 'Differs from PO'}
            </span>
            <span className="text-[11px] tabular-nums text-slate-500">
              ({m2(delivery.declared_dims_m.w)} × {m2(delivery.declared_dims_m.d)} × {m2(delivery.declared_dims_m.h)})
            </span>
            <DeltaChip axis="W" value={declared.deviation_m.w} limit={declaredLimit} />
            <DeltaChip axis="D" value={declared.deviation_m.d} limit={declaredLimit} />
            <DeltaChip axis="H" value={declared.deviation_m.h} limit={declaredLimit} />
          </div>
        )}

        {fit && fit.ok && (
          <Line tone="ok" icon={<CircleCheck size={14} />}>
            {delivery.measurement_source === 'manual' ? 'Doorway widths pass' : 'Fits every door'}{target ? <> to <b className="font-medium text-slate-100">{target}</b></> : null}
            {fit.route ? <span className="text-slate-500"> · {Math.round(fit.route.length_m)} m</span> : null}
          </Line>
        )}
        {fit && !fit.ok && (
          <>
            {blocking.length ? (
              blocking.map((door) => (
                <Line key={door.id} tone="danger" icon={<DoorOpen size={14} />}>
                  {door.reason === 'steps' ? 'Steps at ' : "Won't pass "}
                  <b className="font-medium text-rose-200">{door.label ?? door.id.split('-').slice(-1)[0]}</b>
                  {door.reason !== 'steps' && (
                    <span className="tabular-nums text-slate-400">
                      {' '}
                      ({door.width_m.toFixed(2)} m &lt; {m2(delivery.measurement_source === 'manual' ? dims.w : Math.min(dims.w, dims.d))} m)
                    </span>
                  )}
                </Line>
              ))
            ) : (
              <Line tone="danger" icon={<Ban size={14} />}>
                No step-free route{target ? ` to ${target}` : ''}
              </Line>
            )}
            {fit.alternative ? (
              <Line tone="warn" icon={<RouteIcon size={14} />}>
                Alternative route{target ? <> to <b className="font-medium text-slate-100">{target}</b></> : null}
                <span className="tabular-nums text-slate-400"> · {Math.round(fit.alternative.length_m)} m</span>
              </Line>
            ) : (
              <Line tone="danger" icon={<Ban size={14} />}>
                No route wide enough — stays at {placedIn ?? 'the dock'}
              </Line>
            )}
          </>
        )}
        {delivery.measurement_source === 'manual' && <Line tone="warn" icon={<TriangleAlert size={14} />}>{check.summary}</Line>}
        {check?.floor_fit && !check.floor_fit.ok && (
          <Line tone="warn" icon={<Layers size={14} />}>
            {check.floor_fit.reason}
          </Line>
        )}
        {check?.summary && (
          <p className="mt-0.5 line-clamp-3 text-[11px] leading-snug text-slate-400" title={check.summary}>
            {check.summary.includes('⚠') && !fit && <TriangleAlert size={11} className="mr-1 inline text-warn" />}
            {check.summary}
          </p>
        )}
      </div>
    </div>
  )
}
