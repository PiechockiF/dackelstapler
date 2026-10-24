// Owner: agent D. Create a Standort from an address or map position plus a building.json or several
// floor-plan photos (escape plans etc.). Claude reads every plan; the server stitches storeys and stacks them.
import { useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { AlertTriangle, Building2, Crosshair, FileJson, Loader2, MapPin, Upload, X } from 'lucide-react'
import { api } from '../lib/api'
import PlanReview from './PlanReview'
import type { GeoResult, Site, SiteDraft } from '../lib/types'

type Phase = 'idle' | 'uploading' | 'parsing' | 'done' | 'error'
type LatLon = { lat: number; lon: number }
const KINDS: Site['kind'][] = ['factory', 'campus', 'office', 'airport', 'mall', 'other']
const PLAN_ACCEPT = '.json,application/json,image/png,image/jpeg,image/webp,application/pdf'

const isJsonFile = (file: File) => file.name.toLowerCase().endsWith('.json') || file.type === 'application/json'

export default function AddSiteDialog(props: {
  /** Last position picked on the map (right-click or "Pick on map"); bump pickSeq on every pick. */
  lat?: number | null
  lon?: number | null
  pickSeq?: number
  /** While true the dialog shrinks to a hint bar so the map can be clicked. */
  picking?: boolean
  onPickOnMap?: (current: LatLon | null) => void
  onCancelPick?: () => void
  onClose: () => void
  onCreated: (site: Site) => void
}) {
  const [name, setName] = useState('')
  const [kind, setKind] = useState<Site['kind']>('office')
  const [address, setAddress] = useState('')
  const [location, setLocation] = useState<LatLon | null>(props.lat != null && props.lon != null ? { lat: props.lat, lon: props.lon } : null)
  const [suggestions, setSuggestions] = useState<GeoResult[]>([])
  const [addressTyped, setAddressTyped] = useState(false)
  const [geoBusy, setGeoBusy] = useState(false)
  const [files, setFiles] = useState<File[]>([])
  const [widthM, setWidthM] = useState('')
  const [phase, setPhase] = useState<Phase>('idle')
  const [error, setError] = useState<string | null>(null)
  const [review, setReview] = useState<SiteDraft | null>(null)
  const [overrides, setOverrides] = useState<Record<number, number>>({})
  const [created, setCreated] = useState<(Site & { warnings?: string[] }) | null>(null)
  const [dragging, setDragging] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  const jsonFile = files.find(isJsonFile) ?? null
  const plans = jsonFile ? [] : files
  const busy = phase === 'uploading' || phase === 'parsing'
  const siteName = name.trim() || address.trim()

  // A pick on the map sets the position and looks up its address.
  useEffect(() => {
    if (props.lat == null || props.lon == null) return
    const picked = { lat: props.lat, lon: props.lon }
    setLocation(picked)
    setSuggestions([])
    setAddressTyped(false)
    let cancelled = false
    setGeoBusy(true)
    api
      .reverseGeocode(picked.lat, picked.lon)
      .then((hit) => !cancelled && hit.label && setAddress(hit.label))
      .catch(() => {})
      .finally(() => !cancelled && setGeoBusy(false))
    return () => {
      cancelled = true
    }
  }, [props.lat, props.lon, props.pickSeq])

  // Search-as-you-type for the address field.
  useEffect(() => {
    const query = address.trim()
    if (!addressTyped || query.length < 3) {
      setSuggestions([])
      return
    }
    let cancelled = false
    const timer = setTimeout(() => {
      setGeoBusy(true)
      api
        .geocode(query, location ?? undefined)
        .then((hits) => !cancelled && setSuggestions(hits))
        .catch(() => !cancelled && setSuggestions([]))
        .finally(() => !cancelled && setGeoBusy(false))
    }, 350)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
    // location only biases the search; don't re-run when it changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address, addressTyped])

  useEffect(() => {
    if (!busy) return
    const started = Date.now()
    const timer = setInterval(() => setElapsed(Math.round((Date.now() - started) / 1000)), 500)
    return () => clearInterval(timer)
  }, [busy])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || busy) return
      if (props.picking) props.onCancelPick?.()
      else if (suggestions.length) setSuggestions([])
      else props.onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, props, suggestions.length])

  const choose = (hit: GeoResult) => {
    setAddress(hit.label)
    setAddressTyped(false)
    setSuggestions([])
    setLocation({ lat: hit.lat, lon: hit.lon })
  }

  const addFiles = (picked: FileList | null | undefined) => {
    const list = Array.from(picked ?? [])
    if (!list.length) return
    setError(null)
    const json = list.find(isJsonFile)
    // A building.json stands alone; plan images add up.
    if (json) setFiles([json])
    else setFiles((old) => [...old.filter((f) => !isJsonFile(f)), ...list.filter((f) => !old.some((o) => o.name === f.name && o.size === f.size))])
  }

  const resolveLocation = async (): Promise<LatLon | null> => {
    if (location) return location
    if (address.trim().length < 3) return null
    const [hit] = await api.geocode(address.trim())
    if (!hit) return null
    choose(hit)
    return { lat: hit.lat, lon: hit.lon }
  }

  const baseForm = (where: LatLon) => {
    const form = new FormData()
    if (name.trim()) form.append('name', name.trim())
    if (address.trim()) form.append('address', address.trim())
    form.append('lat', String(where.lat))
    form.append('lon', String(where.lon))
    form.append('kind', kind)
    return form
  }

  const submit = async () => {
    if (!files.length) return setError('Choose a building.json or one or more floor plans / escape plans.')
    setError(null)
    let where: LatLon | null
    try {
      where = await resolveLocation()
    } catch (err) {
      return setError(`Address lookup failed: ${(err as Error).message}`)
    }
    if (!where) return setError('Address not found. Pick a suggestion or mark the spot on the map.')
    setPhase(jsonFile ? 'uploading' : 'parsing')
    const form = baseForm(where)
    if (jsonFile) form.append('file', jsonFile)
    else plans.forEach((file) => form.append('files', file))
    if (!jsonFile && widthM.trim()) form.append('width_m', widthM.trim())
    try {
      const draft = await api.previewSite(form)
      setReview(draft)
      setOverrides({})
      setPhase('idle')
    } catch (err) {
      setPhase('error')
      setError((err as Error).message)
    }
  }

  const changeLevel = async (index: number, level: number) => {
    if (!review?.extractions || !location) return
    const next = { ...overrides, [index]: level }
    setOverrides(next)
    setPhase('uploading')
    setError(null)
    try {
      const draft = await api.restitchSite({
        extractions: review.extractions,
        matches: review.matches,
        level_overrides: next,
        site_id: review.site_id,
        name: name.trim() || undefined,
        address: address.trim() || undefined,
        lat: location.lat,
        lon: location.lon,
        width_m: widthM.trim() ? Number(widthM) : undefined,
      })
      setReview(draft)
      setPhase('idle')
    } catch (err) {
      setPhase('error')
      setError((err as Error).message)
    }
  }

  const confirm = async () => {
    if (!review || !location) return
    setPhase('uploading')
    setError(null)
    const form = baseForm(location)
    form.append('site_id', review.site_id)
    form.append('file', new File([JSON.stringify(review.building)], 'building.json', { type: 'application/json' }))
    plans.forEach((file) => form.append('files', file))
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

  if (props.picking) {
    return (
      <div className="pointer-events-auto absolute left-1/2 top-4 z-50 flex -translate-x-1/2 items-center gap-3 rounded-xl border border-amber-300/40 bg-slate-950/85 px-4 py-2 text-sm text-amber-100 shadow-2xl shadow-black/50 backdrop-blur-xl">
        <Crosshair size={15} />
        Click on the map to place the Standort
        <button type="button" onClick={props.onCancelPick} className="rounded-lg border border-white/10 px-2 py-0.5 text-xs text-slate-300 hover:bg-white/10">
          Back to form
        </button>
      </div>
    )
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
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold">New Standort</h2>
            <p className="truncate text-xs text-slate-400">
              {location ? `${location.lat.toFixed(5)}, ${location.lon.toFixed(5)}` : 'Enter an address or mark the spot on the map'}
            </p>
          </div>
          <button type="button" onClick={props.onClose} disabled={busy} className="rounded-lg p-1.5 text-slate-400 hover:bg-white/10 hover:text-white" aria-label="Close">
            <X size={16} />
          </button>
        </div>

        {review && !created ? (
          <div className="space-y-3">
            <PlanReview building={review.building} files={plans} warnings={review.warnings} busy={busy} onLevelChange={review.extractions ? changeLevel : undefined} />
            {error && <p className="text-sm text-red-300">{error}</p>}
            <div className="flex gap-2">
              <button type="button" disabled={busy} onClick={() => { setReview(null); setError(null) }} className="flex-1 rounded-xl border border-white/10 py-2 text-sm disabled:opacity-40">Back</button>
              <button type="button" disabled={busy} onClick={confirm} className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-sky-500 py-2 text-sm font-medium disabled:opacity-40">
                {busy && <Loader2 size={14} className="animate-spin" />}
                {busy ? 'Working…' : 'Confirm & create site'}
              </button>
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
            <div className="relative">
              <span className="mb-1 block text-xs text-slate-400">Address</span>
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <MapPin size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
                  <input
                    value={address}
                    onChange={(event) => {
                      setAddress(event.target.value)
                      setAddressTyped(true)
                      setLocation(null)
                    }}
                    onKeyDown={(event) => event.key === 'Enter' && suggestions[0] && choose(suggestions[0])}
                    placeholder="e.g. Freddie-Mercury-Straße 5, München"
                    disabled={busy}
                    className="w-full rounded-xl border border-white/10 bg-white/5 py-2 pl-8 pr-8 text-sm placeholder:text-slate-500 focus:border-sky-400/60 focus:outline-none"
                  />
                  {geoBusy && <Loader2 size={14} className="absolute right-3 top-1/2 -translate-y-1/2 animate-spin text-slate-500" />}
                </div>
                <button
                  type="button"
                  disabled={busy || !props.onPickOnMap}
                  onClick={() => props.onPickOnMap?.(location)}
                  className="flex shrink-0 items-center gap-1.5 rounded-xl border border-white/10 px-3 text-xs text-slate-300 hover:bg-white/5 disabled:opacity-40"
                >
                  <Crosshair size={14} /> Pick on map
                </button>
              </div>
              {suggestions.length > 0 && (
                <ul className="absolute left-0 right-0 top-full z-10 mt-1 overflow-hidden rounded-xl border border-white/10 bg-slate-900/95 shadow-xl backdrop-blur-xl">
                  {suggestions.map((hit) => (
                    <li key={`${hit.lat},${hit.lon},${hit.label}`}>
                      <button type="button" onClick={() => choose(hit)} className="w-full px-3 py-2 text-left text-sm text-slate-200 hover:bg-white/10">
                        {hit.label}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <label className="block">
              <span className="mb-1 block text-xs text-slate-400">Name (optional)</span>
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder={address.trim() ? `defaults to: ${address.trim()}` : 'e.g. Werk Freiham Halle 3'}
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
                addFiles(event.dataTransfer.files)
              }}
              onClick={() => !busy && inputRef.current?.click()}
              className={`flex cursor-pointer flex-col items-center justify-center gap-1.5 rounded-xl border border-dashed px-4 py-4 text-center transition ${
                dragging ? 'border-sky-400 bg-sky-400/10' : 'border-white/15 bg-white/[0.03] hover:border-white/30'
              }`}
            >
              {jsonFile ? (
                <>
                  <FileJson size={22} className="text-sky-300" />
                  <span className="text-sm">{jsonFile.name}</span>
                  <span className="text-[11px] text-slate-400">building.json — loaded as is</span>
                </>
              ) : (
                <>
                  <Upload size={22} className="text-slate-400" />
                  <span className="text-sm text-slate-300">
                    {plans.length ? 'Add more plans' : 'Drop photos of escape plans / floor plans (PNG, JPG, PDF)'}
                  </span>
                  <span className="text-[11px] text-slate-500">
                    several photos of one floor are stitched; different floors are stacked · or drop a building.json
                  </span>
                </>
              )}
              <input
                ref={inputRef}
                type="file"
                multiple
                accept={PLAN_ACCEPT}
                className="hidden"
                onChange={(event) => {
                  addFiles(event.target.files)
                  event.target.value = ''
                }}
              />
            </div>

            {plans.length > 0 && (
              <ul className="grid grid-cols-4 gap-2">
                {plans.map((file) => (
                  <li key={`${file.name}-${file.size}`}>
                    <FileThumb file={file} disabled={busy} onRemove={() => setFiles((old) => old.filter((f) => f !== file))} />
                  </li>
                ))}
              </ul>
            )}
            {jsonFile && (
              <button type="button" disabled={busy} onClick={() => setFiles([])} className="text-xs text-slate-400 underline hover:text-white">
                Remove building.json
              </button>
            )}

            {plans.length > 0 && (
              <label className="block">
                <span className="mb-1 block text-xs text-slate-400">Longest side of the building in metres (optional — sets the scale)</span>
                <input
                  value={widthM}
                  onChange={(event) => setWidthM(event.target.value.replace(',', '.'))}
                  inputMode="decimal"
                  placeholder="estimated from doors and stairs if empty"
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
                    animate={{ width: phase === 'parsing' ? `${Math.min(95, 5 + (elapsed * 1.6) / Math.max(1, Math.ceil(plans.length / 4)))}%` : '80%' }}
                    transition={{ ease: 'easeOut', duration: 0.5 }}
                  />
                </div>
                <p className="text-[11px] text-slate-400">
                  {phase === 'parsing'
                    ? `Reading ${plans.length} plan${plans.length === 1 ? '' : 's'} in parallel, stitching floors and stacking them… ${elapsed}s (usually 1–2 minutes)`
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
                disabled={busy || !files.length || (!location && address.trim().length < 3)}
                title={siteName ? `Will be saved as “${siteName}”` : undefined}
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

function FileThumb({ file, disabled, onRemove }: { file: File; disabled: boolean; onRemove: () => void }) {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!file.type.startsWith('image/')) return
    const next = URL.createObjectURL(file)
    setUrl(next)
    return () => URL.revokeObjectURL(next)
  }, [file])
  return (
    <div className="group relative aspect-[3/4] overflow-hidden rounded-lg border border-white/10 bg-white/5" title={file.name}>
      {url ? (
        <img src={url} alt={file.name} className="h-full w-full object-cover" />
      ) : (
        <div className="flex h-full items-center justify-center p-1 text-center text-[10px] text-slate-400">{file.name}</div>
      )}
      <button
        type="button"
        disabled={disabled}
        onClick={(event) => {
          event.stopPropagation()
          onRemove()
        }}
        className="absolute right-1 top-1 rounded-md bg-black/60 p-0.5 text-slate-200 opacity-0 transition group-hover:opacity-100"
        aria-label={`Remove ${file.name}`}
      >
        <X size={12} />
      </button>
    </div>
  )
}
