// Owner: agent C. Full-screen "drag a box around the item" editor (normalised [x0, y0, x1, y1]).
import { Check, RotateCcw, X } from 'lucide-react'
import { useRef, useState, type PointerEvent } from 'react'

export type BBox = [number, number, number, number]

export default function BBoxEditor({ src, initial, onDone, onCancel }: {
  src: string
  initial: BBox | null
  onDone: (bbox: BBox | null) => void
  onCancel: () => void
}) {
  const image = useRef<HTMLImageElement>(null)
  const [box, setBox] = useState<BBox | null>(initial)
  const start = useRef<[number, number] | null>(null)

  const point = (event: PointerEvent): [number, number] => {
    const rect = image.current!.getBoundingClientRect()
    return [
      Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)),
      Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)),
    ]
  }
  const onDown = (event: PointerEvent) => {
    ;(event.target as Element).setPointerCapture(event.pointerId)
    const p = point(event)
    start.current = p
    setBox([p[0], p[1], p[0], p[1]])
  }
  const onMove = (event: PointerEvent) => {
    if (!start.current) return
    const [x0, y0] = start.current
    const [x1, y1] = point(event)
    setBox([Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)])
  }
  const onUp = () => {
    start.current = null
    setBox((b) => (b && b[2] - b[0] > 0.03 && b[3] - b[1] > 0.03 ? b : null))
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black/95">
      <div className="flex items-center justify-between px-4 pb-2 pt-[max(env(safe-area-inset-top),12px)] text-sm text-slate-200">
        <button className="rounded-lg p-2 active:bg-white/10" onClick={onCancel} aria-label="Cancel">
          <X size={20} />
        </button>
        <span className="font-medium">Drag a box around the item</span>
        <button className="rounded-lg p-2 active:bg-white/10" onClick={() => setBox(null)} aria-label="Reset">
          <RotateCcw size={18} />
        </button>
      </div>
      <div className="relative flex min-h-0 flex-1 items-center justify-center px-2">
        <div className="relative max-h-full touch-none select-none" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp}>
          <img ref={image} src={src} alt="" draggable={false} className="block max-h-[calc(100dvh-170px)] max-w-full object-contain" />
          {box && (
            <div
              className="pointer-events-none absolute border-2 border-sky-400 bg-sky-400/10 shadow-[0_0_0_9999px_rgba(0,0,0,0.45)]"
              style={{ left: `${box[0] * 100}%`, top: `${box[1] * 100}%`, width: `${(box[2] - box[0]) * 100}%`, height: `${(box[3] - box[1]) * 100}%` }}
            />
          )}
        </div>
      </div>
      <div className="flex gap-2 px-4 pb-[max(env(safe-area-inset-bottom),16px)] pt-3">
        <p className="flex-1 text-xs leading-snug text-slate-400">Include the pallet, not the marker. Optional — helps on busy floors.</p>
        <button
          className="inline-flex items-center gap-1.5 rounded-xl bg-sky-500 px-4 py-2.5 text-sm font-semibold text-white active:bg-sky-600"
          onClick={() => onDone(box)}
        >
          <Check size={16} /> Done
        </button>
      </div>
    </div>
  )
}
