/**
 * The ⋯ menus of the shared player grids (same items and order as Keyhole), and the agent credential dialogs they
 * open. Unavailable items stay in place, aria-disabled, with the reason.
 */
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ago, maskAgentToken } from '../lib/format'
import { actions, canAdmin, isActive, isLastOwner, isOnline, isOrgAdmin, membershipsOf, myOrgRole, ORG_ADMIN_ROLES, statusIn, useDB, useNow } from '../lib/store'
import type { Agent, Human, Principal, Workspace } from '../lib/types'
import { accessImpactRows, ImpactDialog } from '../components/shared'
import { showAgentToken } from '../components/tokens'
import { Button, Footer, Modal, Segmented, type MenuItem } from '../components/ui'
import { AssignWorkspacesModal, ChangeOrgRoleModal, MemberConfirm, PersonConfirm, type MemberPending, type PersonAction } from './playerDialogs'

function workspaceItems(d: ReturnType<typeof useDB>, w: Workspace, p: Principal, open: (x: MemberPending) => void): MenuItem[] {
  const m = w.members.find((x) => x.kind === p.kind && x.id === p.id)
  const may = canAdmin(d, w)
  const why = !may ? 'Workspace admins only' : !m ? 'Admin through their org role — not a member here' : undefined
  const off = !may || !m
  return [
    m?.role === 'admin' ? { label: 'Remove workspace admin…', disabled: off, hint: why, onClick: () => m && open({ kind: 'demote', m, w }) } : { label: 'Make workspace admin…', disabled: off, hint: why, onClick: () => m && open({ kind: 'delegate', m, w }) },
    ...(p.kind === 'agent' ? [{ label: 'Rotate workspace token…', disabled: off, hint: why, onClick: () => m && open({ kind: 'rotate', m, w }) }] : []),
    { label: `Remove from ${w.name}…`, danger: true, disabled: off, hint: why, onClick: () => m && open({ kind: 'remove', m, w }) },
  ]
}


/** Why the current person can't act on this person's org membership, or null when they can. */
function blockedOn(d: ReturnType<typeof useDB>, h: Human, action: 'role' | 'suspend' | 'remove'): string | null {
  if (!isOrgAdmin(d)) return 'Org admins only'
  if (h.id === d.currentUserId) return 'Not for yourself'
  if (h.roles[d.currentOrgId] === 'Owner' && myOrgRole(d) !== 'Owner') return 'Only an Owner can act on an Owner'
  if (action === 'role' && h.roles[d.currentOrgId] === 'Owner') return 'An Owner’s role changes only by transferring ownership'
  if (action !== 'role' && isLastOwner(d, h)) return 'The last active Owner — transfer ownership first'
  return null
}

export function useUserActions(ws?: Workspace) {
  const d = useDB()
  const [acting, setActing] = useState<PersonAction | null>(null)
  const [roleFor, setRoleFor] = useState<Human | null>(null)
  const [assignFor, setAssignFor] = useState<Principal | null>(null)
  const [pending, setPending] = useState<MemberPending | null>(null)
  const menuFor = (h: Human): (MenuItem | 'separator')[] => {
    const suspended = statusIn(h, d.currentOrgId) === 'suspended'
    const transferWhy = !isOrgAdmin(d) || myOrgRole(d) !== 'Owner' ? 'Owners only' : h.id === d.currentUserId ? 'That’s you' : h.roles[d.currentOrgId] === 'Owner' ? 'Already an Owner' : !isActive(h, d.currentOrgId) ? 'Only to an active person' : null
    const assignWhy = !isOrgAdmin(d) ? 'Org admins only' : ORG_ADMIN_ROLES.includes(h.roles[d.currentOrgId]) ? 'Org admins administer every workspace' : null
    return [
      { label: 'Change org role…', disabled: !!blockedOn(d, h, 'role'), hint: blockedOn(d, h, 'role') ?? undefined, onClick: () => setRoleFor(h) },
      { label: 'Assign workspaces…', disabled: !!assignWhy, hint: assignWhy ?? undefined, onClick: () => setAssignFor({ kind: 'human', id: h.id }) },
      { label: 'Transfer ownership…', disabled: !!transferWhy, hint: transferWhy ?? undefined, onClick: () => setActing({ kind: 'transfer', h }) },
      suspended
        ? { label: 'Resume…', disabled: !!blockedOn(d, h, 'suspend'), hint: blockedOn(d, h, 'suspend') ?? undefined, onClick: () => setActing({ kind: 'resume', h }) }
        : { label: 'Suspend…', disabled: !!blockedOn(d, h, 'suspend'), hint: blockedOn(d, h, 'suspend') ?? undefined, onClick: () => setActing({ kind: 'suspend', h }) },
      { label: 'Remove from organization…', danger: true, disabled: !!blockedOn(d, h, 'remove'), hint: blockedOn(d, h, 'remove') ?? undefined, onClick: () => setActing({ kind: 'remove', h }) },
      ...(ws ? (['separator', ...workspaceItems(d, ws, { kind: 'human', id: h.id }, setPending)] as (MenuItem | 'separator')[]) : []),
    ]
  }
  const dialogs = (
    <>
      <PersonConfirm acting={acting} onClose={() => setActing(null)} />
      <ChangeOrgRoleModal h={roleFor} onClose={() => setRoleFor(null)} />
      <AssignWorkspacesModal p={assignFor} onClose={() => setAssignFor(null)} />
      <MemberConfirm pending={pending} onClose={() => setPending(null)} />
    </>
  )
  return { menuFor, dialogs, setPending }
}

/* ------------------------------------------------------------------ */
/* Agents: the ⋯ menu and its dialogs                                  */
/* ------------------------------------------------------------------ */
const SIM_CLIENTS = ['Claude Code', 'Codex', 'OpenCode', 'REST'] as const
type SimClient = (typeof SIM_CLIENTS)[number]

export function useAgentActions(ws?: Workspace) {
  const d = useDB()
  const nav = useNavigate()
  const now = useNow()
  const [rotating, setRotating] = useState<Agent | null>(null)
  const [suspending, setSuspending] = useState<Agent | null>(null)
  const [resuming, setResuming] = useState<Agent | null>(null)
  const [revoking, setRevoking] = useState<Agent | null>(null)
  const [assignFor, setAssignFor] = useState<Principal | null>(null)
  const [pending, setPending] = useState<MemberPending | null>(null)
  // Prototype: an agent that has never connected has reported nothing, so ask which client it connects with.
  const [firstConnect, setFirstConnect] = useState<{ a: Agent; client: SimClient } | null>(null)
  const simulate = (a: Agent) => (a.connected ? actions.connectAgent(a.id, false) : a.client ? actions.connectAgent(a.id, true, a.client) : setFirstConnect({ a, client: (a.configFormat as SimClient) ?? 'Claude Code' }))
  const menuFor = (a: Agent, opts: { detail?: boolean } = {}): (MenuItem | 'separator')[] => {
    const admin = isOrgAdmin(d, a.orgId)
    const why = (x: string | null) => (!admin ? 'Org admins only' : x)
    const revoked = a.status === 'revoked'
    const assignWhy = why(revoked ? 'Revoked agents can’t join workspaces' : null)
    const rotateWhy = why(revoked ? 'Revoked — its token no longer works' : null)
    const statusWhy = why(revoked ? 'Revoked — can’t be resumed' : null)
    const revokeWhy = why(revoked ? 'Already revoked' : null)
    return [
      { label: 'Assign workspaces…', disabled: !!assignWhy, hint: assignWhy ?? undefined, onClick: () => setAssignFor({ kind: 'agent', id: a.id }) },
      { label: 'Rotate token…', disabled: !!rotateWhy, hint: rotateWhy ?? undefined, onClick: () => setRotating(a) },
      a.status === 'suspended' ? { label: 'Resume…', disabled: !!statusWhy, hint: statusWhy ?? undefined, onClick: () => setResuming(a) } : { label: 'Suspend…', disabled: !!statusWhy, hint: statusWhy ?? undefined, onClick: () => setSuspending(a) },
      { label: 'Revoke…', danger: true, disabled: !!revokeWhy, hint: revokeWhy ?? undefined, onClick: () => setRevoking(a) },
      // Dispatch's own items, after the shared ones.
      'separator',
      ...(ws
        ? workspaceItems(d, ws, { kind: 'agent', id: a.id }, setPending)
        : [
            ...(opts.detail ? [] : [{ label: 'Edit its own filters…', onClick: () => nav(`/players/agents/${a.id}`) }]),
            { label: a.connected ? 'Simulate disconnect' : 'Simulate connect', disabled: !admin || a.status !== 'active', hint: !admin ? 'Org admins only' : a.status !== 'active' ? `It’s ${a.status}` : 'Prototype only', onClick: () => simulate(a) },
          ]),
    ]
  }
  const mships = (a: Agent) => membershipsOf(d, { kind: 'agent', id: a.id }, a.orgId)
  const adminIn = (a: Agent) => mships(a).filter(({ m }) => m.role === 'admin').map(({ w }) => w.name)
  const dialogs = (
    <>
      <AssignWorkspacesModal p={assignFor} onClose={() => setAssignFor(null)} />
      <MemberConfirm pending={pending} onClose={() => setPending(null)} />
      <ImpactDialog
        open={!!rotating}
        onClose={() => setRotating(null)}
        title={`Rotate ${rotating?.label}’s agent token?`}
        rows={
          rotating
            ? [
                ['Current token', `${maskAgentToken(rotating.tokenLast4)} — keeps working for 10 minutes`, 'amber'],
                ['Workspace tokens', 'Unchanged'],
                ['Connected now', isOnline(rotating) ? 'Yes — update its config within 10 minutes' : 'No'],
              ]
            : []
        }
        body="The new token is shown once."
        confirmLabel="Rotate token"
        confirmVariant="danger"
        onConfirm={() => {
          if (!rotating) return
          const t = actions.rotateAgentToken(rotating.id)
          if (t) showAgentToken(rotating, t)
        }}
      />
      <ImpactDialog
        open={!!suspending}
        onClose={() => setSuspending(null)}
        title={`Suspend ${suspending?.label}?`}
        rows={
          suspending
            ? [
                ['Connected now', isOnline(suspending) ? 'Yes — disconnected now' : 'No', isOnline(suspending) ? 'amber' : undefined],
                ['Workspaces', mships(suspending).map(({ w }) => w.name).join(', ') || 'None'],
                ['Admin in', adminIn(suspending).join(', ') || 'None', adminIn(suspending).length ? 'amber' : undefined],
                ...accessImpactRows(d, suspending.id, undefined, false),
              ]
            : []
        }
        body="Reversible: its tokens stay valid but every request is refused until you resume it. Queued messages are held, not dropped — resuming delivers them (re-checked at delivery). Nothing it already recorded changes."
        confirmLabel="Suspend agent"
        onConfirm={() => suspending && actions.setAgentStatus(suspending.id, 'suspended')}
      />
      <ImpactDialog
        open={!!resuming}
        onClose={() => setResuming(null)}
        title={`Resume ${resuming?.label}?`}
        rows={
          resuming
            ? [
                ['Status', 'suspended → active', 'amber'],
                ['Workspaces', mships(resuming).map(({ w }) => w.name).join(', ') || 'None'],
                ['Held messages', `${d.messages.filter((m) => m.receipts[resuming.id]?.held).length} — delivered when it next connects, re-checked at delivery`],
              ]
            : []
        }
        body="Its agent token and workspace tokens work again right away."
        confirmLabel="Resume agent"
        confirmVariant="primary"
        onConfirm={() => resuming && actions.setAgentStatus(resuming.id, 'active')}
      />
      <ImpactDialog
        open={!!revoking}
        onClose={() => setRevoking(null)}
        title={`Revoke ${revoking?.label}?`}
        rows={
          revoking
            ? [
                ['Last seen', ago(revoking.lastSeen, now), revoking.lastSeen && now - revoking.lastSeen < 3_600_000 ? 'amber' : undefined],
                ['Workspaces', mships(revoking).map(({ w }) => w.name).join(', ') || 'None'],
                ['Admin in', adminIn(revoking).join(', ') || 'None'],
                ...accessImpactRows(d, revoking.id, undefined, true),
              ]
            : []
        }
        body="Its agent token and every workspace token stop working now. Its next request is refused and logged. What it already received, read or acknowledged stays as recorded. This can’t be undone."
        confirmLabel="Revoke agent"
        onConfirm={() => revoking && actions.setAgentStatus(revoking.id, 'revoked')}
      />
      <Modal open={!!firstConnect} onClose={() => setFirstConnect(null)} width={460} title={`Simulate ${firstConnect?.a.label} connecting`}>
        <div className="text-sm2 text-zinc-400">
          {firstConnect?.a.label} hasn’t connected yet, so it hasn’t reported a client. Which client does it connect with?{firstConnect?.a.configFormat ? ` (Its last downloaded config was for ${firstConnect.a.configFormat}.)` : ''}
        </div>
        <Segmented label="Client it connects with" value={firstConnect?.client ?? 'Claude Code'} onChange={(c) => firstConnect && setFirstConnect({ ...firstConnect, client: c })} options={SIM_CLIENTS.map((c) => ({ value: c, label: c }))} />
        <Footer>
          <Button size="lg" onClick={() => setFirstConnect(null)}>
            Cancel
          </Button>
          <Button
            size="lg"
            variant="primary"
            onClick={() => {
              if (firstConnect) actions.connectAgent(firstConnect.a.id, true, firstConnect.client === 'REST' ? { name: 'REST', via: 'REST' } : { name: firstConnect.client, via: 'MCP' })
              setFirstConnect(null)
            }}
          >
            Connect
          </Button>
        </Footer>
      </Modal>
    </>
  )
  return { menuFor, dialogs, setPending, simulate }
}


