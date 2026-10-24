import { useEffect, useMemo, useState } from 'react'
import type { Building, PlanSource } from '../lib/types'

const LEVELS = Array.from({ length: 15 }, (_, i) => i - 3)

function levelName(level: number) {
  if (level === 0) return 'Ground floor (EG)'
  return level < 0 ? `Basement ${-level} (UG)` : `${level}. upper floor (OG)`
}

/** Review the parsed geometry before it becomes a saved site. Uploaded photos are drawn under the rooms
 * with the transform the stitcher found, so misaligned plans are easy to spot. */
export default function PlanReview({ building, files, warnings, busy, onLevelChange }: {
  building: Building
  files: File[]
  warnings: string[]
  busy?: boolean
  onLevelChange?: (index: number, level: number) => void
}) {
  const [floorId, setFloorId] = useState(building.floors[0]?.id)
  const [photos, setPhotos] = useState(true)
  const [urls, setUrls] = useState<(string | null)[]>([])
  useEffect(() => {
    const next = files.map((file) => (file.type.startsWith('image/') ? URL.createObjectURL(file) : null))
    setUrls(next)
    return () => next.forEach((url) => url && URL.revokeObjectURL(url))
  }, [files])
  useEffect(() => {
    if (!building.floors.some((f) => f.id === floorId)) setFloorId(building.floors[0]?.id)
  }, [building, floorId])

  const floor = building.floors.find((f) => f.id === floorId)
  const plans = building.building.plans ?? []
  const overlays = plans.filter((p) => p.transform && p.level === floor?.level && urls[p.index])
  const spaces = building.spaces.filter((s) => s.floor_id === floorId)
  const bounds = useMemo(() => {
    const points = spaces.flatMap((s) => s.polygon)
    if (photos) {
      for (const plan of overlays) {
        const [a, b, c, d, e, f] = plan.transform!
        for (const [u, v] of [[0, 0], [1000, 0], [0, 1000], [1000, 1000]]) points.push([a * u + c * v + e, b * u + d * v + f])
      }
    }
    if (!points.length) return { x: 0, y: 0, w: 1, h: 1 }
    const xs = points.map((p) => p[0]), ys = points.map((p) => p[1])
    const x = Math.min(...xs), y = Math.min(...ys)
    return { x, y, w: Math.max(1, Math.max(...xs) - x), h: Math.max(1, Math.max(...ys) - y) }
  }, [spaces, overlays, photos])
  const radius = Math.max(bounds.w, bounds.h) / 180
  const connectors = building.vertical_connectors.filter((c) => c.floor_ids.includes(floorId ?? ''))

  return (
    <div className="space-y-3">
      <div>
        <h3 className="font-semibold">Review layout</h3>
        <p className="text-xs text-slate-400">
          Check room outlines, entrances and how the photos line up before saving. Hover a room to see its name. Nothing has been saved yet.
        </p>
      </div>
      <div className="flex items-center justify-between gap-3">
        <select aria-label="Review floor" value={floorId} onChange={(e) => setFloorId(e.target.value)} className="rounded-lg bg-slate-800 px-2 py-1 text-sm">
          {building.floors.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
        </select>
        {overlays.length > 0 && <label className="text-xs"><input type="checkbox" checked={photos} onChange={(e) => setPhotos(e.target.checked)} /> Show photos</label>}
      </div>
      <svg role="img" aria-label="Floor plan review" viewBox={`${bounds.x} ${bounds.y} ${bounds.w} ${bounds.h}`} className="h-80 w-full rounded-xl border border-white/10 bg-slate-900">
        <g transform={`translate(0 ${2 * bounds.y + bounds.h}) scale(1 -1)`}>
          {photos && overlays.map((plan) => (
            <image key={plan.index} href={urls[plan.index]!} x={0} y={0} width={1000} height={1000} preserveAspectRatio="none" opacity={0.55} transform={`matrix(${plan.transform!.join(' ')})`} />
          ))}
          {spaces.map((s) => <polygon key={s.id} points={s.polygon.map((p) => p.join(',')).join(' ')} fill={s.type === 'stair' || s.type === 'lift' ? '#a78bfa' : '#38bdf8'} fillOpacity={photos && overlays.length ? 0.18 : 0.25} stroke="#38bdf8" strokeWidth={radius / 3}><title>{s.name}</title></polygon>)}
          {building.openings.filter((o) => o.floor_id === floorId).map((o) => <circle key={o.id} cx={o.position[0]} cy={o.position[1]} r={radius} fill={o.space_ids.includes('outside') ? '#34d399' : '#fbbf24'}><title>{o.space_ids.includes('outside') ? 'Entrance' : 'Door'} · {o.width_m} m</title></circle>)}
        </g>
      </svg>
      <p className="text-xs text-slate-400">
        {spaces.length} spaces · {bounds.w.toFixed(1)} × {bounds.h.toFixed(1)} m · {connectors.length} stair/lift link{connectors.length === 1 ? '' : 's'} ·{' '}
        <span className="text-emerald-300">Entrances</span> · <span className="text-amber-300">Doors</span> · <span className="text-violet-300">Stairs/lifts</span>
      </p>
      {plans.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-xs text-slate-400">Uploaded plans{onLevelChange ? ' — fix a wrongly detected floor and the layout is stitched again' : ''}</p>
          <ul className="space-y-1.5">
            {plans.map((plan) => <PlanRow key={plan.index} plan={plan} url={urls[plan.index] ?? null} busy={busy} onLevelChange={onLevelChange} />)}
          </ul>
        </div>
      )}
      {!!warnings.length && <div className="rounded-xl border border-amber-400/20 bg-amber-500/10 p-3"><p className="mb-1 text-sm text-amber-200">Check these assumptions</p><ul className="max-h-32 list-disc overflow-auto pl-4 text-xs text-amber-100">{warnings.map((w, i) => <li key={i}>{w}</li>)}</ul></div>}
    </div>
  )
}

const METHOD: Record<NonNullable<PlanSource['method']>, string> = {
  reference: 'reference',
  anchors: 'stitched via shared rooms',
  point_match: 'stitched via matched points',
  side_by_side: 'not aligned — placed alongside',
}

function PlanRow({ plan, url, busy, onLevelChange }: { plan: PlanSource; url: string | null; busy?: boolean; onLevelChange?: (index: number, level: number) => void }) {
  return (
    <li className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/[0.03] p-1.5">
      <div className="h-10 w-8 shrink-0 overflow-hidden rounded bg-white/5">{url && <img src={url} alt="" className="h-full w-full object-cover" />}</div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs text-slate-200">{plan.filename}</p>
        <p className="truncate text-[11px] text-slate-500">
          {plan.error
            ? <span className="text-red-300">{plan.error}</span>
            : <>
                {plan.floor_label || 'no storey label'}{plan.has_north_arrow ? ' · north arrow' : ''}
                {plan.method && ` · ${METHOD[plan.method]}`}
                {plan.method === 'anchors' && plan.anchors ? ` (${Math.max(plan.anchors, plan.matched_rooms ?? 0)} rooms, ±${plan.residual_m ?? 0} m)` : ''}
              </>}
        </p>
      </div>
      {plan.level != null && (
        <select
          aria-label={`Floor of ${plan.filename}`}
          value={plan.level}
          disabled={busy || !onLevelChange}
          onChange={(e) => onLevelChange?.(plan.index, Number(e.target.value))}
          className="rounded-md bg-slate-800 px-1.5 py-1 text-xs disabled:opacity-60"
        >
          {LEVELS.map((level) => <option key={level} value={level}>{levelName(level)}{level === plan.detected_level ? ' ✓' : ''}</option>)}
        </select>
      )}
    </li>
  )
}
