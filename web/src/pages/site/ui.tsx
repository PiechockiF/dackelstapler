import clsx from 'clsx'
import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from 'react'

export const glass = 'rounded-2xl border border-white/10 bg-slate-950/60 shadow-2xl shadow-black/40 backdrop-blur-xl'

export function Glass({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
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

export function Field({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <label className={clsx('flex flex-col gap-1 text-[11px] font-medium uppercase tracking-wide text-slate-400', className)}>
      {label}
      {children}
    </label>
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
