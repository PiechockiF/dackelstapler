import { useEffect, useMemo, useState } from 'react'
import type { Building } from '../lib/types'

/** Review the parsed geometry before it becomes a saved site. Image plans use their metric frame. */
export default function PlanReview({ building, file, warnings }: { building: Building; file: File | null; warnings: string[] }) {
  const [floorId, setFloorId] = useState(building.floors[0]?.id)
  const [imageUrl, setImageUrl] = useState<string | null>(null)
  const [overlay, setOverlay] = useState(true)
  useEffect(() => {
    if (!file?.type.startsWith('image/')) return
    const url = URL.createObjectURL(file)
    setImageUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [file])
  const spaces = building.spaces.filter((s) => s.floor_id === floorId)
  const bounds = useMemo(() => {
    const scale = building.building.scale
    if (scale) return { x: 0, y: 0, w: scale.plan_width_m, h: scale.plan_height_m }
    const points = building.spaces.filter((s) => s.floor_id === floorId).flatMap((s) => s.polygon)
    if (!points.length) return { x: 0, y: 0, w: 1, h: 1 }
    const xs = points.map((p) => p[0]), ys = points.map((p) => p[1])
    const x = Math.min(...xs), y = Math.min(...ys)
    return { x, y, w: Math.max(1, Math.max(...xs) - x), h: Math.max(1, Math.max(...ys) - y) }
  }, [building, floorId])
  const radius = Math.max(bounds.w, bounds.h) / 180
  return (
    <div className="space-y-3">
      <div>
        <h3 className="font-semibold">Review layout</h3>
        <p className="text-xs text-slate-400">Check room outlines, entrances and scale before saving. Hover a room to see its name. Nothing has been saved yet.</p>
      </div>
      <div className="flex items-center justify-between gap-3">
        <select aria-label="Review floor" value={floorId} onChange={(e) => setFloorId(e.target.value)} className="rounded-lg bg-slate-800 px-2 py-1 text-sm">
          {building.floors.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
        </select>
        {imageUrl && <label className="text-xs"><input type="checkbox" checked={overlay} onChange={(e) => setOverlay(e.target.checked)} /> Show room outlines</label>}
      </div>
      <svg role="img" aria-label="Floor plan review" viewBox={`${bounds.x} ${bounds.y} ${bounds.w} ${bounds.h}`} className="h-72 w-full rounded-xl border border-white/10 bg-slate-900">
        {imageUrl && <image href={imageUrl} x={bounds.x} y={bounds.y} width={bounds.w} height={bounds.h} preserveAspectRatio="none" />}
        <g transform={`translate(0 ${2 * bounds.y + bounds.h}) scale(1 -1)`}>
          {(!imageUrl || overlay) && spaces.map((s) => <polygon key={s.id} points={s.polygon.map((p) => p.join(',')).join(' ')} fill="#38bdf8" fillOpacity={0.22} stroke="#38bdf8" strokeWidth={radius / 3}><title>{s.name}</title></polygon>)}
          {(!imageUrl || overlay) && building.openings.filter((o) => o.floor_id === floorId).map((o) => <circle key={o.id} cx={o.position[0]} cy={o.position[1]} r={radius} fill={o.space_ids.includes('outside') ? '#34d399' : '#fbbf24'}><title>{o.space_ids.includes('outside') ? 'Entrance' : 'Door'} · {o.width_m} m</title></circle>)}
        </g>
      </svg>
      <p className="text-xs text-slate-400">{spaces.length} spaces · {bounds.w.toFixed(1)} × {bounds.h.toFixed(1)} m · <span className="text-emerald-300">Entrances</span> · <span className="text-amber-300">Doors</span></p>
      {file?.type === 'application/pdf' && <p className="text-xs text-slate-400">PDF: review the extracted layout above and compare it with your original document.</p>}
      {!!warnings.length && <div className="rounded-xl border border-amber-400/20 bg-amber-500/10 p-3"><p className="mb-1 text-sm text-amber-200">Check these assumptions</p><ul className="max-h-32 list-disc overflow-auto pl-4 text-xs text-amber-100">{warnings.map((w, i) => <li key={i}>{w}</li>)}</ul></div>}
    </div>
  )
}
