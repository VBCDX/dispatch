import { useEffect } from 'react'
import { Outlet, useLocation } from 'react-router-dom'
import { actions, agentById, getDB, iAmActive, me, org, statusIn, useDB, wsById } from '../lib/store'
import { DispatchMark } from './credential'
import { OrgSwitcher } from './OrgSwitcher'
import { Sidebar } from './Sidebar'
import { Button } from './ui'

export function AppShell() {
  const d = useDB()
  const { pathname } = useLocation()
  // A record opened by ID resolves its own organization on arrival — even from behind another org's gate — so that
  // org's gate and roles apply to it (pages deny records from orgs you're not in). Only on arrival: once you switch
  // org yourself, the record you're leaving doesn't pull you back.
  useEffect(() => {
    const db = getDB()
    const m = /^\/(workspaces|agents)\/([^/?]+)/.exec(pathname)
    const recordOrg = m ? (m[1] === 'workspaces' ? wsById(db, m[2])?.orgId : agentById(db, m[2])?.orgId) : undefined
    if (recordOrg && recordOrg !== db.currentOrgId && me(db)?.roles[recordOrg]) actions.switchOrg(recordOrg)
  }, [pathname])
  // Only active members get the app. Suspended people and invitees see a full-screen gate instead — no sidebar,
  // no workspace names, nothing from this organization.
  if (!iAmActive(d)) return <OrgGate />
  return (
    <div className="flex h-full bg-page text-zinc-100">
      <Sidebar />
      <main className="min-w-0 flex-1 overflow-y-auto px-10 py-8">
        <Outlet />
      </main>
    </div>
  )
}

function OrgGate() {
  const d = useDB()
  const u = me(d)
  const o = org(d)
  const status = statusIn(u, d.currentOrgId)
  const others = d.orgs.filter((x) => x.id !== d.currentOrgId && u?.roles[x.id])
  return (
    <div className="flex h-full items-center justify-center bg-page p-6 text-zinc-100">
      <div role="alert" className="w-[460px] max-w-full rounded-xl border border-edge bg-panel p-7">
        <div className="flex items-center gap-2.5">
          <DispatchMark size={20} />
          <div className="text-[15px] font-semibold">
            {status === 'invited' ? `You’ve been invited to ${o?.name}` : status === 'suspended' ? `You’re suspended in ${o?.name}` : `You’re not a member of ${o?.name}`}
          </div>
        </div>
        <div className="mt-2 text-sm2 leading-relaxed text-zinc-400">
          {status === 'invited'
            ? `${u?.name}, you’ve been invited as ${u?.roles[d.currentOrgId]}. You get access to ${o?.name} once you accept.`
            : status === 'suspended'
              ? `An admin of ${o?.name} suspended your access. You can’t open anything in this organization until they resume you. Your other organizations aren’t affected.`
              : 'Ask an admin of this organization to add you.'}
        </div>
        {status === 'invited' && (
          <Button variant="primary" className="mt-4" onClick={() => actions.acceptInvite()}>
            Accept invitation
          </Button>
        )}
        {others.length > 0 && (
          <div className="mt-5 border-t border-line pt-4">
            <div className="eyebrow-sm mb-2">Switch organization</div>
            <OrgSwitcher />
          </div>
        )}
      </div>
    </div>
  )
}
