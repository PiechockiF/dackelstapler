import clsx from 'clsx'
import { Pause, Play, Radio } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTwin } from '../../lib/store'
import type { EventType } from '../../lib/types'
import { Glass } from './ui'

const DAYS = 7
const DOT: Record<EventType, string> = {
  delivery: 'bg-amber-300',
  asset_moved: 'bg-sky-300',
  closure: 'bg-rose-400',
  booking: 'bg-blue-400',
  door_added: 'bg-emerald-300',
  capture: 'bg-violet-300',
}

export function Timeline() {
  const events = useTwin((s) => s.events)
  const ts = useTwin((s) => s.timelineTs)
  const setTs = useTwin((s) => s.setTimelineTs)
  const [now, setNow] = useState(() => Date.now())
  const [playing, setPlaying] = useState(false)
  const start = now - DAYS * 86400_000
  const value = ts ? Date.parse(ts) : now
  const frac = (t: number) => Math.min(1, Math.max(0, (t - start) / (now - start)))

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(id)
  }, [])

  // Play: sweep from the current scrub position to "now" in ~8 s.
  const raf = useRef(0)
  useEffect(() => {
    if (!playing) return
    let last = performance.now()
    let t = ts ? Date.parse(ts) : start
    if (!ts || t >= now - 60_000) t = start
    const step = (p: number) => {
      const dt = p - last
      last = p
      t += (dt / 8000) * (now - start)
      if (t >= now) {
        setTs(null)
        setPlaying(false)
        return
      }
      setTs(new Date(t).toISOString())
      raf.current = requestAnimationFrame(step)
    }
    raf.current = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing])

  const ticks = useMemo(() => events.filter((e) => Date.parse(e.ts) >= start), [events, start])
  const days = useMemo(() => {
    const out: { t: number; label: string }[] = []
    const d = new Date(start)
    d.setHours(0, 0, 0, 0)
    for (let t = d.getTime() + 86400_000; t < now; t += 86400_000) out.push({ t, label: new Date(t).toLocaleDateString([], { weekday: 'short' }) })
    return out
  }, [start, now])

  const live = ts == null
  return (
    <Glass className="flex items-center gap-3 px-3 py-2">
      <button
        onClick={() => setPlaying((p) => !p)}
        className="grid size-8 shrink-0 place-items-center rounded-full bg-white/5 text-slate-200 transition hover:bg-white/10"
        title={playing ? 'Pause' : 'Replay last 7 days'}
      >
        {playing ? <Pause size={14} /> : <Play size={14} />}
      </button>
      <div className="relative h-10 min-w-0 flex-1">
        <div className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-white/10" />
        <div className="absolute left-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-gradient-to-r from-sky-500/30 to-sky-400" style={{ width: `${frac(value) * 100}%` }} />
        {days.map((d) => (
          <div key={d.t} className="absolute top-0 h-full" style={{ left: `${frac(d.t) * 100}%` }}>
            <div className="h-2 w-px bg-white/15" />
            <div className="absolute bottom-0 -translate-x-1/2 text-[9px] uppercase tracking-wide text-slate-500">{d.label}</div>
          </div>
        ))}
        {ticks.map((e) => (
          <div
            key={e.id}
            title={e.title}
            className={clsx('absolute top-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-slate-950', DOT[e.type] ?? 'bg-slate-300', Date.parse(e.ts) > value && 'opacity-30')}
            style={{ left: `${frac(Date.parse(e.ts)) * 100}%` }}
          />
        ))}
        <input
          type="range"
          min={start}
          max={now}
          step={60_000}
          value={value}
          onChange={(e) => {
            setPlaying(false)
            const v = Number(e.target.value)
            setTs(v >= now - 60_000 ? null : new Date(v).toISOString())
          }}
          className="timeline-range absolute inset-0 h-full w-full cursor-pointer appearance-none bg-transparent"
        />
      </div>
      <div className="w-28 shrink-0 text-right">
        {live ? (
          <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-emerald-300">
            <Radio size={13} className="animate-pulse" /> LIVE
          </span>
        ) : (
          <button onClick={() => setTs(null)} className="text-right text-[11px] leading-tight text-slate-300 hover:text-white" title="Back to live">
            <div className="font-mono">{new Date(value).toLocaleDateString([], { weekday: 'short', day: '2-digit', month: 'short' })}</div>
            <div className="font-mono text-sky-300">{new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
          </button>
        )}
      </div>
      <style>{`
        .timeline-range::-webkit-slider-thumb { -webkit-appearance: none; width: 14px; height: 14px; border-radius: 9999px; background: #e0f2fe; box-shadow: 0 0 0 4px rgba(56,189,248,.35), 0 0 16px rgba(56,189,248,.8); }
        .timeline-range::-moz-range-thumb { width: 14px; height: 14px; border: 0; border-radius: 9999px; background: #e0f2fe; box-shadow: 0 0 0 4px rgba(56,189,248,.35), 0 0 16px rgba(56,189,248,.8); }
        .timeline-range::-webkit-slider-runnable-track { background: transparent; }
      `}</style>
    </Glass>
  )
}
