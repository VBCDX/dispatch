import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { actions, me, org, statusIn, useDB } from '../lib/store'
import { cx, useLayer } from './ui'

/**
 * The one organization switcher: the org box at the top of the sidebar (also shown on the suspended/invited gate).
 * A dropdown listing the person's organizations with their role and a suspended/invited marker, the current one
 * checked, and pending invitations in their own group. Switching lands on that organization's Home.
 * Keyboard: Enter/Space/↓ opens, ↑/↓/Home/End move, Enter picks, Escape or Tab closes.
 */
export function OrgSwitcher({ online, className }: { online?: number; className?: string }) {
  const d = useDB()
  const nav = useNavigate()
  const u = me(d)
  const [open, setOpen] = useState(false)
  const wrap = useRef<HTMLDivElement>(null)
  const btn = useRef<HTMLButtonElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const close = (refocus = true) => {
    setOpen(false)
    if (refocus) btn.current?.focus()
  }
  useLayer(open, () => close())
  useEffect(() => {
    if (!open) return
    const items = Array.from(list.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? [])
    ;(items.find((x) => x.getAttribute('aria-checked') === 'true') ?? items[0])?.focus()
    const h = (e: MouseEvent) => !wrap.current?.contains(e.target as Node) && setOpen(false)
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [open])
  const mine = d.orgs.filter((o) => u?.roles[o.id])
  const member = mine.filter((o) => statusIn(u, o.id) !== 'invited')
  const invites = mine.filter((o) => statusIn(u, o.id) === 'invited')
  const here = statusIn(u, d.currentOrgId)
  const pick = (id: string) => {
    close()
    if (id === d.currentOrgId) return
    // Leave the current page first so a record URL can't pull us back, then land on the new org's Home.
    nav('/')
    actions.switchOrg(id)
  }
  const onKeyDown = (e: React.KeyboardEvent) => {
    const els = Array.from(list.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? [])
    const i = els.indexOf(document.activeElement as HTMLElement)
    const to = e.key === 'ArrowDown' ? (i + 1) % els.length : e.key === 'ArrowUp' ? (i - 1 + els.length) % els.length : e.key === 'Home' ? 0 : e.key === 'End' ? els.length - 1 : -1
    if (e.key === 'Tab') setOpen(false)
    if (to < 0 || !els.length) return
    e.preventDefault()
    els[to].focus()
  }
  const item = (o: (typeof mine)[number]) => {
    const st = statusIn(u, o.id)
    const current = o.id === d.currentOrgId
    return (
      <button key={o.id} type="button" role="menuitemradio" aria-checked={current} tabIndex={-1} onClick={() => pick(o.id)} className={cx('flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] outline-none focus:bg-line', current ? 'text-zinc-100' : 'text-zinc-300 hover:bg-line')}>
        <span aria-hidden className="w-3 text-2xs text-signal-light">{current ? '✓' : ''}</span>
        <span className="min-w-0 flex-1 truncate">{o.name}</span>
        <span className="text-2xs text-zinc-500">{u?.roles[o.id]}</span>
        {st !== 'active' && <span className={cx('rounded border px-1 text-2xs', st === 'suspended' ? 'border-amber-500/40 text-amber-400' : 'border-sky-500/40 text-sky-400')}>{st}</span>}
      </button>
    )
  }
  return (
    <div ref={wrap} className={cx('relative', className)}>
      <button
        ref={btn}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Organization: ${org(d)?.name}${here && here !== 'active' ? ` (${here})` : ''}. Switch organization`}
        onClick={() => setOpen(!open)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' && !open) {
            e.preventDefault()
            setOpen(true)
          }
        }}
        className="flex w-full items-center justify-between rounded-lg border border-edge bg-panel px-3 py-[9px] text-left hover:border-zinc-700"
      >
        <span className="flex min-w-0 items-center gap-2">
          <span className="flex size-5 items-center justify-center rounded-[5px] border border-chip bg-line text-2xs font-semibold text-zinc-400">{org(d)?.name.charAt(0)}</span>
          <span className="truncate text-[13px] font-medium text-zinc-200">{org(d)?.name}</span>
          {here && here !== 'active' && <span className="text-2xs text-amber-400">{here}</span>}
        </span>
        <span className="flex items-center gap-1.5 text-2xs text-zinc-500">
          {online !== undefined && (
            <span className="flex items-center gap-1.5" title="Agents connected right now">
              <span className={cx('size-1.5 rounded-full', online ? 'bg-green-500' : 'bg-zinc-600')} />
              {online}
            </span>
          )}
          <span aria-hidden className="text-[9px] text-zinc-600">
            {open ? '▴' : '▾'}
          </span>
        </span>
      </button>
      {open && (
        <div ref={list} role="menu" aria-label="Switch organization" onKeyDown={onKeyDown} className="absolute top-full right-0 left-0 z-40 mt-1 rounded-lg border border-edge bg-panel p-1 shadow-xl">
          <div className="px-2 pt-1 pb-0.5 text-[10px] font-semibold tracking-[0.08em] text-zinc-500 uppercase" role="presentation">
            Your organizations
          </div>
          {member.map(item)}
          {invites.length > 0 && (
            <>
              <div className="mt-1 border-t border-line px-2 pt-1.5 pb-0.5 text-[10px] font-semibold tracking-[0.08em] text-zinc-500 uppercase" role="presentation">
                Pending invitations
              </div>
              {invites.map(item)}
            </>
          )}
        </div>
      )}
    </div>
  )
}
