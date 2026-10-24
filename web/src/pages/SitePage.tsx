// Owner: agent B. 3D twin of one site with HUD panels; embeds <ChatPanel siteId=... /> from ../chat (agent D).
import '../dev/mockApi'
import { useQuery } from '@tanstack/react-query'
import clsx from 'clsx'
import { AnimatePresence, motion } from 'framer-motion'
import { ArrowLeft, CalendarDays, ChevronRight, MessageSquare, Navigation, PackageOpen, Radio } from 'lucide-react'
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import ChatPanel from '../chat/ChatPanel'
import { isMockActive, onMockChange } from '../dev/mockApi'
import { api } from '../lib/api'
import { useTwin } from '../lib/store'
import type { Delivery, SiteEvent, WsMessage } from '../lib/types'
import { useLive } from '../lib/ws'
import { refreshRoute } from '../twin/actions'
import { TwinLayout } from '../twin/layout'
import { ROOM_LEGEND } from '../twin/palette'
import { useTwinUi } from '../twin/uiStore'
import { BookingPanel } from './site/BookingPanel'
import { DeliveryPanel, focusDelivery } from './site/DeliveryPanel'
import { FeedPanel } from './site/FeedPanel'
import { FloorBar } from './site/FloorBar'
import { RoutePanel } from './site/RoutePanel'
import { Timeline } from './site/Timeline'
import { Glass } from './site/ui'

const TwinScene = lazy(() => import('../twin/TwinScene'))

type Tab = 'feed' | 'rooms' | 'deliveries' | 'route'
const TABS: { id: Tab; label: string; icon: ReactNode }[] = [
  { id: 'feed', label: 'Changes', icon: <Radio size={14} /> },
  { id: 'deliveries', label: 'Deliveries', icon: <PackageOpen size={14} /> },
  { id: 'rooms', label: 'Rooms', icon: <CalendarDays size={14} /> },
  { id: 'route', label: 'Route', icon: <Navigation size={14} /> },
]

const LEFT_W = 340
const CHAT_W = 380

export default function SitePage() {
  const { siteId = '' } = useParams()
  const nav = useNavigate()
  const building = useTwin((s) => (s.siteId === siteId ? s.building : null))
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('feed')
  const [chatOpen, setChatOpen] = useState(true)
  const [toast, setToast] = useState<{ text: string; tone: 'info' | 'ok' | 'warn' } | null>(null)
  const [mock, setMock] = useState(isMockActive())
  useEffect(() => onMockChange(setMock), [])
  const sites = useQuery({ queryKey: ['sites'], queryFn: api.sites, staleTime: 60_000 })
  const site = sites.data?.find((s) => s.id === siteId)

  // ---- load building + state + events ----
  useEffect(() => {
    let cancelled = false
    setError(null)
    useTwinUi.setState({ roomGlow: {}, popover: null, originId: null, flashIds: [] })
    useTwin.getState().setTimelineTs(null)
    api
      .building(siteId)
      .then(async (b) => {
        if (cancelled) return
        useTwin.getState().setSite(siteId, b)
        const [st, ev] = await Promise.all([api.state(siteId).catch(() => null), api.events(siteId).catch(() => [] as SiteEvent[])])
        if (cancelled) return
        if (st) useTwin.getState().setState(st)
        useTwin.getState().setEvents(ev)
      })
      .catch((e) => !cancelled && setError(String(e.message ?? e)))
    return () => {
      cancelled = true
    }
  }, [siteId])

  // ---- live updates ----
  const refetchTimer = useRef<number | undefined>(undefined)
  const refetchState = useCallback(() => {
    window.clearTimeout(refetchTimer.current)
    refetchTimer.current = window.setTimeout(async () => {
      try {
        const st = await api.state(siteId)
        if (useTwin.getState().siteId !== siteId) return
        useTwin.getState().setState(st)
        await refreshRoute(siteId)
      } catch {
        /* server hiccup: keep the old state */
      }
    }, 150)
  }, [siteId])

  useEffect(() => () => window.clearTimeout(refetchTimer.current), [siteId])

  // A route requested anywhere (map popover, Rooms, Route tab) opens the Route tab with its directions.
  useEffect(() => useTwinUi.subscribe((s, prev) => {
    if (s.directionsTick !== prev.directionsTick) setTab('route')
  }), [])

  const showToast = useCallback((text: string, tone: 'info' | 'ok' | 'warn' = 'info') => {
    setToast({ text, tone })
    window.setTimeout(() => setToast((t) => (t?.text === text ? null : t)), 5000)
  }, [])

  const onLive = useCallback(
    (m: WsMessage) => {
      if (m.type === 'event' && m.event.site_id === siteId) {
        useTwin.getState().pushEvent(m.event)
        refetchState()
        if (m.event.type === 'door_added') {
          void api.building(siteId).then((next) => {
            if (useTwin.getState().siteId === siteId) useTwin.setState({ building: next })
          }).catch(() => undefined)
        }
        if (m.event.type === 'delivery' && m.event.payload?.id) {
          const d = m.event.payload as Delivery
          showToast(m.event.title, d.status === 'ok' ? 'ok' : 'warn')
          window.setTimeout(() => { if (useTwin.getState().siteId === siteId) focusDelivery(d) }, 400)
          setTab('deliveries')
        } else showToast(m.event.title)
      } else if (m.type === 'capture_progress' && m.job.site_id === siteId) {
        showToast(`Capture: ${m.job.message || m.job.status} (${Math.round(m.job.progress * 100)}%)`)
      }
    },
    [siteId, refetchState, showToast],
  )
  useLive(onLive)

  const layout = useMemo(() => (building ? new TwinLayout(building) : null), [building])
  const insets = useMemo(
    () => ({ left: LEFT_W + 24, right: chatOpen ? CHAT_W + 24 : 0, top: 72, bottom: 84 }),
    [chatOpen],
  )

  return (
    <div className="relative h-full w-full overflow-hidden bg-[#05070d] text-slate-200">
      {building && layout && (
        <Suspense fallback={null}>
          {/* isolate: keeps drei <Html> labels (z-index) below the HUD panels */}
          <div className="absolute inset-0 isolate">
            <TwinScene key={siteId} building={building} siteId={siteId} layout={layout} insets={insets} />
          </div>
        </Suspense>
      )}

      {/* header */}
      <div className="pointer-events-none absolute left-4 top-4 flex items-start gap-3" style={{ width: LEFT_W }}>
        <Glass className="pointer-events-auto flex w-full items-center gap-3 px-3 py-2.5">
          <button onClick={() => nav('/')} className="grid size-8 shrink-0 place-items-center rounded-lg bg-white/5 text-slate-300 transition hover:bg-white/10 hover:text-white" title="Back to map">
            <ArrowLeft size={16} />
          </button>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[15px] font-semibold text-white">{site?.name ?? building?.building.name ?? siteId}</div>
            <div className="truncate text-[11px] text-slate-400">
              {building ? `${building.floors.length} floors · ${building.spaces.length} spaces · ${building.assets.length} assets` : 'Loading…'}
              {mock && <span className="ml-1.5 rounded bg-amber-400/20 px-1 text-[10px] font-semibold text-amber-200">MOCK</span>}
            </div>
          </div>
        </Glass>
      </div>

      {/* left panel */}
      {building && (
        <div className="pointer-events-none absolute bottom-24 left-4 top-[84px] flex flex-col" style={{ width: LEFT_W }}>
          <Glass className="pointer-events-auto flex max-h-full min-h-0 flex-col">
            <div className="flex gap-1 border-b border-white/5 p-1.5">
              {TABS.map((t) => (
                <button
                  key={t.id}
                  onClick={() => setTab(t.id)}
                  className={clsx(
                    'flex flex-1 items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-medium transition',
                    tab === t.id ? 'bg-sky-500/20 text-sky-50' : 'text-slate-400 hover:bg-white/5 hover:text-slate-200',
                  )}
                >
                  {t.icon}
                  {t.label}
                </button>
              ))}
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-2.5 [scrollbar-width:thin]">
              {tab === 'feed' && <FeedPanel building={building} />}
              {tab === 'deliveries' && <DeliveryPanel siteId={siteId} />}
              {tab === 'rooms' && <BookingPanel siteId={siteId} />}
              {tab === 'route' && <RoutePanel building={building} siteId={siteId} />}
            </div>
          </Glass>
        </div>
      )}

      {/* floor switcher */}
      {building && (
        <div className="pointer-events-none absolute top-4 flex justify-center" style={{ left: LEFT_W + 32, right: chatOpen ? CHAT_W + 32 : 16 }}>
          <div className="pointer-events-auto">
            <FloorBar building={building} />
          </div>
        </div>
      )}

      {/* chat */}
      <AnimatePresence initial={false}>
        {chatOpen ? (
          <motion.div
            key="chat"
            initial={{ x: CHAT_W + 40, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: CHAT_W + 40, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 260, damping: 30 }}
            className="absolute bottom-4 right-4 top-4 flex flex-col"
            style={{ width: CHAT_W }}
          >
            <Glass className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
              <button onClick={() => setChatOpen(false)} className="absolute -left-3 top-1/2 z-10 grid size-6 -translate-y-1/2 place-items-center rounded-full border border-white/10 bg-slate-900 text-slate-400 hover:text-white" title="Hide chat">
                <ChevronRight size={14} />
              </button>
              <div className="min-h-0 flex-1 overflow-hidden">{siteId && <ChatPanel key={siteId} siteId={siteId} />}</div>
            </Glass>
          </motion.div>
        ) : (
          <motion.button
            key="chat-btn"
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.8 }}
            onClick={() => setChatOpen(true)}
            className="absolute right-4 top-4 grid size-11 place-items-center rounded-2xl border border-sky-400/30 bg-sky-500/20 text-sky-100 shadow-[0_0_30px_rgba(56,189,248,0.35)] backdrop-blur-xl hover:bg-sky-500/30"
            title="Open assistant"
          >
            <MessageSquare size={18} />
          </motion.button>
        )}
      </AnimatePresence>

      {/* timeline */}
      {building && (
        <div className="absolute bottom-4" style={{ left: LEFT_W + 32, right: chatOpen ? CHAT_W + 32 : 16 }}>
          <Timeline />
        </div>
      )}

      {/* legend + attribution */}
      {building && (
        <div className="pointer-events-none absolute bottom-4 left-4 flex flex-col gap-1.5" style={{ width: LEFT_W }}>
          <div className="flex flex-wrap gap-x-2.5 gap-y-1 px-1">
            {ROOM_LEGEND.map(([label, color]) => (
              <span key={label} className="flex items-center gap-1 text-[10px] text-slate-400">
                <span className="size-2 rounded-sm" style={{ background: color }} />
                {label}
              </span>
            ))}
          </div>
          <div className="truncate px-1 text-[10px] text-slate-500" title={building.building.attribution}>
            {building.building.attribution}
          </div>
        </div>
      )}

      {/* toast */}
      <AnimatePresence>
        {toast && (
          <motion.div
            initial={{ opacity: 0, y: -12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -12 }}
            className="absolute top-20 z-40 -translate-x-1/2"
            style={{ left: `calc(50% + ${(LEFT_W - (chatOpen ? CHAT_W : 0)) / 2}px)` }}
          >
            <div
              className={clsx(
                'rounded-full border px-4 py-1.5 text-sm font-medium shadow-xl backdrop-blur-xl',
                toast.tone === 'ok' && 'border-emerald-400/40 bg-emerald-500/20 text-emerald-50',
                toast.tone === 'warn' && 'border-amber-400/40 bg-amber-500/20 text-amber-50',
                toast.tone === 'info' && 'border-sky-400/30 bg-slate-900/70 text-slate-100',
              )}
            >
              {toast.text}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {error && (
        <div className="absolute inset-0 grid place-items-center">
          <Glass className="max-w-md p-6 text-center">
            <div className="text-lg font-semibold text-white">Could not load this site</div>
            <div className="mt-1 text-sm text-slate-400">{error}</div>
            <button onClick={() => nav('/')} className="mt-4 rounded-lg bg-sky-500/20 px-3 py-1.5 text-sm text-sky-100 hover:bg-sky-500/30">Back to map</button>
          </Glass>
        </div>
      )}

      {/* entry crossfade from the map */}
      <motion.div
        className="pointer-events-none absolute inset-0 bg-[#05070d]"
        initial={{ opacity: 1 }}
        animate={{ opacity: building || error ? 0 : 1 }}
        transition={{ duration: 1.1, ease: 'easeOut' }}
      >
        {!building && !error && (
          <div className="grid h-full place-items-center">
            <div className="flex flex-col items-center gap-3">
              <div className="size-10 animate-spin rounded-full border-2 border-sky-400/20 border-t-sky-400" />
              <div className="text-xs uppercase tracking-[0.25em] text-slate-500">Building twin</div>
            </div>
          </div>
        )}
      </motion.div>
    </div>
  )
}
