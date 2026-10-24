// Owner: agent B (map + 3D twin). Globe with all Standorte.
import '../dev/mockApi'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import { AnimatePresence, motion } from 'framer-motion'
import { Building2, Factory, GraduationCap, Layers, MapPin, Plane, Plus, Search, ShoppingBag, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { isMockActive, onMockChange } from '../dev/mockApi'
import { api } from '../lib/api'
import type { Site } from '../lib/types'
import { eventFlows, syntheticFlows, type Flow } from '../map/arcs'
import SiteMap, { KIND_COLOR, type SiteMapApi } from '../map/SiteMap'
import AddSiteDialog from '../sites/AddSiteDialog'

const KIND_ICON: Record<Site['kind'], ReactNode> = {
  factory: <Factory size={14} />,
  campus: <GraduationCap size={14} />,
  office: <Building2 size={14} />,
  airport: <Plane size={14} />,
  mall: <ShoppingBag size={14} />,
  other: <MapPin size={14} />,
}

const VISITED_KEY = 'sitetwin-visited-map'

export default function MapPage() {
  const nav = useNavigate()
  const qc = useQueryClient()
  const sites = useQuery({ queryKey: ['sites'], queryFn: api.sites, staleTime: 60_000 })
  const [query, setQuery] = useState('')
  const [hovered, setHovered] = useState<string | null>(null)
  const [active, setActive] = useState<string | null>(null)
  const [pickMode, setPickMode] = useState(false)
  // The Add-Standort dialog stays mounted while the user picks a spot on the map (picking=true).
  const [dialog, setDialog] = useState<{ lat: number | null; lon: number | null; seq: number; picking: boolean } | null>(null)
  const [leaving, setLeaving] = useState(false)
  const [flows, setFlows] = useState<Flow[]>([])
  const [mock, setMock] = useState(isMockActive())
  useEffect(() => onMockChange(setMock), [])
  const mapApi = useRef<SiteMapApi>(null)
  const [skipIntro] = useState(() => sessionStorage.getItem(VISITED_KEY) === '1')
  useEffect(() => sessionStorage.setItem(VISITED_KEY, '1'), [])

  const list = useMemo(() => sites.data ?? [], [sites.data])
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    const out = q ? list.filter((s) => `${s.name} ${s.kind} ${s.id} ${s.source}`.toLowerCase().includes(q)) : list
    return [...out].sort((a, b) => Number(a.demo_location) - Number(b.demo_location) || a.name.localeCompare(b.name))
  }, [list, query])

  // Flows: real delivery events when available, else synthetic arcs.
  useEffect(() => {
    if (list.length < 2) return
    let cancelled = false
    setFlows(syntheticFlows(list))
    eventFlows(list)
      .then((f) => !cancelled && f.length >= 3 && setFlows(f))
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [list])

  const enter = async (site: Site) => {
    if (leaving) return
    setActive(site.id)
    setPickMode(false)
    await mapApi.current?.flyToSite(site)
    setLeaving(true)
    setTimeout(() => nav(`/site/${site.id}`), 650)
  }

  const counts = useMemo(() => {
    const c: Partial<Record<Site['kind'], number>> = {}
    for (const s of list) c[s.kind] = (c[s.kind] ?? 0) + 1
    return c
  }, [list])

  return (
    <div className="relative h-full w-full overflow-hidden bg-[#05070d]">
      <SiteMap
        ref={mapApi}
        sites={list}
        flows={flows}
        hoveredId={hovered}
        activeId={active}
        pickMode={pickMode}
        skipIntro={skipIntro}
        onSiteClick={enter}
        onSiteHover={setHovered}
        onPick={(lat, lon) => {
          setPickMode(false)
          setDialog((d) => ({ lat, lon, seq: (d?.seq ?? 0) + 1, picking: false }))
        }}
      />

      {/* soft vignette over the map */}
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_55%,rgba(3,5,10,0.65)_100%)]" />

      {/* left panel */}
      <motion.div
        initial={{ x: -40, opacity: 0 }}
        animate={{ x: 0, opacity: 1 }}
        transition={{ delay: 0.4, type: 'spring', stiffness: 200, damping: 26 }}
        className="absolute bottom-4 left-4 top-4 flex w-[340px] flex-col"
      >
        <div className="flex min-h-0 flex-1 flex-col rounded-2xl border border-white/10 bg-slate-950/60 shadow-2xl shadow-black/50 backdrop-blur-xl">
          <div className="p-4 pb-3">
            <div className="flex items-center gap-2.5">
              <div className="grid size-9 place-items-center rounded-xl bg-gradient-to-br from-sky-400 to-violet-500 text-white shadow-[0_0_24px_rgba(56,189,248,0.5)]">
                <Layers size={18} />
              </div>
              <div>
                <div className="text-[17px] font-semibold tracking-tight text-white">SiteTwin</div>
                <div className="text-[11px] text-slate-400">Living 3D twins of every Standort</div>
              </div>
              {mock && <span className="ml-auto rounded bg-amber-400/20 px-1.5 py-0.5 text-[10px] font-semibold text-amber-200">MOCK</span>}
            </div>
            <div className="mt-4 flex items-center gap-2 rounded-xl border border-white/10 bg-slate-900/70 px-3 py-2 focus-within:border-sky-400/50 focus-within:ring-2 focus-within:ring-sky-400/15">
              <Search size={15} className="text-slate-500" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && filtered[0] && enter(filtered[0])}
                placeholder="Search Standorte…"
                className="min-w-0 flex-1 bg-transparent text-sm text-slate-100 outline-none placeholder:text-slate-500"
              />
              {query && (
                <button onClick={() => setQuery('')} className="text-slate-500 hover:text-slate-200">
                  <X size={14} />
                </button>
              )}
            </div>
            <div className="mt-3 flex flex-wrap gap-1.5">
              {(Object.keys(counts) as Site['kind'][]).map((k) => (
                <button
                  key={k}
                  onClick={() => setQuery(query === k ? '' : k)}
                  className={clsx(
                    'flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] capitalize transition',
                    query === k ? 'border-white/25 bg-white/10 text-white' : 'border-white/10 text-slate-400 hover:text-slate-200',
                  )}
                >
                  <span className="size-1.5 rounded-full" style={{ background: KIND_COLOR[k], boxShadow: `0 0 8px ${KIND_COLOR[k]}` }} />
                  {k} <span className="text-slate-500">{counts[k]}</span>
                </button>
              ))}
            </div>
          </div>
          <div className="mx-4 h-px bg-white/5" />
          <ul className="min-h-0 flex-1 overflow-y-auto p-2 [scrollbar-width:thin]">
            {sites.isLoading && <li className="px-3 py-6 text-center text-sm text-slate-500">Loading sites…</li>}
            {sites.isError && <li className="px-3 py-6 text-center text-sm text-rose-300">Could not load sites: {String(sites.error)}</li>}
            {filtered.map((s) => (
              <li key={s.id}>
                <button
                  onClick={() => enter(s)}
                  onMouseEnter={() => setHovered(s.id)}
                  onMouseLeave={() => setHovered(null)}
                  className={clsx(
                    'group flex w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left transition',
                    hovered === s.id || active === s.id ? 'bg-white/[0.07]' : 'hover:bg-white/5',
                  )}
                >
                  <span
                    className="grid size-8 shrink-0 place-items-center rounded-lg"
                    style={{ color: KIND_COLOR[s.kind], background: `color-mix(in srgb, ${KIND_COLOR[s.kind]} 14%, transparent)` }}
                  >
                    {KIND_ICON[s.kind] ?? KIND_ICON.other}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-medium text-slate-100 group-hover:text-white">{s.name}</span>
                    <span className="block truncate text-[11px] text-slate-500">
                      {s.floors} floor{s.floors === 1 ? '' : 's'} · {s.source.replace(/_/g, ' ')}
                      {s.demo_location && ' · demo location'}
                    </span>
                  </span>
                </button>
              </li>
            ))}
            {!sites.isLoading && !filtered.length && !sites.isError && <li className="px-3 py-6 text-center text-sm text-slate-500">No Standort matches.</li>}
          </ul>
          <div className="border-t border-white/5 p-3">
            <button
              onClick={() => {
                setPickMode(false)
                setDialog({ lat: null, lon: null, seq: 0, picking: false })
              }}
              className="flex w-full items-center justify-center gap-2 rounded-xl border border-sky-400/30 bg-sky-500/15 px-3 py-2 text-sm font-medium text-sky-100 transition hover:bg-sky-500/25"
            >
              <Plus size={15} /> Add Standort
            </button>
            <div className="mt-1.5 text-center text-[10px] text-slate-500">by address, or right-click anywhere on the map</div>
          </div>
        </div>
      </motion.div>

      {/* flows legend */}
      {flows.length > 0 && (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 1.2 }} className="pointer-events-none absolute right-4 top-4 rounded-xl border border-white/10 bg-slate-950/60 px-3 py-2 text-[11px] text-slate-300 backdrop-blur-xl">
          <span className="mr-1.5 inline-block size-1.5 animate-pulse rounded-full bg-sky-300 shadow-[0_0_8px_#7dd3fc]" />
          {flows.length} deliveries in motion · last 7 days
        </motion.div>
      )}

      {dialog && (
        <div className={clsx('absolute inset-0 z-40', dialog.picking && 'pointer-events-none')}>
          <AddSiteDialog
            lat={dialog.lat}
            lon={dialog.lon}
            pickSeq={dialog.seq}
            picking={dialog.picking}
            onPickOnMap={(current) => {
              setDialog((d) => d && { ...d, picking: true })
              setPickMode(true)
              if (current) mapApi.current?.flyTo(current.lat, current.lon)
            }}
            onCancelPick={() => {
              setPickMode(false)
              setDialog((d) => d && { ...d, picking: false })
            }}
            onClose={() => {
              setPickMode(false)
              setDialog(null)
            }}
            onCreated={(site) => {
              setDialog(null)
              qc.setQueryData<Site[]>(['sites'], (old) => [...(old ?? []).filter((s) => s.id !== site.id), site])
              void qc.invalidateQueries({ queryKey: ['sites'] })
              setTimeout(() => enter(site), 300)
            }}
          />
        </div>
      )}

      {/* crossfade into the twin */}
      <AnimatePresence>
        {leaving && (
          <motion.div
            className="pointer-events-none absolute inset-0 z-50 bg-[#05070d]"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.6, ease: 'easeIn' }}
          />
        )}
      </AnimatePresence>
    </div>
  )
}
