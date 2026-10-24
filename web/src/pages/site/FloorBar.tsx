import clsx from 'clsx'
import { Layers, Maximize2, Rows3 } from 'lucide-react'
import { useTwin } from '../../lib/store'
import type { Building } from '../../lib/types'
import { sortedFloors } from '../../twin/geom'
import { useTwinUi } from '../../twin/uiStore'
import { Glass } from './ui'

export function FloorBar({ building }: { building: Building }) {
  const focus = useTwin((s) => s.focusFloorId)
  const exploded = useTwin((s) => s.exploded)
  const setFocus = useTwin((s) => s.setFocusFloor)
  const setExploded = useTwin((s) => s.setExploded)
  const frameAll = useTwinUi((s) => s.frameAll)
  const floors = sortedFloors(building).reverse()
  const pill = 'rounded-lg px-2.5 py-1 text-xs font-medium transition whitespace-nowrap'
  return (
    <Glass className="flex items-center gap-1 p-1">
      <button
        title={exploded ? 'Stack floors' : 'Explode floors'}
        onClick={() => setExploded(!exploded)}
        className={clsx(pill, 'flex items-center gap-1.5', exploded ? 'bg-violet-500/25 text-violet-100' : 'text-slate-300 hover:bg-white/10')}
      >
        {exploded ? <Layers size={14} /> : <Rows3 size={14} />}
        {exploded ? 'Exploded' : 'Stacked'}
      </button>
      <div className="mx-1 h-5 w-px bg-white/10" />
      <div className="flex max-w-[46vw] items-center gap-1 overflow-x-auto">
        <button onClick={() => setFocus(null)} className={clsx(pill, focus == null ? 'bg-sky-500/25 text-sky-50' : 'text-slate-300 hover:bg-white/10')}>
          All
        </button>
        {floors.map((f) => (
          <button
            key={f.id}
            title={f.name}
            onClick={() => setFocus(focus === f.id ? null : f.id)}
            className={clsx(pill, 'font-mono', focus === f.id ? 'bg-sky-500/25 text-sky-50' : 'text-slate-300 hover:bg-white/10')}
          >
            {f.level >= 0 ? `L${f.level}` : `B${-f.level}`}
          </button>
        ))}
      </div>
      <div className="mx-1 h-5 w-px bg-white/10" />
      <button title="Frame building" onClick={() => { setFocus(null); frameAll() }} className={clsx(pill, 'text-slate-300 hover:bg-white/10')}>
        <Maximize2 size={14} />
      </button>
    </Glass>
  )
}
