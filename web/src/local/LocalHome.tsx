import { useQuery } from '@tanstack/react-query'
import { ArrowUpRight, Building2, Download, Search, ShieldCheck, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../lib/api'
import { exportBackup, resetMedia } from './media'
import { database, resetRecords } from './storage'
import { disposeRouter } from './routingClient'

export default function LocalHome() {
  const sites = useQuery({ queryKey: ['sites'], queryFn: async () => { await database(); return api.sites() }, staleTime: Infinity })
  const [query, setQuery] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false)
  const list = (sites.data ?? []).filter((s) => `${s.name} ${s.kind} ${s.id}`.toLowerCase().includes(query.toLowerCase()))
  const action = async (fn: () => Promise<string>) => {
    setBusy(true); setNotice('')
    try { setNotice(await fn()) } catch (error) { setNotice(`Could not finish: ${(error as Error).message}`) }
    finally { setBusy(false) }
  }
  return <main className="local-home h-full overflow-y-auto bg-[#070b14] px-5 text-slate-200">
    <div className="mx-auto max-w-5xl pb-10 pt-7">
      <header className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3"><img src="/dackel.png" alt="" className="size-10 rounded-xl bg-white object-cover" /><div><h1 className="text-xl font-semibold tracking-tight text-white">Dackel</h1><p className="text-xs text-slate-400">forklift certified</p></div></div>
        <span className="flex items-center gap-1.5 rounded-full border border-emerald-400/20 bg-emerald-400/10 px-2.5 py-1 text-[11px] text-emerald-200"><ShieldCheck size={13} /> Local</span>
      </header>
      <section className="mt-7 rounded-2xl border border-sky-300/15 bg-gradient-to-br from-sky-950/60 to-violet-950/30 p-5">
        <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-sky-300">Ready without a connection</p>
        <h2 className="mt-2 text-2xl font-semibold tracking-tight text-white">Step inside your site.</h2>
        <p className="mt-2 max-w-lg text-sm leading-relaxed text-slate-400">Explore floors, plan routes, book rooms and save deliveries. Everything stays on this device.</p>
        {sites.data?.some((s) => s.id === 'proc-factory-dev-003') && <Link to="/site/proc-factory-dev-003" className="mt-4 inline-flex items-center gap-2 rounded-xl bg-sky-400 px-4 py-2.5 text-sm font-semibold text-slate-950">Open demo factory <ArrowUpRight size={16} /></Link>}
      </section>
      <label className="mt-6 flex items-center gap-2 rounded-xl border border-white/10 bg-slate-900/70 px-3 py-3"><Search size={17} className="text-slate-500" /><input aria-label="Search sites" className="min-w-0 flex-1 bg-transparent text-base outline-none" placeholder="Search sites or building type…" value={query} onChange={(e) => setQuery(e.target.value)} /></label>
      <div className="mb-3 mt-5 flex justify-between text-[11px] uppercase tracking-wider text-slate-500"><span>Bundled sites</span><span>{list.length} buildings</span></div>
      {sites.isPending && <p className="py-6 text-sm text-slate-400">Opening local storage and bundled buildings…</p>}
      {sites.error && <div role="alert" className="rounded-xl border border-rose-400/25 p-4 text-sm text-rose-200">{sites.error.message}<button className="ml-3 underline" onClick={() => void sites.refetch()}>Retry</button></div>}
      <ul className="grid gap-2 sm:grid-cols-2">
        {list.map((site) => <li key={site.id}><Link to={`/site/${site.id}`} className="flex h-full items-center gap-3 rounded-xl border border-white/[0.07] bg-slate-900/40 p-4 transition hover:border-sky-400/30 hover:bg-slate-900"><span className="grid size-10 shrink-0 place-items-center rounded-lg bg-slate-800 text-sky-300"><Building2 size={19} /></span><span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium text-slate-100">{site.name}</span><span className="mt-1 block text-xs capitalize text-slate-500">{site.kind} · {site.floors} floors{site.demo_location ? ' · demo location' : ''}</span></span><ArrowUpRight size={16} className="shrink-0 text-slate-500" /></Link></li>)}
      </ul>
      {!sites.isPending && !sites.error && !list.length && <p className="py-6 text-sm text-slate-400">No matching buildings.</p>}
      <footer className="mt-7 border-t border-white/10 pt-5 text-xs text-slate-500">
        <p>Bookings and edits are local to this phone. Cloud AI, automatic measurements, reconstruction and shared availability are not included.</p>
        <div className="mt-4 flex flex-wrap gap-3"><button disabled={busy} className="flex items-center gap-1.5 rounded-lg border border-white/10 px-3 py-2 text-slate-300 disabled:opacity-40" onClick={() => void action(exportBackup)}><Download size={13} /> Export backup</button><button disabled={busy} className="flex items-center gap-1.5 rounded-lg border border-white/10 px-3 py-2 disabled:opacity-40" onClick={() => {
          if (window.confirm('Delete this device’s saved bookings, photos, deliveries and edits? Export a backup first. Bundled buildings stay available.')) void action(async () => { await resetRecords(); await resetMedia(); disposeRouter(); return 'Saved local data cleared. Bundled buildings are unchanged.' })
        }}><Trash2 size={13} /> Reset local data</button></div>
        {notice && <p role="status" className="mt-3 text-sky-200">{notice}</p>}
      </footer>
    </div>
  </main>
}
