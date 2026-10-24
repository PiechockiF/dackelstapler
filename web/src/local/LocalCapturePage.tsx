import { useQuery } from '@tanstack/react-query'
import { ArrowLeft, Camera, Check, LoaderCircle } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import DeliveryCard from '../capture/DeliveryCard'
import { api } from '../lib/api'
import type { Delivery } from '../lib/types'
import { saveManualDelivery } from './provider'

const field = 'mt-1 w-full rounded-xl border border-white/10 bg-slate-900 px-3 py-3 text-base text-slate-100 outline-none focus:border-sky-400'
export default function LocalCapturePage() {
  const [params] = useSearchParams(), siteId = params.get('site') ?? ''
  const building = useQuery({ queryKey: ['captureBuilding', siteId], queryFn: () => api.building(siteId), enabled: !!siteId })
  const [photo, setPhoto] = useState<File>(), [preview, setPreview] = useState('')
  const [spaceId, setSpaceId] = useState(''), [label, setLabel] = useState(''), [note, setNote] = useState('')
  const [dimensions, setDimensions] = useState({ w: '', d: '', h: '' })
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [saved, setSaved] = useState<Delivery>()
  useEffect(() => {
    if (!photo) { setPreview(''); return }
    const url = URL.createObjectURL(photo); setPreview(url)
    return () => URL.revokeObjectURL(url)
  }, [photo])
  const save = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!photo || !spaceId || busy) return
    setBusy(true); setError('')
    try { setSaved(await saveManualDelivery(siteId, { photo, spaceId, label, note, dimensions: { w: Number(dimensions.w), d: Number(dimensions.d), h: Number(dimensions.h) } })) }
    catch (e) { setError((e as Error).message) }
    finally { setBusy(false) }
  }
  return <main className="local-home h-full overflow-y-auto px-5 text-slate-200"><div className="mx-auto max-w-lg pb-10 pt-6">
    <Link to={siteId ? `/site/${siteId}` : '/'} className="inline-flex items-center gap-2 text-sm text-sky-300"><ArrowLeft size={16} /> Back to building</Link>
    <h1 className="mt-5 text-2xl font-semibold text-white">Save a delivery</h1>
    <p className="mt-2 text-sm leading-relaxed text-slate-400">Photo and entered dimensions are stored on this phone. The route check compares doorway widths; it does not measure the photo or assess turns, height or floor fit.</p>
    {building.error && <p role="alert" className="mt-4 text-rose-300">{building.error.message}</p>}
    {!siteId && <p className="mt-4">Choose a building from the home screen first.</p>}
    {saved ? <div className="mt-5 space-y-4"><p className="flex items-center gap-2 text-emerald-300"><Check size={17} /> Saved on this device</p><DeliveryCard delivery={saved} /><Link className="block rounded-xl bg-sky-400 px-4 py-3 text-center font-medium text-slate-950" to={`/site/${siteId}`}>View in building</Link></div> : building.data && <form onSubmit={save} className="mt-6 flex flex-col gap-4">
      <label className="block rounded-xl border border-dashed border-sky-400/40 bg-sky-400/5 p-4 text-sm text-sky-200"><span className="flex items-center gap-2"><Camera size={17} /> Take or choose a photo</span><input required type="file" accept="image/*" onChange={(e) => setPhoto(e.target.files?.[0])} className="mt-3 block w-full text-xs text-slate-400" /></label>
      {preview && <img src={preview} alt="Delivery photo preview" className="max-h-52 w-full rounded-xl object-contain" />}
      <label className="text-xs text-slate-400">Label<input maxLength={120} className={field} value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Steel drum pallet" /></label>
      <fieldset><legend className="mb-1 text-xs text-slate-400">Entered dimensions (metres)</legend><div className="grid grid-cols-3 gap-2">{(['w', 'd', 'h'] as const).map((axis) => <label key={axis} className="text-xs text-slate-400">{{ w: 'Width', d: 'Depth', h: 'Height' }[axis]}<input aria-label={{ w: 'Width in metres', d: 'Depth in metres', h: 'Height in metres' }[axis]} required type="number" inputMode="decimal" min="0.01" max="39.99" step="any" className={field} value={dimensions[axis]} onChange={(e) => setDimensions({ ...dimensions, [axis]: e.target.value })} /></label>)}</div></fieldset>
      <label className="text-xs text-slate-400">Destination room<select required className={field} value={spaceId} onChange={(e) => setSpaceId(e.target.value)}><option value="">Choose a room…</option>{building.data.spaces.filter((s) => s.type !== 'outdoor').map((s) => <option value={s.id} key={s.id}>{s.name} · {building.data.floors.find((f) => f.id === s.floor_id)?.name}</option>)}</select></label>
      <label className="text-xs text-slate-400">Note<textarea className={field} value={note} maxLength={2000} onChange={(e) => setNote(e.target.value)} /></label>
      {error && <p role="alert" className="text-sm text-rose-300">{error}</p>}
      <button disabled={busy} className="flex items-center justify-center gap-2 rounded-xl bg-sky-400 px-4 py-3 font-semibold text-slate-950 disabled:opacity-50">{busy && <LoaderCircle className="animate-spin" size={17} />}{busy ? 'Saving photo and checking route…' : 'Save delivery on this phone'}</button>
      <p className="text-xs text-slate-500">Automatic measurement, generated 3D models and room reconstruction need the online backend and are unavailable in this mode.</p>
    </form>}
  </div></main>
}
