/**
 * The dialogs behind the shared player grids' ⋯ menus: Assign workspaces…, Change org role…, transfer, suspend,
 * resume and remove, and a workspace admin's own member actions. The menus themselves are in playerActions.tsx.
 */
import { useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { clock, maskWsToken } from '../lib/format'
import { actions, agentById, coupleReadWrite, explicitHumanAdmins, humanFootprint, me, org, orgAdmins, ORG_ADMIN_ROLES, principalName, useDB } from '../lib/store'
import type { Human, Membership, MemberRole, Principal, Workspace } from '../lib/types'
import { accessImpactRows, ImpactDialog, ImpactRows } from '../components/shared'
import { showWsToken } from '../components/tokens'
import { Button, Callout, Checkbox, Footer, Modal, Segmented, Toggle } from '../components/ui'

type Rows = [string, ReactNode, ('amber' | 'red')?][]
const and = (names: string[]) => (names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : (names[0] ?? ''))

/** "Production (admin), Staging, Incidents +2" — more than three collapse to "+N". */
/* ------------------------------------------------------------------ */
/* Workspace membership actions (Workspace › Members)                  */
/* ------------------------------------------------------------------ */
export type MemberPending = { kind: 'delegate' | 'demote' | 'rotate' | 'remove' | 'read' | 'write'; m: Membership; w: Workspace }

/** Impact previews for a workspace's own member actions: delegating, removing admin, read/write, rotation, removal. */
export function MemberConfirm({ pending, onClose }: { pending: MemberPending | null; onClose: () => void }) {
  const d = useDB()
  const m = pending?.m
  const w = pending?.w
  const name = m ? principalName(d, { kind: m.kind, id: m.id }) : ''
  // Demoting or removing the last explicit human admin is allowed: the org's Owners and userAdmins become default admins.
  const losesLastHuman = !!m && !!w && m.kind === 'human' && m.role === 'admin' && (pending?.kind === 'demote' || pending?.kind === 'remove') && !w.members.some((x) => x !== m && x.kind === 'human' && x.role === 'admin')
  const otherAdmins = w ? w.members.filter((x) => x !== m && x.role === 'admin').map((x) => principalName(d, { kind: x.kind, id: x.id })) : []
  const defaultNames = w ? orgAdmins(d, w.orgId).map((h) => h.name) : []
  const fallbackNote = losesLastHuman && (
    <Callout tone="neutral">
      {and(defaultNames)} (org admins) become this workspace’s default admins.
      {otherAdmins.length > 0 && ` ${otherAdmins.join(', ')} keep${otherAdmins.length === 1 ? 's' : ''} admin too, but a workspace is never administered by agents alone.`} The audit log records the fallback.
    </Callout>
  )
  const self = m?.kind === 'human' && m.id === d.currentUserId
  const p = m ? ({ kind: m.kind, id: m.id } as Principal) : null

  const spec: { title: string; rows: Rows; body: ReactNode; confirm: string; tone: 'danger' | 'primary'; run: () => void } | null =
    !pending || !m || !p || !w
      ? null
      : pending.kind === 'delegate'
        ? {
            title: `Make ${name} a workspace admin of ${w.name}?`,
            rows: [
              ['Kind', m.kind],
              ['Can then', 'Add and remove members, delegate or remove workspace admin, set the blocklist, rotate workspace tokens, expire any message, rotate listener passwords, read the audit log, change settings', 'amber'],
              ['Through', m.kind === 'agent' ? 'The REST API and MCP, with its own agent + workspace tokens' : 'The web app'],
              ['Audited as', m.kind === 'agent' ? `“${name} … — as delegated admin” (agent actions)` : `${name}’s own actions`],
            ],
            body: m.kind === 'agent' ? `${name} acts on its own, without a human in the loop. You can remove admin again from this menu.` : 'You can remove admin again from this menu. Nothing org-level comes with it.',
            confirm: 'Make workspace admin',
            tone: 'primary',
            run: () => actions.setMember(w.id, p, { role: 'admin' }),
          }
        : pending.kind === 'demote'
          ? {
              title: `Remove workspace admin from ${self ? 'yourself' : name}?`,
              rows: [
                ['Kind', m.kind],
                ['Role after', 'Member — keeps its read and write access'],
                ['Explicit admins left', otherAdmins.join(', ') || '—'],
                ['Human admin', losesLastHuman ? `Default admins: ${defaultNames.join(', ')} (org Owners/userAdmins)` : 'Unchanged'],
                ['Admin rights they delegated', 'Stand — nothing cascades from losing admin'],
              ],
              body: (
                <div className="flex flex-col gap-2.5">
                  {self && <div>{ORG_ADMIN_ROLES.includes(me(d).roles[w.orgId]) ? 'You keep admin here through your org role.' : 'You lose admin here as soon as you confirm.'}</div>}
                  {fallbackNote}
                </div>
              ),
              confirm: 'Remove workspace admin',
              tone: 'danger',
              run: () => actions.setMember(w.id, p, { role: 'member' }),
            }
          : pending.kind === 'read'
            ? {
                title: `Turn off reading for ${name} in ${w.name}?`,
                rows: [
                  ['Read', 'on → off', 'amber'],
                  ['Write', m.write ? 'on → off — writing without reading makes no sense' : 'already off', m.write ? 'amber' : undefined],
                  ['Reads here after this', 'Nothing — refused at rule 5 (membership allows read)'],
                  ...accessImpactRows(d, m.id, w.id, false),
                ],
                body: 'Reversible: turn Read (or Write, which turns Read back on too) on again and held messages are delivered — access is re-checked at delivery. Nothing already recorded changes.',
                confirm: 'Turn off read',
                tone: 'danger',
                run: () => actions.setMember(w.id, p, { read: false }),
              }
            : pending.kind === 'write'
              ? {
                  title: `Turn off writing for ${name} in ${w.name}?`,
                  rows: [
                    ['Can no longer', m.kind === 'agent' ? 'Send messages, retry webhooks, write shared context' : 'Post, retry webhooks, edit shared context', 'amber'],
                    ['Still can', m.kind === 'agent' ? 'Read what’s addressed to it' : 'See and search every message'],
                    ['Already sent', 'Stays as it is'],
                  ],
                  body: 'Reversible: turn Write back on at any time.',
                  confirm: 'Turn off write',
                  tone: 'danger',
                  run: () => actions.setMember(w.id, p, { write: false }),
                }
              : pending.kind === 'rotate'
                ? {
                    title: `Rotate ${name}’s workspace token?`,
                    rows: [
                      ['Current token', `${maskWsToken(m.tokenLast4 ?? '')} — keeps working for 10 minutes`, 'amber'],
                      ['Other agents', 'Unaffected — each has its own token'],
                      ['Agent token', 'Unchanged'],
                    ],
                    body: 'The new token is shown once. Put it in the agent’s config within 10 minutes; after that the old one is refused.',
                    confirm: 'Rotate token',
                    tone: 'danger',
                    run: () => {
                      const t = actions.rotateMemberToken(w.id, m.id)
                      if (t)
                        showWsToken(w, m.id, t, 'Workspace token rotated', (
                          <>
                            The old token works until {clock(Date.now() + 10 * 60_000)}. <Link to={`/workspaces/${w.id}/connect?agent=${m.id}`}>Open connection instructions →</Link>
                          </>
                        ))
                    },
                  }
                : {
                    title: `Remove ${name} from ${w.name}?`,
                    rows: [
                      ['Kind', m.kind],
                      ['Role', (m.role === 'admin' ? 'Workspace admin' : 'Member') + (m.delegatedBy ? ` (delegated by ${m.delegatedBy})` : '')],
                      ...(m.kind === 'agent' ? accessImpactRows(d, m.id, w.id, true) : []),
                      ['Workspace token', m.kind === 'agent' ? `${maskWsToken(m.tokenLast4 ?? '')} — stops working immediately` : '—', m.kind === 'agent' ? 'amber' : undefined],
                    ],
                    body: (
                      <div className="flex flex-col gap-2.5">
                        <div>Its past messages and receipts stay in the workspace and the audit log. Admin rights it delegated stand.</div>
                        {fallbackNote}
                      </div>
                    ),
                    confirm: 'Remove member',
                    tone: 'danger',
                    run: () => actions.removeMember(w.id, p),
                  }
  return <ImpactDialog open={!!spec} onClose={onClose} title={spec?.title ?? ''} rows={spec?.rows ?? []} body={spec?.body} confirmLabel={spec?.confirm ?? ''} confirmVariant={spec?.tone} onConfirm={() => spec?.run()} />
}

/** The workspace admin's items for one row, after the separator (Workspace › Members only). */
/* ------------------------------------------------------------------ */
/* Assign workspaces… (users and agents)                               */
/* ------------------------------------------------------------------ */
type Sel = { role: MemberRole; read: boolean; write: boolean }
const roleName = (r: MemberRole | undefined) => (r === 'admin' ? 'Workspace admin' : 'Member')
const access = (x: { read: boolean; write: boolean }) => [x.read && 'read', x.write && 'write'].filter(Boolean).join(' + ') || 'none'

/**
 * The shared Assign workspaces… dialog: each of the org's workspaces with a checkbox and Member / Workspace admin,
 * plus Dispatch's Read and Write (read off turns write off; write on turns read on — humans always read). Changes are
 * previewed first, then applied one workspace at a time, each audited in its workspace — the same rows the
 * workspace's own Members tab writes. For an agent, each newly added workspace issues a workspace token, shown once.
 */
export function AssignWorkspacesModal({ p, onClose }: { p: Principal | null; onClose: () => void }) {
  // Keyed by the player, so each opening starts from their current memberships.
  return p ? <AssignWorkspaces key={`${p.kind}:${p.id}`} p={p} onClose={onClose} /> : null
}
function AssignWorkspaces({ p, onClose }: { p: Principal; onClose: () => void }) {
  const d = useDB()
  const ws = d.workspaces.filter((w) => w.orgId === d.currentOrgId)
  const before = (w: Workspace) => w.members.find((m) => m.kind === p.kind && m.id === p.id)
  const [sel, setSel] = useState<Record<string, Sel>>(() => Object.fromEntries(ws.flatMap((w) => { const b = before(w); return b ? [[w.id, { role: b.role, read: b.read, write: b.write }]] : [] })))
  const [previewing, setPreviewing] = useState(false)
  const name = principalName(d, p)
  const agent = p.kind === 'agent' ? agentById(d, p.id) : undefined
  const added = ws.filter((w) => !before(w) && sel[w.id])
  const removed = ws.filter((w) => before(w) && !sel[w.id])
  const roleChanged = ws.filter((w) => before(w) && sel[w.id] && before(w)!.role !== sel[w.id].role)
  const accessChanged = ws.filter((w) => before(w) && sel[w.id] && (before(w)!.read !== sel[w.id].read || before(w)!.write !== sel[w.id].write))
  // Where they're the only active explicit human admin and stop being one, the org's admins take over by default.
  const takeover = p.kind === 'human' ? ws.filter((w) => before(w)?.role === 'admin' && sel[w.id]?.role !== 'admin' && explicitHumanAdmins(d, w).every((m) => m.id === p.id) && explicitHumanAdmins(d, w).length > 0) : []
  const any = added.length + removed.length + roleChanged.length + accessChanged.length > 0
  const reducing = removed.length > 0 || roleChanged.some((w) => sel[w.id].role === 'member') || accessChanged.some((w) => (before(w)!.read && !sel[w.id].read) || (before(w)!.write && !sel[w.id].write))
  const set = (w: Workspace, patch: Partial<Sel>) => {
    const cur = sel[w.id]
    if (!cur) return
    // Humans always read; for agents, read off turns write off and write on turns read on.
    const c = coupleReadWrite(cur, { ...(patch.read !== undefined ? { read: patch.read } : {}), ...(patch.write !== undefined ? { write: patch.write } : {}) })
    const read = p.kind === 'human' ? true : (c.read ?? cur.read)
    const write = p.kind === 'human' ? (patch.write ?? cur.write) : (c.write ?? cur.write)
    setSel({ ...sel, [w.id]: { role: patch.role ?? cur.role, read, write } })
  }
  const rows: Rows = [
    ['Added', added.map((w) => `${w.name} (${roleName(sel[w.id].role)} · ${access(sel[w.id])})`).join(', ') || 'None'],
    ['Removed', removed.map((w) => w.name).join(', ') || 'None', removed.length ? 'amber' : undefined],
    ['Role changes', roleChanged.map((w) => `${w.name}: ${roleName(before(w)!.role)} → ${roleName(sel[w.id].role)}`).join('; ') || 'None', roleChanged.some((w) => sel[w.id].role === 'member') ? 'amber' : undefined],
    ['Read / write changes', accessChanged.map((w) => `${w.name}: ${access(before(w)!)} → ${access(sel[w.id])}`).join('; ') || 'None', accessChanged.length ? 'amber' : undefined],
    ['Default admins take over', takeover.length ? takeover.map((w) => `${w.name} — ${and(orgAdmins(d, w.orgId).filter((h) => h.id !== p.id).map((h) => h.name))} (org admins)`).join('; ') : 'None'],
    ...(p.kind === 'agent' ? ([['Workspace tokens', added.length ? `${added.length} new — one per added workspace, each shown once` : 'None', added.length ? 'amber' : undefined]] as Rows) : []),
    ...(p.kind === 'agent' ? removed.flatMap((w) => accessImpactRows(d, p.id, w.id, true).map(([k, v, t]) => [`${w.name} · ${k}`, v, t] as Rows[number])) : []),
  ]
  const apply = () => {
    const tokens: [Workspace, string][] = []
    for (const w of ws) {
      const b = before(w)
      const a = sel[w.id]
      if (!b && a) {
        const t = actions.addMember(w.id, p, a.role, a.read, a.write)
        if (t) tokens.push([w, t])
      } else if (b && !a) actions.removeMember(w.id, p)
      else if (b && a) {
        if (b.role !== a.role) actions.setMember(w.id, p, { role: a.role })
        if (b.read !== a.read || b.write !== a.write) actions.setMember(w.id, p, p.kind === 'human' ? { write: a.write } : { read: a.read, write: a.write })
      }
    }
    onClose()
    tokens.forEach(([w, t], i) => showWsToken(w, p.id, t, `Workspace token for ${w.name}${tokens.length > 1 ? ` (${i + 1} of ${tokens.length})` : ''}`))
  }
  return (
    <Modal open onClose={onClose} width={640} title={previewing ? `Apply these workspace changes for ${name}?` : `Assign workspaces for ${name}`}>
      {!previewing ? (
        <>
          <div role="group" aria-label={`Workspaces for ${name}`} className="flex flex-col rounded-lg border border-edge bg-page">
            <div className="grid grid-cols-[1fr_150px_64px_64px] items-center gap-3 border-b border-line px-3 py-1.5 text-2xs text-zinc-500">
              <span>Workspace</span>
              <span>Role</span>
              <span>Read</span>
              <span>Write</span>
            </div>
            {ws.map((w) => {
              const s = sel[w.id]
              const warn = agent && (agent.filters.workspaceBlocklist.includes(w.id) ? `${agent.label} blocks ${w.name} on its own side` : w.agentBlocklist.includes(agent.id) ? `${w.name} blocks ${agent.label}` : null)
              return (
                <div key={w.id} className="border-b border-line px-3 py-2 last:border-b-0">
                  <div className="grid grid-cols-[1fr_150px_64px_64px] items-center gap-3">
                    <Checkbox checked={!!s} onChange={(v) => setSel(v ? { ...sel, [w.id]: { role: 'member', read: true, write: true } } : Object.fromEntries(Object.entries(sel).filter(([k]) => k !== w.id)))} label={w.name} />
                    <select aria-label={`Role in ${w.name}`} disabled={!s} value={s?.role ?? 'member'} onChange={(e) => set(w, { role: e.target.value as MemberRole })} className="rounded-md border border-edge bg-panel px-2 py-1 text-xs text-zinc-300 outline-none focus:border-zinc-500 disabled:opacity-40">
                      <option value="member">Member</option>
                      <option value="admin">Workspace admin</option>
                    </select>
                    <span className="inline-flex" title={p.kind === 'human' ? 'Humans in a workspace always read every message' : undefined}>
                      <Toggle on={p.kind === 'human' ? !!s : !!s?.read} disabled={!s || p.kind === 'human'} label={`Read in ${w.name}`} onChange={(v) => set(w, { read: v })} />
                    </span>
                    <Toggle on={!!s?.write} disabled={!s} label={`Write in ${w.name}`} onChange={(v) => set(w, { write: v })} />
                  </div>
                  {s && warn && <div className="mt-1 text-2xs text-amber-400">{warn} — it can be a member, but the block wins.</div>}
                </div>
              )
            })}
            {!ws.length && <div className="p-4 text-sm2 text-zinc-500">This organization has no workspaces yet.</div>}
          </div>
          <div className="text-xs text-zinc-500">
            A workspace admin manages that workspace’s members, delegates workspace admin, sets its blocklist and webhooks — nothing org-level.
            {p.kind === 'human' ? ' Humans always read every message in their workspaces.' : ' Read off turns write off; write on turns read on. Each newly added workspace issues a workspace token, shown once.'}
          </div>
          <Footer>
            <Button size="lg" onClick={onClose}>
              Cancel
            </Button>
            <Button size="lg" variant="primary" disabled={!any} onClick={() => setPreviewing(true)}>
              Review changes
            </Button>
          </Footer>
        </>
      ) : (
        <>
          <ImpactRows rows={rows} />
          <div className="text-sm2 text-zinc-400">Each change is audited in its own workspace, exactly as if it were made from that workspace’s Members tab.</div>
          <Footer>
            <Button size="lg" onClick={() => setPreviewing(false)}>
              Back
            </Button>
            <Button size="lg" variant={reducing ? 'danger' : 'primary'} onClick={apply}>
              Apply changes
            </Button>
          </Footer>
        </>
      )}
    </Modal>
  )
}

/* ------------------------------------------------------------------ */
/* Users: the ⋯ menu and its dialogs                                   */
/* ------------------------------------------------------------------ */
export type PersonAction = { kind: 'remove' | 'suspend' | 'resume' | 'transfer'; h: Human }
/** Change org role…: user ↔ userAdmin, previewed. Owner is given only by transferring ownership. */
export function ChangeOrgRoleModal({ h, onClose }: { h: Human | null; onClose: () => void }) {
  return h ? <ChangeOrgRole key={h.id} h={h} onClose={onClose} /> : null
}
function ChangeOrgRole({ h, onClose }: { h: Human; onClose: () => void }) {
  const d = useDB()
  const cur = h.roles[d.currentOrgId]
  const [role, setRole] = useState<'user' | 'userAdmin'>(cur === 'user' ? 'user' : 'userAdmin')
  if (!cur) return null
  const f = humanFootprint(d, h)
  const others = orgAdmins(d).filter((x) => x.id !== h.id)
  const defaultOf = d.workspaces.filter((w) => w.orgId === d.currentOrgId && !explicitHumanAdmins(d, w).length)
  const changed = role !== cur
  const rows: Rows = [
    ['Org role', changed ? `${cur} → ${role}` : `${cur} (unchanged)`, changed ? 'amber' : undefined],
    ['Workspaces', role === 'userAdmin' ? 'Administers every workspace in the organization' : `Sees only ${f.memberships.map((w) => w.name).join(', ') || 'no workspaces'} (where they’ve been added)`],
    ...(changed && role === 'user' ? ([['Default admin of', defaultOf.length ? `${defaultOf.map((w) => w.name).join(', ')} — no longer; ${and(others.map((x) => x.name))} remain default admins` : 'None']] as Rows) : []),
    ['Agents they registered', f.agents.length ? `${f.agents.map((a) => a.label).join(', ')} — unaffected; agents belong to the organization` : 'None'],
    ['Admin rights they delegated', f.delegations.length ? `${f.delegations.map(({ w, m }) => `${principalName(d, m)} on ${w.name}`).join(', ')} — stand` : 'None'],
  ]
  return (
    <Modal open onClose={onClose} width={500} title={`Change ${h.name}’s org role`}>
      <Segmented
        label="Org role"
        value={role}
        onChange={setRole}
        options={[
          { value: 'user', label: 'user' },
          { value: 'userAdmin', label: 'userAdmin' },
        ]}
      />
      <ImpactRows rows={rows} />
      <div className="text-sm2 text-zinc-400">Permission is checked when an action happens; what they already did stays in place. Owner is given by transferring ownership.</div>
      <Footer>
        <Button size="lg" onClick={onClose}>
          Cancel
        </Button>
        <Button
          size="lg"
          variant={role === 'user' ? 'danger' : 'primary'}
          disabled={!changed}
          onClick={() => {
            actions.setOrgRole(h.id, role)
            onClose()
          }}
        >
          {role === 'userAdmin' ? 'Make userAdmin' : 'Make user'}
        </Button>
      </Footer>
    </Modal>
  )
}

/** Impact previews for transfer, suspend, resume and remove. Nothing a person did is undone (rule 4). */
export function PersonConfirm({ acting, onClose }: { acting: PersonAction | null; onClose: () => void }) {
  const d = useDB()
  const h = acting?.h
  if (!acting || !h) return null
  const f = humanFootprint(d, h)
  const others = orgAdmins(d).filter((x) => x.id !== h.id)
  const fallback = (list: Workspace[]) => (list.length ? `${list.map((w) => w.name).join(', ')} — ${and(others.map((x) => x.name))} (org admins) become ${list.length === 1 ? 'its' : 'their'} default admins` : 'None')
  const standing: Rows = [
    ['Agents they registered', f.agents.length ? `${f.agents.map((a) => a.label).join(', ')} — unaffected; agents belong to the organization` : 'None'],
    ['Admin rights they delegated', f.delegations.length ? `${f.delegations.map(({ w, m }) => `${principalName(d, m)} on ${w.name}`).join(', ')} — stand` : 'None'],
    ['Members they added', f.added.length ? `${f.added.length} — stay` : 'None'],
    ['Messages they sent', `${f.messages} — stay, under their name`],
  ]
  const spec =
    acting.kind === 'transfer'
      ? {
          title: `Transfer ownership of ${org(d)?.name} to ${h.name}?`,
          rows: [
            [h.name, `${h.roles[d.currentOrgId]} → Owner`, 'amber'],
            ['You', 'Owner → userAdmin — you keep administering every workspace'],
          ] as Rows,
          body: 'Only an Owner can act on Owners. After this, the last-Owner protection applies to them.',
          confirm: 'Transfer ownership',
          tone: 'danger' as const,
          run: () => actions.transferOwnership(h.id),
        }
      : acting.kind === 'resume'
        ? {
            title: `Resume ${h.name}?`,
            rows: [
              ['Status', `suspended → ${h.suspendedFrom?.[d.currentOrgId] ?? 'active'}`, 'amber'],
              ['Org role', h.roles[d.currentOrgId]],
              ['Workspaces', f.memberships.map((w) => `${w.name}${w.members.some((m) => m.kind === 'human' && m.id === h.id && m.role === 'admin') ? ' (admin)' : ''}`).join(', ') || 'None'],
            ] as Rows,
            body: h.suspendedFrom?.[d.currentOrgId] === 'invited' ? 'They go back to invited and still have to accept.' : `They can use ${org(d)?.name} again right away, with the role and workspaces they had.`,
            confirm: 'Resume',
            tone: 'primary' as const,
            run: () => actions.setHumanStatus(h.id, 'active'),
          }
        : {
            title: acting.kind === 'suspend' ? `Suspend ${h.name}?` : `Remove ${h.name} from ${org(d)?.name}?`,
            rows: [
              ['Org role', `${h.roles[d.currentOrgId]}${acting.kind === 'remove' ? ' → none' : ''}`, 'amber'],
              [acting.kind === 'remove' ? 'Their memberships' : 'Workspaces', f.memberships.map((w) => w.name).join(', ') || 'None', acting.kind === 'remove' && f.memberships.length ? 'amber' : undefined],
              ['Only active explicit human admin in', fallback(f.lastExplicitAdminIn)],
              ...standing,
            ] as Rows,
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


/**
 * Change workspace role…: Member or Workspace admin, previewed. The same dialog for people and (in Dispatch) agents;
 * losing the last named human workspace admin hands the workspace to the org admins by default (rule 2).
 */
export function ChangeWorkspaceRoleModal({ target, onClose }: { target: { m: Membership; w: Workspace } | null; onClose: () => void }) {
  return target ? <ChangeWorkspaceRole key={`${target.w.id}:${target.m.kind}:${target.m.id}`} m={target.m} w={target.w} onClose={onClose} /> : null
}
function ChangeWorkspaceRole({ m, w, onClose }: { m: Membership; w: Workspace; onClose: () => void }) {
  const d = useDB()
  const [role, setRole] = useState<MemberRole>(m.role)
  const p: Principal = { kind: m.kind, id: m.id }
  const name = principalName(d, p)
  const changed = role !== m.role
  const losesLastHuman = changed && role === 'member' && m.kind === 'human' && explicitHumanAdmins(d, w).every((x) => x.id === m.id) && explicitHumanAdmins(d, w).length > 0
  const defaults = orgAdmins(d, w.orgId).map((h) => h.name)
  const rows: Rows = [
    ['Workspace role', changed ? `${roleName(m.role)} → ${roleName(role)}` : `${roleName(m.role)} (unchanged)`, changed ? 'amber' : undefined],
    ...(role === 'admin' && changed ? ([['Can then', 'Add and remove members and change their workspace role' + (m.kind === 'agent' ? ' — over the REST API and MCP, audited as agent actions' : ''), 'amber']] as Rows) : []),
    ...(losesLastHuman ? ([['Default admins take over', `${and(defaults)} (org admins)`, 'amber']] as Rows) : []),
    ['Admin rights they delegated', 'Stand — nothing cascades'],
  ]
  return (
    <Modal open onClose={onClose} width={500} title={`Change ${name}’s role in ${w.name}`}>
      <Segmented
        label="Workspace role"
        value={role}
        onChange={setRole}
        options={[
          { value: 'member', label: 'Member' },
          { value: 'admin', label: 'Workspace admin' },
        ]}
      />
      <ImpactRows rows={rows} />
      {m.kind === 'agent' && <div className="text-xs text-zinc-500">Agents as workspace admins are a Dispatch capability; it never replaces the human admin.</div>}
      <Footer>
        <Button size="lg" onClick={onClose}>
          Cancel
        </Button>
        <Button
          size="lg"
          variant={role === 'member' ? 'danger' : 'primary'}
          disabled={!changed}
          onClick={() => {
            actions.setMember(w.id, p, { role })
            onClose()
          }}
        >
          Change role
        </Button>
      </Footer>
    </Modal>
  )
}
