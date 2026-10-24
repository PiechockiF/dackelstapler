import { QrCode, X } from 'lucide-react'
import { AnimatePresence, motion } from 'framer-motion'
import { useState } from 'react'
import CaptureQR from '../../capture/CaptureQR'
import DeliveryCard from '../../capture/DeliveryCard'
import { useTwin } from '../../lib/store'
import type { Delivery } from '../../lib/types'
import { useTwinUi } from '../../twin/uiStore'
import { useSnapshot } from '../../twin/useSnapshot'
import { Empty } from './FeedPanel'
import { Btn, Glass } from './ui'

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
  const list = [...snap.deliveries].sort((a, b) => b.ts.localeCompare(a.ts))
  return (
    <div className="flex flex-col gap-3">
      <Btn tone="accent" onClick={() => setQr(true)}>
        <QrCode size={14} /> Capture with phone
      </Btn>
      {!list.length && <Empty>No deliveries yet.</Empty>}
      {list.map((d) => (
        <div key={d.id} onClick={() => focusDelivery(d)} className="cursor-pointer rounded-xl transition hover:ring-1 hover:ring-sky-400/40">
          <DeliveryCard delivery={d} />
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
