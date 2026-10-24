// Owner: agent C. Mobile capture page opened via QR code: /capture?site=<id>.
// "New delivery": 1–4 photos with the A4 marker → measured dims, 3D model, door/route/floor check.
// "Room scan": walk-through video or a splat file → splat fitted into the plan + wall deviations.
import clsx from 'clsx'
import { AnimatePresence, motion } from 'framer-motion'
import {
  ArrowRight, Box, Camera, Check, ChevronDown, CircleX, Crop, FileUp, ImagePlus, LoaderCircle, Package, Printer,
  RotateCcw, Ruler, ScanLine, Sparkles, Trash2, Video,
} from 'lucide-react'
import { lazy, Suspense, useEffect, useMemo, useState, type ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { api } from '../lib/api'
import { useTwin } from '../lib/store'
import type { Building, CaptureJob, Delivery, RoomScan, Site } from '../lib/types'
import BBoxEditor, { type BBox } from './BBoxEditor'
import { MARKER_PDF_URL, samplePhotoFile, uploadForm, useCaptureJob } from './captureApi'
import DeliveryCard from './DeliveryCard'
import RoomPicker from './RoomPicker'

const ModelPreview = lazy(() => import('./ModelPreview'))

type Mode = 'delivery' | 'room'
interface Photo { id: string; file: File; url: string; bbox: BBox | null }

const MAX_PHOTOS = 4

// ---------------------------------------------------------------- small UI bits

function Section({ title, hint, children }: { title: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2.5">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-400">{title}</h2>
        {hint && <div className="text-[11px] text-slate-500">{hint}</div>}
      </div>
      {children}
    </section>
  )
}

const inputCls =
  'w-full rounded-xl border border-white/10 bg-slate-900/70 px-3 py-2.5 text-base text-slate-100 outline-none placeholder:text-slate-500 focus:border-sky-400/60 focus:ring-2 focus:ring-sky-400/20 sm:text-sm'

function DimInput({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="relative flex-1">
      <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-xs font-semibold text-slate-500">{label}</span>
      <input
        inputMode="decimal"
        value={value}
        onChange={(e) => onChange(e.target.value.replace(',', '.'))}
        placeholder="0.00"
        className={clsx(inputCls, 'pl-8 pr-7 text-right tabular-nums')}
      />
      <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-slate-500">m</span>
    </label>
  )
}

function newId() {
  return Math.random().toString(36).slice(2, 10)
}

// ---------------------------------------------------------------- progress

const DELIVERY_STAGES = [
  { key: 'upload', label: 'Upload', detail: 'Sending photos to the twin', icon: FileUp },
  { key: 'measure', label: 'Measure', detail: 'Marker scale + item outline', icon: Ruler },
  { key: 'model', label: '3D model', detail: 'Mesh at the measured size', icon: Box },
  { key: 'check', label: 'Check', detail: 'PO, doors, route, floor space', icon: ScanLine },
]
const ROOM_STAGES = [
  { key: 'upload', label: 'Upload', detail: 'Sending the scan', icon: FileUp },
  { key: 'model', label: 'Reconstruct', detail: 'Gaussian splat of the room', icon: Sparkles },
  { key: 'align', label: 'Align', detail: 'Fit into the floor-plan walls', icon: ScanLine },
]

function stageIndex(mode: Mode, job: CaptureJob | null): number {
  if (!job) return 0
  if (job.status === 'done') return 99
  if (mode === 'delivery') {
    if (job.status === 'queued' || job.status === 'measuring') return 1
    if (job.status === 'modeling') return job.progress >= 0.84 ? 3 : 2
    return 3
  }
  if (job.status === 'queued') return 1
  if (job.status === 'modeling') return 1
  return 2
}

function ProgressView({ mode, job, upload, error, onRetry }: {
  mode: Mode
  job: CaptureJob | null
  upload: number
  error: string | null
  onRetry: () => void
}) {
  const stages = mode === 'delivery' ? DELIVERY_STAGES : ROOM_STAGES
  const current = stageIndex(mode, job)
  const failed = error || job?.status === 'failed'
  const progress = job ? Math.max(0.08, job.progress) : upload * 0.08
  return (
    <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="flex flex-col gap-6 pt-4">
      <div className="relative mx-auto grid size-40 place-items-center">
        <svg viewBox="0 0 100 100" className="absolute inset-0 -rotate-90">
          <circle cx="50" cy="50" r="44" className="fill-none stroke-white/5" strokeWidth="6" />
          <motion.circle
            cx="50" cy="50" r="44" strokeWidth="6" strokeLinecap="round"
            className={clsx('fill-none', failed ? 'stroke-danger' : 'stroke-accent')}
            strokeDasharray={2 * Math.PI * 44}
            animate={{ strokeDashoffset: 2 * Math.PI * 44 * (1 - Math.min(1, progress)) }}
            transition={{ type: 'spring', stiffness: 60, damping: 18 }}
          />
        </svg>
        <div className="absolute inset-5 animate-pulse rounded-full bg-sky-500/10 blur-xl" />
        <div className="relative text-center">
          {failed ? (
            <CircleX size={36} className="mx-auto text-danger" />
          ) : (
            <div className="text-3xl font-semibold tabular-nums text-white">{Math.round(progress * 100)}%</div>
          )}
          <div className="mt-1 text-[11px] uppercase tracking-widest text-slate-400">{failed ? 'failed' : mode === 'delivery' ? 'delivery' : 'room scan'}</div>
        </div>
      </div>

      <ol className="flex flex-col gap-2">
        {stages.map((stage, index) => {
          const done = index < current
          const active = index === current && !failed
          const Icon = stage.icon
          return (
            <li
              key={stage.key}
              className={clsx(
                'flex items-center gap-3 rounded-xl border px-3 py-2.5 transition',
                active ? 'border-sky-400/40 bg-sky-500/10' : done ? 'border-emerald-400/20 bg-emerald-500/5' : 'border-white/5 bg-white/[0.02]',
              )}
            >
              <div className={clsx('grid size-8 place-items-center rounded-lg', active ? 'bg-sky-500/20 text-sky-200' : done ? 'bg-emerald-500/15 text-ok' : 'bg-white/5 text-slate-500')}>
                {done ? <Check size={16} /> : active ? <LoaderCircle size={16} className="animate-spin" /> : <Icon size={16} />}
              </div>
              <div className="min-w-0">
                <div className={clsx('text-sm font-medium', active || done ? 'text-slate-100' : 'text-slate-500')}>{stage.label}</div>
                <div className="truncate text-[11px] text-slate-500">{stage.detail}</div>
              </div>
            </li>
          )
        })}
      </ol>

      <p className={clsx('min-h-10 text-center text-sm leading-snug', failed ? 'text-danger' : 'text-slate-300')}>
        {error ?? job?.message ?? (upload < 1 ? `Uploading… ${Math.round(upload * 100)}%` : 'Starting…')}
      </p>
      {failed && (
        <button onClick={onRetry} className="mx-auto inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm text-slate-200 active:bg-white/10">
          <RotateCcw size={15} /> Back to the form
        </button>
      )}
    </motion.div>
  )
}

// ---------------------------------------------------------------- results

function DeliveryResult({ delivery, siteId, onAgain }: { delivery: Delivery; siteId: string; onAgain: () => void }) {
  const overlay = (delivery as Delivery & { overlay_url?: string | null }).overlay_url
  const [showOverlay, setShowOverlay] = useState(Boolean(overlay))
  const measure = (delivery as Delivery & { measure?: { method: string; message: string; model: string; seconds: number } }).measure
  return (
    <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="flex flex-col gap-4 pt-2">
      <div className="text-center">
        <div className="mx-auto mb-2 grid size-11 place-items-center rounded-full bg-emerald-500/15 text-ok ring-1 ring-emerald-400/30">
          <Check size={22} />
        </div>
        <h2 className="text-lg font-semibold text-white">Delivery in the twin</h2>
        <p className="text-xs text-slate-400">
          It just dropped into the 3D view on the big screen{measure?.seconds ? ` · ${Math.round(measure.seconds)} s` : ''}.
        </p>
      </div>
      {(overlay || delivery.photo_url) && (
        <button onClick={() => setShowOverlay((v) => !v)} className="relative overflow-hidden rounded-2xl border border-white/10">
          <img src={showOverlay && overlay ? overlay : delivery.photo_url} alt="" className="block max-h-72 w-full object-cover" />
          {overlay && (
            <span className="absolute bottom-2 right-2 rounded-full bg-black/60 px-2 py-1 text-[10px] text-slate-200 backdrop-blur">
              {showOverlay ? 'measurement overlay · tap for photo' : 'photo · tap for overlay'}
            </span>
          )}
        </button>
      )}
      <DeliveryCard delivery={delivery} />
      {delivery.model_url && (
        <Suspense fallback={<div className="h-56 animate-pulse rounded-2xl bg-white/5" />}>
          <ModelPreview url={delivery.model_url} />
        </Suspense>
      )}
      {measure && (
        <p className="text-center text-[11px] leading-snug text-slate-500">
          {measure.message}. Model: {measure.model === 'procedural' ? 'parametric crate (no FAL_KEY)' : measure.model}.
        </p>
      )}
      <div className="flex gap-2">
        <Link to={`/site/${siteId}`} className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-xl border border-white/10 bg-white/5 py-3 text-sm text-slate-200 active:bg-white/10">
          Open twin <ArrowRight size={15} />
        </Link>
        <button onClick={onAgain} className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-sky-500 py-3 text-sm font-semibold text-white active:bg-sky-600">
          <Camera size={15} /> Next delivery
        </button>
      </div>
    </motion.div>
  )
}

function RoomResult({ scan, siteId, building, onAgain }: { scan: RoomScan; siteId: string; building: Building | null; onAgain: () => void }) {
  const room = building?.spaces.find((s) => s.id === scan.space_id)
  const deviations = [...scan.deviations].sort((a, b) => Math.abs(b.offset_m) - Math.abs(a.offset_m))
  return (
    <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="flex flex-col gap-4 pt-2">
      <div className="text-center">
        <div className="mx-auto mb-2 grid size-11 place-items-center rounded-full bg-violet-500/15 text-violet-300 ring-1 ring-violet-400/30">
          <ScanLine size={22} />
        </div>
        <h2 className="text-lg font-semibold text-white">{room?.name ?? 'Room'} scanned</h2>
        <p className="text-xs text-slate-400">The splat is now fitted inside the plan walls on the big screen.</p>
      </div>
      <div className="rounded-2xl border border-white/10 bg-slate-900/60 p-4 text-sm leading-relaxed text-slate-200">{scan.summary}</div>
      <div className="flex flex-col gap-1.5">
        {deviations.map((d) => {
          const big = Math.abs(d.offset_m) >= 0.15
          const label = (d as typeof d & { direction?: string }).direction ?? `wall ${d.wall_index + 1}`
          return (
            <div key={d.wall_index} className="flex items-center gap-3 rounded-xl bg-white/[0.03] px-3 py-2">
              <span className="w-24 shrink-0 text-xs capitalize text-slate-300">{label} wall</span>
              <div className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-white/5">
                <div
                  className={clsx('absolute inset-y-0 left-0 rounded-full', big ? 'bg-danger' : Math.abs(d.offset_m) > 0.05 ? 'bg-warn' : 'bg-ok')}
                  style={{ width: `${Math.min(100, (Math.abs(d.offset_m) / 0.5) * 100)}%` }}
                />
              </div>
              <span className={clsx('w-16 shrink-0 text-right text-xs tabular-nums', big ? 'text-danger' : 'text-slate-400')}>
                {Math.round(d.offset_m * 100) > 0 ? '+' : ''}{Math.round(d.offset_m * 100) || 0} cm
              </span>
            </div>
          )
        })}
      </div>
      <div className="flex gap-2">
        <Link to={`/site/${siteId}`} className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-xl border border-white/10 bg-white/5 py-3 text-sm text-slate-200 active:bg-white/10">
          Open twin <ArrowRight size={15} />
        </Link>
        <button onClick={onAgain} className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-violet-500 py-3 text-sm font-semibold text-white active:bg-violet-600">
          <ScanLine size={15} /> Scan another
        </button>
      </div>
    </motion.div>
  )
}

// ---------------------------------------------------------------- site chooser (no ?site=)

function SiteChooser({ onPick }: { onPick: (id: string) => void }) {
  const [sites, setSites] = useState<Site[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    api.sites().then(setSites).catch((e: Error) => setError(e.message))
  }, [])
  return (
    <div className="flex flex-col gap-2 pt-4">
      <h2 className="text-sm font-medium text-slate-300">Which site are you at?</h2>
      {error && <p className="text-sm text-danger">{error}</p>}
      {!sites && !error && <div className="h-24 animate-pulse rounded-xl bg-white/5" />}
      {sites?.slice(0, 40).map((site) => (
        <button key={site.id} onClick={() => onPick(site.id)} className="flex items-center justify-between rounded-xl border border-white/10 bg-white/[0.03] px-3 py-3 text-left active:bg-white/10">
          <span className="text-sm text-slate-100">{site.name}</span>
          <ArrowRight size={15} className="text-slate-500" />
        </button>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------- page

export default function CapturePage() {
  const [params, setParams] = useSearchParams()
  const siteId = params.get('site')
  const [site, setSite] = useState<Site | null>(null)
  const [building, setBuilding] = useState<Building | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [mode, setMode] = useState<Mode>(params.get('mode') === 'room' ? 'room' : 'delivery')
  const [photos, setPhotos] = useState<Photo[]>([])
  const [editing, setEditing] = useState<string | null>(null)
  const [showDetails, setShowDetails] = useState(false)
  const [label, setLabel] = useState('')
  const [note, setNote] = useState('')
  const [dims, setDims] = useState({ w: '', d: '', h: '' })
  const [target, setTarget] = useState<string | null>(null)
  const [room, setRoom] = useState<string | null>(null)
  const [roomFile, setRoomFile] = useState<File | null>(null)

  const [stage, setStage] = useState<'form' | 'progress'>('form')
  const [upload, setUpload] = useState(0)
  const [submitted, setSubmitted] = useState<CaptureJob | null>(null)
  const [error, setError] = useState<string | null>(null)
  const job = useCaptureJob(submitted)

  useEffect(() => {
    if (!siteId) return
    let cancelled = false
    setLoadError(null)
    api.sites().then((all) => !cancelled && setSite(all.find((s) => s.id === siteId) ?? null)).catch(() => undefined)
    api
      .building(siteId)
      .then((b) => {
        if (cancelled) return
        setBuilding(b)
        useTwin.setState({ building: b }) // DeliveryCard resolves room names from the shared store
      })
      .catch((e: Error) => !cancelled && setLoadError(e.message))
    return () => {
      cancelled = true
    }
  }, [siteId])

  useEffect(() => () => photos.forEach((p) => URL.revokeObjectURL(p.url)), []) // eslint-disable-line react-hooks/exhaustive-deps

  // ?job=<id> resumes a capture (phone reload, or a link to a result).
  const jobParam = params.get('job')
  useEffect(() => {
    if (!jobParam || submitted?.id === jobParam) return
    api
      .captureJob(jobParam)
      .then((existing) => {
        setMode(existing.kind)
        setUpload(1)
        setSubmitted(existing)
        setStage('progress')
      })
      .catch(() => undefined)
  }, [jobParam]) // eslint-disable-line react-hooks/exhaustive-deps

  const rememberJob = (id: string | null) =>
    setParams(
      (current) => {
        const next = new URLSearchParams(current)
        if (id) next.set('job', id)
        else next.delete('job')
        return next
      },
      { replace: true },
    )

  const addFiles = (files: FileList | File[] | null) => {
    if (!files) return
    const incoming = Array.from(files).filter((f) => f.type.startsWith('image/') || /\.(jpe?g|png|heic|webp)$/i.test(f.name))
    setPhotos((current) => [
      ...current,
      ...incoming.slice(0, MAX_PHOTOS - current.length).map((file) => ({ id: newId(), file, url: URL.createObjectURL(file), bbox: null })),
    ])
  }
  const removePhoto = (id: string) =>
    setPhotos((current) => {
      const photo = current.find((p) => p.id === id)
      if (photo) URL.revokeObjectURL(photo.url)
      return current.filter((p) => p.id !== id)
    })

  const declaredState = useMemo(() => {
    const values = [dims.w, dims.d, dims.h].map((v) => v.trim())
    const filled = values.filter(Boolean).length
    const valid = values.every((v) => !v || (Number.isFinite(Number(v)) && Number(v) > 0 && Number(v) < 40))
    return { filled, ok: valid && (filled === 0 || filled === 3) }
  }, [dims])

  const canSubmit =
    !!siteId && (mode === 'delivery' ? photos.length > 0 && declaredState.ok : !!room)

  const submit = async () => {
    if (!siteId || !canSubmit) return
    setError(null)
    setUpload(0)
    setSubmitted(null)
    setStage('progress')
    window.scrollTo({ top: 0, behavior: 'smooth' })
    const form = new FormData()
    form.append('site_id', siteId)
    try {
      let created: CaptureJob
      if (mode === 'delivery') {
        photos.forEach((p) => form.append('photos', p.file, p.file.name || 'photo.jpg'))
        if (declaredState.filled === 3) {
          form.append('declared_w', dims.w)
          form.append('declared_d', dims.d)
          form.append('declared_h', dims.h)
        }
        if (target) form.append('target_space', target)
        if (label.trim()) form.append('label', label.trim())
        if (note.trim()) form.append('note', note.trim())
        if (photos.some((p) => p.bbox)) form.append('bboxes', JSON.stringify(photos.map((p) => p.bbox)))
        created = await uploadForm('/api/capture/delivery', form, setUpload)
      } else {
        form.append('space_id', room!)
        if (roomFile) {
          const isSplat = /\.(ply|spz|splat)$/i.test(roomFile.name)
          form.append(isSplat ? 'splat' : 'video', roomFile, roomFile.name)
        }
        created = await uploadForm('/api/capture/room', form, setUpload)
      }
      setUpload(1)
      setSubmitted(created)
      rememberJob(created.id)
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const reset = () => {
    rememberJob(null)
    setStage('form')
    setSubmitted(null)
    setError(null)
    setUpload(0)
  }
  const again = () => {
    photos.forEach((p) => URL.revokeObjectURL(p.url))
    setPhotos([])
    setLabel('')
    setNote('')
    setDims({ w: '', d: '', h: '' })
    setRoomFile(null)
    reset()
  }

  const result = job?.status === 'done' ? job.result : undefined
  const editingPhoto = photos.find((p) => p.id === editing)

  return (
    <div className="min-h-dvh bg-bg bg-[radial-gradient(ellipse_at_top,rgba(56,189,248,0.14),transparent_55%),radial-gradient(ellipse_at_bottom_right,rgba(167,139,250,0.10),transparent_50%)] text-slate-200">
      <header className="sticky top-0 z-30 border-b border-white/5 bg-bg/80 px-4 pb-3 pt-[max(env(safe-area-inset-top),12px)] backdrop-blur-xl">
        <div className="mx-auto flex max-w-md items-center gap-3">
          <div className="grid size-9 place-items-center rounded-xl bg-gradient-to-br from-sky-400 to-violet-500 text-white shadow-lg shadow-sky-500/30">
            <Package size={18} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[10px] font-semibold uppercase tracking-[0.2em] text-sky-300/80">Dackel capture</div>
            <div className="truncate text-sm font-medium text-white">{site?.name ?? building?.building.name ?? (siteId ? siteId : 'Choose a site')}</div>
          </div>
          <a href={MARKER_PDF_URL} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 rounded-lg border border-white/10 px-2 py-1.5 text-[11px] text-slate-300 active:bg-white/10">
            <Printer size={13} /> Marker
          </a>
        </div>
      </header>

      <main className="mx-auto flex max-w-md flex-col gap-6 px-4 pb-36 pt-4">
        {!siteId && <SiteChooser onPick={(id) => setParams({ site: id })} />}
        {loadError && <p className="rounded-xl border border-rose-400/30 bg-rose-500/10 p-3 text-sm text-rose-200">Could not load the site: {loadError}</p>}

        {siteId && stage === 'progress' && !result && (
          <ProgressView mode={mode} job={job} upload={upload} error={error} onRetry={reset} />
        )}
        {siteId && result && mode === 'delivery' && <DeliveryResult delivery={result as Delivery} siteId={siteId} onAgain={again} />}
        {siteId && result && mode === 'room' && <RoomResult scan={result as RoomScan} siteId={siteId} building={building} onAgain={again} />}

        {siteId && stage === 'form' && (
          <>
            <div className="grid grid-cols-2 gap-1 rounded-2xl border border-white/10 bg-white/[0.03] p-1">
              {([
                ['delivery', 'New delivery', Package],
                ['room', 'Room scan', ScanLine],
              ] as const).map(([key, text, Icon]) => (
                <button
                  key={key}
                  onClick={() => setMode(key)}
                  className={clsx(
                    'relative flex items-center justify-center gap-2 rounded-xl py-2.5 text-sm font-medium transition',
                    mode === key ? 'text-white' : 'text-slate-400',
                  )}
                >
                  {mode === key && <motion.span layoutId="mode-pill" className="absolute inset-0 rounded-xl bg-white/10 ring-1 ring-white/15" />}
                  <Icon size={16} className="relative" />
                  <span className="relative">{text}</span>
                </button>
              ))}
            </div>

            <AnimatePresence mode="wait">
              {mode === 'delivery' ? (
                <motion.div key="delivery" initial={{ opacity: 0, x: -12 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 12 }} className="flex flex-col gap-6">
                  <Section title="Photos" hint={`${photos.length}/${MAX_PHOTOS}`}>
                    <div className="flex items-start gap-3 rounded-2xl border border-sky-400/20 bg-sky-500/[0.06] p-3 text-xs leading-snug text-sky-100/90">
                      <Ruler size={16} className="mt-0.5 shrink-0 text-sky-300" />
                      <span>
                        Lay the printed <b>A4 marker</b> flat on the floor next to the item, then shoot from 2–3 m, a bit from above. 2–4 angles
                        give the best accuracy.
                      </span>
                    </div>
                    <div className="grid grid-cols-2 gap-2.5">
                      {photos.map((photo, index) => (
                        <motion.div layout key={photo.id} className="group relative aspect-[4/3] overflow-hidden rounded-xl ring-1 ring-white/10">
                          <img src={photo.url} alt="" className="size-full object-cover" />
                          {photo.bbox && (
                            <div
                              className="pointer-events-none absolute border-2 border-sky-400"
                              style={{ left: `${photo.bbox[0] * 100}%`, top: `${photo.bbox[1] * 100}%`, width: `${(photo.bbox[2] - photo.bbox[0]) * 100}%`, height: `${(photo.bbox[3] - photo.bbox[1]) * 100}%` }}
                            />
                          )}
                          <span className="absolute left-1.5 top-1.5 rounded-md bg-black/60 px-1.5 py-0.5 text-[10px] text-slate-200">{index + 1}</span>
                          <div className="absolute inset-x-1.5 bottom-1.5 flex justify-between">
                            <button onClick={() => setEditing(photo.id)} className={clsx('inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] backdrop-blur', photo.bbox ? 'bg-sky-500/80 text-white' : 'bg-black/60 text-slate-200')}>
                              <Crop size={12} /> {photo.bbox ? 'Outlined' : 'Outline'}
                            </button>
                            <button onClick={() => removePhoto(photo.id)} aria-label="Remove photo" className="rounded-lg bg-black/60 p-1.5 text-slate-200 backdrop-blur">
                              <Trash2 size={12} />
                            </button>
                          </div>
                        </motion.div>
                      ))}
                      {photos.length < MAX_PHOTOS && (
                        <label className="flex aspect-[4/3] cursor-pointer flex-col items-center justify-center gap-1.5 rounded-xl border-2 border-dashed border-sky-400/40 bg-sky-500/[0.06] text-sky-200 active:bg-sky-500/15">
                          <Camera size={26} />
                          <span className="text-sm font-medium">Take photo</span>
                          <input type="file" accept="image/*" capture="environment" multiple className="hidden" onChange={(e) => { addFiles(e.target.files); e.target.value = '' }} />
                        </label>
                      )}
                      {photos.length < MAX_PHOTOS && (
                        <label className="flex aspect-[4/3] cursor-pointer flex-col items-center justify-center gap-1.5 rounded-xl border border-white/10 bg-white/[0.03] text-slate-300 active:bg-white/10">
                          <ImagePlus size={22} />
                          <span className="text-xs">From library</span>
                          <input type="file" accept="image/*" multiple className="hidden" onChange={(e) => { addFiles(e.target.files); e.target.value = '' }} />
                        </label>
                      )}
                    </div>
                    {photos.length === 0 && (
                      <button
                        onClick={() => samplePhotoFile().then((f) => addFiles([f])).catch((e: Error) => setError(e.message))}
                        className="self-center text-xs text-slate-400 underline decoration-dotted underline-offset-4"
                      >
                        No marker at hand? Use a sample photo
                      </button>
                    )}
                  </Section>

                  <Section title="Where should it go?" hint="optional">
                    <RoomPicker building={building} value={target} onChange={setTarget} optional placeholder="Target room — we'll check every door" />
                  </Section>

                  <section className="flex flex-col gap-3">
                    <button onClick={() => setShowDetails((v) => !v)} className="flex items-center justify-between text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-400">
                      Delivery note &amp; PO dimensions
                      <ChevronDown size={16} className={clsx('transition', showDetails && 'rotate-180')} />
                    </button>
                    <AnimatePresence initial={false}>
                      {showDetails && (
                        <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="flex flex-col gap-2.5 overflow-hidden">
                          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="What is it? e.g. Pallet with steel drum" className={inputCls} />
                          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Delivery note no., e.g. LS-2026-4711" className={inputCls} />
                          <div className="flex gap-2">
                            <DimInput label="W" value={dims.w} onChange={(w) => setDims((d) => ({ ...d, w }))} />
                            <DimInput label="D" value={dims.d} onChange={(v) => setDims((d) => ({ ...d, d: v }))} />
                            <DimInput label="H" value={dims.h} onChange={(h) => setDims((d) => ({ ...d, h }))} />
                          </div>
                          {!declaredState.ok && <p className="text-xs text-warn">Enter all three PO dimensions in metres (or none).</p>}
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </section>
                </motion.div>
              ) : (
                <motion.div key="room" initial={{ opacity: 0, x: 12 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -12 }} className="flex flex-col gap-6">
                  <Section title="Which room?">
                    <RoomPicker building={building} value={room} onChange={setRoom} />
                  </Section>
                  <Section title="Scan" hint="video or splat file">
                    <div className="grid grid-cols-2 gap-2.5">
                      <label className="flex aspect-[4/3] cursor-pointer flex-col items-center justify-center gap-1.5 rounded-xl border-2 border-dashed border-violet-400/40 bg-violet-500/[0.06] text-violet-200 active:bg-violet-500/15">
                        <Video size={24} />
                        <span className="text-sm font-medium">Record walk-through</span>
                        <input type="file" accept="video/*" capture="environment" className="hidden" onChange={(e) => setRoomFile(e.target.files?.[0] ?? null)} />
                      </label>
                      <label className="flex aspect-[4/3] cursor-pointer flex-col items-center justify-center gap-1.5 rounded-xl border border-white/10 bg-white/[0.03] text-slate-300 active:bg-white/10">
                        <FileUp size={22} />
                        <span className="text-xs">Splat file</span>
                        <span className="text-[10px] text-slate-500">.ply · .spz · .splat</span>
                        <input type="file" accept=".ply,.spz,.splat,application/octet-stream" className="hidden" onChange={(e) => setRoomFile(e.target.files?.[0] ?? null)} />
                      </label>
                    </div>
                    {roomFile ? (
                      <div className="flex items-center justify-between rounded-xl bg-white/[0.04] px-3 py-2 text-xs text-slate-300">
                        <span className="truncate">{roomFile.name} · {(roomFile.size / 1e6).toFixed(1)} MB</span>
                        <button onClick={() => setRoomFile(null)} className="p-1 text-slate-400" aria-label="Remove file"><Trash2 size={13} /></button>
                      </div>
                    ) : (
                      <p className="text-xs leading-snug text-slate-500">
                        Walk slowly along the walls for 30–60 s. Without a GPU worker the twin uses its demo scan of this room, so you can also submit
                        without a file.
                      </p>
                    )}
                  </Section>
                </motion.div>
              )}
            </AnimatePresence>
            {error && <p className="text-sm text-danger">{error}</p>}
          </>
        )}
      </main>

      {siteId && stage === 'form' && (
        <div className="fixed inset-x-0 bottom-0 z-30 border-t border-white/5 bg-bg/85 px-4 pb-[max(env(safe-area-inset-bottom),14px)] pt-3 backdrop-blur-xl">
          <button
            onClick={submit}
            disabled={!canSubmit}
            className={clsx(
              'mx-auto flex w-full max-w-md items-center justify-center gap-2 rounded-2xl py-3.5 text-base font-semibold text-white shadow-lg transition disabled:opacity-40',
              mode === 'delivery' ? 'bg-gradient-to-r from-sky-500 to-cyan-400 shadow-sky-500/30' : 'bg-gradient-to-r from-violet-500 to-fuchsia-500 shadow-violet-500/30',
            )}
          >
            {mode === 'delivery' ? <Ruler size={18} /> : <ScanLine size={18} />}
            {mode === 'delivery' ? (photos.length ? `Measure & check ${photos.length > 1 ? `(${photos.length} photos)` : ''}` : 'Add a photo first') : room ? 'Fit scan into plan' : 'Pick the room first'}
          </button>
        </div>
      )}

      {editingPhoto && (
        <BBoxEditor
          src={editingPhoto.url}
          initial={editingPhoto.bbox}
          onCancel={() => setEditing(null)}
          onDone={(bbox) => {
            setPhotos((current) => current.map((p) => (p.id === editingPhoto.id ? { ...p, bbox } : p)))
            setEditing(null)
          }}
        />
      )}
    </div>
  )
}
