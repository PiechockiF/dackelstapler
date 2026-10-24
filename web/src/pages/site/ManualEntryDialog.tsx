// Type data in by hand instead of capturing it with the phone: manage a room's equipment (add, edit,
// delete), or log / edit / delete a delivery.
import { useQuery } from '@tanstack/react-query'
import clsx from 'clsx'
import { AnimatePresence, motion } from 'framer-motion'
import { PackagePlus, Pencil, Save, SquarePlus, Wrench, X } from 'lucide-react'
import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import RoomPicker from '../../capture/RoomPicker'
import { api } from '../../lib/api'
import { useTwin } from '../../lib/store'
import type { Asset, Building, Delivery, Dims, EquipmentType } from '../../lib/types'
import { useTwinUi, type ManualEntry } from '../../twin/uiStore'
import { focusDelivery } from './DeliveryPanel'
import { Empty } from './FeedPanel'
import { Btn, DeleteButton, Field, Glass, inputCls } from './ui'

const EURO_PALLET = { w: '1.20', d: '0.80', h: '1.00' }
const MODES: { id: ManualEntry['mode']; label: string; icon: ReactNode }[] = [
  { id: 'equipment', label: 'Equipment', icon: <Wrench size={14} /> },
  { id: 'delivery', label: 'Delivery', icon: <PackagePlus size={14} /> },
]

export function ManualEntryDialog({ siteId, building }: { siteId: string; building: Building }) {
  const entry = useTwinUi((s) => s.manualEntry)
  const open = useTwinUi((s) => s.openManualEntry)
  const deliveries = useTwin((s) => s.state?.deliveries)
  const close = () => open(null)

  useEffect(() => {
    if (!entry) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && open(null)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [entry, open])

  const editing = entry?.mode === 'delivery' && entry.deliveryId ? deliveries?.find((d) => d.id === entry.deliveryId) : undefined
  return (
    <AnimatePresence>
      {entry && (
        <motion.div
          className="fixed inset-0 z-50 grid place-items-center bg-black/50 backdrop-blur-sm"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={close}
        >
          <motion.div initial={{ scale: 0.92, y: 10 }} animate={{ scale: 1, y: 0 }} exit={{ scale: 0.95 }} onClick={(e) => e.stopPropagation()}>
            <Glass className="relative flex max-h-[85vh] w-96 flex-col gap-3 overflow-y-auto p-5 [scrollbar-width:thin]">
              <button className="absolute right-3 top-3 rounded p-1 text-slate-400 hover:bg-white/10 hover:text-white" onClick={close}>
                <X size={16} />
              </button>
              <div className="text-sm font-semibold text-slate-100">{editing ? 'Edit delivery' : 'By hand'}</div>
              {!editing && (
                <div className="flex gap-1 rounded-xl bg-white/5 p-1">
                  {MODES.map((m) => (
                    <button
                      key={m.id}
                      onClick={() => open({ mode: m.id, spaceId: entry.spaceId })}
                      className={clsx(
                        'flex flex-1 items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-medium transition',
                        entry.mode === m.id ? 'bg-sky-500/20 text-sky-50' : 'text-slate-400 hover:bg-white/5 hover:text-slate-200',
                      )}
                    >
                      {m.icon}
                      {m.label}
                    </button>
                  ))}
                </div>
              )}
              {entry.mode === 'equipment' ? (
                <EquipmentPanel key={`${entry.spaceId}:${entry.assetId}`} siteId={siteId} building={building} entry={entry} onClose={close} />
              ) : (
                <DeliveryForm key={`${entry.spaceId}:${editing?.id}`} siteId={siteId} building={building} initialSpace={entry.spaceId} delivery={editing} onDone={close} />
              )}
            </Glass>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

// ---------------------------------------------------------------- equipment

/** A room's equipment list with edit/delete, or the add/edit form. */
function EquipmentPanel({ siteId, building, entry, onClose }: { siteId: string; building: Building; entry: ManualEntry; onClose: () => void }) {
  const overrides = useTwin((s) => s.state?.asset_overrides)
  const types = useEquipmentTypes()
  const [space, setSpace] = useState<string | null>(entry.spaceId)
  const [editing, setEditing] = useState<string | null>(entry.assetId ?? null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  // Opened straight into the form (e.g. "Add equipment"): saving closes the dialog instead of returning to the list.
  const direct = entry.assetId !== undefined
  const roomOf = (a: Asset) => overrides?.[a.id]?.space_id ?? a.space_id

  const asset = editing && editing !== 'new' ? building.assets.find((a) => a.id === editing) : undefined
  if (editing === 'new' || asset) {
    return (
      <EquipmentForm
        siteId={siteId}
        building={building}
        asset={asset}
        initialSpace={asset ? roomOf(asset) : space}
        onDone={(spaceId) => {
          if (direct) return onClose()
          setSpace(spaceId)
          setEditing(null)
        }}
        onCancel={direct ? undefined : () => setEditing(null)}
      />
    )
  }

  const inRoom = space ? building.assets.filter((a) => roomOf(a) === space).sort((a, b) => a.name.localeCompare(b.name)) : []
  const show = (a: Asset) => {
    const twin = useTwin.getState()
    twin.setFocusFloor(overrides?.[a.id]?.floor_id ?? a.floor_id)
    twin.setHighlight({ ids: [a.id], label: a.name })
  }
  const remove = async (a: Asset) => {
    setBusy(true)
    setErr(null)
    try {
      await api.deleteAsset(siteId, a.id)
      await refreshTwin(siteId, true)
    } catch (x) {
      setErr(String((x as Error).message ?? x))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <Field label="Room" as="div">
        <RoomPicker building={building} value={space} onChange={setSpace} />
      </Field>
      {space && (
        <div className="flex flex-col gap-1">
          <div className="flex items-baseline justify-between text-[11px] font-medium uppercase tracking-wide text-slate-400">
            Equipment
            <span className="tabular-nums text-slate-500">{inRoom.length}</span>
          </div>
          {!inRoom.length && <Empty>No equipment in this room yet.</Empty>}
          {inRoom.length > 0 && (
            <ul className="-mx-2 flex max-h-72 flex-col overflow-y-auto [scrollbar-width:thin]">
              {inRoom.map((a) => (
                <li key={a.id} className="flex items-center gap-1 rounded-xl px-2 py-1 transition hover:bg-white/5">
                  <button className="min-w-0 flex-1 py-0.5 text-left" title="Show in 3D" onClick={() => show(a)}>
                    <span className="block truncate text-[13px] text-slate-100">{a.name}</span>
                    <span className="block truncate text-[11px] text-slate-500">
                      {typeLabel(a.type, types)}
                      {a.footprint && ` · ${a.footprint.width_m.toFixed(2)} × ${a.footprint.depth_m.toFixed(2)} m`}
                    </span>
                  </button>
                  <Btn tone="ghost" title="Edit" disabled={busy} onClick={() => setEditing(a.id)}>
                    <Pencil size={13} />
                  </Btn>
                  <DeleteButton disabled={busy} onConfirm={() => void remove(a)} />
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {err && <div className="text-xs text-rose-300">{err}</div>}
      <Btn tone="accent" onClick={() => setEditing('new')}>
        <SquarePlus size={14} /> Add equipment
      </Btn>
    </div>
  )
}

function EquipmentForm({ siteId, building, asset, initialSpace, onDone, onCancel }: {
  siteId: string
  building: Building
  asset?: Asset
  initialSpace: string | null
  onDone: (spaceId: string) => void
  onCancel?: () => void
}) {
  const types = useEquipmentTypes()
  const [space, setSpace] = useState<string | null>(initialSpace)
  const [kind, setKind] = useState(asset ? typeLabel(asset.type, types) : '')
  const [name, setName] = useState(asset?.name ?? '')
  const [width, setWidth] = useState(asset?.footprint?.width_m.toFixed(2) ?? '')
  const [depth, setDepth] = useState(asset?.footprint?.depth_m.toFixed(2) ?? '')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const typed = kind.trim().toLowerCase()
  const known = types?.find((t) => t.label.toLowerCase() === typed || t.type === slug(typed))
  const type = known?.type ?? slug(typed)
  const room = building.spaces.find((s) => s.id === space)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!space || !typed) return
    setBusy(true)
    setErr(null)
    try {
      let saved: Asset
      if (asset) {
        const changes: Parameters<typeof api.updateAsset>[2] = {}
        if (name.trim() && name.trim() !== asset.name) changes.name = name.trim()
        if (type !== asset.type) changes.type = type
        if (num(width) && num(width) !== asset.footprint?.width_m) changes.width_m = num(width)
        if (num(depth) && num(depth) !== asset.footprint?.depth_m) changes.depth_m = num(depth)
        if (space !== initialSpace) changes.space_id = space
        saved = Object.keys(changes).length ? await api.updateAsset(siteId, asset.id, changes) : asset
      } else {
        saved = await api.addAsset(siteId, { type, space_id: space, name: name.trim() || undefined, width_m: num(width), depth_m: num(depth) })
      }
      await refreshTwin(siteId, true)
      const twin = useTwin.getState()
      if (twin.siteId === siteId) {
        twin.setFocusFloor(building.spaces.find((s) => s.id === space)?.floor_id ?? saved.floor_id)
        twin.setHighlight({ ids: [saved.id], label: saved.name })
      }
      onDone(space)
    } catch (x) {
      setErr(String((x as Error).message ?? x))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      {asset && <div className="truncate text-[13px] text-slate-300">Editing <span className="font-medium text-slate-100">{asset.name}</span></div>}
      <Field label="Room" as="div">
        <RoomPicker building={building} value={space} onChange={setSpace} />
      </Field>
      <Field label="What is it">
        <input list="equipment-types" value={kind} onChange={(e) => setKind(e.target.value)} placeholder="e.g. Coffee machine, CNC mill" className={inputCls} />
        <datalist id="equipment-types">
          {types?.map((t) => <option key={t.type} value={t.label} />)}
        </datalist>
      </Field>
      <Field label={asset ? 'Name' : 'Name (optional)'}>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={typed ? `${known?.label ?? kind.trim()} ${room?.ref ?? room?.name ?? ''}`.trim() : 'Generated from type and room'}
          className={inputCls}
        />
      </Field>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Width">
          <MetreInput value={width} onChange={setWidth} placeholder={known ? known.width_m.toFixed(2) : '1.00'} />
        </Field>
        <Field label="Depth">
          <MetreInput value={depth} onChange={setDepth} placeholder={known ? known.depth_m.toFixed(2) : '1.00'} />
        </Field>
      </div>
      {!asset && (
        <div className="text-[11px] text-slate-500">
          {known ? `Typical ${known.label.toLowerCase()} size is used if left empty.` : 'Leave the size empty to use a typical size.'} It is placed on a free spot in the room.
        </div>
      )}
      {asset && space !== initialSpace && <div className="text-[11px] text-slate-500">It moves to a free spot in the new room.</div>}
      {err && <div className="text-xs text-rose-300">{err}</div>}
      <div className="flex gap-2">
        {onCancel && (
          <Btn type="button" tone="ghost" onClick={onCancel}>
            Cancel
          </Btn>
        )}
        <Btn type="submit" tone="accent" className="flex-1" disabled={busy || !space || !typed}>
          {asset ? <Save size={14} /> : <SquarePlus size={14} />}
          {busy ? 'Saving…' : asset ? 'Save changes' : 'Add to room'}
        </Btn>
      </div>
    </form>
  )
}

// ---------------------------------------------------------------- delivery

function DeliveryForm({ siteId, building, initialSpace, delivery, onDone }: {
  siteId: string
  building: Building
  initialSpace: string | null
  delivery?: Delivery
  onDone: () => void
}) {
  const initialDims = delivery ? { w: delivery.dims_m.w.toFixed(2), d: delivery.dims_m.d.toFixed(2), h: delivery.dims_m.h.toFixed(2) } : EURO_PALLET
  const [label, setLabel] = useState(delivery?.label ?? '')
  const [space, setSpace] = useState<string | null>(delivery?.space_id ?? initialSpace)
  const [target, setTarget] = useState<string | null>(delivery?.target_space_id ?? null)
  const [dims, setDims] = useState(initialDims)
  const [note, setNote] = useState(delivery?.note ?? '')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const size: Dims | undefined = num(dims.w) && num(dims.d) && num(dims.h) ? { w: num(dims.w)!, d: num(dims.d)!, h: num(dims.h)! } : undefined
  // Only send a size the person actually changed: re-sending a rounded measured size would discard its tolerance.
  const dimsChanged = (['w', 'd', 'h'] as const).some((k) => dims[k] !== initialDims[k])

  const run = async (fn: () => Promise<void>) => {
    setBusy(true)
    setErr(null)
    try {
      await fn()
      onDone()
    } catch (x) {
      setErr(String((x as Error).message ?? x))
    } finally {
      setBusy(false)
    }
  }

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!space || !label.trim() || !size) return
    void run(async () => {
      let saved: Delivery
      if (delivery) {
        const changes: Parameters<typeof api.updateDelivery>[2] = {}
        if (label.trim() !== delivery.label) changes.label = label.trim()
        if (space !== delivery.space_id) changes.space_id = space
        if (dimsChanged) changes.dims_m = size
        if (target !== (delivery.target_space_id ?? null)) changes.target_space_id = target
        if (note.trim() !== (delivery.note ?? '')) changes.note = note.trim()
        saved = Object.keys(changes).length ? await api.updateDelivery(siteId, delivery.id, changes) : delivery
      } else {
        saved = await api.logDelivery(siteId, { label: label.trim(), space_id: space, dims_m: size, target_space_id: target ?? undefined, note: note.trim() || undefined })
      }
      await refreshTwin(siteId)
      if (useTwin.getState().siteId === siteId) focusDelivery(saved)
    })
  }

  const remove = () =>
    void run(async () => {
      await api.deleteDelivery(siteId, delivery!.id)
      await refreshTwin(siteId)
      useTwin.getState().setHighlight(null)
    })

  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <Field label="What arrived">
        <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Steel sheet pallet" className={inputCls} />
      </Field>
      <Field label="Where is it now" as="div">
        <RoomPicker building={building} value={space} onChange={setSpace} placeholder="Search room, e.g. Goods-in" />
      </Field>
      <Field label={delivery ? 'Size' : 'Size (Euro pallet by default)'} as="div">
        <div className="grid grid-cols-3 gap-2">
          {(['w', 'd', 'h'] as const).map((k) => (
            <MetreInput key={k} prefix={k.toUpperCase()} value={dims[k]} onChange={(v) => setDims({ ...dims, [k]: v })} placeholder="0.00" />
          ))}
        </div>
      </Field>
      <Field label="Needs to go to (optional)" as="div">
        <RoomPicker building={building} value={target} onChange={setTarget} optional placeholder="Checks doors on the way" />
      </Field>
      <Field label="Note (optional)">
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Supplier, PO number…" className={inputCls} />
      </Field>
      {err && <div className="text-xs text-rose-300">{err}</div>}
      <div className="flex gap-2">
        {delivery && <DeleteButton label="Delete" disabled={busy} onConfirm={remove} />}
        <Btn type="submit" tone="accent" className="flex-1" disabled={busy || !space || !label.trim() || !size}>
          {delivery ? <Save size={14} /> : <PackagePlus size={14} />}
          {busy ? 'Saving…' : delivery ? 'Save changes' : 'Save delivery'}
        </Btn>
      </div>
    </form>
  )
}

// ---------------------------------------------------------------- helpers

function MetreInput({ value, onChange, placeholder, prefix }: { value: string; onChange: (v: string) => void; placeholder: string; prefix?: string }) {
  return (
    <span className="relative">
      {prefix && <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-xs font-semibold text-slate-500">{prefix}</span>}
      <input
        inputMode="decimal"
        value={value}
        onChange={(e) => onChange(e.target.value.replace(',', '.'))}
        placeholder={placeholder}
        className={clsx(inputCls, 'pr-6 text-right tabular-nums', prefix && 'pl-6')}
      />
      <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-slate-500">m</span>
    </span>
  )
}

function useEquipmentTypes(): EquipmentType[] | undefined {
  return useQuery({ queryKey: ['equipmentTypes'], queryFn: api.equipmentTypes, staleTime: Infinity }).data
}

function typeLabel(type: string, types?: EquipmentType[]): string {
  const known = types?.find((t) => t.type === type)?.label
  if (known) return known
  const text = type.replace(/_/g, ' ')
  return text.charAt(0).toUpperCase() + text.slice(1)
}

const slug = (text: string) => text.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')

function num(text: string): number | undefined {
  const value = Number.parseFloat(text)
  return Number.isFinite(value) && value > 0 ? value : undefined
}

/** Re-read state (and the building, when assets changed) after an edit, without waiting for the WebSocket. */
async function refreshTwin(siteId: string, withBuilding = false) {
  const [building, state] = await Promise.all([withBuilding ? api.building(siteId) : null, api.state(siteId)])
  if (useTwin.getState().siteId !== siteId) return
  if (building) useTwin.setState({ building })
  useTwin.getState().setState(state)
}
