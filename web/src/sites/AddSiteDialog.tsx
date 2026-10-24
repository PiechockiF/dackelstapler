// Owner: agent D. Create a Standort at a clicked map position from a building.json or floor-plan image.
import { useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { AlertTriangle, Building2, FileJson, ImageIcon, Loader2, Upload, X } from 'lucide-react'
import { api } from '../lib/api'
import PlanReview from './PlanReview'
import type { Building, Site } from '../lib/types'

type Phase = 'idle' | 'uploading' | 'parsing' | 'done' | 'error'
const KINDS: Site['kind'][] = ['factory', 'campus', 'office', 'airport', 'mall', 'other']

export default function AddSiteDialog(props: { lat: number; lon: number; onClose: () => void; onCreated: (site: Site) => void }) {
  const [name, setName] = useState('')
  const [kind, setKind] = useState<Site['kind']>('factory')
  const [file, setFile] = useState<File | null>(null)
  const [widthM, setWidthM] = useState('')
  const [phase, setPhase] = useState<Phase>('idle')
  const [error, setError] = useState<string | null>(null)
  const [review, setReview] = useState<{ building: Building; warnings: string[] } | null>(null)
  const [created, setCreated] = useState<(Site & { warnings?: string[] }) | null>(null)
  const [dragging, setDragging] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  const isJson = !!file && (file.name.toLowerCase().endsWith('.json') || file.type === 'application/json')
  const isPlan = !!file && !isJson
  const busy = phase === 'uploading' || phase === 'parsing'

  useEffect(() => {
    if (!busy) return
    const started = Date.now()
    const timer = setInterval(() => setElapsed(Math.round((Date.now() - started) / 1000)), 500)
    return () => clearInterval(timer)
  }, [busy])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && !busy && props.onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, props])

  const pick = (picked: File | undefined | null) => {
    if (!picked) return
    setFile(picked)
    setError(null)
    if (!name) setName(picked.name.replace(/\.(json|png|jpe?g|webp|pdf)$/i, '').replace(/[_-]+/g, ' '))
  }

  const submit = async () => {
    if (!name.trim()) return setError('Give the site a name.')
    if (!file) return setError('Choose a building.json or a floor-plan image/PDF.')
    setError(null)
    setPhase(isPlan ? 'parsing' : 'uploading')
    const form = new FormData()
    form.append('name', name.trim())
    form.append('lat', String(props.lat))
    form.append('lon', String(props.lon))
    form.append('kind', kind)
    form.append('file', file)
    if (isPlan && widthM.trim()) form.append('width_m', widthM.trim())
    try {
      const draft = await api.previewSite(form)
      setReview(draft)
      setPhase('idle')
    } catch (err) {
      setPhase('error')
      setError((err as Error).message)
    }
  }

  const confirm = async () => {
    if (!review) return
    setPhase('uploading')
    setError(null)
    const form = new FormData()
    form.append('name', name.trim())
    form.append('lat', String(props.lat))
    form.append('lon', String(props.lon))
    form.append('kind', kind)
    form.append('file', new File([JSON.stringify(review.building)], 'building.json', { type: 'application/json' }))
    try {
      const site = (await api.createSite(form)) as Site & { warnings?: string[] }
      setCreated(site)
      setPhase('done')
      if (!site.warnings?.length) props.onCreated(site)
    } catch (err) {
      setPhase('error')
      setError((err as Error).message)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm" onClick={() => !busy && props.onClose()}>
      <motion.div
        initial={{ opacity: 0, y: 12, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.18 }}
        onClick={(event) => event.stopPropagation()}
        className="max-h-[90vh] w-full max-w-xl overflow-y-auto rounded-2xl border border-white/10 bg-slate-950/85 p-5 text-slate-100 shadow-2xl shadow-black/50 backdrop-blur-xl"
      >
        <div className="mb-4 flex items-start gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-sky-400 to-violet-400 text-slate-950">
            <Building2 size={18} />
          </div>
          <div className="flex-1">
            <h2 className="text-base font-semibold">New Standort</h2>
            <p className="text-xs text-slate-400">
              {props.lat.toFixed(5)}, {props.lon.toFixed(5)}
            </p>
          </div>
          <button type="button" onClick={props.onClose} disabled={busy} className="rounded-lg p-1.5 text-slate-400 hover:bg-white/10 hover:text-white" aria-label="Close">
            <X size={16} />
          </button>
        </div>

        {review && !created ? (
          <div className="space-y-3">
            <PlanReview building={review.building} file={file} warnings={review.warnings} />
            {error && <p className="text-sm text-red-300">{error}</p>}
            <div className="flex gap-2">
              <button type="button" disabled={busy} onClick={() => { setReview(null); setError(null) }} className="flex-1 rounded-xl border border-white/10 py-2 text-sm disabled:opacity-40">Back</button>
              <button type="button" disabled={busy} onClick={confirm} className="flex-1 rounded-xl bg-sky-500 py-2 text-sm font-medium disabled:opacity-40">{busy ? 'Saving…' : 'Confirm & create site'}</button>
            </div>
          </div>
        ) : created && created.warnings?.length ? (
          <div className="space-y-3">
            <p className="text-sm text-emerald-300">“{created.name}” is ready. A few things were fixed automatically:</p>
            <ul className="max-h-40 list-disc space-y-1 overflow-y-auto pl-5 text-xs text-amber-200">
              {created.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
            <button type="button" onClick={() => props.onCreated(created)} className="w-full rounded-xl bg-sky-500 py-2 text-sm font-medium text-white hover:bg-sky-400">
              Open site
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            <label className="block">
              <span className="mb-1 block text-xs text-slate-400">Name</span>
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="e.g. Werk Freiham Halle 3"
                disabled={busy}
                className="w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm placeholder:text-slate-500 focus:border-sky-400/60 focus:outline-none"
              />
            </label>

            <div>
              <span className="mb-1 block text-xs text-slate-400">Kind</span>
              <div className="flex flex-wrap gap-1.5">
                {KINDS.map((option) => (
                  <button
                    key={option}
                    type="button"
                    disabled={busy}
                    onClick={() => setKind(option)}
                    className={`rounded-full border px-2.5 py-0.5 text-xs capitalize transition ${
                      kind === option ? 'border-sky-400/70 bg-sky-400/15 text-sky-100' : 'border-white/10 text-slate-400 hover:text-white'
                    }`}
                  >
                    {option}
                  </button>
                ))}
              </div>
            </div>

            <div
              onDragOver={(event) => {
                event.preventDefault()
                setDragging(true)
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(event) => {
                event.preventDefault()
                setDragging(false)
                pick(event.dataTransfer.files[0])
              }}
              onClick={() => !busy && inputRef.current?.click()}
              className={`flex cursor-pointer flex-col items-center justify-center gap-1.5 rounded-xl border border-dashed px-4 py-5 text-center transition ${
                dragging ? 'border-sky-400 bg-sky-400/10' : 'border-white/15 bg-white/[0.03] hover:border-white/30'
              }`}
            >
              {file ? (
                <>
                  {isJson ? <FileJson size={22} className="text-sky-300" /> : <ImageIcon size={22} className="text-violet-300" />}
                  <span className="text-sm">{file.name}</span>
                  <span className="text-[11px] text-slate-400">
                    {isJson ? 'building.json — loaded as is' : 'Floor plan — Claude reads rooms, doors and entrances'}
                  </span>
                </>
              ) : (
                <>
                  <Upload size={22} className="text-slate-400" />
                  <span className="text-sm text-slate-300">Drop a building.json or a floor plan (PNG, JPG, PDF)</span>
                  <span className="text-[11px] text-slate-500">or click to choose a file</span>
                </>
              )}
              <input
                ref={inputRef}
                type="file"
                accept=".json,application/json,image/png,image/jpeg,image/webp,application/pdf"
                className="hidden"
                onChange={(event) => pick(event.target.files?.[0])}
              />
            </div>

            {isPlan && (
              <label className="block">
                <span className="mb-1 block text-xs text-slate-400">Plan width in metres (optional — sets the scale)</span>
                <input
                  value={widthM}
                  onChange={(event) => setWidthM(event.target.value.replace(',', '.'))}
                  inputMode="decimal"
                  placeholder="estimated from door widths if empty"
                  disabled={busy}
                  className="w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm placeholder:text-slate-500 focus:border-sky-400/60 focus:outline-none"
                />
              </label>
            )}

            {error && (
              <div className="flex gap-2 rounded-xl border border-red-400/30 bg-red-500/10 px-3 py-2 text-xs text-red-200">
                <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                <span>{error}</span>
              </div>
            )}

            {busy && (
              <div className="space-y-1.5">
                <div className="h-1 overflow-hidden rounded-full bg-white/10">
                  <motion.div
                    className="h-full rounded-full bg-gradient-to-r from-sky-400 to-violet-400"
                    initial={{ width: '5%' }}
                    animate={{ width: phase === 'parsing' ? `${Math.min(95, 5 + elapsed * 1.6)}%` : '80%' }}
                    transition={{ ease: 'easeOut', duration: 0.5 }}
                  />
                </div>
                <p className="text-[11px] text-slate-400">
                  {phase === 'parsing'
                    ? `Reading the floor plan, checking every room is reachable… ${elapsed}s (usually under a minute)`
                    : 'Uploading and checking the building…'}
                </p>
              </div>
            )}

            <div className="flex gap-2 pt-1">
              <button type="button" onClick={props.onClose} disabled={busy} className="flex-1 rounded-xl border border-white/10 py-2 text-sm text-slate-300 hover:bg-white/5 disabled:opacity-40">
                Cancel
              </button>
              <button
                type="button"
                onClick={submit}
                disabled={busy || !file || !name.trim()}
                className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-sky-500 py-2 text-sm font-medium text-white hover:bg-sky-400 disabled:opacity-40"
              >
                {busy && <Loader2 size={14} className="animate-spin" />}
                {busy ? 'Reading…' : 'Review layout'}
              </button>
            </div>
          </div>
        )}
      </motion.div>
    </div>
  )
}
