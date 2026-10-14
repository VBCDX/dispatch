// The app shell, ported from the mock (mocks/v1/src/components/AppShell.tsx,
// Sidebar.tsx and OrgSwitcher.tsx): left navigation, the organization
// switcher, the VBCDX suite switcher and the signed-in user menu.
import { useEffect, useRef, useState } from 'react'
import { Link, NavLink, Outlet, useNavigate } from 'react-router-dom'
import type { Org } from './api'
import { useSession } from './session'
import { Card, DispatchMark, SoonButton, cx } from './ui'

export function AppShell() {
  const { org } = useSession()
  // Only active members get the app. Suspended people and invitees see a
  // full-screen gate instead: no sidebar, nothing from this organization.
  if (org?.status !== 'active') return <OrgGate />
  return (
    <div className="flex h-full bg-page text-zinc-100">
      <Sidebar />
      <main className="min-w-0 flex-1 overflow-y-auto px-10 py-8">
        <Outlet />
      </main>
    </div>
  )
}

type Item = { label: string; to?: string; indent?: boolean; group?: boolean; end?: boolean }
const NAV: Item[] = [
  { label: 'Home', to: '/', end: true },
  { label: 'Workspaces', to: '/workspaces' },
  { label: 'Search', to: '/search' },
  { label: 'Players', group: true },
  { label: 'Agents', to: '/agents', indent: true },
  { label: 'People', to: '/people', indent: true },
  { label: 'Audit', to: '/audit' },
  { label: 'Developers', group: true },
  { label: 'API & MCP', to: '/developers', indent: true },
  { label: 'Settings', group: true },
  { label: 'My Settings', to: '/settings/me', indent: true },
  { label: 'Account', to: '/settings/account', indent: true },
]

function Sidebar() {
  const { workspaces } = useSession()
  const ws = workspaces.state === 'ready' ? workspaces.data : []
  return (
    <aside className="flex h-full w-60 min-w-60 flex-col border-r border-line bg-rail">
      <Link to="/" className="flex items-center gap-2 px-4 pt-4 pb-1.5">
        <DispatchMark />
        <span className="text-sm font-semibold tracking-[-0.01em] text-zinc-100">Dispatch</span>
      </Link>
      <OrgSwitcher className="mx-3 my-2.5" />
      <nav className="flex min-h-0 flex-1 flex-col gap-px overflow-y-auto px-2 py-1 pb-4">
        {NAV.map((it) =>
          it.group ? (
            <div key={it.label} className="mt-3.5 px-2 py-1.5 text-[10px] font-semibold tracking-[0.08em] text-[#5b5b64] uppercase">
              {it.label}
            </div>
          ) : (
            <div key={it.label}>
              <NavLink to={it.to!} end={it.end} className={({ isActive }) => cx('block rounded-md py-1.5 pr-2 text-[13px]', it.indent ? 'pl-[22px]' : 'pl-2', isActive ? 'bg-line font-semibold text-zinc-100 hover:text-zinc-100' : 'text-zinc-400 hover:bg-white/[0.02] hover:text-zinc-200')}>
                {it.label}
              </NavLink>
              {it.label === 'Workspaces' &&
                ws.map((w) => (
                  <NavLink key={w.id} to={`/workspaces/${w.id}/messages`} className={({ isActive }) => cx('block truncate rounded-md py-1 pr-2 pl-[22px] text-xs', isActive ? 'text-zinc-100 hover:text-zinc-100' : 'text-zinc-500 hover:text-zinc-300')}>
                    {w.name}
                  </NavLink>
                ))}
            </div>
          ),
        )}
      </nav>
      <SuiteSwitcher />
      <UserMenu />
    </aside>
  )
}

/** Closes a dropdown on a click outside it or on Escape. */
function useDropdown() {
  const [open, setOpen] = useState(false)
  const wrap = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const click = (e: MouseEvent) => !wrap.current?.contains(e.target as Node) && setOpen(false)
    const key = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('mousedown', click)
    document.addEventListener('keydown', key)
    return () => {
      document.removeEventListener('mousedown', click)
      document.removeEventListener('keydown', key)
    }
  }, [open])
  return { open, setOpen, wrap }
}

/** Arrow keys, Home and End move between a menu's items. */
function menuKeys(list: HTMLElement | null, selector: string, e: React.KeyboardEvent) {
  const els = Array.from(list?.querySelectorAll<HTMLElement>(selector) ?? [])
  const i = els.indexOf(document.activeElement as HTMLElement)
  const to = e.key === 'ArrowDown' ? (i + 1) % els.length : e.key === 'ArrowUp' ? (i - 1 + els.length) % els.length : e.key === 'Home' ? 0 : e.key === 'End' ? els.length - 1 : -1
  if (to < 0 || !els.length) return
  e.preventDefault()
  els[to].focus()
}

/**
 * The organization switcher: the org box at the top of the sidebar (also on
 * the suspended and invited gate). Lists your organizations with your role
 * and a suspended or invited marker, the current one checked, and pending
 * invitations in their own group. Switching lands on that organization's Home.
 */
export function OrgSwitcher({ className }: { className?: string }) {
  const { orgs, org, switchOrg } = useSession()
  const nav = useNavigate()
  const { open, setOpen, wrap } = useDropdown()
  const btn = useRef<HTMLButtonElement>(null)
  const list = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const items = Array.from(list.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? [])
    ;(items.find((x) => x.getAttribute('aria-checked') === 'true') ?? items[0])?.focus()
  }, [open])
  const member = orgs.filter((o) => o.status !== 'invited')
  const invites = orgs.filter((o) => o.status === 'invited')
  const here = org?.status
  const pick = (id: string) => {
    setOpen(false)
    btn.current?.focus()
    if (id === org?.id) return
    // Leave the current page first so a record URL can't pull us back.
    nav('/')
    switchOrg(id)
  }
  const item = (o: Org) => {
    const current = o.id === org?.id
    return (
      <button key={o.id} type="button" role="menuitemradio" aria-checked={current} tabIndex={-1} onClick={() => pick(o.id)} className={cx('flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] outline-none focus:bg-line', current ? 'text-zinc-100' : 'text-zinc-300 hover:bg-line')}>
        <span aria-hidden className="w-3 text-2xs text-signal-light">{current ? '✓' : ''}</span>
        <span className="min-w-0 flex-1 truncate">{o.name}</span>
        <span className="text-2xs text-zinc-500">{o.role}</span>
        {o.status !== 'active' && <span className={cx('rounded border px-1 text-2xs', o.status === 'suspended' ? 'border-amber-500/40 text-amber-400' : 'border-sky-500/40 text-sky-400')}>{o.status}</span>}
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
        aria-label={`Organization: ${org?.name}${here && here !== 'active' ? ` (${here})` : ''}. Switch organization`}
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
          <span className="flex size-5 items-center justify-center rounded-[5px] border border-chip bg-line text-2xs font-semibold text-zinc-400">{org?.name.charAt(0)}</span>
          <span className="truncate text-[13px] font-medium text-zinc-200">{org?.name}</span>
          {here && here !== 'active' && <span className="text-2xs text-amber-400">{here}</span>}
        </span>
        <span aria-hidden className="text-[9px] text-zinc-600">
          {open ? '▴' : '▾'}
        </span>
      </button>
      {open && (
        <div
          ref={list}
          role="menu"
          aria-label="Switch organization"
          onKeyDown={(e) => {
            if (e.key === 'Tab') setOpen(false)
            menuKeys(list.current, '[role="menuitemradio"]', e)
          }}
          className="absolute top-full right-0 left-0 z-40 mt-1 rounded-lg border border-edge bg-panel p-1 shadow-xl"
        >
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

/**
 * Links to the other VBCDX apps (SUITE_APPS), above the user menu. They
 * share one SSO sign-in, so the other app opens signed in. Hidden when
 * there is no other app to go to.
 */
function SuiteSwitcher() {
  const { suite } = useSession()
  if (!suite.some((a) => !a.current)) return null
  return (
    <nav aria-label="VBCDX apps" className="border-t border-line px-2 pt-2 pb-1">
      <div className="px-2 pb-1 text-[10px] font-semibold tracking-[0.08em] text-[#5b5b64] uppercase">VBCDX apps</div>
      <ul className="flex flex-wrap gap-1 px-1">
        {suite.map((a) => (
          <li key={a.url}>
            {a.current ? (
              <span aria-current="page" className="block rounded-md bg-line px-2 py-1 text-xs font-semibold text-zinc-100">
                {a.name}
              </span>
            ) : (
              <a href={a.url} className="block rounded-md px-2 py-1 text-xs text-zinc-400 hover:bg-white/[0.02] hover:text-zinc-200">
                {a.name}
              </a>
            )}
          </li>
        ))}
      </ul>
    </nav>
  )
}

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('') || '?'

/** Who is signed in, at the bottom of the sidebar, with My Settings and Sign out. */
function UserMenu() {
  const { me, signOut } = useSession()
  const { open, setOpen, wrap } = useDropdown()
  const list = useRef<HTMLDivElement>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (open) list.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
  }, [open])
  const name = me.user.name || me.user.email
  async function out() {
    setBusy(true)
    setError(null)
    try {
      await signOut()
    } catch {
      setError('Sign-out failed. Please try again.')
      setBusy(false)
    }
  }
  const itemClass = 'block w-full rounded-md px-2 py-1.5 text-left text-[13px] text-zinc-300 outline-none hover:bg-line hover:text-zinc-100 focus:bg-line disabled:opacity-40'
  return (
    <div ref={wrap} className="relative border-t border-line p-2">
      {error && (
        <p role="alert" className="px-2 pb-1.5 text-xs text-red-400">
          {error}
        </p>
      )}
      <button type="button" aria-haspopup="menu" aria-expanded={open} aria-label={`Signed in as ${name}. Account menu`} onClick={() => setOpen(!open)} className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left hover:bg-white/[0.02]">
        <span aria-hidden className="flex size-[26px] shrink-0 items-center justify-center rounded-full bg-avatar text-2xs font-semibold text-zinc-200">
          {initials(name)}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] text-zinc-200">{name}</span>
          {me.user.name && <span className="block truncate text-2xs text-zinc-500">{me.user.email}</span>}
        </span>
        <span aria-hidden className="text-[9px] text-zinc-600">
          {open ? '▾' : '▴'}
        </span>
      </button>
      {open && (
        <div ref={list} role="menu" aria-label="Account" onKeyDown={(e) => menuKeys(list.current, '[role="menuitem"]', e)} className="absolute right-2 bottom-full left-2 z-40 mb-1 rounded-lg border border-edge bg-panel p-1 shadow-xl">
          <Link role="menuitem" to="/settings/me" onClick={() => setOpen(false)} className={cx(itemClass, 'hover:!text-zinc-100')}>
            My Settings
          </Link>
          <button type="button" role="menuitem" disabled={busy} onClick={out} className={itemClass}>
            {busy ? 'Signing out…' : 'Sign out'}
          </button>
        </div>
      )}
    </div>
  )
}

/** Full-screen gate for an organization you can't use: suspended, invited, or none at all. */
function OrgGate() {
  const { me, orgs, org, signOut } = useSession()
  const status = org?.status
  const others = orgs.filter((x) => x.id !== org?.id)
  const name = me.user.name || me.user.email
  return (
    <Card width={460}>
      <div role="alert">
        <div className="flex items-center gap-2.5">
          <DispatchMark size={20} />
          <div className="text-[15px] font-semibold">
            {!org ? 'You’re not in an organization yet' : status === 'invited' ? `You’ve been invited to ${org.name}` : `You’re suspended in ${org.name}`}
          </div>
        </div>
        <div className="mt-2 text-sm2 leading-relaxed text-zinc-400">
          {!org
            ? `${name}, ask an admin of your organization to add you.`
            : status === 'invited'
              ? `${name}, you’ve been invited as ${org.role}. You get access to ${org.name} once you accept.`
              : `An admin of ${org.name} suspended your access. You can’t open anything in this organization until they resume you. Your other organizations aren’t affected.`}
        </div>
      </div>
      {status === 'invited' && (
        <div className="mt-4">
          <SoonButton variant="primary">Accept invitation</SoonButton>
        </div>
      )}
      {others.length > 0 && (
        <div className="mt-5 border-t border-line pt-4">
          <div className="eyebrow-sm mb-2">Switch organization</div>
          <OrgSwitcher />
        </div>
      )}
      <button type="button" onClick={() => signOut().catch(() => undefined)} className="mt-5 text-xs text-zinc-500 hover:text-zinc-300">
        Sign out
      </button>
    </Card>
  )
}
