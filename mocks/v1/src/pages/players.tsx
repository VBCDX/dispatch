import { useEffect, useState, type ReactNode } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { evaluate } from '../lib/access'
import { ago, maskAgentToken } from '../lib/format'
import { actions, agentById, canManageHuman, isActive, statusIn, emailTaken, explicitHumanAdmins, humanFootprint, isLastOwner, isOnline, isOrgAdmin, labelTaken, myOrgRole, org, orgAdmins, principalName, orgAgents, orgEvents, orgHumans, receiptState, useDB, useNow, wsById } from '../lib/store'
import type { Agent, AgentFilters, Harness, Human, OrgRole, Workspace } from '../lib/types'
import { CopyChip } from '../components/credential'
import { showSecret } from '../lib/secrets'
import { accessImpactRows, AgentGlyph, AuditLog, ImpactDialog, ListBody, NoAccess, PrincipalChip, useRecordOrg } from '../components/shared'
import { Breadcrumb, Button, Card, Field, Footer, Input, Menu, Modal, PageTitle, Pill, Row, Segmented, StatusInline, Table, Textarea, Toggle, cx } from '../components/ui'

/* ------------------------------------------------------------------ */
/* Agents                                                              */
/* ------------------------------------------------------------------ */
const A_COLS = '1.3fr 1fr 0.9fr 1.3fr 0.9fr 1.5fr 1fr'

export function AgentStatus({ a }: { a: Agent }) {
  const now = useNow()
  if (a.status === 'revoked') return <StatusInline tone="gray">Revoked</StatusInline>
  if (a.status === 'suspended') return <StatusInline tone="amber">Suspended</StatusInline>
  if (isOnline(a)) return <StatusInline tone="green">Online</StatusInline>
  return <StatusInline tone="gray">{a.lastSeen ? `Offline · ${ago(a.lastSeen, now).toLowerCase()}` : 'Never connected'}</StatusInline>
}

export function AgentsPage() {
  const d = useDB()
  const nav = useNavigate()
  const [params, setParams] = useSearchParams()
  const [creating, setCreating] = useState(params.get('new') === '1')
  useEffect(() => {
    if (params.get('new')) setParams({}, { replace: true })
  }, []) // eslint-disable-line
  const list = orgAgents(d)
  return (
    <div>
      <PageTitle actions={isOrgAdmin(d) && <Button variant="primary" onClick={() => setCreating(true)}>Register agent</Button>}>Agents</PageTitle>
      <div className="mt-1 max-w-[760px] text-sm2 text-zinc-500">Agents from any harness — Claude Code, Codex, OpenCode, or anything that speaks REST or MCP. Each has a public agent ID and a secret agent token. Membership in a workspace adds a second, per-workspace token.</div>
      <Table cols={A_COLS} head={['Agent', 'Agent ID', 'Harness', 'Status', 'Token', 'Workspaces', 'Own filters']} className="mt-5 max-w-[1160px]">
        <ListBody cols={A_COLS} what="agents" empty={list.length ? undefined : <div className="p-10 text-center text-[13px] text-zinc-400">No agents yet. Register one to give it an ID and token it can connect with.</div>}>
          {list.map((a) => {
            const ws = d.workspaces.filter((w) => w.orgId === a.orgId && w.members.some((m) => m.kind === 'agent' && m.id === a.id))
            const f = a.filters
            const narrowed = [!f.read && 'no read', !f.write && 'no write', f.workspaceBlocklist.length && `${f.workspaceBlocklist.length} ws blocked`, f.agentBlocklist.length && `${f.agentBlocklist.length} authors blocked`].filter(Boolean)
            return (
              <Row key={a.id} cols={A_COLS} onClick={() => nav(`/agents/${a.id}`)} className={cx(a.status === 'revoked' && 'text-zinc-500')}>
                <div className="min-w-0">
                  <PrincipalChip p={{ kind: 'agent', id: a.id }} />
                </div>
                <div>
                  <CopyChip value={a.id} variant="inline" />
                </div>
                <div className="text-zinc-400">{a.harness}</div>
                <div>
                  <AgentStatus a={a} />
                </div>
                <div className="masked-token text-xs text-zinc-500">••••{a.tokenLast4}</div>
                <div className="min-w-0 truncate text-zinc-400">
                  {ws.map((w) => {
                    const ok = evaluate(d, a.id, w.id, 'read').allowed
                    return (
                      <span key={w.id} className={cx('mr-2', !ok && 'text-red-400 line-through')} title={ok ? '' : evaluate(d, a.id, w.id, 'read').reason ?? ''}>
                        {w.name}
                      </span>
                    )
                  })}
                  {!ws.length && '—'}
                </div>
                <div className={cx('text-xs', narrowed.length ? 'text-amber-400' : 'text-zinc-500')}>{narrowed.join(' · ') || 'None'}</div>
              </Row>
            )
          })}
        </ListBody>
      </Table>
      <NewAgentModal open={creating} onClose={() => setCreating(false)} />
    </div>
  )
}

function NewAgentModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const d = useDB()
  const nav = useNavigate()
  const [label, setLabel] = useState('')
  const [harness, setHarness] = useState<Harness>('Claude Code')
  const [desc, setDesc] = useState('')
  useEffect(() => {
    if (open) {
      const n = orgAgents(d).length
      setLabel(n === 0 ? 'planner' : n === 1 ? 'builder' : '')
      setHarness(n === 1 ? 'Codex' : 'Claude Code')
      setDesc('')
    }
  }, [open]) // eslint-disable-line
  const clash = labelTaken(d, label)
  const register = () => {
    const made = actions.createAgent({ label: label.trim(), harness, description: desc })
    onClose()
    nav(`/agents/${made.id}`)
    showSecret({
      kind: 'token',
      title: 'Agent registered',
      token: made.token,
      subtitle: (
        <span>
          <span className="font-mono">{label.trim()}</span> · {harness} · agent ID <span className="font-mono text-zinc-200">{made.id}</span>
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
      <Field label="Harness" hint="Informational — membership never depends on the harness.">
        <Segmented
          label="Harness"
          value={harness}
          onChange={setHarness}
          options={(['Claude Code', 'Codex', 'OpenCode', 'Other'] as Harness[]).map((h) => ({ value: h, label: h }))}
        />
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

export function showAgentToken(a: Agent, token: string) {
  showSecret({ kind: 'token', title: 'Agent token rotated', token, subtitle: `${a.label} · ${a.id}`, note: 'The old token keeps working for 10 minutes so a running agent can switch over. Workspace tokens are unchanged.' })
}

export function AgentDetail() {
  const d = useDB()
  const now = useNow()
  const { agentId } = useParams()
  const a = agentById(d, agentId)
  const [revoking, setRevoking] = useState(false)
  const [suspending, setSuspending] = useState(false)
  const [rotating, setRotating] = useState(false)
  const [savingFilters, setSavingFilters] = useState(false)
  const access = useRecordOrg(a?.orgId)
  const [f, setF] = useState<AgentFilters | null>(a?.filters ?? null)
  useEffect(() => setF(a?.filters ?? null), [a?.id]) // eslint-disable-line
  if (access === 'switching') return null
  if (!a || !f || access === 'denied') return <NoAccess what="agent" back={{ to: '/agents', label: 'Back to agents' }} />
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
      <Breadcrumb items={[{ label: 'Agents', to: '/agents' }, { label: a.label }]} />
      <PageTitle
        sub={<AgentStatus a={a} />}
        actions={
          admin &&
          a.status !== 'revoked' && (
            <>
              {a.status === 'active' && <Button onClick={() => actions.connectAgent(a.id, !a.connected)}>{a.connected ? 'Simulate disconnect' : 'Simulate connect'}</Button>}
              <Button onClick={() => setRotating(true)}>Rotate token</Button>
              <Button onClick={() => (a.status === 'suspended' ? actions.setAgentStatus(a.id, 'active') : setSuspending(true))}>{a.status === 'suspended' ? 'Resume' : 'Suspend'}</Button>
              <Button variant="danger" onClick={() => setRevoking(true)}>
                Revoke
              </Button>
            </>
          )
        }
      >
        <span className="flex items-center gap-3">
          <AgentGlyph harness={a.harness} size={28} dim={a.status !== 'active'} />
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
          <span className="text-zinc-500">Harness</span>
          <span>{a.harness}</span>
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
              <Toggle on={f.read} disabled={!admin} label="Read" onChange={(v) => setF({ ...f, read: v })} /> Read
            </span>
            <span className="flex items-center gap-2 text-[13px]">
              <Toggle on={f.write} disabled={!admin} label="Write" onChange={(v) => setF({ ...f, write: v })} /> Write
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
                <Pill tone={m.role === 'admin' ? 'green' : 'neutral'}>{m.role}</Pill>
              </div>
              <div className={r.allowed ? 'text-green-400' : 'text-red-400'}>{r.allowed ? 'Allowed' : 'Refused'}</div>
              <div className={wr.allowed ? 'text-green-400' : 'text-zinc-500'}>{wr.allowed ? 'Allowed' : 'Refused'}</div>
              <div className="text-xs text-zinc-400">{r.reason ?? wr.reason ?? 'All rules pass.'}</div>
            </Row>
          )
        })}
        {!memberships.length && <div className="p-6 text-center text-sm2 text-zinc-500">Not in any workspace yet. Add it from a workspace’s Members tab.</div>}
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

      <div className="eyebrow mt-7 mb-3">Activity</div>
      <AuditLog events={orgEvents(d).filter((e) => e.actorId === a.id || e.object.includes(a.label) || e.object.includes(a.id))} />

      <ImpactDialog
        open={rotating}
        onClose={() => setRotating(false)}
        title={`Rotate ${a.label}’s agent token?`}
        rows={[
          ['Current token', `${maskAgentToken(a.tokenLast4)} — keeps working for 10 minutes`, 'amber'],
          ['Workspace tokens', 'Unchanged'],
          ['Connected now', isOnline(a) ? 'Yes — update its config within 10 minutes' : 'No'],
        ]}
        body="The new token is shown once."
        confirmLabel="Rotate token"
        onConfirm={() => {
          const t = actions.rotateAgentToken(a.id)
          if (t) showAgentToken(a, t)
        }}
      />
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
      <ImpactDialog
        open={suspending}
        onClose={() => setSuspending(false)}
        title={`Suspend ${a.label}?`}
        rows={[
          ['Connected now', isOnline(a) ? 'Yes — disconnected now' : 'No', isOnline(a) ? 'amber' : undefined],
          ['Workspaces', memberships.map((w) => w.name).join(', ') || 'None'],
          ['Admin in', memberships.filter((w) => w.members.some((m) => m.id === a.id && m.role === 'admin')).map((w) => w.name).join(', ') || 'None', memberships.some((w) => w.members.some((m) => m.id === a.id && m.role === 'admin')) ? 'amber' : undefined],
          ...accessImpactRows(d, a.id, undefined, false),
        ]}
        body="Reversible: its tokens stay valid but every request is refused until you resume it. Queued messages are held, not dropped — resuming delivers them (re-checked at delivery). Nothing it already recorded changes."
        confirmLabel="Suspend agent"
        onConfirm={() => actions.setAgentStatus(a.id, 'suspended')}
      />
      <ImpactDialog
        open={revoking}
        onClose={() => setRevoking(false)}
        title={`Revoke ${a.label}?`}
        rows={[
          ['Last seen', ago(a.lastSeen, now), a.lastSeen && now - a.lastSeen < 3_600_000 ? 'amber' : undefined],
          ['Workspaces', memberships.map((w) => w.name).join(', ') || 'None'],
          ['Admin in', memberships.filter((w) => w.members.some((m) => m.id === a.id && m.role === 'admin')).map((w) => w.name).join(', ') || 'None'],
          ...accessImpactRows(d, a.id, undefined, true),
        ]}
        body="Its agent token and every workspace token stop working now. Its next request is refused and logged. What it already received, read or acknowledged stays as recorded. This can’t be undone."
        confirmLabel="Revoke agent"
        onConfirm={() => actions.setAgentStatus(a.id, 'revoked')}
      />
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
/* People                                                              */
/* ------------------------------------------------------------------ */
const P_COLS = '1.4fr 1.6fr 0.9fr 0.9fr 2fr 1fr 36px'
type PersonAction = { kind: 'remove' | 'suspend' | 'transfer' | 'role'; h: Human; role?: 'userAdmin' | 'user' }
export function PeoplePage() {
  const d = useDB()
  const now = useNow()
  const [inviting, setInviting] = useState(false)
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<OrgRole>('user')
  const [acting, setActing] = useState<PersonAction | null>(null)
  const list = orgHumans(d)
  const iAmOwner = isOrgAdmin(d) && myOrgRole(d) === 'Owner'
  // Last active *in this organization*, from its own audit log. Activity elsewhere is never shown here.
  const lastActiveHere = new Map<string, number>()
  for (const e of orgEvents(d)) if (e.actorKind === 'human' && e.actorId && !lastActiveHere.has(e.actorId)) lastActiveHere.set(e.actorId, e.at)
  return (
    <div>
      <PageTitle actions={isOrgAdmin(d) && <Button variant="primary" onClick={() => setInviting(true)}>Invite person</Button>}>People</PageTitle>
      <div className="mt-1 max-w-[760px] text-sm2 text-zinc-500">Humans sign in to the web app with SSO. Like agents, they see a workspace only once an admin adds them — and inside it they can read, search and post to every message.</div>
      <Table cols={P_COLS} head={['Name', 'Email', 'Org role', 'Status', 'Workspaces', 'Last active', '']} className="mt-5 max-w-[1120px]">
        <ListBody cols={P_COLS} what="people">
          {list.map((h) => {
            // This organization's workspaces only — a person's memberships elsewhere are not shown here.
            const ws = d.workspaces.filter((w) => w.orgId === d.currentOrgId && w.members.some((m) => m.kind === 'human' && m.id === h.id))
            return (
              <Row key={h.id} cols={P_COLS}>
                <PrincipalChip p={{ kind: 'human', id: h.id }} />
                <div className="text-zinc-400">{h.email}</div>
                <div className="text-zinc-400">
                  {h.roles[d.currentOrgId]}
                  {isLastOwner(d, h) && <div className="text-2xs text-zinc-600">last active Owner</div>}
                </div>
                <div>{statusIn(h, d.currentOrgId) === 'active' ? <StatusInline tone="green">Active</StatusInline> : statusIn(h, d.currentOrgId) === 'invited' ? <StatusInline tone="gray">Invited</StatusInline> : <StatusInline tone="amber">Suspended</StatusInline>}</div>
                <div className="text-xs text-zinc-400">
                  {ws.map((w) => {
                    const m = w.members.find((x) => x.kind === 'human' && x.id === h.id)!
                    return (
                      <span key={w.id} className="mr-2">
                        {w.name}
                        {m.role === 'admin' && <span className="text-green-400"> (admin)</span>}
                      </span>
                    )
                  })}
                  {!ws.length && '—'}
                </div>
                <div className="text-zinc-500">{h.id === d.currentUserId ? 'Now' : lastActiveHere.has(h.id) ? ago(lastActiveHere.get(h.id)!, now) : '—'}</div>
                <div className="text-right">
                  {isOrgAdmin(d) && h.id !== d.currentUserId && (
                    <Menu
                      label={`Actions for ${h.name}`}
                      items={[
                        h.roles[d.currentOrgId] === 'Owner'
                          ? null
                          : h.roles[d.currentOrgId] === 'user'
                            ? { label: 'Make userAdmin', onClick: () => setActing({ kind: 'role', h, role: 'userAdmin' }) }
                            : { label: 'Make user', onClick: () => setActing({ kind: 'role', h, role: 'user' }) },
                        iAmOwner && h.roles[d.currentOrgId] !== 'Owner' ? { label: 'Transfer ownership…', disabled: !isActive(h, d.currentOrgId), hint: !isActive(h, d.currentOrgId) ? 'Only to an active person' : undefined, onClick: () => setActing({ kind: 'transfer', h }) } : null,
                        statusIn(h, d.currentOrgId) === 'suspended'
                          ? { label: 'Resume', disabled: !canManageHuman(d, h), onClick: () => actions.setHumanStatus(h.id, 'active') }
                          : { label: 'Suspend…', disabled: !canManageHuman(d, h) || isLastOwner(d, h), hint: isLastOwner(d, h) ? 'The last active Owner — transfer ownership first' : !canManageHuman(d, h) ? 'Only an Owner can act on an Owner' : undefined, onClick: () => setActing({ kind: 'suspend', h }) },
                        { label: 'Remove from organization…', danger: true, disabled: !canManageHuman(d, h) || isLastOwner(d, h), hint: isLastOwner(d, h) ? 'The last active Owner — transfer ownership first' : !canManageHuman(d, h) ? 'Only an Owner can act on an Owner' : undefined, onClick: () => setActing({ kind: 'remove', h }) },
                      ]}
                    />
                  )}
                </div>
              </Row>
            )
          })}
        </ListBody>
      </Table>
      <Modal open={inviting} onClose={() => setInviting(false)} width={440} title="Invite person">
        <Field label="Email" error={emailTaken(d, email) ? `${email.trim()} is already in ${d.orgs.find((o) => o.id === d.currentOrgId)?.name}.` : null}>
          <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
        </Field>
        <Field label="Org role" hint="Owners and userAdmins administer every workspace. Users see only the workspaces they’ve been added to. Owner is given by transferring ownership.">
          <Segmented
            label="Org role"
            value={role}
            onChange={setRole}
            options={[
              { value: 'user', label: 'user' },
              { value: 'userAdmin', label: 'userAdmin' },
            ]}
          />
        </Field>
        <Footer>
          <Button size="lg" onClick={() => setInviting(false)}>
            Cancel
          </Button>
          <Button
            size="lg"
            variant="primary"
            disabled={!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || emailTaken(d, email)}
            onClick={() => {
              actions.inviteHuman(email, role)
              setInviting(false)
              setEmail('')
            }}
          >
            Send invite
          </Button>
        </Footer>
      </Modal>
      <PersonConfirm acting={acting} onClose={() => setActing(null)} />
    </div>
  )
}


/** Impact previews for People: role changes, transfer, suspend, remove. Nothing a person did is undone (rule 4). */
function PersonConfirm({ acting, onClose }: { acting: PersonAction | null; onClose: () => void }) {
  const d = useDB()
  const h = acting?.h
  if (!acting || !h) return <ImpactDialog open={false} onClose={onClose} title="" rows={[]} confirmLabel="" onConfirm={() => {}} />
  const f = humanFootprint(d, h)
  const others = orgAdmins(d).filter((x) => x.id !== h.id)
  const fallback = (ws: Workspace[]) =>
    ws.length ? `${ws.map((w) => w.name).join(', ')} — ${others.map((x) => x.name).join(' and ')} (org admins) become ${ws.length === 1 ? 'its' : 'their'} default admins` : 'None'
  const standing: [string, ReactNode, ('amber' | 'red')?][] = [
    ['Agents they registered', f.agents.length ? `${f.agents.map((a) => a.label).join(', ')} — unaffected; agents belong to the organization` : 'None'],
    ['Admin rights they delegated', f.delegations.length ? `${f.delegations.map(({ w, m }) => `${principalName(d, m)} on ${w.name}`).join(', ')} — stand` : 'None'],
    ['Members they added', f.added.length ? `${f.added.length} — stay` : 'None'],
    ['Messages they sent', `${f.messages} — stay, under their name`],
  ]
  const spec =
    acting.kind === 'role'
      ? {
          title: `Make ${h.name} a ${acting.role}?`,
          rows: [
            ['Org role', `${h.roles[d.currentOrgId]} → ${acting.role}`, 'amber'],
            ['Workspaces', acting.role === 'userAdmin' ? 'Administers every workspace in the organization' : `Sees only ${f.memberships.map((w) => w.name).join(', ') || 'no workspaces'} (where they’ve been added)`],
            ...(acting.role === 'user'
              ? ([['Default admin of', ((ws) => (ws.length ? `${ws.map((w) => w.name).join(', ')} — no longer; ${others.map((x) => x.name).join(' and ')} remain default admins` : 'None'))(d.workspaces.filter((w) => w.orgId === d.currentOrgId && !explicitHumanAdmins(d, w).length))]] as [string, ReactNode][])
              : []),
            ...standing.slice(0, 2),
          ] as [string, ReactNode, ('amber' | 'red')?][],
          body: 'Permission is checked when an action happens; what they already did stays in place.',
          confirm: acting.role === 'userAdmin' ? 'Make userAdmin' : 'Make user',
          tone: acting.role === 'userAdmin' ? ('primary' as const) : ('danger' as const),
          run: () => actions.setOrgRole(h.id, acting.role!),
        }
      : acting.kind === 'transfer'
        ? {
            title: `Transfer ownership of ${org(d)?.name} to ${h.name}?`,
            rows: [
              [h.name, `${h.roles[d.currentOrgId]} → Owner`, 'amber'],
              ['You', 'Owner → userAdmin — you keep administering every workspace'],
            ] as [string, ReactNode, ('amber' | 'red')?][],
            body: 'Only an Owner can act on Owners. After this, the last-Owner protection applies to them.',
            confirm: 'Transfer ownership',
            tone: 'danger' as const,
            run: () => actions.transferOwnership(h.id),
          }
        : {
            title: acting.kind === 'suspend' ? `Suspend ${h.name}?` : `Remove ${h.name} from ${org(d)?.name}?`,
            rows: [
              ['Org role', `${h.roles[d.currentOrgId]}${acting.kind === 'remove' ? ' → none' : ''}`, 'amber'],
              [acting.kind === 'remove' ? 'Their memberships' : 'Workspaces', f.memberships.map((w) => w.name).join(', ') || 'None', acting.kind === 'remove' && f.memberships.length ? 'amber' : undefined],
              ['Only active explicit human admin in', fallback(f.lastExplicitAdminIn)],
              ...standing,
            ] as [string, ReactNode, ('amber' | 'red')?][],
            body:
              acting.kind === 'suspend'
                ? `Blocks them from ${org(d)?.name} entirely until resumed — they can’t open anything here (their other organizations aren’t affected). Resume restores the status they had before. Losing permission doesn’t undo what was already done, and the audit log keeps their name on all of it.`
                : 'Losing permission doesn’t undo what was already done. Agents they registered keep working, admin rights they delegated stand, and the audit log keeps their name on all of it.',
            confirm: acting.kind === 'suspend' ? 'Suspend' : 'Remove from organization',
            tone: 'danger' as const,
            run: () => (acting.kind === 'suspend' ? actions.setHumanStatus(h.id, 'suspended') : actions.removeHuman(h.id)),
          }
  return <ImpactDialog open onClose={onClose} title={spec.title} rows={spec.rows} body={spec.body} confirmLabel={spec.confirm} confirmVariant={spec.tone} onConfirm={spec.run} />
}
