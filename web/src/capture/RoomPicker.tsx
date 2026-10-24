// Owner: agent C. Searchable room picker for the phone (inline list, big touch targets).
import clsx from 'clsx'
import { MapPin, Search, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { Building } from '../lib/types'
import { pickableSpaces, spaceTitle } from './captureApi'

export default function RoomPicker({
  building,
  value,
  onChange,
  placeholder = 'Search room, e.g. 0.21 or Assembly',
  optional = false,
}: {
  building: Building | null
  value: string | null
  onChange: (spaceId: string | null) => void
  placeholder?: string
  optional?: boolean
}) {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const groups = useMemo(() => pickableSpaces(building), [building])
  const selected = building?.spaces.find((s) => s.id === value) ?? null
  const floorName = (floorId: string) => building?.floors.find((f) => f.id === floorId)?.name ?? ''

  const filtered = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean)
    return groups
      .map((group) => ({
        ...group,
        spaces: group.spaces.filter((space) => {
          const haystack = `${space.name} ${space.ref ?? ''} ${space.room_type ?? ''} ${group.floorName}`.toLowerCase()
          return words.every((word) => haystack.includes(word))
        }),
      }))
      .filter((group) => group.spaces.length)
  }, [groups, query])

  if (selected && !open) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-sky-400/30 bg-sky-500/10 px-3 py-2.5">
        <MapPin size={16} className="shrink-0 text-sky-300" />
        <button type="button" className="min-w-0 flex-1 text-left" onClick={() => setOpen(true)}>
          <div className="truncate text-sm font-medium text-slate-100">{spaceTitle(selected)}</div>
          <div className="truncate text-[11px] text-slate-400">{floorName(selected.floor_id)}</div>
        </button>
        {optional && (
          <button type="button" aria-label="Clear room" className="rounded-lg p-1.5 text-slate-400 active:bg-white/10" onClick={() => onChange(null)}>
            <X size={16} />
          </button>
        )}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2 rounded-xl border border-white/10 bg-slate-900/70 px-3 focus-within:border-sky-400/60 focus-within:ring-2 focus-within:ring-sky-400/20">
        <Search size={16} className="shrink-0 text-slate-500" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => setOpen(true)}
          placeholder={building ? placeholder : 'Loading rooms…'}
          disabled={!building}
          className="min-w-0 flex-1 bg-transparent py-2.5 text-base text-slate-100 outline-none placeholder:text-slate-500 sm:text-sm"
        />
        {open && (
          <button type="button" className="rounded-lg p-1 text-slate-400" onClick={() => { setOpen(false); setQuery('') }} aria-label="Close">
            <X size={16} />
          </button>
        )}
      </div>
      {open && (
        <div className="max-h-72 overflow-y-auto overscroll-contain rounded-xl border border-white/10 bg-slate-950/90">
          {filtered.length === 0 && <div className="px-3 py-4 text-center text-sm text-slate-500">No room matches “{query}”.</div>}
          {filtered.map((group) => (
            <div key={group.level}>
              <div className="sticky top-0 z-10 bg-slate-950/95 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                {group.floorName}
              </div>
              {group.spaces.slice(0, 80).map((space) => (
                <button
                  type="button"
                  key={space.id}
                  onClick={() => {
                    onChange(space.id)
                    setOpen(false)
                    setQuery('')
                  }}
                  className={clsx(
                    'flex w-full items-center justify-between gap-2 px-3 py-2.5 text-left text-sm active:bg-sky-500/20',
                    space.id === value ? 'text-sky-200' : 'text-slate-200',
                  )}
                >
                  <span className="truncate">{spaceTitle(space)}</span>
                  <span className="shrink-0 text-[11px] text-slate-500">{(space.room_type ?? space.type).replace(/_/g, ' ')}</span>
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
