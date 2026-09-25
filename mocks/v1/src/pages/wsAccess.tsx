import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { evaluate, type Op } from '../lib/access'
import { ago, clock, maskAgentToken, maskWsToken, plural } from '../lib/format'
import { actions, agentById, canAdmin, defaultAdmins, isActive, statusIn, getDB, isExpired, isOrgAdmin, me, ORG_ADMIN_ROLES, orgAdmins, humanById, isOnline, orgAgents, orgHumans, principalName, sessionSecret, useDB, useNow } from '../lib/store'
import type { Harness, Membership, MemberRole, OrgRole, Principal } from '../lib/types'
import { CopyChip, DispatchMark, KeyholeIcon } from '../components/credential'
import { showSecret } from '../lib/secrets'
import { accessImpactRows, ImpactDialog, PrincipalChip } from '../components/shared'
import { Button, Callout, Card, Checkbox, Field, Footer, Menu, Modal, Pill, Row, Segmented, Select, Table, Toggle, cx } from '../components/ui'
import { useWorkspace } from './workspaces'

/* ------------------------------------------------------------------ */
/* Members                                                             */
/* ------------------------------------------------------------------ */
const M_COLS = '1.6fr 1.1fr 60px 60px 1.2fr 1.6fr 36px'

type Pending = { kind: 'delegate' | 'demote' | 'rotate' | 'remove' | 'read' | 'write'; m: Membership }

export function WsMembers() {
  const d = useDB()
  const w = useWorkspace()
  const now = useNow()
  const admin = canAdmin(d, w)
  const [adding, setAdding] = useState(false)
  const [pending, setPending] = useState<Pending | null>(null)
  const sorted = [...w.members].sort((a, b) => (a.kind === b.kind ? (a.role === b.role ? 0 : a.role === 'admin' ? -1 : 1) : a.kind === 'human' ? -1 : 1))
  const p = (m: Membership): Principal => ({ kind: m.kind, id: m.id })
  const isOrgAdminHuman = (m: Membership) => m.kind === 'human' && ORG_ADMIN_ROLES.includes(humanById(d, m.id)?.roles[d.currentOrgId] as OrgRole)
  // With no explicit human admin, the org's Owners and userAdmins administer the workspace by default.
  const defaults = defaultAdmins(d, w)
  const defaultRows = defaults.filter((h) => !w.members.some((m) => m.kind === 'human' && m.id === h.id))

  return (
    <div className="mt-5">
      <div className="flex items-center justify-between gap-4">
        <div className="max-w-[720px] text-sm2 text-zinc-500">
          Humans and agents share one member list. An admin can add either kind and delegate admin to either kind. Each agent gets its <span className="text-zinc-300">own</span> workspace token, so removing one agent never disturbs another.
        </div>
        {admin && (
          <Button variant="primary" onClick={() => setAdding(true)}>
            Add member
          </Button>
        )}
      </div>
      {defaults.length > 0 && (
        <Callout tone="neutral" className="mt-4">
          No human is admin of {w.name} explicitly, so the organization’s Owners and userAdmins — {defaults.map((h) => h.name).join(', ')} — are its default admins. Every workspace has at least one human admin; agent admins never replace it. Delegate admin to a person here to set one explicitly.
        </Callout>
      )}
      <Table cols={M_COLS} head={['Member', 'Role', 'Read', 'Write', 'Workspace token', 'Effective access', '']} className="mt-4">
        {defaultRows.map((h) => (
          <Row key={'default' + h.id} cols={M_COLS} className="bg-white/[0.01]">
            <div className="min-w-0">
              <PrincipalChip p={{ kind: 'human', id: h.id }} withKind />
              <div className="mt-0.5 pl-[30px] text-2xs text-zinc-600">{h.email}</div>
            </div>
            <div>
              <Pill tone="green">default admin</Pill>
              <div className="mt-0.5 text-2xs text-zinc-500">org {h.roles[d.currentOrgId]}</div>
            </div>
            <span className="text-2xs text-zinc-500">Always</span>
            <span className="text-2xs text-zinc-500">Always</span>
            <span className="text-2xs text-zinc-600">Signs in with SSO</span>
            <span className="text-xs text-zinc-400">Default admin (org {h.roles[d.currentOrgId]}) — not a member; can’t be removed here</span>
            <span />
          </Row>
        ))}
        {sorted.map((m) => {
          const a = m.kind === 'agent' ? agentById(d, m.id) : null
          const h = m.kind === 'human' ? humanById(d, m.id) : null
          const r = a ? evaluate(d, a.id, w.id, 'read') : null
          const wr = a ? evaluate(d, a.id, w.id, 'write') : null
          const orgAdminHuman = isOrgAdminHuman(m)
          const grace = m.prevTokenLast4 && m.prevTokenUntil && m.prevTokenUntil > now
          return (
            <Row key={m.kind + m.id} cols={M_COLS}>
              <div className="min-w-0">
                <PrincipalChip p={p(m)} withKind />
                <div className="mt-0.5 pl-[30px] text-2xs text-zinc-600">
                  {a ? `${a.id} · ${a.harness} · ${isOnline(a) ? 'online' : a.status !== 'active' ? a.status : `seen ${ago(a.lastSeen, now).toLowerCase()}`}` : h?.email}
                </div>
              </div>
              <div>
                <Pill tone={m.role === 'admin' ? 'green' : 'neutral'}>{m.role}</Pill>
                {m.role !== 'admin' && defaults.some((h) => h.id === m.id) && <div className="mt-0.5 text-2xs text-green-400">default admin (org {humanById(d, m.id)?.roles[d.currentOrgId]})</div>}
                {m.kind === 'human' && !isActive(humanById(d, m.id), w.orgId) && <div className="mt-0.5 text-2xs text-amber-400">{statusIn(humanById(d, m.id), w.orgId) ?? 'not in the org'} — can’t act{m.role === 'admin' ? '; not counted as the human admin' : ''}</div>}
                {m.delegatedBy && <div className="mt-0.5 text-2xs text-zinc-500">delegated by {m.delegatedBy}</div>}
              </div>
              <div>
                {m.kind === 'human' ? <span className="text-2xs text-zinc-500" title="Humans in a workspace always see every message">Always</span> : <Toggle on={m.read} disabled={!admin} label={`Read for ${principalName(d, p(m))}`} onChange={(v) => (v ? actions.setMember(w.id, p(m), { read: true }) : setPending({ kind: 'read', m }))} />}
              </div>
              <div title={orgAdminHuman ? `${humanById(d, m.id)?.roles[d.currentOrgId]}: org admins can always write in every workspace` : undefined}>
                <Toggle on={m.write || orgAdminHuman} disabled={!admin || orgAdminHuman} label={`Write for ${principalName(d, p(m))}`} onChange={(v) => (v ? actions.setMember(w.id, p(m), { write: true }) : setPending({ kind: 'write', m }))} />
                {orgAdminHuman && <div className="mt-0.5 text-2xs text-zinc-600">org admin</div>}
              </div>
              <div className="masked-token text-xs text-zinc-400">
                {m.kind === 'agent' ? maskWsToken(m.tokenLast4 ?? '????') : <span className="font-sans tracking-normal text-zinc-600">Signs in with SSO</span>}
                {grace && <div className="font-sans text-2xs tracking-normal text-amber-400">old ••••{m.prevTokenLast4} works until {clock(m.prevTokenUntil!)}</div>}
              </div>
              <div className="text-xs">
                {m.kind === 'human' ? (
                  <span className="text-zinc-400">Sees, searches and posts to every message{orgAdminHuman ? ' (org admin)' : !m.write && ' (read-only)'}</span>
                ) : r?.allowed ? (
                  <span className="text-green-400">
                    Read ✓ {wr?.allowed ? 'Write ✓' : <span className="text-zinc-500">Write ✗</span>}
                    {!wr?.allowed && <div className="text-2xs text-zinc-500">{wr?.reason}</div>}
                  </span>
                ) : (
                  <span className="text-red-400">
                    Blocked
                    <div className="text-2xs text-zinc-400">{r?.reason}</div>
                  </span>
                )}
              </div>
              <div className="text-right">
                {admin && (
                  <Menu
                    label={`Actions for ${principalName(d, p(m))}`}
                    items={[
                      m.role === 'admin'
                        ? { label: 'Remove admin', onClick: () => setPending({ kind: 'demote', m }) }
                        : { label: `Delegate admin to this ${m.kind}`, onClick: () => setPending({ kind: 'delegate', m }) },
                      m.kind === 'agent' ? { label: 'Rotate workspace token', onClick: () => setPending({ kind: 'rotate', m }) } : null,
                      { label: 'Remove from workspace', danger: true, onClick: () => setPending({ kind: 'remove', m }) },
                    ]}
                  />
                )}
              </div>
            </Row>
          )
        })}
      </Table>

      <AddMemberModal open={adding} onClose={() => setAdding(false)} onToken={(t, agentId) => showWsToken(w, agentId, t, 'Agent added')} />
      <MemberConfirm pending={pending} onClose={() => setPending(null)} />
    </div>
  )
}

/** Impact previews for the member ⋯ menu: delegation, removing admin, rotation and removal. */
function MemberConfirm({ pending, onClose }: { pending: Pending | null; onClose: () => void }) {
  const d = useDB()
  const w = useWorkspace()
  const m = pending?.m
  const name = m ? principalName(d, { kind: m.kind, id: m.id }) : ''
  // Demoting or removing the last explicit human admin is allowed: the org's Owners and userAdmins become default admins.
  const losesLastHuman = !!m && m.kind === 'human' && m.role === 'admin' && (pending?.kind === 'demote' || pending?.kind === 'remove') && !w.members.some((x) => x !== m && x.kind === 'human' && x.role === 'admin')
  const otherAdmins = w.members.filter((x) => x !== m && x.role === 'admin').map((x) => principalName(d, { kind: x.kind, id: x.id }))
  const defaultNames = orgAdmins(d).map((h) => h.name)
  const fallbackNote = losesLastHuman && (
    <Callout tone="neutral">
      {defaultNames.length > 1 ? `${defaultNames.slice(0, -1).join(', ')} and ${defaultNames[defaultNames.length - 1]}` : defaultNames[0]} (org admins) become this workspace’s default admins.
      {otherAdmins.length > 0 && ` ${otherAdmins.join(', ')} keep${otherAdmins.length === 1 ? 's' : ''} admin too, but a workspace is never administered by agents alone.`} The audit log records the fallback.
    </Callout>
  )
  const self = m?.kind === 'human' && m.id === d.currentUserId
  const p = m ? ({ kind: m.kind, id: m.id } as Principal) : null

  const spec: { title: string; rows: [string, ReactNode, ('amber' | 'red')?][]; body: ReactNode; confirm: string; tone: 'danger' | 'primary'; run: () => void } | null =
    !pending || !m || !p
      ? null
      : pending.kind === 'delegate'
        ? {
            title: `Delegate admin on ${w.name} to ${name}?`,
            rows: [
              ['Kind', m.kind],
              ['Can then', 'Add and remove members, delegate or remove admin, set the blocklist, rotate workspace tokens, expire any message, rotate listener passwords, read the audit log, change settings', 'amber'],
              ['Through', m.kind === 'agent' ? 'The REST API and MCP, with its own agent + workspace tokens' : 'The web app'],
              ['Audited as', m.kind === 'agent' ? `“${name} … — as delegated admin” (agent actions)` : `${name}’s own actions`],
            ],
            body: m.kind === 'agent' ? `${name} acts on its own, without a human in the loop. You can remove admin again from this menu.` : 'You can remove admin again from this menu.',
            confirm: 'Delegate admin',
            tone: 'primary',
            run: () => actions.setMember(w.id, p, { role: 'admin' }),
          }
        : pending.kind === 'demote'
          ? {
              title: `Remove admin from ${self ? 'yourself' : name}?`,
              rows: [
                ['Kind', m.kind],
                ['Role after', 'member — keeps its read and write access'],
                ['Explicit admins left', otherAdmins.join(', ') || '—'],
                ['Human admin', losesLastHuman ? `Default admins: ${defaultNames.join(', ')} (org Owners/userAdmins)` : 'Unchanged'],
                ['Admin rights they delegated', 'Stand — nothing cascades from losing admin'],
              ],
              body: (
                <div className="flex flex-col gap-2.5">
                  {self && <div>{ORG_ADMIN_ROLES.includes(me(d).roles[d.currentOrgId]) ? 'You keep admin here through your org role.' : 'You lose admin here as soon as you confirm.'}</div>}
                  {fallbackNote}
                </div>
              ),
              confirm: 'Remove admin',
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
                  if (t) showWsToken(w, m.id, t, 'Workspace token rotated', <>The old token works until {clock(Date.now() + 10 * 60_000)}. <Link to={`/workspaces/${w.id}/connect?agent=${m.id}`}>Open connection instructions →</Link></>)
                },
              }
            : {
                title: `Remove ${name} from ${w.name}?`,
                rows: [
                  ['Kind', m.kind],
                  ['Role', m.role + (m.delegatedBy ? ` (delegated by ${m.delegatedBy})` : '')],
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

/** Hands a freshly issued workspace token to the root secret host. */
export function showWsToken(w: { id: string; name: string }, agentId: string, token: string, title: string, note?: ReactNode) {
  const label = agentById(getDB(), agentId)?.label ?? agentId
  showSecret({
    kind: 'token',
    title,
    token,
    subtitle: (
      <span>
        <span className="font-mono">{label}</span> in {w.name}. This agent presents it together with its agent ID + agent token and <span className="font-mono">X-Dispatch-Workspace-Id: {w.id}</span>.
      </span>
    ),
    note: note ?? <Link to={`/workspaces/${w.id}/connect?agent=${agentId}`}>Open connection instructions →</Link>,
  })
}

function AddMemberModal({ open, onClose, onToken }: { open: boolean; onClose: () => void; onToken: (t: string, agentId: string) => void }) {
  const d = useDB()
  const w = useWorkspace()
  const [kind, setKind] = useState<'agent' | 'human'>('agent')
  const [id, setId] = useState('')
  const [role, setRole] = useState<MemberRole>('member')
  const [read, setRead] = useState(true)
  const [write, setWrite] = useState(true)
  const candidates = kind === 'agent' ? orgAgents(d).filter((a) => a.status !== 'revoked' && !w.members.some((m) => m.kind === 'agent' && m.id === a.id)) : orgHumans(d).filter((h) => !w.members.some((m) => m.kind === 'human' && m.id === h.id))
  useEffect(() => {
    if (open) {
      setRole('member')
      setRead(true)
      setWrite(true)
    }
  }, [open])
  useEffect(() => setId(candidates[0]?.id ?? ''), [kind, open]) // eslint-disable-line
  const a = kind === 'agent' ? agentById(d, id) : null
  const preCheck = a && (a.filters.workspaceBlocklist.includes(w.id) ? `${a.label} blocks this workspace on its own side — it will be a member but can’t get in.` : w.agentBlocklist.includes(a.id) ? `${a.label} is on this workspace’s blocklist — the block wins over membership.` : null)
  return (
    <Modal open={open} onClose={onClose} width={500} title={`Add to ${w.name}`}>
      <Segmented
        label="Kind of member"
        value={kind}
        onChange={setKind}
        options={[
          { value: 'agent', label: 'Agent' },
          { value: 'human', label: 'Human' },
        ]}
      />
      <Field label={kind === 'agent' ? 'Agent' : 'Person'}>
        {candidates.length ? (
          <Select value={id} onChange={(e) => setId(e.target.value)}>
            {candidates.map((c) => (
              <option key={c.id} value={c.id}>
                {'label' in c ? `${c.label} · ${c.harness} · ${c.id}` : `${c.name} · ${c.email}`}
              </option>
            ))}
          </Select>
        ) : (
          <div className="text-sm2 text-zinc-500">
            {kind === 'agent' ? (
              <>
                Every agent is already here. <Link to="/agents?new=1">Register a new agent</Link>
              </>
            ) : (
              <>
                Everyone is already here. <Link to="/people">Invite someone</Link>
              </>
            )}
          </div>
        )}
      </Field>
      <Field label="Role" hint={role === 'admin' ? `Delegated admin: can add and remove members, delegate admin, set the blocklist and manage webhooks${kind === 'agent' ? ' — over the API and MCP' : ''}.` : 'Reads and writes messages as allowed below.'}>
        <Segmented
          label="Role"
          value={role}
          onChange={setRole}
          options={[
            { value: 'member', label: 'Member' },
            { value: 'admin', label: 'Admin' },
          ]}
        />
      </Field>
      <div className="flex gap-6">
        <Checkbox checked={kind === 'human' || read} disabled={kind === 'human'} onChange={setRead} label={kind === 'human' ? 'Read (always, for humans)' : 'Read'} />
        <Checkbox checked={write} onChange={setWrite} label="Write" />
      </div>
      {preCheck && <Callout tone="amber">{preCheck}</Callout>}
      {kind === 'agent' && <div className="text-xs text-zinc-500">A workspace token is issued for this agent and shown once.</div>}
      <Footer>
        <Button size="lg" onClick={onClose}>
          Cancel
        </Button>
        <Button
          size="lg"
          variant="primary"
          disabled={!id}
          onClick={() => {
            const t = actions.addMember(w.id, { kind, id }, role, read, write)
            onClose()
            if (t) onToken(t, id)
          }}
        >
          Add {kind}
        </Button>
      </Footer>
    </Modal>
  )
}

/* ------------------------------------------------------------------ */
/* Access — blocklists, the ladder, and a checker                      */
/* ------------------------------------------------------------------ */
export function WsAccess() {
  const d = useDB()
  const w = useWorkspace()
  const admin = canAdmin(d, w)
  const agents = orgAgents(d)
  const [who, setWho] = useState(w.agentBlocklist[0] ?? w.members.find((m) => m.kind === 'agent')?.id ?? agents[0]?.id ?? '')
  const [op, setOp] = useState<Op>('read')
  const res = who ? evaluate(d, who, w.id, op) : null
  const memberAgents = w.members.filter((m) => m.kind === 'agent').map((m) => agentById(d, m.id)!).filter(Boolean)
  const selfBlocks = agents.filter((a) => a.filters.workspaceBlocklist.includes(w.id))
  const narrowed = memberAgents.filter((a) => !a.filters.read || !a.filters.write)
  const authorBlocks = memberAgents.filter((a) => a.filters.agentBlocklist.length)
  const firstFail = res?.steps.findIndex((s) => !s.pass) ?? -1
  const [pick, setPick] = useState('')
  const [confirmBlock, setConfirmBlock] = useState<string | null>(null)
  const blockee = confirmBlock ? agentById(d, confirmBlock) : undefined
  const blockeeMember = confirmBlock ? w.members.find((m) => m.kind === 'agent' && m.id === confirmBlock) : undefined

  return (
    <div className="mt-5 grid grid-cols-2 gap-5">
      <Card className="p-5">
        <div className="text-md font-semibold">Workspace blocklist</div>
        <div className="mt-1 text-xs2 leading-relaxed text-zinc-500">Agents listed here are refused in {w.name} — even with a valid membership and token. The block wins over any grant, and every refused attempt is logged.</div>
        <div className="mt-3 flex flex-wrap gap-2">
          {w.agentBlocklist.map((id) => (
            <span key={id} className="inline-flex items-center gap-2 rounded-full border border-red-500/30 bg-red-500/[0.06] px-2.5 py-1 text-xs">
              <span className="font-mono text-red-300">{agentById(d, id)?.label}</span>
              <span className="font-mono text-2xs text-zinc-500">{id}</span>
              {admin && (
                <button type="button" aria-label={`Unblock ${agentById(d, id)?.label ?? id}`} className="text-zinc-500 hover:text-zinc-200" onClick={() => actions.setWsBlocklist(w.id, w.agentBlocklist.filter((x) => x !== id))}>
                  ✕
                </button>
              )}
            </span>
          ))}
          {!w.agentBlocklist.length && <span className="text-sm2 text-zinc-500">No agents blocked.</span>}
        </div>
        {admin && (
          <div className="mt-3 flex items-center gap-2">
            <select aria-label="Block an agent" value={pick} onChange={(e) => setPick(e.target.value)} className="rounded-md border border-edge bg-page px-2.5 py-1.5 text-xs text-zinc-400 outline-none">
              <option value="">Choose an agent to block…</option>
              {agents
                .filter((a) => !w.agentBlocklist.includes(a.id))
                .map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.label} · {a.id}
                  </option>
                ))}
            </select>
            <Button size="sm" disabled={!pick} onClick={() => setConfirmBlock(pick)}>
              Block…
            </Button>
          </div>
        )}
        <ImpactDialog
          open={!!confirmBlock}
          onClose={() => setConfirmBlock(null)}
          title={`Block ${blockee?.label ?? ''} in ${w.name}?`}
          rows={[
            ['Membership', blockeeMember ? `${blockeeMember.role}${blockeeMember.role === 'admin' ? ' — loses admin here while blocked' : ''}` : 'Not a member', blockeeMember?.role === 'admin' ? 'red' : undefined],
            ['Workspace token', blockeeMember ? `${maskWsToken(blockeeMember.tokenLast4 ?? '')} — refused from now on (stays valid, the block wins)` : '—', blockeeMember ? 'amber' : undefined],
            ...(confirmBlock ? accessImpactRows(d, confirmBlock, w.id, true) : []),
            ['Connected', blockee && isOnline(blockee) ? 'Yes — its next request is refused' : 'No'],
          ]}
          body="Every refused attempt is logged with the rule. What it already received, read or acknowledged stays as recorded. Unblocking later doesn't bring back the messages filtered now."
          confirmLabel="Block agent"
          onConfirm={() => {
            if (!confirmBlock) return
            actions.setWsBlocklist(w.id, [...w.agentBlocklist, confirmBlock])
            setPick('')
          }}
        />
        <div className="mt-6 text-md font-semibold">Agent-side filters that touch this workspace</div>
        <div className="mt-1 text-xs2 text-zinc-500">Agents can narrow themselves. Their filters beat anything this workspace grants.</div>
        <ul className="mt-3 mb-0 flex list-none flex-col gap-2 pl-0 text-xs">
          {selfBlocks.map((a) => (
            <li key={a.id}>
              <Link to={`/agents/${a.id}`} className="font-mono">{a.label}</Link> <span className="text-zinc-400">blocks {w.name} — it can’t enter even though {w.members.some((m) => m.id === a.id) ? 'it’s a member' : 'it could be invited'}.</span>
            </li>
          ))}
          {narrowed.map((a) => (
            <li key={a.id}>
              <Link to={`/agents/${a.id}`} className="font-mono">{a.label}</Link> <span className="text-zinc-400">has turned {!a.filters.read ? 'reading' : 'writing'} off for itself.</span>
            </li>
          ))}
          {authorBlocks.map((a) => (
            <li key={a.id}>
              <Link to={`/agents/${a.id}`} className="font-mono">{a.label}</Link> <span className="text-zinc-400">doesn’t receive messages from {a.filters.agentBlocklist.map((id) => agentById(d, id)?.label).join(', ')}.</span>
            </li>
          ))}
          {!selfBlocks.length && !narrowed.length && !authorBlocks.length && <li className="text-zinc-500">None.</li>}
        </ul>
      </Card>

      <Card className="p-5">
        <div className="text-md font-semibold">Check access</div>
        <div className="mt-1 text-xs2 leading-relaxed text-zinc-500">Every agent request walks this ladder, top to bottom. The first rule that fails decides — and names itself in the 403 and the audit log.</div>
        <div className="mt-3 flex gap-2">
          <select aria-label="Agent" value={who} onChange={(e) => setWho(e.target.value)} className="flex-1 rounded-lg border border-zinc-700 bg-page px-2.5 py-2 font-mono text-xs text-zinc-200 outline-none">
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label} · {a.id}
              </option>
            ))}
          </select>
          <Segmented
            size="sm"
            label="Operation"
            value={op}
            onChange={setOp}
            options={[
              { value: 'read', label: 'read' },
              { value: 'write', label: 'write' },
              { value: 'admin', label: 'admin' },
            ]}
          />
        </div>
        {res && (
          <ol className="mt-4 mb-0 flex list-none flex-col gap-0 pl-0">
            {res.steps.map((s, i) => {
              const skipped = firstFail >= 0 && i > firstFail
              return (
                <li key={s.rule} className={cx('flex gap-3 border-l-2 py-1.5 pl-3', skipped ? 'border-line opacity-40' : s.pass ? 'border-green-500/50' : 'border-red-500')}>
                  <span className={cx('w-4 text-xs font-bold', skipped ? 'text-zinc-600' : s.pass ? 'text-green-400' : 'text-red-400')}>{skipped ? '·' : s.pass ? '✓' : '✗'}</span>
                  <span>
                    <span className="text-[13px] text-zinc-200">
                      {i + 1}. {s.rule}
                    </span>
                    <span className="block text-xs text-zinc-500">{skipped ? 'Not reached.' : s.detail}</span>
                  </span>
                </li>
              )
            })}
          </ol>
        )}
        {res && (
          <div className={cx('mt-3 rounded-lg border px-3.5 py-2.5 text-sm2', res.allowed ? 'border-green-500/30 bg-green-500/[0.06] text-green-400' : 'border-red-500/35 bg-red-500/[0.06] text-red-400')}>
            {res.allowed ? `Allowed — ${agentById(d, who)?.label} can ${op} in ${w.name}.` : `403 — ${res.reason}`}
          </div>
        )}
      </Card>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Connect — per agent, per harness                                    */
/* ------------------------------------------------------------------ */
const HARNESSES: (Harness | 'REST')[] = ['Claude Code', 'Codex', 'OpenCode', 'REST']

function configFor(h: Harness | 'REST', v: { agentId: string; agentToken: string; wsId: string; wsToken: string }) {
  const headers = { 'X-Dispatch-Agent-Id': v.agentId, Authorization: `Bearer ${v.agentToken}`, 'X-Dispatch-Workspace-Id': v.wsId, 'X-Dispatch-Workspace-Token': v.wsToken }
  const url = 'https://mcp.dispatch.dev/mcp'
  if (h === 'Claude Code') return { file: '.mcp.json', text: JSON.stringify({ mcpServers: { [`dispatch-${v.wsId}`]: { type: 'http', url, headers } } }, null, 2) }
  if (h === 'OpenCode') return { file: 'opencode.json', text: JSON.stringify({ $schema: 'https://opencode.ai/config.json', mcp: { [`dispatch-${v.wsId}`]: { type: 'remote', url, headers } } }, null, 2) }
  if (h === 'Codex')
    return {
      file: 'config.toml',
      text: `# ~/.codex/config.toml\n[mcp_servers.dispatch_${v.wsId}]\nurl = "${url}"\n\n[mcp_servers.dispatch_${v.wsId}.http_headers]\n${Object.entries(headers)
        .map(([k, x]) => `"${k}" = "${x}"`)
        .join('\n')}\n`,
    }
  return {
    file: 'dispatch.env',
    text: `# REST — see the API reference for every endpoint\nDISPATCH_API=https://api.dispatch.dev\nDISPATCH_AGENT_ID=${v.agentId}\nDISPATCH_AGENT_TOKEN=${v.agentToken}\nDISPATCH_WORKSPACE_ID=${v.wsId}\nDISPATCH_WORKSPACE_TOKEN=${v.wsToken}\n\n# curl "$DISPATCH_API/v1/workspaces/$DISPATCH_WORKSPACE_ID/messages?unread=true" \\\n#   -H "X-Dispatch-Agent-Id: $DISPATCH_AGENT_ID" \\\n#   -H "Authorization: Bearer $DISPATCH_AGENT_TOKEN" \\\n#   -H "X-Dispatch-Workspace-Id: $DISPATCH_WORKSPACE_ID" \\\n#   -H "X-Dispatch-Workspace-Token: $DISPATCH_WORKSPACE_TOKEN"\n`,
  }
}

function Masked({ text, masks }: { text: string; masks: string[] }) {
  const re = new RegExp(`(${masks.map((m) => m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'g')
  return (
    <pre className="m-0 max-h-80 overflow-auto rounded-lg border border-edge bg-rail px-4 py-3.5 font-mono text-xs2 leading-[1.7] text-zinc-400">
      {text.split(re).map((part, i) => (masks.includes(part) ? <span key={i} className="text-brass-light">{part}</span> : <span key={i}>{part}</span>))}
    </pre>
  )
}

export function WsConnect() {
  const d = useDB()
  const w = useWorkspace()
  const agents = w.members.filter((m) => m.kind === 'agent')
  const initial = new URLSearchParams(location.hash.split('?')[1] ?? '').get('agent')
  const [agentId, setAgentId] = useState(initial && agents.some((m) => m.id === initial) ? initial : (agents[0]?.id ?? ''))
  const a = agentById(d, agentId)
  const m = agents.find((x) => x.id === agentId)
  const [h, setH] = useState<Harness | 'REST'>(a?.harness === 'Other' ? 'REST' : (a?.harness ?? 'Claude Code'))
  const [waiting, setWaiting] = useState(false)
  const [template, setTemplate] = useState(false)
  const [rotating, setRotating] = useState<'agent' | 'ws' | null>(null)
  const timer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  useEffect(() => {
    if (a) setH(a.harness === 'Other' ? 'REST' : a.harness)
    setWaiting(false)
    setTemplate(false)
  }, [agentId]) // eslint-disable-line
  if (!agents.length)
    return (
      <Card className="mt-5 p-10 text-center text-[13px] text-zinc-400">
        No agents in this workspace yet. <Link to={`/workspaces/${w.id}/members`}>Add one on the Members tab.</Link>
      </Card>
    )
  if (!a || !m) return null
  const agentTok = sessionSecret(`agent:${a.id}`)
  const wsTok = sessionSecret(`ws:${w.id}:${a.id}`)
  const maskA = maskAgentToken(a.tokenLast4)
  const maskW = maskWsToken(m.tokenLast4 ?? '')
  const preview = configFor(h, { agentId: a.id, agentToken: agentTok ? maskA : '<AGENT_TOKEN>', wsId: w.id, wsToken: wsTok ? maskW : '<WORKSPACE_TOKEN>' })
  const access = evaluate(d, a.id, w.id, 'read')
  const queued = d.messages.filter((x) => x.wsId === w.id && x.receipts[a.id] && !x.receipts[a.id].deliveredAt && !x.receipts[a.id].filtered && !isExpired(x)).length
  // The file only works as-is when both tokens were issued in this tab; otherwise it's a template.
  const missing = [!agentTok && 'agent token', !wsTok && 'workspace token'].filter(Boolean) as string[]
  const canRotateAgent = isOrgAdmin(d) && a.status !== 'revoked'
  const canRotateWs = canAdmin(d, w)

  const download = () => {
    const cfg = configFor(h, { agentId: a.id, agentToken: agentTok ?? '<AGENT_TOKEN>', wsId: w.id, wsToken: wsTok ?? '<WORKSPACE_TOKEN>' })
    const url = URL.createObjectURL(new Blob([cfg.text], { type: 'text/plain' }))
    const el = document.createElement('a')
    el.href = url
    el.download = cfg.file
    el.click()
    URL.revokeObjectURL(url)
    setTemplate(missing.length > 0)
    if (!isOnline(a) && access.allowed && !missing.length) {
      setWaiting(true)
      window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => {
        actions.connectAgent(a.id)
        setWaiting(false)
      }, 4000)
    }
  }

  return (
    <div className="mt-5 grid grid-cols-[1fr_300px] gap-6">
      <div className="flex min-w-0 flex-col gap-4">
        <div className="flex items-end gap-4">
          <Field label="Agent">
            <Select value={agentId} onChange={(e) => setAgentId(e.target.value)} mono className="min-w-72">
              {agents.map((x) => (
                <option key={x.id} value={x.id}>
                  {agentById(d, x.id)?.label} · {x.id}
                </option>
              ))}
            </Select>
          </Field>
          <Segmented size="sm" label="Harness" value={h} onChange={setH} options={HARNESSES.map((x) => ({ value: x, label: x }))} className="mb-1" />
        </div>
        <div className="grid grid-cols-[170px_1fr_auto] items-center gap-x-4 gap-y-2 rounded-[10px] border border-edge bg-panel p-4 text-sm2">
          <span className="text-zinc-500">Agent ID</span>
          <span>
            <CopyChip value={a.id} variant="inline" />
          </span>
          <span />
          <span className="text-zinc-500">Agent token</span>
          <span>
            <span className="masked-token text-xs text-zinc-400">{maskA}</span>
            <span className={cx('ml-2 text-2xs', agentTok ? 'text-green-400' : 'text-amber-400')}>{agentTok ? 'issued in this tab — goes in the file' : 'not in this tab — placeholder in the file'}</span>
          </span>
          {canRotateAgent ? (
            <Button size="sm" onClick={() => setRotating('agent')}>
              Rotate agent token
            </Button>
          ) : (
            <span />
          )}
          <span className="text-zinc-500">Workspace ID</span>
          <span>
            <CopyChip value={w.id} variant="inline" />
          </span>
          <span />
          <span className="text-zinc-500">Workspace token</span>
          <span>
            <span className="masked-token text-xs text-zinc-400">{maskW}</span>
            <span className={cx('ml-2 text-2xs', wsTok ? 'text-green-400' : 'text-amber-400')}>{wsTok ? 'issued in this tab — goes in the file' : 'not in this tab — placeholder in the file'}</span>
          </span>
          {canRotateWs ? (
            <Button size="sm" onClick={() => setRotating('ws')}>
              Rotate workspace token
            </Button>
          ) : (
            <span />
          )}
        </div>
        <div className="flex items-center justify-between gap-4">
          <span className="text-xs font-medium text-zinc-300">{h === 'REST' ? 'Environment for REST calls' : `${h} · MCP server entry`}</span>
          <Button variant={missing.length ? 'secondary' : 'primary'} size="sm" onClick={download}>
            {missing.length ? `Download template — missing ${missing.length === 2 ? '2 tokens' : `the ${missing[0]}`}` : 'Download config'}
          </Button>
        </div>
        {template && missing.length > 0 && (
          <Callout tone="amber">
            That file is a template: it has {missing.map((x) => `<${x === 'agent token' ? 'AGENT_TOKEN' : 'WORKSPACE_TOKEN'}>`).join(' and ')} where the {missing.join(' and ')} go{missing.length === 1 ? 'es' : ''}. As-is, {a.label} gets 401. Paste the token{missing.length === 1 ? '' : 's'} you stored, or rotate {missing.length === 1 ? 'it' : 'them'} above and download again.
          </Callout>
        )}
        <Masked text={preview.text} masks={[maskA, maskW]} />
        <div className="text-xs2 text-zinc-500">
          {agentTok && wsTok ? 'Both tokens were issued in this session, so the downloaded file has them filled in. On screen they stay masked.' : 'Tokens are shown once, when issued. The file has placeholders for any token not issued in this session — paste the ones you stored, or rotate to get new ones.'}{' '}
          An agent in several workspaces adds one server entry per workspace, or passes <span className="font-mono">workspace_id</span> + <span className="font-mono">workspace_token</span> on each tool call.
        </div>
        <Link to="/developers" className="text-sm2">
          Full API & MCP reference (Swagger) →
        </Link>
      </div>
      <div className="flex flex-col gap-3">
        {!access.allowed ? (
          <div className="rounded-[10px] border border-red-500/35 bg-red-500/[0.06] p-4">
            <div className="text-[13px] font-semibold text-red-400">This agent can’t get in</div>
            <div className="mt-1 text-xs text-zinc-300">{access.reason}</div>
            <Link to={`/workspaces/${w.id}/access`} className="mt-2 inline-block text-xs">
              Check access →
            </Link>
          </div>
        ) : isOnline(a) ? (
          <div className="flex items-start gap-3 rounded-[10px] border border-green-500/30 bg-green-500/[0.06] p-4">
            <DispatchMark size={20} />
            <div>
              <div className="text-[13px] font-semibold text-green-400">{a.label} is connected</div>
              <div className="mt-0.5 text-xs text-zinc-400">
                Last heartbeat {ago(a.lastSeen).toLowerCase()} · {queued ? `${plural(queued, 'message')} still queued` : 'nothing queued'}
              </div>
              <button className="mt-2 text-xs text-zinc-500 hover:text-zinc-300" onClick={() => actions.connectAgent(a.id, false)}>
                Simulate disconnect
              </button>
            </div>
          </div>
        ) : (
          <div className="flex items-start gap-3 rounded-[10px] border border-edge bg-rail p-4">
            <DispatchMark size={20} pulse />
            <div>
              <div className="text-[13px] font-semibold">{waiting ? `Waiting for ${a.label} to connect…` : `${a.label} isn’t connected`}</div>
              <div className="mt-0.5 text-xs text-zinc-500">{queued ? `${plural(queued, 'message')} queued for it — delivered the moment it connects.` : 'Nothing queued for it yet.'}</div>
              {!waiting && a.status === 'active' && !missing.length && (
                <button className="mt-2 text-xs text-signal hover:text-signal-light" onClick={() => actions.connectAgent(a.id)}>
                  Simulate the agent connecting
                </button>
              )}
              {!waiting && a.status === 'active' && missing.length > 0 && (
                <div className="mt-2 text-xs text-zinc-500">
                  This tab doesn’t hold its {missing.join(' or ')}, so a downloaded file can’t connect it.{' '}
                  <button className="text-zinc-400 underline decoration-dotted hover:text-zinc-200" onClick={() => actions.connectAgent(a.id)}>
                    Prototype: simulate it connecting with tokens stored elsewhere
                  </button>
                </div>
              )}
            </div>
          </div>
        )}
        <ImpactDialog
          open={!!rotating}
          onClose={() => setRotating(null)}
          title={rotating === 'agent' ? `Rotate ${a.label}’s agent token?` : `Rotate ${a.label}’s workspace token for ${w.name}?`}
          rows={
            rotating === 'agent'
              ? [
                  ['Current token', `${maskA} — keeps working for 10 minutes`, 'amber'],
                  ['Affects', `Every workspace ${a.label} is in — it’s the same agent token everywhere`],
                  ['Workspace tokens', 'Unchanged'],
                ]
              : [
                  ['Current token', `${maskW} — keeps working for 10 minutes`, 'amber'],
                  ['Affects', `${a.label} in ${w.name} only`],
                  ['Agent token', 'Unchanged'],
                ]
          }
          body="The new token is shown once, and this page puts it in the downloaded file."
          confirmLabel="Rotate token"
          onConfirm={() => {
            if (rotating === 'agent') {
              const t = actions.rotateAgentToken(a.id)
              if (t) showSecret({ kind: 'token', title: 'Agent token rotated', token: t, subtitle: `${a.label} · ${a.id}`, note: 'The old token keeps working for 10 minutes. Download the config again to get a file with it.' })
            } else {
              const t = actions.rotateMemberToken(w.id, a.id)
              if (t) showWsToken(w, a.id, t, 'Workspace token rotated', 'The old token keeps working for 10 minutes. Download the config again to get a file with it.')
            }
            setTemplate(false)
          }}
        />
        <Card className="p-4 text-xs2 leading-relaxed text-zinc-500">
          <div className="mb-1 flex items-center gap-2 font-semibold text-zinc-300">
            <KeyholeIcon size={12} /> Two credentials, two flows
          </div>
          <span className="font-mono">agent ID + agent token</span> alone opens the agent-only flows (who am I, my workspaces, my filters). Add <span className="font-mono">workspace ID + workspace token</span> to act inside {w.name}.
        </Card>
      </div>
    </div>
  )
}

