/**
 * Organizations — the suite's shared org pages: a list of your organizations, and for each one the shared tabs
 * Overview, Members (Users), Agents, Workspaces and Audit. Keyhole has the same tabs plus its own Stores and Tools.
 */
import { useState } from 'react'
import { Link, Outlet, useNavigate, useParams } from 'react-router-dom'
import { ago, plural } from '../lib/format'
import { activeOwners, isActive, isOrgAdmin, isOnline, me, myWorkspaces, org, orgAgents, orgHumans, owners, statusIn, useDB, useNow, visibleEvents } from '../lib/store'
import { AuditLog, ListBody, NoAccess } from '../components/shared'
import { Breadcrumb, Button, Callout, Card, PageTitle, Row, Table, Tabs } from '../components/ui'
import { AgentsGrid, InviteUserModal, UsersGrid } from './grids'
import { WorkspacesTable } from './workspaces'

const ORG_COLS = '1.6fr 1fr 1fr 1fr 1fr 1fr'

export function OrgsList() {
  const d = useDB()
  const nav = useNavigate()
  const now = useNow()
  const u = me(d)
  const mine = d.orgs.filter((o) => u?.roles[o.id])
  return (
    <div>
      <PageTitle>Organizations</PageTitle>
      <div className="mt-1 max-w-[760px] text-sm2 text-zinc-500">Organizations you belong to. People, workspaces and agents are shared across the suite; each organization is fully separate from the others.</div>
      <Table cols={ORG_COLS} head={['Name', 'Your role', 'Your status', 'Members', 'Workspaces', 'Created']} className="mt-5 max-w-[1000px]">
        <ListBody cols={ORG_COLS} what="organizations">
          {mine.map((o) => {
            const status = statusIn(u, o.id)
            // Member and workspace counts only for organizations you can actually use.
            const open = status === 'active'
            return (
              <Row
                key={o.id}
                cols={ORG_COLS}
                onClick={() => {
                  nav(`/orgs/${o.id}/overview`)
                }}
              >
                <div>
                  <div className="font-medium">{o.name}</div>
                  <div className="font-mono text-2xs text-zinc-600">{o.id}</div>
                </div>
                <div className="text-zinc-400">{u.roles[o.id]}</div>
                <div className={status === 'active' ? 'text-zinc-400' : 'text-amber-400'}>{status}</div>
                <div className="text-zinc-400">{open ? d.humans.filter((h) => h.roles[o.id]).length : '—'}</div>
                <div className="text-zinc-400">{open ? d.workspaces.filter((w) => w.orgId === o.id).length : '—'}</div>
                <div className="text-zinc-500">{ago(o.createdAt, now)}</div>
              </Row>
            )
          })}
        </ListBody>
      </Table>
    </div>
  )
}

/** One organization. Opening another org's URL switches to it if you belong to it (AppShell); otherwise no access. */
export function OrgDetail() {
  const d = useDB()
  const { orgId } = useParams()
  const o = orgId === d.currentOrgId ? org(d) : undefined
  if (!o) return orgId && me(d)?.roles[orgId] ? null : <NoAccess what="organization" back={{ to: '/orgs', label: 'Back to your organizations' }} />
  const base = `/orgs/${o.id}`
  return (
    <div className="max-w-[1180px]">
      <Breadcrumb items={[{ label: 'Organizations', to: '/orgs' }, { label: o.name }]} />
      <PageTitle>{o.name}</PageTitle>
      <Tabs
        tabs={[
          { to: `${base}/overview`, label: 'Overview' },
          { to: `${base}/members`, label: `Members · ${orgHumans(d).length}` },
          { to: `${base}/agents`, label: `Agents · ${orgAgents(d).length}` },
          { to: `${base}/workspaces`, label: 'Workspaces' },
          { to: `${base}/audit`, label: 'Audit' },
        ]}
      />
      <Outlet />
    </div>
  )
}

export function OrgOverview() {
  const d = useDB()
  const now = useNow()
  const o = org(d)!
  const all = owners(d)
  const counts: [string, string | number, string][] = [
    ['Members', orgHumans(d).length, 'members'],
    ['Agents', `${orgAgents(d).filter(isOnline).length} online / ${orgAgents(d).filter((a) => a.status !== 'revoked').length}`, 'agents'],
    ['Workspaces', myWorkspaces(d).length, 'workspaces'],
    ['Suspended people', orgHumans(d).filter((h) => statusIn(h, o.id) === 'suspended').length, 'members'],
  ]
  return (
    <div className="mt-5 max-w-[960px]">
      <div className="grid grid-cols-4 gap-4">
        {counts.map(([l, n, tab]) => (
          <Link key={l} to={`/orgs/${o.id}/${tab}`} className="rounded-[10px] border border-edge bg-panel p-4 hover:border-zinc-700">
            <div className="text-xs text-zinc-500">{l}</div>
            <div className="mt-1.5 text-[22px] font-semibold text-zinc-100">{n}</div>
          </Link>
        ))}
      </div>
      {!activeOwners(d).length && (
        <Callout tone="amber" className="mt-4">
          No active Owner. Admins can keep running workspaces, but Owner-only actions — managing Owners and transferring ownership — wait until an Owner is active again.
        </Callout>
      )}
      <Card className="mt-4 grid grid-cols-[160px_1fr] gap-x-3 gap-y-2.5 p-5 text-[13px]">
        <span className="text-zinc-500">Organization ID</span>
        <span className="font-mono text-xs2">{o.id}</span>
        <span className="text-zinc-500">{all.length === 1 ? 'Owner' : 'Owners'}</span>
        <span>{all.map((h) => (isActive(h, o.id) ? h.name : `${h.name} (${statusIn(h, o.id)})`)).join(', ') || 'None'}</span>
        <span className="text-zinc-500">Created</span>
        <span>{ago(o.createdAt, now)}</span>
        <span className="text-zinc-500">Your role</span>
        <span>{me(d).roles[o.id]}</span>
        <span className="text-zinc-500">Shared with Keyhole</span>
        <span className="text-zinc-400">People, org roles, workspaces, workspace memberships and agent records. Messages, context, webhooks and Dispatch tokens stay in Dispatch.</span>
      </Card>
      {isOrgAdmin(d) && (
        <div className="mt-4 flex gap-2">
          <Link to="/settings/account">
            <Button>Rename organization</Button>
          </Link>
          <Link to={`/orgs/${o.id}/members`}>
            <Button>Manage members</Button>
          </Link>
        </div>
      )}
    </div>
  )
}

export function OrgMembers() {
  const d = useDB()
  const [inviting, setInviting] = useState(false)
  return (
    <div className="mt-5">
      <div className="flex items-center justify-between gap-4">
        <div className="max-w-[720px] text-sm2 text-zinc-500">The same Users grid as Players › Users.</div>
        {isOrgAdmin(d) && (
          <Button variant="primary" onClick={() => setInviting(true)}>
            Invite user
          </Button>
        )}
      </div>
      <UsersGrid className="mt-4" />
      <InviteUserModal open={inviting} onClose={() => setInviting(false)} />
    </div>
  )
}

export function OrgAgents() {
  return (
    <div className="mt-5">
      <div className="max-w-[720px] text-sm2 text-zinc-500">The same Agents grid as Players › Agents.</div>
      <AgentsGrid className="mt-4" />
    </div>
  )
}

export function OrgWorkspaces() {
  const d = useDB()
  const all = d.workspaces.filter((w) => w.orgId === d.currentOrgId).length
  const mine = myWorkspaces(d).length
  return (
    <div className="mt-5">
      {mine < all && <div className="mb-3 text-sm2 text-zinc-500">You see the {plural(mine, 'workspace')} you belong to.</div>}
      <WorkspacesTable className="max-w-[1080px]" />
    </div>
  )
}

export function OrgAudit() {
  const d = useDB()
  return (
    <div className="mt-5">
      <div className="mb-3 text-sm2 text-zinc-500">{org(d)?.name}’s events in Dispatch, plus shared suite events (marked Shared). {isOrgAdmin(d) ? 'You see the whole organization.' : 'You see your workspaces and your own actions.'}</div>
      <AuditLog events={visibleEvents(d)} />
    </div>
  )
}

