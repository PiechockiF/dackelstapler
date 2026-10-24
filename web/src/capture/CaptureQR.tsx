// Owner: agent C. QR code that opens /capture?site=<id> on a phone. Rendered by SitePage (agent B).
import { Copy, ExternalLink, Printer, Smartphone, Wifi } from 'lucide-react'
import { QRCodeSVG } from 'qrcode.react'
import { useEffect, useMemo, useState } from 'react'
import { MARKER_PDF_URL } from './captureApi'

const STORAGE_KEY = 'sitetwin.captureHost'
const isLocal = (host: string) => /^(localhost|127\.|\[?::1\]?)/.test(host)

function initialHost(): string {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved) return saved
  } catch {
    /* private mode */
  }
  return (import.meta.env.VITE_PUBLIC_HOST as string | undefined) || location.host
}

export default function CaptureQR({ siteId }: { siteId: string }) {
  const [host, setHost] = useState(initialHost)
  const [lanIp, setLanIp] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  // A phone can't open "localhost": ask the server for the laptop's LAN IP and suggest it.
  useEffect(() => {
    let cancelled = false
    fetch('/api/capture/host')
      .then((r) => (r.ok ? r.json() : null))
      .then((info: { lan_ip: string | null } | null) => {
        if (cancelled || !info?.lan_ip) return
        const suggestion = `${info.lan_ip}${location.port ? `:${location.port}` : ''}`
        setLanIp(suggestion)
        setHost((current) => (isLocal(current) ? suggestion : current))
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    try {
      if (!isLocal(host)) localStorage.setItem(STORAGE_KEY, host)
    } catch {
      /* ignore */
    }
  }, [host])

  const url = useMemo(() => {
    const clean = host.trim().replace(/^https?:\/\//, '').replace(/\/+$/, '')
    return `${location.protocol}//${clean}/capture?site=${encodeURIComponent(siteId)}`
  }, [host, siteId])
  const local = isLocal(host.trim())

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard blocked on http */
    }
  }

  return (
    <div className="flex w-72 flex-col items-center gap-3">
      <div className="relative rounded-2xl bg-white p-3 shadow-[0_0_40px_-8px] shadow-sky-400/40">
        <QRCodeSVG value={url} size={200} level="M" marginSize={0} fgColor="#070b14" />
        <div className="absolute -bottom-2 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full bg-sky-500 px-2 py-0.5 text-[10px] font-semibold text-white shadow">
          <Smartphone size={11} /> scan with your phone
        </div>
      </div>

      <div className="mt-1 flex items-center gap-1.5 text-xs text-slate-300">
        <Wifi size={13} className="text-sky-300" />
        Phone and laptop on the same Wi-Fi
      </div>

      <label className="w-full text-[10px] font-medium uppercase tracking-wide text-slate-400">
        Laptop address (host:port)
        <input
          value={host}
          onChange={(e) => setHost(e.target.value)}
          spellCheck={false}
          className="mt-1 w-full rounded-lg border border-white/10 bg-slate-900/70 px-2.5 py-1.5 font-mono text-xs normal-case tracking-normal text-slate-100 outline-none focus:border-sky-400/60 focus:ring-2 focus:ring-sky-400/20"
        />
      </label>
      {local && (
        <p className="-mt-1 w-full text-[11px] leading-snug text-warn">
          Phones can't open localhost — enter this laptop's Wi-Fi IP{lanIp ? (
            <>
              , e.g.{' '}
              <button className="underline decoration-dotted" onClick={() => setHost(lanIp)}>
                {lanIp}
              </button>
            </>
          ) : null}
          .
        </p>
      )}

      <div className="flex w-full items-center gap-1.5">
        <button
          onClick={copy}
          className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-2 py-1.5 text-xs text-slate-200 hover:bg-white/10"
        >
          <Copy size={12} /> {copied ? 'Copied' : 'Copy link'}
        </button>
        <a
          href={`/capture?site=${encodeURIComponent(siteId)}`}
          target="_blank"
          rel="noreferrer"
          className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-2 py-1.5 text-xs text-slate-200 hover:bg-white/10"
        >
          <ExternalLink size={12} /> Open here
        </a>
        <a
          href={MARKER_PDF_URL}
          target="_blank"
          rel="noreferrer"
          className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-sky-400/30 bg-sky-500/15 px-2 py-1.5 text-xs text-sky-100 hover:bg-sky-500/25"
          title="A4, print at 100 %"
        >
          <Printer size={12} /> Marker
        </a>
      </div>
    </div>
  )
}
