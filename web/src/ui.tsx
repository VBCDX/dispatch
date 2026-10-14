// Primitives from the mock (mocks/v1/src/components/ui.tsx and shared.tsx),
// trimmed to what the built screens use.
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from 'react'
import { Link, NavLink } from 'react-router-dom'

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ')

export const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`

type BtnVariant = 'primary' | 'secondary' | 'ghost'
const BTN: Record<BtnVariant, string> = {
  primary: 'bg-zinc-50 text-zinc-900 font-semibold hover:bg-white border border-transparent',
  secondary: 'bg-transparent text-zinc-300 border border-zinc-700 hover:bg-white/[0.03] hover:text-zinc-100',
  ghost: 'bg-transparent text-zinc-400 hover:text-zinc-100 border border-transparent',
}
const SIZE = { sm: 'rounded-[7px] px-3 py-1.5 text-sm2', md: 'rounded-lg px-3.5 py-2 text-[13px]', lg: 'rounded-lg px-4 py-[9px] text-[13px]' }
const BTN_BASE = 'inline-flex items-center justify-center gap-2 whitespace-nowrap transition-colors disabled:opacity-40'

export function Button({
  variant = 'secondary',
  size = 'md',
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: BtnVariant; size?: keyof typeof SIZE }) {
  return <button type="button" {...rest} className={cx(BTN_BASE, BTN[variant], SIZE[size], className)} />
}

export function ButtonLink({ variant = 'secondary', className, ...rest }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { variant?: BtnVariant }) {
  return <a {...rest} className={cx(BTN_BASE, BTN[variant], SIZE.md, 'hover:!text-zinc-100', className)} />
}

/** A write action that isn't built yet: shown, disabled, with a "Coming soon" tooltip. */
export function SoonButton(props: { children: ReactNode; variant?: BtnVariant; size?: keyof typeof SIZE; className?: string }) {
  return (
    <span title="Coming soon" tabIndex={0} aria-label={`${typeof props.children === 'string' ? props.children : 'This action'}: coming soon`} className="inline-flex rounded-lg outline-none focus-visible:ring-1 focus-visible:ring-zinc-500">
      <Button {...props} disabled aria-hidden tabIndex={-1} className={cx('pointer-events-none', props.className)} />
    </span>
  )
}

export function Field({ label, htmlFor, children }: { label: ReactNode; htmlFor: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className="text-xs font-medium text-zinc-300">
        {label}
      </label>
      {children}
    </div>
  )
}

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className="w-full rounded-lg border border-zinc-700 bg-page px-3 py-[9px] text-[13px] text-zinc-100 placeholder:text-zinc-600 outline-none focus:border-zinc-500"
    />
  )
}

export function DispatchMark({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden className="shrink-0">
      <circle cx="6.5" cy="12" r="3" stroke="#a78bfa" strokeWidth="1.8" />
      <circle cx="17.5" cy="12" r="3" fill="#a78bfa" />
      <path d="M9.5 12h5" stroke="#a78bfa" strokeWidth="1.8" />
    </svg>
  )
}

/** A centred card on its own, for sign-in and the full-screen gates. */
export function Card({ children, width = 420 }: { children: ReactNode; width?: number }) {
  return (
    <div className="flex h-full items-center justify-center bg-page p-6 text-zinc-100">
      <div className="max-w-full rounded-xl border border-edge bg-panel p-7" style={{ width }}>
        {children}
      </div>
    </div>
  )
}

type Tone = 'neutral' | 'green' | 'amber' | 'red' | 'blue'
const PILL: Record<Tone, string> = {
  neutral: 'text-zinc-400 bg-line border-chip',
  green: 'text-green-400 bg-green-500/10 border-green-500/30',
  amber: 'text-amber-400 bg-amber-500/[0.08] border-amber-500/30',
  red: 'text-red-400 bg-red-500/10 border-red-500/30',
  blue: 'text-sky-400 bg-sky-500/10 border-sky-500/30',
}
export function Pill({ tone = 'neutral', children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return <span className={cx('inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-2xs font-semibold whitespace-nowrap', PILL[tone], className)}>{children}</span>
}

export function Breadcrumb({ items }: { items: { label: string; to?: string }[] }) {
  return (
    <div className="text-xs text-zinc-500">
      {items.map((it, i) => (
        <span key={i}>
          {i > 0 && ' / '}
          {it.to ? (
            <Link to={it.to} className="text-zinc-500 hover:text-zinc-300">
              {it.label}
            </Link>
          ) : (
            it.label
          )}
        </span>
      ))}
    </div>
  )
}

export function PageTitle({ children, actions, sub }: { children: ReactNode; actions?: ReactNode; sub?: ReactNode }) {
  return (
    <div className="mt-1 flex items-center justify-between gap-4">
      <div className="flex min-w-0 items-center gap-3">
        <h1 className="m-0 text-lg font-semibold tracking-[-0.01em]">{children}</h1>
        {sub}
      </div>
      {actions && <div className="flex shrink-0 gap-2">{actions}</div>}
    </div>
  )
}

export function Tabs({ tabs }: { tabs: { to: string; label: ReactNode; end?: boolean }[] }) {
  return (
    <nav className="mt-5 flex gap-1 overflow-x-auto border-b border-line">
      {tabs.map((t) => (
        <NavLink
          key={t.to}
          to={t.to}
          end={t.end}
          className={({ isActive }) =>
            cx('-mb-px px-3 py-2 text-[13px] whitespace-nowrap', isActive ? 'border-b-2 border-signal font-semibold text-zinc-100 hover:text-zinc-100' : 'text-zinc-400 hover:text-zinc-200')
          }
        >
          {t.label}
        </NavLink>
      ))}
    </nav>
  )
}

export function Table({ cols, head, children, className }: { cols: string; head: ReactNode[]; children: ReactNode; className?: string }) {
  return (
    <div className={cx('overflow-x-auto rounded-[10px] border border-edge bg-panel', className)}>
      <div className="min-w-fit">
        <div className="grid gap-3 border-b border-line px-4 py-2.5" style={{ gridTemplateColumns: cols }}>
          {head.map((h, i) => (
            <div key={i} className="th">
              {h}
            </div>
          ))}
        </div>
        <div className="[&>*:last-child]:border-b-0">{children}</div>
      </div>
    </div>
  )
}

export function Row({ cols, children, className, onClick }: { cols: string; children: ReactNode; className?: string; onClick?: () => void }) {
  return (
    <div
      onClick={onClick}
      className={cx('grid items-center gap-3 border-b border-line px-4 py-[13px] text-[13px]', onClick && 'cursor-pointer hover:bg-white/[0.015]', className)}
      style={{ gridTemplateColumns: cols }}
    >
      {children}
    </div>
  )
}

export function SkeletonRows({ cols, n = 3 }: { cols: string; n?: number }) {
  const count = cols.split(' ').length
  return (
    <div aria-busy="true" aria-label="Loading">
      {Array.from({ length: n }).map((_, r) => (
        <div key={r} className="grid gap-3 border-b border-line px-4 py-4" style={{ gridTemplateColumns: cols }} aria-hidden>
          {Array.from({ length: count }).map((_, c) => (
            <div key={c} className="skeleton h-3" style={{ width: `${50 + ((r * 7 + c * 13) % 40)}%` }} />
          ))}
        </div>
      ))}
    </div>
  )
}

export function ErrorBox({ what, onRetry }: { what: string; onRetry: () => void }) {
  return (
    <div role="alert" className="flex items-center justify-between gap-4 rounded-[10px] border border-red-500/30 bg-red-500/[0.04] px-4 py-3.5">
      <div>
        <div className="text-[13px] font-semibold text-red-400">Couldn’t load {what}</div>
        <div className="mt-0.5 text-xs text-zinc-400">Dispatch didn’t answer. Nothing was changed.</div>
      </div>
      <Button size="sm" onClick={onRetry}>
        Retry
      </Button>
    </div>
  )
}

export function NoAccess({ what, back }: { what: string; back: { to: string; label: string } }) {
  return (
    <div role="alert" className="max-w-[560px] rounded-[10px] border border-edge bg-panel p-6 text-sm2 text-zinc-400">
      <div className="text-[13px] font-semibold text-zinc-200">You don’t have access to this {what}.</div>
      <div className="mt-1">It doesn’t exist, or it belongs to an organization or workspace you’re not part of. Nothing about it is shown.</div>
      <Link to={back.to} className="mt-3 inline-block">
        {back.label} →
      </Link>
    </div>
  )
}

/** The panel a route shows until its screen is built. */
export function ComingSoon({ title, inline }: { title?: string; inline?: boolean }) {
  return (
    <div className={inline ? 'mt-5' : undefined}>
      {title && <PageTitle>{title}</PageTitle>}
      <div className={cx('max-w-[560px] rounded-[10px] border border-edge bg-panel p-6 text-sm2 text-zinc-400', title && 'mt-5')}>
        <div className="text-[13px] font-semibold text-zinc-200">Coming soon</div>
        <div className="mt-1">This part of Dispatch isn’t built yet.</div>
      </div>
    </div>
  )
}
