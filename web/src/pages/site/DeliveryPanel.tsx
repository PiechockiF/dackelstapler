import { Camera, PackagePlus, Pencil, QrCode, X } from 'lucide-react'
import { AnimatePresence, motion } from 'framer-motion'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { isLocalMode } from '../../lib/mode'
import CaptureQR from '../../capture/CaptureQR'
import DeliveryCard from '../../capture/DeliveryCard'
import { api } from '../../lib/api'
import { useTwin } from '../../lib/store'
import type { Delivery } from '../../lib/types'
import { useTwinUi } from '../../twin/uiStore'
import { useSnapshot } from '../../twin/useSnapshot'
import { Empty } from './FeedPanel'
import { Btn, DeleteButton, Glass } from './ui'

export function focusDelivery(d: Delivery) {
  const s = useTwin.getState()
  s.setFocusFloor(d.floor_id)
  s.setHighlight({ ids: [d.id], label: d.label })
  useTwinUi.getState().flash(d.status === 'blocked' ? (d.check?.route_fit?.blocking_openings ?? []).map((b) => b.id) : [])
  const alt = d.check?.route_fit?.alternative ?? d.check?.route_fit?.route
  if (alt?.reachable) setTimeout(() => useTwin.getState().setRoute(alt), d.status === 'blocked' ? 1800 : 0)
}

export function DeliveryPanel({ siteId }: { siteId: string }) {
  const snap = useSnapshot()
  const [qr, setQr] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const remove = async (d: Delivery) => {
    setErr(null)
    try {
      await api.deleteDelivery(siteId, d.id)
      const state = await api.state(siteId)
      if (useTwin.getState().siteId === siteId) useTwin.getState().setState(state)
    } catch (x) {
      setErr(String((x as Error).message ?? x))
    }
  }
  const list = [...snap.deliveries].sort((a, b) => b.ts.localeCompare(a.ts))
  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-2">
        {isLocalMode ? (
          <Link
            to={`/capture?site=${encodeURIComponent(siteId)}`}
            className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-sky-400/30 bg-sky-500/20 px-2.5 py-1.5 text-xs font-medium text-sky-100 transition hover:bg-sky-500/30"
          >
            <Camera size={14} /> With photo
          </Link>
        ) : (
          <Btn tone="accent" onClick={() => setQr(true)}>
            <QrCode size={14} /> Phone capture
          </Btn>
        )}
        <Btn onClick={() => useTwinUi.getState().openManualEntry({ mode: 'delivery', spaceId: null })}>
          <PackagePlus size={14} /> Log by hand
        </Btn>
      </div>
      {!list.length && <Empty>No deliveries yet.</Empty>}
      {err && <div className="text-xs text-rose-300">{err}</div>}
      {list.map((d) => (
        <div key={d.id} className="flex flex-col gap-1">
          <div onClick={() => focusDelivery(d)} className="cursor-pointer rounded-xl transition hover:ring-1 hover:ring-sky-400/40">
            <DeliveryCard delivery={d} />
          </div>
          <div className="flex justify-end gap-1">
            <Btn tone="ghost" onClick={() => useTwinUi.getState().openManualEntry({ mode: 'delivery', spaceId: d.space_id, deliveryId: d.id })}>
              <Pencil size={13} /> Edit
            </Btn>
            <DeleteButton label="Delete" onConfirm={() => void remove(d)} />
          </div>
        </div>
      ))}
      <AnimatePresence>
        {qr && (
          <motion.div
            className="fixed inset-0 z-50 grid place-items-center bg-black/50 backdrop-blur-sm"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setQr(false)}
          >
            <motion.div initial={{ scale: 0.92, y: 10 }} animate={{ scale: 1, y: 0 }} exit={{ scale: 0.95 }} onClick={(e) => e.stopPropagation()}>
              <Glass className="relative min-w-72 p-5">
                <button className="absolute right-3 top-3 rounded p-1 text-slate-400 hover:bg-white/10 hover:text-white" onClick={() => setQr(false)}>
                  <X size={16} />
                </button>
                <div className="mb-3 text-sm font-semibold text-slate-100">Capture a delivery</div>
                <CaptureQR siteId={siteId} />
              </Glass>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
