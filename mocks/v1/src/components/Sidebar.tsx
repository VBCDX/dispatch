import { Link, NavLink } from 'react-router-dom'
import { isOnline, myWorkspaces, org, orgAgents, useDB } from '../lib/store'
import { DispatchMark } from './credential'
import { cx } from './ui'

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
      <div className="mx-3 my-2.5 flex items-center justify-between rounded-lg border border-edge bg-panel px-3 py-[9px]">
        <span className="flex min-w-0 items-center gap-2">
          <span className="flex size-5 items-center justify-center rounded-[5px] border border-chip bg-line text-2xs font-semibold text-zinc-400">{org(d)?.name.charAt(0)}</span>
          <span className="truncate text-[13px] font-medium text-zinc-200">{org(d)?.name}</span>
        </span>
        <span className="flex items-center gap-1.5 text-2xs text-zinc-500" title="Agents connected right now">
          <span className={cx('size-1.5 rounded-full', online ? 'bg-green-500' : 'bg-zinc-600')} />
          {online}
        </span>
      </div>
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
