import { useQuery } from '@tanstack/react-query'
import clsx from 'clsx'
import { CalendarCheck, Navigation, Search, Users } from 'lucide-react'
import { useEffect, useState } from 'react'
import { api } from '../../lib/api'
import { originOf } from '../../twin/actions'
import { useTwin } from '../../lib/store'
import type { BookableRoom } from '../../lib/types'
import { navigate } from '../../twin/actions'
import { type RoomGlow, useTwinUi } from '../../twin/uiStore'
import { Empty } from './FeedPanel'
import { Btn, Field, inputCls } from './ui'

type Room = BookableRoom & { distance_m?: number | null }

function nextHourLocal() {
  const d = new Date()
  d.setMinutes(0, 0, 0)
  d.setHours(d.getHours() + 1)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:00`
}

export function BookingPanel({ siteId }: { siteId: string }) {
  const [start, setStart] = useState(nextHourLocal)
  const [minutes, setMinutes] = useState(60)
  const [people, setPeople] = useState(6)
  const [search, setSearch] = useState<{ s: string; e: string; people: number; near: string | null } | null>(null)
  const bookingRevision = useTwin((s) => s.events.find((e) => e.type === 'booking')?.id)
  const result = useQuery({
    queryKey: ['bookableRooms', siteId, search, bookingRevision],
    enabled: search !== null,
    queryFn: async (): Promise<Room[]> => {
      const { s, e, people, near } = search!
      return api.bookableRooms(siteId, s, e, people, near)
    },
  })
  const currentSearch = search && search.people === people && Date.parse(start) === Date.parse(search.s) && Date.parse(search.e) - Date.parse(search.s) === minutes * 60_000
  const rooms = currentSearch ? result.data : undefined
  const [booked, setBooked] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const setRoomGlow = useTwinUi((s) => s.setRoomGlow)

  const range = () => {
    const s = new Date(start)
    return { s: s.toISOString(), e: new Date(s.getTime() + minutes * 60_000).toISOString() }
  }

  const find = () => {
    setErr(null)
    try {
      const { s, e } = range()
      const b = useTwin.getState().building
      setBooked(new Set())
      const next = { s, e, people, near: b ? originOf(b) : null }
      if (JSON.stringify(next) === JSON.stringify(search)) void result.refetch()
      else setSearch(next)
    } catch (e) {
      setErr(String((e as Error).message))
    }
  }

  useEffect(() => {
    const glow: Record<string, RoomGlow> = {}
    for (const r of rooms ?? []) glow[r.space_id] = booked.has(r.space_id) && !r.free ? 'booked' : r.free ? 'free' : 'busy'
    setRoomGlow(glow)
  }, [rooms, booked, setRoomGlow])

  // Clear glows when leaving the panel.
  useEffect(() => () => setRoomGlow({}), [setRoomGlow])

  const book = async (r: BookableRoom) => {
    setBusy(true)
    setErr(null)
    try {
      if (!search) return
      const { s, e } = search
      await api.book(siteId, { space_id: r.space_id, start: s, end: e, who: 'You', title: `Meeting (${search.people} people)` })
      const next = new Set(booked).add(r.space_id)
      setBooked(next)
      await result.refetch()
      useTwin.getState().setHighlight({ ids: [r.space_id], label: `Booked: ${r.name}` })
    } catch (e) {
      setErr(String((e as Error).message))
    } finally {
      setBusy(false)
    }
  }

  const focus = (r: BookableRoom) => {
    useTwin.getState().setFocusFloor(r.floor_id)
    useTwin.getState().select(r.space_id)
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-2">
        <Field label="Start" className="col-span-2">
          <input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} className={inputCls} />
        </Field>
        <Field label="Duration">
          <select value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} className={inputCls}>
            {[30, 60, 90, 120, 240].map((m) => (
              <option key={m} value={m}>{m < 60 ? `${m} min` : `${m / 60} h`}</option>
            ))}
          </select>
        </Field>
        <Field label="People">
          <input type="number" min={1} max={200} value={people} onChange={(e) => setPeople(Number(e.target.value))} className={inputCls} />
        </Field>
      </div>
      <Btn tone="accent" onClick={find} disabled={busy || result.isFetching}>
        <Search size={14} /> Find free rooms
      </Btn>
      {(err || result.error) && <div className="text-xs text-rose-300">{err ?? result.error?.message}</div>}
      {rooms && !rooms.length && <Empty>No room fits {people} people.</Empty>}
      {rooms && rooms.length > 0 && (
        <ul className="flex flex-col gap-1">
          {rooms.map((r) => {
            const isBooked = booked.has(r.space_id) && !r.free
            return (
              <li
                key={r.space_id}
                onClick={() => focus(r)}
                className="flex cursor-pointer items-center gap-2 rounded-xl px-2 py-2 transition hover:bg-white/5"
              >
                <span
                  className={clsx(
                    'size-2.5 shrink-0 rounded-full',
                    isBooked ? 'bg-blue-400 shadow-[0_0_10px_#60a5fa]' : r.free ? 'bg-emerald-400 shadow-[0_0_10px_#34d399]' : 'bg-slate-600',
                  )}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] text-slate-100">{r.name}</span>
                  <span className="flex items-center gap-2 text-[11px] text-slate-500">
                    <span className="font-mono">L{r.level}</span>
                    <span className="flex items-center gap-0.5"><Users size={11} /> {r.capacity}</span>
                    <span>{r.area_m2.toFixed(0)} m²</span>
                    {r.distance_m != null && <span>{Math.round(r.distance_m)} m away</span>}
                  </span>
                </span>
                {r.free && !isBooked && (
                  <Btn tone="ok" disabled={busy || result.isFetching} onClick={(e) => { e.stopPropagation(); void book(r) }}>
                    <CalendarCheck size={13} /> Book
                  </Btn>
                )}
                {isBooked && <span className="text-[11px] font-medium text-blue-300">Booked</span>}
                <Btn tone="ghost" title="Navigate there" onClick={(e) => { e.stopPropagation(); void navigate(siteId, r.space_id).catch((x) => setErr(String(x.message))) }}>
                  <Navigation size={13} />
                </Btn>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
