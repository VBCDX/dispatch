/**
 * The suite's shared player grids — Players › Users and Players › Agents — with their ⋯ menus and dialogs
 * (Assign workspaces…, Invite user, Change org role…). Keyhole has the same grids, columns and menu order.
 * Workspace › Members shows the same grids filtered to the workspace, plus a Role column; there, Dispatch adds
 * its own per-membership layer (read/write, the workspace token) and the workspace admin's actions.
 */
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { evaluate } from '../lib/access'
import { ago, clock } from '../lib/format'
import { actions, canAdmin, clientLabel, emailTaken, explicitHumanAdmins, humanById, isActive, isLastOwner, isOnline, isOrgAdmin, membershipsOf, org, orgAdmins, orgAgents, orgHumans, lastActiveIn, ORG_ADMIN_ROLES, statusIn, useDB, useNow, workspaceRole } from '../lib/store'
import type { Agent, Human, MemberRole, OrgRole, Workspace } from '../lib/types'
import { ListBody, PrincipalChip } from '../components/shared'
import { Button, Callout, Checkbox, Field, Footer, Input, Menu, Modal, Row, Segmented, StatusInline, Table, Toggle, cx } from '../components/ui'
import { CopyChip } from '../components/credential'
import { REASONS, useAgentActions, useUserActions } from './playerActions'

/** "Production (admin), Staging, Incidents +2" — more than three collapse to "+N". */
export function WsNames({ items }: { items: { id: string; name: string; admin: boolean; refused?: string | null }[] }) {
  if (!items.length) return <span className="text-zinc-600">—</span>
  const shown = items.slice(0, 3)
  const rest = items.slice(3)
  return (
    <span className="min-w-0">
      {shown.map((x, i) => (
        <span key={x.id} className={cx(x.refused && 'text-red-400 line-through')} title={x.refused ?? undefined}>
          {x.name}
          {x.admin && <span className={cx(!x.refused && 'text-green-400')}> (admin)</span>}
          {i < shown.length - 1 && ', '}
        </span>
      ))}
      {rest.length > 0 && (
        <span className="text-zinc-500" title={rest.map((x) => `${x.name}${x.admin ? ' (admin)' : ''}`).join(', ')}>
          {' '}
          +{rest.length}
        </span>
      )}
    </span>
  )
}

/** Hands a freshly issued workspace token to the root secret host (one after another when several are issued). */
/** The agent's lifecycle — Active, Suspended or Revoked — the suite's shared Status column. */
export function AgentStatus({ a }: { a: Agent }) {
  if (a.status === 'revoked') return <StatusInline tone="gray">Revoked</StatusInline>
  if (a.status === 'suspended') return <StatusInline tone="amber">Suspended</StatusInline>
  return <StatusInline tone="green">Active</StatusInline>
}

/** Presence (Dispatch): "● online now", or when it was last seen. Shown under Last used, never as the Status. */
export function AgentLastUsed({ a }: { a: Agent }) {
  const now = useNow()
  if (isOnline(a)) return <StatusInline tone="green">online now</StatusInline>
  return <span className="text-xs text-zinc-500">{a.lastSeen ? ago(a.lastSeen, now) : 'Never'}</span>
}

export function PersonStatus({ h, orgId }: { h: Human; orgId: string }) {
  const s = statusIn(h, orgId)
  return s === 'active' ? <StatusInline tone="green">Active</StatusInline> : s === 'invited' ? <StatusInline tone="gray">Invited</StatusInline> : <StatusInline tone="amber">Suspended</StatusInline>
}

/* ------------------------------------------------------------------ */
/* Invite user                                                         */
/* ------------------------------------------------------------------ */
export function InviteUserModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  // Mounted only while open, so each invite starts empty.
  return open ? <InviteUser onClose={onClose} /> : null
}
function InviteUser({ onClose }: { onClose: () => void }) {
  const d = useDB()
  const ws = d.workspaces.filter((w) => w.orgId === d.currentOrgId)
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<OrgRole>('user')
  const [sel, setSel] = useState<Record<string, MemberRole>>({})
  const taken = emailTaken(d, email)
  return (
    <Modal open onClose={onClose} width={480} title="Invite user">
      <Field label="Email" error={taken ? `${email.trim()} is already in ${org(d)?.name}.` : null}>
        <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
      </Field>
      <Field label="Org role" hint="Owners and userAdmins administer every workspace. Users see only the workspaces they’re added to. Owner is given by transferring ownership.">
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
      {role === 'user' ? (
        <Field label="Workspaces" optional hint="They join these once they accept the invitation.">
          <div role="group" aria-label="Workspaces for the invitee" className="flex flex-col rounded-lg border border-edge bg-page">
            {ws.map((w) => (
              <div key={w.id} className="flex items-center justify-between gap-3 border-b border-line px-3 py-2 last:border-b-0">
                <Checkbox checked={!!sel[w.id]} onChange={(v) => setSel(v ? { ...sel, [w.id]: 'member' } : Object.fromEntries(Object.entries(sel).filter(([k]) => k !== w.id)))} label={w.name} />
                <select aria-label={`Role in ${w.name}`} disabled={!sel[w.id]} value={sel[w.id] ?? 'member'} onChange={(e) => setSel({ ...sel, [w.id]: e.target.value as MemberRole })} className="rounded-md border border-edge bg-panel px-2 py-1 text-xs text-zinc-300 outline-none focus:border-zinc-500 disabled:opacity-40">
                  <option value="member">Member</option>
                  <option value="admin">Workspace admin</option>
                </select>
              </div>
            ))}
            {!ws.length && <div className="p-3 text-sm2 text-zinc-500">No workspaces yet.</div>}
          </div>
        </Field>
      ) : (
        <div className="text-xs text-zinc-500">A userAdmin administers every workspace in {org(d)?.name}, so there’s nothing to assign.</div>
      )}
      <Footer>
        <Button size="lg" onClick={onClose}>
          Cancel
        </Button>
        <Button
          size="lg"
          variant="primary"
          disabled={!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || taken}
          onClick={() => {
            actions.inviteHuman(email.trim(), role, role === 'user' ? sel : {})
            onClose()
          }}
        >
          Send invite
        </Button>
      </Footer>
    </Modal>
  )
}

/* ------------------------------------------------------------------ */
/* Users grid                                                          */
/* ------------------------------------------------------------------ */
const U_COLS = 'minmax(150px,1.2fr) minmax(160px,1.3fr) 90px 90px 110px minmax(170px,1.6fr) 36px'
const U_COLS_WS = 'minmax(140px,1.1fr) minmax(150px,1.2fr) 84px 84px 100px minmax(130px,1.2fr) 140px 70px 36px'

/**
 * Players › Users — Name, Email, Org role, Status, Last active (this org), Workspaces, ⋯. With `ws`: filtered to the
 * workspace (its human members, plus the org admins who administer it by default) with a Role column and Dispatch's
 * per-membership Write toggle.
 */
export function UsersGrid({ ws, className }: { ws?: Workspace; className?: string }) {
  const d = useDB()
  const nav = useNavigate()
  const now = useNow()
  const { menuFor, dialogs, setPending } = useUserActions(ws)
  const all = orgHumans(d)
  // In a workspace: its human members plus every active org admin (they administer every workspace).
  const list = ws ? all.filter((h) => workspaceRole(d, ws, { kind: 'human', id: h.id })) : all
  const showMenu = isOrgAdmin(d) || (!!ws && canAdmin(d, ws))
  const cols = ws ? U_COLS_WS : U_COLS
  return (
    <>
      <Table cols={cols} head={['Name', 'Email', 'Org role', 'Status', 'Last active (this org)', 'Workspaces', ...(ws ? ['Role', 'Write here'] : []), '']} className={className}>
        <ListBody cols={cols} what="users" empty={list.length ? undefined : <div className="p-8 text-center text-[13px] text-zinc-400">No one here yet.</div>}>
          {list.map((h) => {
            const role = h.roles[d.currentOrgId]
            // Active Owners and userAdmins administer every workspace, so their column reads All (org admin).
            const orgAdminRole = ORG_ADMIN_ROLES.includes(role) && isActive(h, d.currentOrgId)
            const mine = membershipsOf(d, { kind: 'human', id: h.id })
            const m = ws?.members.find((x) => x.kind === 'human' && x.id === h.id)
            const wsRole = ws ? workspaceRole(d, ws, { kind: 'human', id: h.id }) : null
            return (
              <Row key={h.id} cols={cols} onClick={() => nav(`/players/users/${h.id}`)}>
                <PrincipalChip p={{ kind: 'human', id: h.id }} />
                <div className="truncate text-zinc-400">{h.email}</div>
                <div className="text-zinc-400">
                  {role}
                  {isLastOwner(d, h) && <div className="text-2xs text-zinc-600">last active Owner</div>}
                </div>
                <div>
                  <PersonStatus h={h} orgId={d.currentOrgId} />
                </div>
                <div className="text-zinc-500">{h.id === d.currentUserId ? 'Now' : lastActiveIn(d, h.id) ? ago(lastActiveIn(d, h.id), now) : '—'}</div>
                <div className="truncate text-xs text-zinc-400">{orgAdminRole ? <span className="text-zinc-400">All (org admin)</span> : <WsNames items={mine.map(({ w, m }) => ({ id: w.id, name: w.name, admin: m.role === 'admin' }))} />}</div>
                {ws && (
                  <div className={cx('text-xs', wsRole === 'Member' ? 'text-zinc-400' : 'text-green-400')}>
                    {wsRole}
                    {m?.delegatedBy && m.role === 'admin' && <div className="text-2xs text-zinc-500">delegated by {m.delegatedBy}</div>}
                    {m && !isActive(h, ws.orgId) && <div className="text-2xs text-amber-400">{statusIn(h, ws.orgId)} — can’t act</div>}
                  </div>
                )}
                {ws && (
                  <div onClick={(e) => e.stopPropagation()} title={orgAdminRole ? `${role}: org admins can always write in every workspace` : undefined}>
                    {m ? <Toggle on={m.write || orgAdminRole} disabled={!canAdmin(d, ws) || orgAdminRole} label={`Write for ${h.name} in ${ws.name}`} onChange={(v) => (v ? actions.setMember(ws.id, { kind: 'human', id: h.id }, { write: true }) : setPending({ kind: 'write', m, w: ws }))} /> : <span className="text-2xs text-zinc-500">Always</span>}
                  </div>
                )}
                <div className="text-right">{showMenu && <Menu label={`Actions for ${h.name}`} items={menuFor(h)} disabledReason={ws && orgAdminRole ? REASONS.orgAdminWorkspaces : undefined} />}</div>
              </Row>
            )
          })}
        </ListBody>
      </Table>
      {dialogs}
    </>
  )
}

/* ------------------------------------------------------------------ */
/* Agents grid                                                         */
/* ------------------------------------------------------------------ */
const A_COLS = 'minmax(140px,1.2fr) 120px 100px 170px 140px 100px minmax(150px,1.4fr) 140px 110px 36px'
const A_COLS_WS = 'minmax(140px,1.2fr) 120px 100px 170px 140px 100px minmax(140px,1.2fr) 140px 110px 130px 150px 36px'

/**
 * Players › Agents — Label, Agent ID, Status, Token, Created, Last used, Workspaces, then Dispatch's Reported
 * client and Own filters, ⋯. With `ws`: filtered to the workspace, with a Role column and Dispatch's per-membership
 * Read/Write (the Token column adds the workspace token).
 */
export function AgentsGrid({ ws, className }: { ws?: Workspace; className?: string }) {
  const d = useDB()
  const nav = useNavigate()
  const now = useNow()
  const { menuFor, dialogs, setPending } = useAgentActions(ws)
  const list = ws ? orgAgents(d).filter((a) => ws.members.some((m) => m.kind === 'agent' && m.id === a.id)) : orgAgents(d)
  const showMenu = isOrgAdmin(d) || (!!ws && canAdmin(d, ws))
  const cols = ws ? A_COLS_WS : A_COLS
  return (
    <>
      <Table cols={cols} head={['Label', 'Agent ID', 'Status', 'Token', 'Created', 'Last used', 'Workspaces', 'Reported client', 'Own filters', ...(ws ? ['Role', 'Read · Write here'] : []), '']} className={className}>
        <ListBody cols={cols} what="agents" empty={list.length ? undefined : <div className="p-8 text-center text-[13px] text-zinc-400">{ws ? 'No agents in this workspace yet.' : 'No agents yet. Register one to give it an ID and token it can connect with.'}</div>}>
          {list.map((a) => {
            const f = a.filters
            const narrowed = [!f.read && 'no read', !f.write && 'no write', f.workspaceBlocklist.length && `${f.workspaceBlocklist.length} ws blocked`, f.agentBlocklist.length && `${f.agentBlocklist.length} authors blocked`].filter(Boolean)
            const mine = membershipsOf(d, { kind: 'agent', id: a.id }, a.orgId)
            const m = ws?.members.find((x) => x.kind === 'agent' && x.id === a.id)
            const r = ws ? evaluate(d, a.id, ws.id, 'read') : null
            const wr = ws ? evaluate(d, a.id, ws.id, 'write') : null
            const grace = m?.prevTokenLast4 && m.prevTokenUntil && m.prevTokenUntil > now
            const admin = !!ws && canAdmin(d, ws)
            return (
              <Row key={a.id} cols={cols} onClick={() => nav(`/players/agents/${a.id}`)} className={cx(a.status === 'revoked' && 'text-zinc-500')}>
                <div className="min-w-0">
                  <PrincipalChip p={{ kind: 'agent', id: a.id }} />
                </div>
                <div onClick={(e) => e.stopPropagation()}>
                  <CopyChip value={a.id} variant="inline" />
                </div>
                <div>
                  <AgentStatus a={a} />
                </div>
                <div className="masked-token text-xs text-zinc-500">
                  dsp_agent_••••{a.tokenLast4}
                  {m && (
                    <div className="font-sans text-2xs tracking-normal text-zinc-500">
                      ws <span className="masked-token">••••{m.tokenLast4 ?? '????'}</span>
                      {grace && <span className="text-amber-400"> · old ••••{m.prevTokenLast4} until {clock(m.prevTokenUntil!)}</span>}
                    </div>
                  )}
                </div>
                <div className="text-xs text-zinc-400">
                  {a.createdBy}
                  <div className="text-2xs text-zinc-500">{ago(a.createdAt, now)}</div>
                </div>
                <div>
                  <AgentLastUsed a={a} />
                </div>
                <div className="truncate text-xs text-zinc-400">
                  <WsNames items={mine.map(({ w, m }) => ({ id: w.id, name: w.name, admin: m.role === 'admin', refused: evaluate(d, a.id, w.id, 'read').reason }))} />
                </div>
                <div className={cx('text-xs', a.client ? 'text-zinc-400' : 'text-zinc-600')}>{clientLabel(a)}</div>
                <div className={cx('text-xs', narrowed.length ? 'text-amber-400' : 'text-zinc-500')}>{narrowed.join(' · ') || 'None'}</div>
                {ws && m && (
                  <div className={cx('text-xs', m.role === 'admin' ? 'text-green-400' : 'text-zinc-400')}>
                    {m.role === 'admin' ? 'Workspace admin' : 'Member'}
                    {m.delegatedBy && m.role === 'admin' && <div className="text-2xs text-zinc-500">delegated by {m.delegatedBy}</div>}
                  </div>
                )}
                {ws && m && (
                  <div onClick={(e) => e.stopPropagation()} className="text-xs">
                    <span className="flex items-center gap-2">
                      <Toggle on={m.read} disabled={!admin} label={`Read for ${a.label} in ${ws.name}`} onChange={(v) => (v ? actions.setMember(ws.id, { kind: 'agent', id: a.id }, { read: true }) : setPending({ kind: 'read', m, w: ws }))} />
                      <Toggle on={m.write} disabled={!admin} label={`Write for ${a.label} in ${ws.name}`} onChange={(v) => (v ? actions.setMember(ws.id, { kind: 'agent', id: a.id }, { write: true }) : setPending({ kind: 'write', m, w: ws }))} />
                    </span>
                    <div className={cx('mt-1 text-2xs', r?.allowed ? 'text-green-400' : 'text-red-400')} title={(r?.reason ?? wr?.reason) || undefined}>
                      {r?.allowed ? (wr?.allowed ? 'Read ✓ Write ✓' : 'Read ✓ Write ✗') : 'Blocked'}
                    </div>
                  </div>
                )}
                <div className="text-right">{showMenu && <Menu label={`Actions for ${a.label}`} items={menuFor(a)} />}</div>
              </Row>
            )
          })}
        </ListBody>
      </Table>
      {dialogs}
    </>
  )
}

/** Who administers a workspace by default, for the Members tab's note (rule 2). */
export function DefaultAdminsNote({ w }: { w: Workspace }) {
  const d = useDB()
  const explicit = explicitHumanAdmins(d, w)
  const defaults = orgAdmins(d, w.orgId)
  return explicit.length ? (
    <Callout tone="neutral" className="mt-4">
      Workspace admins: {explicit.map((m) => humanById(d, m.id)?.name).join(', ')}. The organization’s Owners and userAdmins ({defaults.map((h) => h.name).join(', ') || 'none active'}) administer every workspace through their org role.
    </Callout>
  ) : (
    <Callout tone="neutral" className="mt-4">
      No human is a workspace admin of {w.name} explicitly, so the organization’s Owners and userAdmins — {defaults.map((h) => h.name).join(', ') || 'none active'} — are its default admins. Every workspace has at least one human admin; agent admins never replace it.
    </Callout>
  )
}


