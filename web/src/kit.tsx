// Form controls, overlays and confirm dialogs from the mock
// (mocks/v1/src/components/ui.tsx and shared.tsx), for the management
// screens: workspaces, members, access, people and agents.
import { cloneElement, isValidElement, useEffect, useId, useRef, useState, type InputHTMLAttributes, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { ApiError } from './api'
import { Button, cx } from './ui'

/** A labelled form control, with a hint or an error under it. */
export function FormField({ label, children, hint, error, optional }: { label: ReactNode; children: ReactNode; hint?: ReactNode; error?: string | null; optional?: boolean }) {
  // Associate the label with a single form control child, so it has an accessible name.
  const auto = useId()
  const el = isValidElement<{ id?: string }>(children) ? children : null
  const id = el ? (el.props.id ?? auto) : undefined
  if (el && !el.props.id) children = cloneElement(el, { id })
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-xs font-medium text-zinc-300">
        {label}
        {optional && <span className="font-normal text-zinc-600"> · optional</span>}
      </label>
      {children}
      {error ? <div className="text-xs2 text-red-400">{error}</div> : hint ? <div className="text-xs2 text-zinc-500">{hint}</div> : null}
    </div>
  )
}

const INPUT = 'w-full rounded-lg border border-zinc-700 bg-page px-3 py-[9px] text-[13px] text-zinc-100 placeholder:text-zinc-600 outline-none focus:border-zinc-500 disabled:text-zinc-500 disabled:border-edge'

export function TextInput({ mono, className, ...rest }: InputHTMLAttributes<HTMLInputElement> & { mono?: boolean }) {
  return <input {...rest} className={cx(INPUT, mono && 'font-mono text-sm2', className)} />
}

export function Textarea({ className, ...rest }: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...rest} className={cx(INPUT, 'min-h-16 resize-y leading-relaxed', className)} />
}

export function Select({ className, children, mono, ...rest }: React.SelectHTMLAttributes<HTMLSelectElement> & { mono?: boolean }) {
  return (
    <div className="relative">
      <select {...rest} className={cx(INPUT, 'appearance-none pr-8', mono && 'font-mono text-sm2', className)}>
        {children}
      </select>
      <span className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-[10px] text-zinc-600">▾</span>
    </div>
  )
}

/** A single-choice control, exposed as a radio group: arrow keys move the choice. */
export function Segmented<T extends string>({ value, options, onChange, size = 'md', label }: { value: T; options: { value: T; label: ReactNode }[]; onChange: (v: T) => void; size?: 'sm' | 'md'; label?: string }) {
  const refs = useRef<(HTMLButtonElement | null)[]>([])
  const onKeyDown = (e: React.KeyboardEvent, i: number) => {
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0
    if (!step) return
    e.preventDefault()
    const to = (i + step + options.length) % options.length
    onChange(options[to].value)
    refs.current[to]?.focus()
  }
  return (
    <div role="radiogroup" aria-label={label} className={cx('flex gap-0.5 self-start border border-edge bg-page', size === 'sm' ? 'rounded-[7px] p-0.5' : 'rounded-lg p-[3px]')}>
      {options.map((o, i) => {
        const on = o.value === value
        return (
          <button
            key={o.value}
            ref={(el) => void (refs.current[i] = el)}
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            type="button"
            onClick={() => onChange(o.value)}
            onKeyDown={(e) => onKeyDown(e, i)}
            className={cx(size === 'sm' ? 'rounded-[5px] px-2.5 py-1 text-xs2' : 'rounded-md px-3.5 py-1.5 text-sm2', on ? 'bg-edge font-semibold text-zinc-100' : 'text-zinc-400 hover:text-zinc-200')}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

export function Checkbox({ checked, onChange, label, disabled }: { checked: boolean; onChange?: (v: boolean) => void; label?: ReactNode; disabled?: boolean }) {
  return (
    <label className={cx('flex items-center gap-2.5', disabled ? 'opacity-50' : 'cursor-pointer')}>
      <input type="checkbox" className="peer sr-only" checked={checked} disabled={disabled} onChange={(e) => onChange?.(e.target.checked)} />
      <span aria-hidden className={cx('inline-flex size-3.5 min-w-3.5 items-center justify-center rounded text-[10px] font-bold peer-focus-visible:outline-2 peer-focus-visible:outline-zinc-500', checked ? 'bg-zinc-50 text-zinc-900' : 'border border-zinc-700')}>
        {checked && '✓'}
      </span>
      {label != null && <span className={cx('text-[13px]', !checked && 'text-zinc-400')}>{label}</span>}
    </label>
  )
}

export function Toggle({ on, onChange, label, disabled }: { on: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} disabled={disabled} onClick={() => onChange(!on)} className={cx('relative h-5 w-9 min-w-9 rounded-full transition-colors disabled:opacity-45', on ? 'bg-green-600' : 'bg-zinc-700')}>
      <span className={cx('absolute top-0.5 size-4 rounded-full transition-all', on ? 'left-[18px] bg-zinc-100' : 'left-0.5 bg-zinc-400')} />
    </button>
  )
}

export function Callout({ tone, children, className }: { tone: 'amber' | 'red' | 'green' | 'neutral'; children: ReactNode; className?: string }) {
  const t = {
    amber: 'bg-amber-500/[0.06] border-amber-500/30 text-amber-400',
    red: 'bg-red-500/[0.06] border-red-500/30 text-red-400',
    green: 'bg-green-500/[0.06] border-green-500/30 text-green-400',
    neutral: 'bg-rail border-edge text-zinc-400',
  }[tone]
  return (
    <div role={tone === 'red' ? 'alert' : undefined} className={cx('rounded-lg border px-3.5 py-2.5 text-xs leading-relaxed', t, className)}>
      {children}
    </div>
  )
}

export function Panel({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cx('rounded-[10px] border border-edge bg-panel', className)}>{children}</div>
}

export function StatusInline({ tone, children }: { tone: 'green' | 'amber' | 'gray' | 'red'; children: ReactNode }) {
  const dot = { green: 'bg-green-500', amber: 'bg-amber-500', gray: 'bg-zinc-600', red: 'bg-red-500' }[tone]
  const text = { green: 'text-green-400', amber: 'text-amber-400', gray: 'text-zinc-400', red: 'text-red-400' }[tone]
  return (
    <span className={cx('inline-flex items-center gap-1.5 text-xs', text)}>
      <span className={cx('size-1.5 rounded-full', dot)} />
      {children}
    </span>
  )
}

export const DANGER = '!bg-red-600 !text-white font-semibold hover:!bg-red-500 !border-transparent'

/* Overlays. Only the topmost layer reacts to Escape; dialogs trap Tab,
   take focus when they open and hand it back when they close. */
const layerStack: number[] = []
let layerSeq = 0
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
const focusables = (el: HTMLElement) => Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE))

function useLayer(open: boolean, onEscape: (() => void) | null, trap?: React.RefObject<HTMLElement | null>) {
  const esc = useRef(onEscape)
  useEffect(() => {
    esc.current = onEscape
  })
  useEffect(() => {
    if (!open) return
    const id = ++layerSeq
    layerStack.push(id)
    const top = () => layerStack[layerStack.length - 1] === id
    const prev = document.activeElement as HTMLElement | null
    const el = trap?.current
    if (el && !el.contains(document.activeElement)) (focusables(el)[1] ?? focusables(el)[0] ?? el).focus()
    const onKey = (e: KeyboardEvent) => {
      if (!top()) return
      if (e.key === 'Escape') {
        e.preventDefault()
        esc.current?.()
      }
      if (e.key === 'Tab' && el) {
        const f = focusables(el)
        if (!f.length) return e.preventDefault()
        const i = f.indexOf(document.activeElement as HTMLElement)
        if (e.shiftKey && i <= 0) {
          e.preventDefault()
          f[f.length - 1].focus()
        } else if (!e.shiftKey && (i === -1 || i === f.length - 1)) {
          e.preventDefault()
          f[0].focus()
        }
      }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      const wasTop = top()
      layerStack.splice(layerStack.indexOf(id), 1)
      document.removeEventListener('keydown', onKey)
      if (el && wasTop && prev && document.contains(prev)) prev.focus()
    }
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps
}

export function Modal({ open, onClose, width = 480, children, title }: { open: boolean; onClose: () => void; width?: number; children: ReactNode; title: ReactNode }) {
  const id = useId()
  const ref = useRef<HTMLDivElement>(null)
  useLayer(open, onClose, ref)
  if (!open) return null
  return createPortal(
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-canvas/65 p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} tabIndex={-1} role="dialog" aria-modal aria-labelledby={id} style={{ width }} className="flex max-h-[calc(100vh-2rem)] max-w-full flex-col gap-4 overflow-y-auto rounded-xl border border-edge bg-panel p-7 text-zinc-100 shadow-[0_24px_64px_rgba(0,0,0,0.5)] outline-none">
        <div className="flex items-center justify-between gap-4">
          <div id={id} className="text-[15px] font-semibold">
            {title}
          </div>
          <button type="button" aria-label="Close" onClick={onClose} className="text-sm text-zinc-600 hover:text-zinc-300">
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  )
}

export function Footer({ children }: { children: ReactNode }) {
  return <div className="flex justify-end gap-2 border-t border-line pt-4">{children}</div>
}

export type MenuItem = { label: string; onClick: () => void; danger?: boolean; disabled?: boolean; hint?: string }

/** A small row-actions menu. Arrow keys move; Escape closes and returns focus to the ⋯ button. */
export function Menu({ items, label = 'Actions' }: { items: (MenuItem | null | false)[]; label?: string }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const btn = useRef<HTMLButtonElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const close = () => {
    setOpen(false)
    btn.current?.focus()
  }
  useLayer(open, close)
  useEffect(() => {
    if (!open) return
    list.current?.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])')?.focus()
    const h = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false)
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [open])
  const onKeyDown = (e: React.KeyboardEvent) => {
    const els = Array.from(list.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])') ?? [])
    const i = els.indexOf(document.activeElement as HTMLElement)
    const to = e.key === 'ArrowDown' ? (i + 1) % els.length : e.key === 'ArrowUp' ? (i - 1 + els.length) % els.length : -1
    if (e.key === 'Tab') setOpen(false)
    if (to < 0 || !els.length) return
    e.preventDefault()
    els[to].focus()
  }
  const shown = items.filter((x): x is MenuItem => !!x)
  if (!shown.length) return null
  return (
    <div ref={ref} className="relative inline-block" onClick={(e) => e.stopPropagation()}>
      <button ref={btn} type="button" aria-label={label} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)} className="rounded-md px-2 py-0.5 text-zinc-500 hover:bg-line hover:text-zinc-200">
        ⋯
      </button>
      {open && (
        <div ref={list} role="menu" aria-label={label} onKeyDown={onKeyDown} className="absolute top-full right-0 z-30 mt-1 min-w-52 rounded-lg border border-edge bg-panel p-1 text-left shadow-xl">
          {shown.map((it) => (
            <button
              key={it.label}
              type="button"
              role="menuitem"
              tabIndex={-1}
              disabled={it.disabled}
              title={it.hint}
              onClick={() => {
                close()
                it.onClick()
              }}
              className={cx('block w-full rounded-md px-3 py-1.5 text-left text-[13px] outline-none disabled:opacity-40', it.danger ? 'text-red-400 hover:bg-red-500/10 focus:bg-red-500/10' : 'text-zinc-300 hover:bg-line focus:bg-line')}
            >
              {it.label}
              {it.disabled && it.hint && <span className="block text-2xs text-zinc-500">{it.hint}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export type ImpactRow = [string, ReactNode, ('amber' | 'red')?]

/**
 * The confirm dialog for anything that changes access: what changes, row by
 * row, then Confirm. onConfirm runs the write; the dialog stays open with
 * the error if it fails and closes when it succeeds.
 */
export function ImpactDialog({ open, onClose, title, rows, body, confirmLabel, onConfirm, typeToConfirm, danger = true }: { open: boolean; onClose: () => void; title: ReactNode; rows: ImpactRow[]; body?: ReactNode; confirmLabel: string; onConfirm: () => Promise<unknown>; typeToConfirm?: string; danger?: boolean }) {
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (open) {
      setTyped('')
      setError(null)
      setBusy(false)
    }
  }, [open])
  async function confirm() {
    setBusy(true)
    setError(null)
    try {
      await onConfirm()
      onClose()
    } catch (err) {
      setError(errorText(err))
      setBusy(false)
    }
  }
  return (
    <Modal open={open} onClose={onClose} width={500} title={title}>
      {rows.length > 0 && (
        <div className="flex flex-col gap-2.5 rounded-[10px] border border-edge bg-rail p-4 text-sm2">
          {rows.map(([k, v, tone]) => (
            <div key={k} className="flex justify-between gap-6">
              <span className="text-zinc-500">{k}</span>
              <span className={cx('text-right', tone === 'amber' && 'font-semibold text-amber-400', tone === 'red' && 'font-semibold text-red-400')}>{v}</span>
            </div>
          ))}
        </div>
      )}
      {body && <div className="text-sm2 leading-relaxed text-zinc-400">{body}</div>}
      {typeToConfirm && (
        <FormField label={<>Type “{typeToConfirm}” to confirm</>}>
          <TextInput value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={typeToConfirm} />
        </FormField>
      )}
      {error && <Callout tone="red">{error}</Callout>}
      <Footer>
        <Button size="lg" onClick={onClose}>
          Cancel
        </Button>
        <Button size="lg" variant="primary" className={cx(danger && DANGER)} disabled={busy || (!!typeToConfirm && typed !== typeToConfirm)} onClick={confirm}>
          {busy ? 'Working…' : confirmLabel}
        </Button>
      </Footer>
    </Modal>
  )
}

/** A failed write, said for the person who tried it. */
export function errorText(err: unknown) {
  if (err instanceof ApiError) {
    if (err.code === 'csrf') return 'Your session changed. Reload the page and try again.'
    const m = err.message
    return m.charAt(0).toUpperCase() + m.slice(1) + (m.endsWith('.') ? '' : '.')
  }
  return 'Dispatch didn’t answer. Nothing was changed.'
}

/** "3 min ago", "2 h ago", "4 d ago", from an ISO time. */
export function ago(iso: string | null | undefined, now = Date.now()) {
  if (!iso) return '—'
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000))
  if (s < 60) return 'Just now'
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`
  return `${Math.floor(s / 86400)} d ago`
}

export const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('') || '?'

export function Avatar({ name, size = 22 }: { name: string; size?: number }) {
  return (
    <span aria-hidden style={{ width: size, height: size, minWidth: size, fontSize: size > 26 ? 11 : 9 }} className="inline-flex items-center justify-center rounded-full bg-avatar font-semibold text-zinc-200">
      {initials(name)}
    </span>
  )
}

/** A user or agent with its avatar or glyph. */
export function PrincipalChip({ kind, name, withKind, dim }: { kind: string; name: string; withKind?: boolean; dim?: boolean }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-2">
      {kind === 'agent' ? (
        <span aria-hidden className={cx('inline-flex size-[22px] min-w-[22px] items-center justify-center rounded-md border border-signal/30 bg-signal/10 font-mono text-[10px] text-signal-light', dim && 'opacity-50')}>
          ◆
        </span>
      ) : (
        <Avatar name={name} />
      )}
      <span className={cx('truncate', kind === 'agent' ? 'font-mono text-[12.5px]' : 'text-[13px]', dim ? 'text-zinc-500' : 'text-zinc-200')}>{name}</span>
      {withKind && <span className="text-2xs text-zinc-600">{kind === 'agent' ? 'agent' : 'human'}</span>}
    </span>
  )
}
