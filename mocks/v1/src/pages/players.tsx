import { useEffect, useState, type ReactNode } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { evaluate } from '../lib/access'
import { ago, maskAgentToken } from '../lib/format'
import { actions, agentById, clientLabel, coupleReadWrite, humanById, isOrgAdmin, labelTaken, membershipsOf, org, orgAgents, ORG_ADMIN_ROLES, receiptState, useDB, useNow, visibleEvents, workspaceRole, wsById } from '../lib/store'
import type { AgentFilters } from '../lib/types'
import { AgentsGrid, AgentStatus, InviteUserModal, PersonStatus, UsersGrid } from './grids'
import { useAgentActions, useUserActions } from './playerActions'
import { CopyChip } from '../components/credential'
import { showSecret } from '../lib/secrets'
import { accessImpactRows, AgentGlyph, AuditLog, ImpactDialog, NoAccess, useRecordOrg } from '../components/shared'
import { Breadcrumb, Button, Card, Field, Footer, Input, Menu, Modal, PageTitle, Pill, Row, Table, Textarea, Toggle, cx } from '../components/ui'

/* ------------------------------------------------------------------ */
/* Agents                                                              */
/* ------------------------------------------------------------------ */
export function AgentsPage() {
  const d = useDB()
  const [params, setParams] = useSearchParams()
  const [creating, setCreating] = useState(params.get('new') === '1')
  useEffect(() => {
    if (params.get('new')) setParams({}, { replace: true })
  }, []) // eslint-disable-line
  return (
    <div>
      <PageTitle actions={isOrgAdmin(d) && <Button variant="primary" onClick={() => setCreating(true)}>Register agent</Button>}>Agents</PageTitle>
      <div className="mt-1 max-w-[760px] text-sm2 text-zinc-500">One agent record across the suite. In Dispatch each has a public agent ID and a secret agent token (dsp_agent_…); membership in a workspace adds a second, per-workspace token. Agents run on any client — Claude Code, Codex, OpenCode, or anything that speaks REST or MCP.</div>
      <AgentsGrid className="mt-5" />
      <NewAgentModal open={creating} onClose={() => setCreating(false)} />
    </div>
  )
}

function NewAgentModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const d = useDB()
  const nav = useNavigate()
  const [label, setLabel] = useState('')
  const [desc, setDesc] = useState('')
  useEffect(() => {
    if (open) {
      const n = orgAgents(d).length
      setLabel(n === 0 ? 'planner' : n === 1 ? 'builder' : '')
      setDesc('')
    }
  }, [open]) // eslint-disable-line
  const clash = labelTaken(d, label)
  const register = () => {
    const made = actions.createAgent({ label: label.trim(), description: desc })
    onClose()
    nav(`/players/agents/${made.id}`)
    showSecret({
      kind: 'token',
      title: 'Agent registered',
      token: made.token,
      subtitle: (
        <span>
          <span className="font-mono">{label.trim()}</span> · agent ID <span className="font-mono text-zinc-200">{made.id}</span>
        </span>
      ),
      note: 'With the agent ID, this token opens the agent-only flows. Add the agent to a workspace to give it a workspace token too.',
    })
  }
  return (
    <Modal open={open} onClose={onClose} width={480} title="Register agent">
      <Field label="Label" hint="Short and lowercase reads best in logs." error={clash ? 'An agent in this org already uses this label (revoked agents included), so the audit log stays unambiguous.' : null}>
        <Input mono value={label} onChange={(e) => setLabel(e.target.value)} placeholder="planner" autoFocus />
      </Field>
      <Field label="What it does" optional hint="Other agents see this when they list workspace members.">
        <Textarea rows={2} value={desc} onChange={(e) => setDesc(e.target.value)} />
      </Field>
      <Footer>
        <Button size="lg" onClick={onClose}>
          Cancel
        </Button>
        <Button size="lg" variant="primary" disabled={!label.trim() || clash} onClick={register}>
          Register agent
        </Button>
      </Footer>
    </Modal>
  )
}

export function AgentDetail() {
  const d = useDB()
  const now = useNow()
  const { agentId } = useParams()
  const a = agentById(d, agentId)
  const [savingFilters, setSavingFilters] = useState(false)
  const { menuFor, dialogs, simulate } = useAgentActions()
  const access = useRecordOrg(a?.orgId)
  const [f, setF] = useState<AgentFilters | null>(a?.filters ?? null)
  useEffect(() => setF(a?.filters ?? null), [a?.id]) // eslint-disable-line
  if (access === 'switching') return null
  if (!a || !f || access === 'denied') return <NoAccess what="agent" back={{ to: '/players/agents', label: 'Back to agents' }} />
  const admin = isOrgAdmin(d)
  // Only the agent's own organization, whichever org is on screen.
  const memberships = d.workspaces.filter((w) => w.orgId === a.orgId && w.members.some((m) => m.kind === 'agent' && m.id === a.id))
  const allWs = d.workspaces.filter((w) => w.orgId === a.orgId)
  const inbox = d.messages.filter((m) => m.receipts[a.id] && wsById(d, m.wsId)?.orgId === a.orgId).sort((x, y) => y.createdAt - x.createdAt).slice(0, 12)
  const dirty = JSON.stringify(f) !== JSON.stringify(a.filters)
  const others = orgAgents(d).filter((x) => x.id !== a.id)
  // Saving filters that take access away gets an impact preview first.
  const newWsBlocks = f.workspaceBlocklist.filter((x) => !a.filters.workspaceBlocklist.includes(x))
  const newAuthorBlocks = f.agentBlocklist.filter((x) => !a.filters.agentBlocklist.includes(x))
  const reducing = (a.filters.read && !f.read) || (a.filters.write && !f.write) || newWsBlocks.length > 0 || newAuthorBlocks.length > 0

  return (
    <div className="max-w-[1120px]">
      <Breadcrumb items={[{ label: 'Players' }, { label: 'Agents', to: '/players/agents' }, { label: a.label }]} />
      <PageTitle
        sub={<AgentStatus a={a} />}
        actions={
          <>
            {admin && a.status === 'active' && <Button onClick={() => simulate(a)}>{a.connected ? 'Simulate disconnect' : 'Simulate connect'}</Button>}
            {admin && <Menu label={`Actions for ${a.label}`} items={menuFor(a, { detail: true })} />}
          </>
        }
      >
        <span className="flex items-center gap-3">
          <AgentGlyph client={a.client} size={28} dim={a.status !== 'active'} />
          <span className={cx('font-mono', a.status === 'revoked' && 'text-zinc-500 line-through')}>{a.label}</span>
        </span>
      </PageTitle>
      {a.description && <div className="mt-1 text-sm2 text-zinc-500">{a.description}</div>}

      <div className="mt-5 grid grid-cols-[1fr_1fr] gap-5">
        <Card className="grid grid-cols-[130px_1fr] content-start gap-x-3 gap-y-2.5 p-5 text-[13px]">
          <span className="text-zinc-500">Agent ID</span>
          <span>
            <CopyChip value={a.id} variant="inline" />
          </span>
          <span className="text-zinc-500">Agent token</span>
          <span className="masked-token text-xs text-zinc-400">{maskAgentToken(a.tokenLast4)}</span>
          <span className="text-zinc-500">Client</span>
          <span>
            {clientLabel(a)}
            {a.lastTransport && <span className="ml-2 text-xs text-zinc-500">· last transport {a.lastTransport.via}, {ago(a.lastTransport.at, now).toLowerCase()}</span>}
            <span className="block text-xs text-zinc-500">{a.client ? 'As reported by the agent when it connected. Informational — membership never depends on it.' : 'Reported by the agent when it first connects.'}</span>
          </span>
          <span className="text-zinc-500">Registered</span>
          <span>
            {ago(a.createdAt, now)} · by {a.createdBy} <span className="text-xs text-zinc-500">(audit only — agents belong to the organization)</span>
          </span>
          <span className="text-zinc-500">Last seen</span>
          <span>{a.lastSeen ? ago(a.lastSeen, now) : 'Never connected'}</span>
          <span className="text-zinc-500">Agent-only flows</span>
          <span className="text-xs text-zinc-400">
            With just its ID and token it can read its profile, list its workspaces and change its own filters. <Link to="/developers">API reference</Link>
          </span>
        </Card>

        <Card className="p-5">
          <div className="text-md font-semibold">Its own filters</div>
          <div className="mt-1 text-xs2 leading-relaxed text-zinc-500">An agent can narrow itself — over the API, or an admin can set it here. These beat anything a workspace grants.</div>
          <div className="mt-3 flex gap-6">
            <span className="flex items-center gap-2 text-[13px]">
              <Toggle on={f.read} disabled={!admin} label="Read" onChange={(v) => setF({ ...f, ...coupleReadWrite(f, { read: v }) })} /> Read
            </span>
            <span className="flex items-center gap-2 text-[13px]">
              <Toggle on={f.write} disabled={!admin} label="Write" onChange={(v) => setF({ ...f, ...coupleReadWrite(f, { write: v }) })} /> Write
            </span>
          </div>
          <Field label="Never enter these workspaces">
            <IdChips ids={f.workspaceBlocklist} label={(id) => wsById(d, id)?.name ?? id} options={allWs.map((w) => ({ id: w.id, label: `${w.name} · ${w.id}` }))} onChange={(ids) => setF({ ...f, workspaceBlocklist: ids })} disabled={!admin} what="blocked workspaces" />
          </Field>
          <div className="mt-3" />
          <Field label="Never receive messages from these agents">
            <IdChips ids={f.agentBlocklist} label={(id) => agentById(d, id)?.label ?? id} options={others.map((x) => ({ id: x.id, label: `${x.label} · ${x.id}` }))} onChange={(ids) => setF({ ...f, agentBlocklist: ids })} disabled={!admin} what="blocked authors" />
          </Field>
          {admin && (
            <div className="mt-4 flex gap-2">
              <Button variant="primary" size="sm" disabled={!dirty} onClick={() => (reducing ? setSavingFilters(true) : actions.setAgentFilters(a.id, f))}>
                Save filters
              </Button>
              {dirty && (
                <Button size="sm" onClick={() => setF(a.filters)}>
                  Discard
                </Button>
              )}
            </div>
          )}
        </Card>
      </div>

      <div className="eyebrow mt-7 mb-2.5">Workspaces · effective access</div>
      <Table cols="1.2fr 0.8fr 1fr 1fr 2fr" head={['Workspace', 'Role', 'Read', 'Write', 'Deciding rule']}>
        {memberships.map((w) => {
          const m = w.members.find((x) => x.kind === 'agent' && x.id === a.id)!
          const r = evaluate(d, a.id, w.id, 'read')
          const wr = evaluate(d, a.id, w.id, 'write')
          return (
            <Row key={w.id} cols="1.2fr 0.8fr 1fr 1fr 2fr">
              <Link to={`/workspaces/${w.id}/access`} className="font-medium text-zinc-100 hover:text-white">
                {w.name}
              </Link>
              <div>
                <Pill tone={m.role === 'admin' ? 'green' : 'neutral'}>{m.role === 'admin' ? 'Workspace admin' : 'Member'}</Pill>
              </div>
              <div className={r.allowed ? 'text-green-400' : 'text-red-400'}>{r.allowed ? 'Allowed' : 'Refused'}</div>
              <div className={wr.allowed ? 'text-green-400' : 'text-zinc-500'}>{wr.allowed ? 'Allowed' : 'Refused'}</div>
              <div className="text-xs text-zinc-400">{r.reason ?? wr.reason ?? 'All rules pass.'}</div>
            </Row>
          )
        })}
        {!memberships.length && <div className="p-6 text-center text-sm2 text-zinc-500">Not in any workspace yet. Use Assign workspaces… in the ⋯ menu, or add it from a workspace’s Members tab.</div>}
      </Table>

      <div className="eyebrow mt-7 mb-2.5">Addressed to it · recent</div>
      <Card className="overflow-hidden">
        {inbox.map((m) => {
          const s = receiptState(m.receipts[a.id], m, now)
          return (
            <Link key={m.id} to={`/workspaces/${m.wsId}/messages?m=${m.id}`} className="flex items-center gap-3 border-b border-line px-4 py-2.5 text-sm2 last:border-b-0 hover:bg-white/[0.015]">
              <span className={cx('w-28 shrink-0 text-xs', s === 'acked' ? 'text-green-400' : s === 'read' ? 'text-signal-light' : s === 'filtered' || s === 'expired' ? 'text-zinc-600' : s === 'queued' ? 'text-amber-400' : 'text-zinc-400')}>{s === 'expired' ? 'never delivered' : s}</span>
              <span className="w-28 shrink-0 text-xs text-zinc-500">{wsById(d, m.wsId)?.name}</span>
              <span className="truncate text-zinc-300">{m.body}</span>
              <span className="ml-auto shrink-0 text-xs text-zinc-600">{ago(m.createdAt, now).toLowerCase()}</span>
            </Link>
          )
        })}
        {!inbox.length && <div className="p-6 text-center text-sm2 text-zinc-500">Nothing addressed to it yet.</div>}
      </Card>

      <div className="eyebrow mt-7 mb-1">Activity</div>
      <div className="mb-3 text-xs text-zinc-500">{a.label}’s events in Dispatch, plus shared suite events about it (marked Shared).</div>
      <AuditLog events={visibleEvents(d, { player: { kind: 'agent', id: a.id } })} />

      <ImpactDialog
        open={savingFilters}
        onClose={() => setSavingFilters(false)}
        title={`Narrow ${a.label}’s own filters?`}
        rows={[
          ...(a.filters.read && !f.read ? ([['Read off — everywhere', 'Reversible'], ...accessImpactRows(d, a.id, undefined, false)] as [string, ReactNode, ('amber' | 'red')?][]) : []),
          ...(a.filters.write && !f.write ? ([['Write off — everywhere', 'It can’t send or expire; what it sent stays']] as [string, ReactNode][]) : []),
          ...newWsBlocks.flatMap((id) => [[`Blocks ${wsById(d, id)?.name ?? id}`, 'Final for what’s queued there', 'amber'] as [string, ReactNode, 'amber'], ...accessImpactRows(d, a.id, id, true)]),
          ...(newAuthorBlocks.length ? ([[`Blocks messages from`, newAuthorBlocks.map((x) => agentById(d, x)?.label ?? x).join(', ') + ' — queued ones are filtered; already delivered ones stay']] as [string, ReactNode][]) : []),
        ]}
        body="Blocks are final for what hasn’t been delivered yet; turning reading off only holds it. Nothing already recorded changes."
        confirmLabel="Save filters"
        onConfirm={() => actions.setAgentFilters(a.id, f)}
      />
      {dialogs}
    </div>
  )
}

function IdChips({ ids, label, options, onChange, disabled, what }: { ids: string[]; label: (id: string) => string; options: { id: string; label: string }[]; onChange: (ids: string[]) => void; disabled?: boolean; what: string }) {
  const [pick, setPick] = useState('')
  const left = options.filter((o) => !ids.includes(o.id))
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {ids.map((id) => (
        <span key={id} className="inline-flex items-center gap-1.5 rounded-full border border-red-500/30 bg-red-500/[0.06] px-2 py-0.5 text-xs text-red-300">
          {label(id)}
          {!disabled && (
            <button type="button" aria-label={`Remove ${label(id)} from ${what}`} className="text-zinc-500 hover:text-zinc-200" onClick={() => onChange(ids.filter((x) => x !== id))}>
              ✕
            </button>
          )}
        </span>
      ))}
      {!ids.length && <span className="text-xs text-zinc-600">None</span>}
      {!disabled && left.length > 0 && (
        <span className="inline-flex items-center gap-1">
          <select aria-label={`Choose one to add to ${what}`} value={pick} onChange={(e) => setPick(e.target.value)} className="rounded-md border border-edge bg-page px-2 py-0.5 text-xs text-zinc-400 outline-none">
            <option value="">Choose…</option>
            {left.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={!pick}
            onClick={() => {
              onChange([...ids, pick])
              setPick('')
            }}
            className="rounded-md border border-edge px-2 py-0.5 text-xs text-zinc-300 hover:text-zinc-100 disabled:opacity-40"
          >
            Add
          </button>
        </span>
      )}
    </div>
  )
}


/* ------------------------------------------------------------------ */
/* Users                                                               */
/* ------------------------------------------------------------------ */
export function UsersPage() {
  const d = useDB()
  const [inviting, setInviting] = useState(false)
  return (
    <div>
      <PageTitle actions={isOrgAdmin(d) && <Button variant="primary" onClick={() => setInviting(true)}>Invite user</Button>}>Users</PageTitle>
      <div className="mt-1 max-w-[760px] text-sm2 text-zinc-500">People in {org(d)?.name}, shared across the suite. They sign in with SSO and, like agents, see a workspace only once they’re in it — Owners and userAdmins administer every workspace. Inside a workspace a person reads, searches and posts to every message.</div>
      <UsersGrid className="mt-5" />
      <InviteUserModal open={inviting} onClose={() => setInviting(false)} />
    </div>
  )
}

export function UserDetail() {
  const d = useDB()
  const now = useNow()
  const { userId } = useParams()
  const h = humanById(d, userId)
  const { menuFor, dialogs } = useUserActions()
  // Only people in the organization on screen; their other organizations are never shown here.
  if (!h || !h.roles[d.currentOrgId]) return <NoAccess what="person" back={{ to: '/players/users', label: 'Back to users' }} />
  const mine = membershipsOf(d, { kind: 'human', id: h.id })
  const registered = orgAgents(d).filter((a) => a.createdById === h.id)
  const role = h.roles[d.currentOrgId]
  return (
    <div className="max-w-[1120px]">
      <Breadcrumb items={[{ label: 'Players' }, { label: 'Users', to: '/players/users' }, { label: h.name }]} />
      <PageTitle sub={<PersonStatus h={h} orgId={d.currentOrgId} />} actions={isOrgAdmin(d) && <Menu label={`Actions for ${h.name}`} items={menuFor(h)} />}>
        {h.name}
      </PageTitle>
      <Card className="mt-5 grid max-w-[640px] grid-cols-[150px_1fr] gap-x-3 gap-y-2.5 p-5 text-[13px]">
        <span className="text-zinc-500">User ID</span>
        <span>
          <CopyChip value={h.id} variant="inline" />
        </span>
        <span className="text-zinc-500">Email</span>
        <span>{h.email}</span>
        <span className="text-zinc-500">Org role</span>
        <span>
          {role}
          {ORG_ADMIN_ROLES.includes(role) && <span className="text-xs text-zinc-500"> — administers every workspace in {org(d)?.name}</span>}
        </span>
        <span className="text-zinc-500">Last active</span>
        <span>{h.id === d.currentUserId ? 'Now' : ago(h.lastActive, now)}</span>
        <span className="text-zinc-500">Agents they registered</span>
        <span>{registered.map((a) => a.label).join(', ') || 'None'} {registered.length > 0 && <span className="text-xs text-zinc-500">(audit only — agents belong to the organization)</span>}</span>
      </Card>
      <div className="eyebrow mt-7 mb-2.5">Workspaces</div>
      <Table cols="1.4fr 1fr 1fr" head={['Workspace', 'Role', 'Write']} className="max-w-[760px]">
        {mine.map(({ w, m }) => (
          <Row key={w.id} cols="1.4fr 1fr 1fr">
            <Link to={`/workspaces/${w.id}/members`} className="font-medium text-zinc-100 hover:text-white">
              {w.name}
            </Link>
            <span className={cx(workspaceRole(d, w, { kind: 'human', id: h.id }) === 'Member' ? 'text-zinc-400' : 'text-green-400')}>{workspaceRole(d, w, { kind: 'human', id: h.id })}</span>
            <span className="text-zinc-400">{m.write || ORG_ADMIN_ROLES.includes(role) ? 'Yes' : 'No (read-only)'}</span>
          </Row>
        ))}
        {!mine.length && <div className="p-6 text-center text-sm2 text-zinc-500">{ORG_ADMIN_ROLES.includes(role) ? `Not a member of any workspace — as ${role} they administer all of them anyway.` : 'Not in any workspace yet.'}</div>}
      </Table>
      <div className="eyebrow mt-7 mb-1">Activity</div>
      <div className="mb-3 text-xs text-zinc-500">{h.name}’s events in Dispatch, plus shared suite events about them (marked Shared).</div>
      <AuditLog events={visibleEvents(d, { player: { kind: 'human', id: h.id } })} />
      {dialogs}
    </div>
  )
}
