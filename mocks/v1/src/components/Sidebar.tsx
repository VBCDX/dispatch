import { useState } from 'react'
import { Link, NavLink, useNavigate } from 'react-router-dom'
import { actions, isOnline, me, myWorkspaces, org, orgAgents, statusIn, useDB } from '../lib/store'
import { DispatchMark } from './credential'
import { cx, useLayer } from './ui'

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

export function Sidebar() {
  const d = useDB()
  const ws = myWorkspaces(d)
  const online = orgAgents(d).filter(isOnline).length
  return (
    <aside className="flex h-full w-60 min-w-60 flex-col border-r border-line bg-rail">
      <Link to="/" className="flex items-center gap-2 px-4 pt-4 pb-1.5">
        <DispatchMark />
        <span className="text-sm font-semibold tracking-[-0.01em] text-zinc-100">Dispatch</span>
      </Link>
      <OrgSwitcher online={online} />
      <nav className="flex flex-col gap-px overflow-y-auto px-2 py-1 pb-16">
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
    </aside>
  )
}

/** The current organization, and a switcher when the person belongs to more than one. Suspension is shown per org. */
function OrgSwitcher({ online }: { online: number }) {
  const d = useDB()
  const nav = useNavigate()
  const [open, setOpen] = useState(false)
  useLayer(open, () => setOpen(false))
  const mine = d.orgs.filter((o) => me(d)?.roles[o.id])
  const suspendedHere = statusIn(me(d), d.currentOrgId) === 'suspended'
  const many = mine.length > 1
  return (
    <div className="mx-3 my-2.5">
      <button
        type="button"
        disabled={!many}
        aria-expanded={many ? open : undefined}
        aria-label={many ? `Organization: ${org(d)?.name}${suspendedHere ? ' (suspended)' : ''}. Switch organization` : undefined}
        onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between rounded-lg border border-edge bg-panel px-3 py-[9px] text-left enabled:hover:border-zinc-700 disabled:cursor-default disabled:opacity-100"
      >
        <span className="flex min-w-0 items-center gap-2">
          <span className="flex size-5 items-center justify-center rounded-[5px] border border-chip bg-line text-2xs font-semibold text-zinc-400">{org(d)?.name.charAt(0)}</span>
          <span className="truncate text-[13px] font-medium text-zinc-200">{org(d)?.name}</span>
          {suspendedHere && <span className="text-2xs text-amber-400">suspended</span>}
        </span>
        <span className="flex items-center gap-1.5 text-2xs text-zinc-500" title="Agents connected right now">
          <span className={cx('size-1.5 rounded-full', online ? 'bg-green-500' : 'bg-zinc-600')} />
          {online}
          {many && <span className="text-[9px] text-zinc-600">{open ? '▴' : '▾'}</span>}
        </span>
      </button>
      {open && (
        <div className="mt-1 flex flex-col gap-px rounded-lg border border-edge bg-panel p-1">
          {mine.map((o) => {
            const st = statusIn(me(d), o.id)
            return (
              <button
                key={o.id}
                type="button"
                aria-current={o.id === d.currentOrgId}
                onClick={() => {
                  setOpen(false)
                  if (o.id !== d.currentOrgId) {
                    nav('/')
                    actions.switchOrg(o.id)
                  }
                }}
                className={cx('flex items-center justify-between rounded-md px-2 py-1.5 text-left text-[13px]', o.id === d.currentOrgId ? 'bg-line text-zinc-100' : 'text-zinc-300 hover:bg-line')}
              >
                <span className="truncate">{o.name}</span>
                <span className={cx('text-2xs', st === 'suspended' ? 'text-amber-400' : 'text-zinc-500')}>{st === 'active' ? me(d)?.roles[o.id] : st}</span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
