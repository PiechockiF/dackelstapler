import clsx from 'clsx'
import { Trash2 } from 'lucide-react'
import { useEffect, useState, type ButtonHTMLAttributes, type ComponentPropsWithRef, type ReactNode } from 'react'

export const glass = 'rounded-2xl border border-white/10 bg-slate-950/60 shadow-2xl shadow-black/40 backdrop-blur-xl'

export function Glass({ className, ...rest }: ComponentPropsWithRef<'div'>) {
  return <div className={clsx(glass, className)} {...rest} />
}

export function Btn({ className, tone = 'default', ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { tone?: 'default' | 'accent' | 'ok' | 'danger' | 'ghost' }) {
  const tones = {
    default: 'bg-white/5 text-slate-200 hover:bg-white/10 border-white/10',
    accent: 'bg-sky-500/20 text-sky-100 hover:bg-sky-500/30 border-sky-400/30',
    ok: 'bg-emerald-500/20 text-emerald-100 hover:bg-emerald-500/30 border-emerald-400/30',
    danger: 'bg-rose-500/20 text-rose-100 hover:bg-rose-500/30 border-rose-400/30',
    ghost: 'bg-transparent text-slate-300 hover:bg-white/5 border-transparent',
  }
  return (
    <button
      className={clsx(
        'inline-flex items-center justify-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition disabled:cursor-not-allowed disabled:opacity-50',
        tones[tone],
        className,
      )}
      {...rest}
    />
  )
}

/** Caption + control. Use as="div" when the control holds buttons (a <label> would click the first one). */
/** Two-step delete: the first click arms it ("Delete?"), a second click within 3 s confirms. */
export function DeleteButton({ onConfirm, label, disabled }: { onConfirm: () => void; label?: string; disabled?: boolean }) {
  const [armed, setArmed] = useState(false)
  useEffect(() => {
    if (!armed) return
    const timer = window.setTimeout(() => setArmed(false), 3000)
    return () => window.clearTimeout(timer)
  }, [armed])
  return (
    <Btn
      type="button"
      tone={armed ? 'danger' : 'ghost'}
      title={armed ? 'Click again to delete' : 'Delete'}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation()
        if (!armed) return setArmed(true)
        setArmed(false)
        onConfirm()
      }}
    >
      <Trash2 size={13} />
      {armed ? 'Delete?' : label}
    </Btn>
  )
}

export function Field({ label, children, className, as: Tag = 'label' }: { label: string; children: ReactNode; className?: string; as?: 'label' | 'div' }) {
  return (
    <Tag className={clsx('flex flex-col gap-1 text-[11px] font-medium uppercase tracking-wide text-slate-400', className)}>
      {label}
      {children}
    </Tag>
  )
}

export const inputCls =
  'w-full rounded-lg border border-white/10 bg-slate-900/70 px-2.5 py-1.5 text-sm normal-case tracking-normal text-slate-100 outline-none placeholder:text-slate-500 focus:border-sky-400/60 focus:ring-2 focus:ring-sky-400/20'

export function timeAgo(iso: string, now = Date.now()) {
  const s = Math.round((now - Date.parse(iso)) / 1000)
  if (s < 60) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 48) return `${h} h ago`
  return `${Math.round(h / 24)} d ago`
}
