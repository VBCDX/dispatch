// The workspace Members and Access tabs, ported from the mock
// (mocks/v1/src/pages/wsAccess.tsx). Workspace tokens are issued on the
// Connect tab (the messaging issue), so adding an agent here doesn't show
// one.
import { useEffect, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { manage, type Agent, type Ladder, type LadderOp, type Member, type Person, type WorkspaceRole } from '../api'
import { Callout, Checkbox, Footer, FormField, ImpactDialog, Menu, Modal, Panel, PrincipalChip, Segmented, Select, Toggle, ago, errorText, type ImpactRow } from '../kit'
import { useLoad, useSession } from '../session'
import { Button, ErrorBox, Pill, Row, SkeletonRows, Table, cx } from '../ui'
import { useWorkspace } from './workspaces'

const M_COLS = '1.6fr 1.1fr 60px 60px 1.3fr 36px'
const roleLabel = (r: WorkspaceRole) => (r === 'workspace_admin' ? 'admin' : 'member')
const access = (read: boolean, write: boolean) => [read && 'read', write && 'write'].filter(Boolean).join(' + ') || 'none'

type Pending = { kind: 'delegate' | 'demote' | 'remove' | 'read' | 'write'; m: Member }

export function WsMembers() {
  const { me } = useSession()
  const { org, ws, reload } = useWorkspace()
  const [list, retry] = useLoad(() => manage.members(org.id, ws.id), [org.id, ws.id])
  const [adding, setAdding] = useState(false)
  const [pending, setPending] = useState<Pending | null>(null)
  const [error, setError] = useState<string | null>(null)
  if (list.state === 'loading')
    return (
      <div className="mt-5">
        <Table cols={M_COLS} head={['Member', 'Role', 'Read', 'Write', 'Workspace token', '']}>
          <SkeletonRows cols={M_COLS} />
        </Table>
      </div>
    )
  if (list.state === 'error') return <div className="mt-5"><ErrorBox what="members" onRetry={retry} /></div>
  const { members, default_admins: defaults, can_admin: admin } = list.data
  const after = () => {
    retry()
    reload()
  }
  const set = async (m: Member, p: { read?: boolean; write?: boolean }) => {
    setError(null)
    try {
      await manage.updateMember(me.csrf_token, org.id, ws.id, m.id, p)
      after()
    } catch (err) {
      setError(errorText(err))
    }
  }
  const sorted = [...members].sort((a, b) => (a.kind === b.kind ? (a.role === b.role ? 0 : a.role === 'workspace_admin' ? -1 : 1) : a.kind === 'user' ? -1 : 1))
  const defaultRows = defaults.filter((d) => !members.some((m) => m.kind === 'user' && m.member_id === d.user_id))
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
          No active human is admin of {ws.name} explicitly, so the organization’s Owners and userAdmins — {defaults.map((d) => d.name).join(', ')} — are its default admins. Delegate admin to a person here to set one explicitly.
        </Callout>
      )}
      {error && (
        <Callout tone="red" className="mt-4">
          {error}
        </Callout>
      )}
      <Table cols={M_COLS} head={['Member', 'Role', 'Read', 'Write', 'Workspace token', '']} className="mt-4">
        {defaultRows.map((d) => (
          <Row key={'default' + d.user_id} cols={M_COLS} className="bg-white/[0.01]">
            <div className="min-w-0">
              <PrincipalChip kind="user" name={d.name} withKind />
              <div className="mt-0.5 pl-[30px] text-2xs text-zinc-600">{d.email}</div>
            </div>
            <div>
              <Pill tone="green">default admin</Pill>
              <div className="mt-0.5 text-2xs text-zinc-500">org {d.org_role}</div>
            </div>
            <span className="text-2xs text-zinc-500">Always</span>
            <span className="text-2xs text-zinc-500">Always</span>
            <span className="text-2xs text-zinc-600">Not a member — can’t be removed here</span>
            <span />
          </Row>
        ))}
        {sorted.map((m) => {
          const agent = m.kind === 'agent'
          const orgAdminHuman = !agent && (m.org_role === 'Owner' || m.org_role === 'userAdmin') && m.org_status === 'active'
          const grace = m.token?.previous && m.token.previous_until && Date.parse(m.token.previous_until) > Date.now()
          return (
            <Row key={m.id} cols={M_COLS}>
              <div className="min-w-0">
                <PrincipalChip kind={m.kind} name={m.name} withKind dim={agent && m.agent_status !== 'active'} />
                <div className="mt-0.5 truncate pl-[30px] text-2xs text-zinc-600">
                  {agent ? (
                    <>
                      <Link to={`/agents/${m.member_id}`} className="font-mono text-zinc-600 hover:text-zinc-400">
                        {m.member_id}
                      </Link>
                      {' · '}
                      {!m.client ? 'not connected yet' : m.client.via === 'REST' ? 'REST' : `${m.client.name}${m.client.version ? ` ${m.client.version}` : ''} · MCP`}
                      {' · '}
                      {m.agent_status !== 'active' ? m.agent_status : m.last_seen_at ? `seen ${ago(m.last_seen_at).toLowerCase()}` : 'never seen'}
                    </>
                  ) : (
                    m.email
                  )}
                </div>
              </div>
              <div>
                <Pill tone={m.role === 'workspace_admin' ? 'green' : 'neutral'}>{roleLabel(m.role)}</Pill>
                {!agent && m.org_status && m.org_status !== 'active' && <div className="mt-0.5 text-2xs text-amber-400">{m.org_status} — can’t act</div>}
                {m.delegated_by && <div className="mt-0.5 text-2xs text-zinc-500">delegated by {m.delegated_by.label}</div>}
              </div>
              <div>{agent ? <Toggle on={m.read} disabled={!admin} label={`Read for ${m.name}`} onChange={(v) => (v ? set(m, { read: true }) : setPending({ kind: 'read', m }))} /> : <span className="text-2xs text-zinc-500" title="Humans in a workspace always see every message">Always</span>}</div>
              <div title={orgAdminHuman ? `${m.org_role}: org admins can always write in every workspace` : undefined}>
                <Toggle on={m.write || orgAdminHuman} disabled={!admin || orgAdminHuman} label={`Write for ${m.name}`} onChange={(v) => (v ? set(m, { write: true }) : setPending({ kind: 'write', m }))} />
                {orgAdminHuman && <div className="mt-0.5 text-2xs text-zinc-600">org admin</div>}
              </div>
              <div className="text-xs text-zinc-400">
                {!agent ? (
                  <span className="text-zinc-600">Signs in to the web app</span>
                ) : m.token_revoked ? (
                  <span className="text-red-400">Revoked</span>
                ) : m.token ? (
                  <span className="masked-token">
                    {m.token.current.prefix}••••{m.token.current.last4}
                    {grace && <div className="font-sans text-2xs tracking-normal text-amber-400">old ••••{m.token.previous!.last4} works until {new Date(m.token.previous_until!).toLocaleTimeString()}</div>}
                  </span>
                ) : (
                  <span>
                    <span className="text-amber-400">No workspace token yet</span>
                    <Link to={`/workspaces/${ws.id}/connect?agent=${m.member_id}`} className="block text-2xs">
                      Create one on the Connect tab →
                    </Link>
                  </span>
                )}
              </div>
              <div className="text-right">
                {admin && (
                  <Menu
                    label={`Actions for ${m.name}`}
                    items={[
                      m.role === 'workspace_admin' ? { label: 'Remove admin', onClick: () => setPending({ kind: 'demote', m }) } : { label: `Delegate admin to this ${agent ? 'agent' : 'person'}`, onClick: () => setPending({ kind: 'delegate', m }) },
                      { label: 'Remove from workspace', danger: true, onClick: () => setPending({ kind: 'remove', m }) },
                    ]}
                  />
                )}
              </div>
            </Row>
          )
        })}
        {!members.length && !defaultRows.length && <div className="p-8 text-center text-sm2 text-zinc-500">No members yet.</div>}
      </Table>
      <AddMemberModal open={adding} onClose={() => setAdding(false)} existing={members} onAdded={after} />
      <MemberConfirm pending={pending} onClose={() => setPending(null)} members={members} defaults={defaults.map((d) => d.name)} onDone={after} />
    </div>
  )
}

/** Confirm dialogs for the member ⋯ menu and for turning access off. */
function MemberConfirm({ pending, onClose, members, defaults, onDone }: { pending: Pending | null; onClose: () => void; members: Member[]; defaults: string[]; onDone: () => void }) {
  const { me } = useSession()
  const { org, ws } = useWorkspace()
  const m = pending?.m
  const self = m?.kind === 'user' && m.member_id === me.user.id
  const losesLastHuman = !!m && m.kind === 'user' && m.role === 'workspace_admin' && (pending?.kind === 'demote' || pending?.kind === 'remove') && !members.some((x) => x !== m && x.kind === 'user' && x.role === 'workspace_admin' && x.org_status === 'active')
  const fallback = losesLastHuman && <Callout tone="neutral">The organization’s Owners and userAdmins become this workspace’s default admins{defaults.length ? '' : ' once it has no explicit human admin'}. A workspace is never administered by agents alone.</Callout>
  const update = (p: { role?: WorkspaceRole; read?: boolean; write?: boolean }) => async () => {
    await manage.updateMember(me.csrf_token, org.id, ws.id, m!.id, p)
    onDone()
  }
  let spec: { title: string; rows: ImpactRow[]; body?: ReactNode; confirm: string; danger: boolean; run: () => Promise<unknown> } | null = null
  if (pending && m) {
    switch (pending.kind) {
      case 'delegate':
        spec = {
          title: `Delegate admin on ${ws.name} to ${m.name}?`,
          rows: [
            ['Kind', m.kind === 'agent' ? 'agent' : 'human'],
            ['Can then', 'Add and remove members, delegate or remove admin, set the blocklist, change settings, read the audit log', 'amber'],
            ['Through', m.kind === 'agent' ? 'The REST API and MCP, with its own agent + workspace tokens' : 'The web app'],
          ],
          body: m.kind === 'agent' ? `${m.name} acts on its own, without a human in the loop. You can remove admin again from this menu.` : 'You can remove admin again from this menu.',
          confirm: 'Delegate admin',
          danger: false,
          run: update({ role: 'workspace_admin' }),
        }
        break
      case 'demote':
        spec = {
          title: `Remove admin from ${self ? 'yourself' : m.name}?`,
          rows: [
            ['Role after', 'member — keeps its read and write access'],
            ['Admin rights they delegated', 'Stand — nothing cascades from losing admin'],
          ],
          body: (
            <div className="flex flex-col gap-2.5">
              {self && <div>{org.role === 'Owner' || org.role === 'userAdmin' ? 'You keep admin here through your org role.' : 'You lose admin here as soon as you confirm.'}</div>}
              {fallback}
            </div>
          ),
          confirm: 'Remove admin',
          danger: true,
          run: update({ role: 'member' }),
        }
        break
      case 'read':
        spec = {
          title: `Turn off reading for ${m.name} in ${ws.name}?`,
          rows: [
            ['Read', 'on → off', 'amber'],
            ['Write', m.write ? 'on → off — writing without reading makes no sense' : 'already off', m.write ? 'amber' : undefined],
          ],
          body: 'Reversible: turn Read (or Write, which turns Read back on too) on again. Nothing already recorded changes.',
          confirm: 'Turn off read',
          danger: true,
          run: update({ read: false }),
        }
        break
      case 'write':
        spec = {
          title: `Turn off writing for ${m.name} in ${ws.name}?`,
          rows: [
            ['Can no longer', m.kind === 'agent' ? 'Send messages, retry webhooks, write shared context' : 'Post, retry webhooks, edit shared context', 'amber'],
            ['Still can', m.kind === 'agent' ? 'Read what’s addressed to it' : 'See and search every message'],
            ['Already sent', 'Stays as it is'],
          ],
          body: 'Reversible: turn Write back on at any time.',
          confirm: 'Turn off write',
          danger: true,
          run: update({ write: false }),
        }
        break
      case 'remove':
        spec = {
          title: `Remove ${self ? 'yourself' : m.name} from ${ws.name}?`,
          rows: [
            ['Kind', m.kind === 'agent' ? 'agent' : 'human'],
            ['Role', roleLabel(m.role) + (m.delegated_by ? ` (delegated by ${m.delegated_by.label})` : '')],
            ['Access', access(m.read, m.write)],
            ...(m.kind === 'agent' ? ([['Workspace token', m.token ? `••••${m.token.current.last4} — stops working immediately` : 'None issued', m.token ? 'amber' : undefined]] as ImpactRow[]) : []),
          ],
          body: (
            <div className="flex flex-col gap-2.5">
              <div>Its past messages and receipts stay in the workspace and the audit log. Admin rights it delegated stand.</div>
              {fallback}
            </div>
          ),
          confirm: 'Remove member',
          danger: true,
          run: async () => {
            await manage.removeMember(me.csrf_token, org.id, ws.id, m.id)
            onDone()
          },
        }
    }
  }
  return <ImpactDialog open={!!spec} onClose={onClose} title={spec?.title ?? ''} rows={spec?.rows ?? []} body={spec?.body} confirmLabel={spec?.confirm ?? ''} danger={spec?.danger} onConfirm={spec?.run ?? (async () => undefined)} />
}

type Candidates = { people: Person[]; agents: Agent[] }

function AddMemberModal({ open, onClose, existing, onAdded }: { open: boolean; onClose: () => void; existing: Member[]; onAdded: () => void }) {
  const { me } = useSession()
  const { org, ws } = useWorkspace()
  const [cands] = useLoad<Candidates | null>(open ? () => Promise.all([manage.people(org.id), manage.agents(org.id)]).then(([p, a]) => ({ people: p.people, agents: a })) : null, [open, org.id])
  const [kind, setKind] = useState<'agent' | 'user'>('agent')
  const [id, setId] = useState('')
  const [role, setRole] = useState<WorkspaceRole>('member')
  const [read, setRead] = useState(true)
  const [write, setWrite] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const ready = open && cands.state === 'ready' && cands.data
  const options = !ready
    ? []
    : kind === 'agent'
      ? ready.agents.filter((a) => a.status !== 'revoked' && !existing.some((m) => m.kind === 'agent' && m.member_id === a.id)).map((a) => ({ id: a.id, label: `${a.label} · ${a.id}` }))
      : ready.people.filter((p) => p.status !== 'suspended' && !existing.some((m) => m.kind === 'user' && m.member_id === p.user_id)).map((p) => ({ id: p.user_id, label: `${p.name || p.email} · ${p.email}${p.status === 'invited' ? ' (invited)' : ''}` }))
  useEffect(() => {
    if (open) {
      setRole('member')
      setRead(true)
      setWrite(true)
      setError(null)
      setBusy(false)
    }
  }, [open])
  const first = options[0]?.id ?? ''
  useEffect(() => setId(first), [kind, first])
  const picked = ready && kind === 'agent' ? ready.agents.find((a) => a.id === id) : undefined
  const preCheck = picked?.filters.workspace_blocklist.some((x) => x.id === ws.id) ? `${picked.label} blocks this workspace on its own side — it will be a member but can’t get in.` : null
  async function add() {
    setBusy(true)
    setError(null)
    try {
      await manage.addMember(me.csrf_token, org.id, ws.id, { kind, id, role, read: kind === 'user' || read || write, write })
      onClose()
      onAdded()
    } catch (err) {
      setError(errorText(err))
      setBusy(false)
    }
  }
  return (
    <Modal open={open} onClose={onClose} width={500} title={`Add to ${ws.name}`}>
      <Segmented label="Kind of member" value={kind} onChange={setKind} options={[{ value: 'agent', label: 'Agent' }, { value: 'user', label: 'Human' }]} />
      <FormField label={kind === 'agent' ? 'Agent' : 'Person'}>
        {cands.state === 'loading' ? (
          <div className="skeleton h-9" aria-busy="true" aria-label="Loading" />
        ) : cands.state === 'error' ? (
          <div className="text-sm2 text-red-400">Couldn’t load the organization’s {kind === 'agent' ? 'agents' : 'people'}.</div>
        ) : options.length ? (
          <Select value={id} onChange={(e) => setId(e.target.value)} mono={kind === 'agent'}>
            {options.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </Select>
        ) : (
          <div className="text-sm2 text-zinc-500">
            {kind === 'agent' ? 'Every agent in the organization is already here.' : (
              <>
                Everyone is already here. <Link to="/people">Invite someone</Link>
              </>
            )}
          </div>
        )}
      </FormField>
      <FormField label="Role" hint={role === 'workspace_admin' ? `Delegated admin: can add and remove members, delegate admin, set the blocklist and change settings${kind === 'agent' ? ' — over the API and MCP' : ''}.` : 'Reads and writes messages as allowed below.'}>
        <Segmented label="Role" value={role} onChange={setRole} options={[{ value: 'member', label: 'Member' }, { value: 'workspace_admin', label: 'Admin' }]} />
      </FormField>
      <div className="flex gap-6">
        <Checkbox checked={kind === 'user' || read || write} disabled={kind === 'user' || write} onChange={setRead} label={kind === 'user' ? 'Read (always, for humans)' : 'Read'} />
        <Checkbox checked={write} onChange={setWrite} label="Write" />
      </div>
      {preCheck && <Callout tone="amber">{preCheck}</Callout>}
      {kind === 'agent' && <div className="text-xs text-zinc-500">Its workspace token is created on the Connect tab and shown once there.</div>}
      {error && <Callout tone="red">{error}</Callout>}
      <Footer>
        <Button size="lg" onClick={onClose}>
          Cancel
        </Button>
        <Button size="lg" variant="primary" disabled={!id || busy} onClick={add}>
          {busy ? 'Adding…' : `Add ${kind === 'agent' ? 'agent' : 'human'}`}
        </Button>
      </Footer>
    </Modal>
  )
}

/* ------------------------------------------------------------------ */
/* Access — the blocklist, agent-side filters and the access checker   */
/* ------------------------------------------------------------------ */
export function WsAccess() {
  const { me } = useSession()
  const { org, ws, reload } = useWorkspace()
  const [data, retry] = useLoad(() => manage.access(org.id, ws.id), [org.id, ws.id])
  const [pick, setPick] = useState('')
  const [confirm, setConfirm] = useState<{ id: string; label: string; block: boolean } | null>(null)
  const [who, setWho] = useState('')
  const [op, setOp] = useState<LadderOp>('read')
  const ready = data.state === 'ready' ? data.data : null
  useEffect(() => {
    if (ready && !who) setWho(ready.blocklist[0]?.id ?? ready.agents[0]?.id ?? '')
  }, [ready, who])
  const [ladder] = useLoad<Ladder>(who ? () => manage.checkAccess(org.id, ws.id, who, op) : null, [who, op, ws])
  if (data.state === 'loading') return <div className="mt-5 skeleton h-40" aria-busy="true" aria-label="Loading" />
  if (data.state === 'error' || !ready) return <div className="mt-5"><ErrorBox what="access settings" onRetry={retry} /></div>
  const { blocklist, agent_filters: notes, agents, can_admin: admin } = ready
  const firstFail = ladder.state === 'ready' ? ladder.data.steps.findIndex((s) => !s.pass) : -1
  return (
    <div className="mt-5 grid grid-cols-2 gap-5">
      <Panel className="p-5">
        <div className="text-md font-semibold">Workspace blocklist</div>
        <div className="mt-1 text-xs2 leading-relaxed text-zinc-500">Agents listed here are refused in {ws.name} — even with a valid membership and token. The block wins over any grant, and every refused attempt is logged.</div>
        <div className="mt-3 flex flex-wrap gap-2">
          {blocklist.map((a) => (
            <span key={a.id} className="inline-flex items-center gap-2 rounded-full border border-red-500/30 bg-red-500/[0.06] px-2.5 py-1 text-xs">
              <span className="font-mono text-red-300">{a.label}</span>
              <span className="font-mono text-2xs text-zinc-500">{a.id}</span>
              {admin && (
                <button type="button" aria-label={`Unblock ${a.label}`} className="text-zinc-500 hover:text-zinc-200" onClick={() => setConfirm({ ...a, block: false })}>
                  ✕
                </button>
              )}
            </span>
          ))}
          {!blocklist.length && <span className="text-sm2 text-zinc-500">No agents blocked.</span>}
        </div>
        {admin && (
          <div className="mt-3 flex items-center gap-2">
            <select aria-label="Block an agent" value={pick} onChange={(e) => setPick(e.target.value)} className="rounded-md border border-edge bg-page px-2.5 py-1.5 text-xs text-zinc-400 outline-none">
              <option value="">Choose an agent to block…</option>
              {agents
                .filter((a) => !blocklist.some((b) => b.id === a.id))
                .map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.label} · {a.id}
                  </option>
                ))}
            </select>
            <Button size="sm" disabled={!pick} onClick={() => setConfirm({ id: pick, label: agents.find((a) => a.id === pick)?.label ?? pick, block: true })}>
              Block…
            </Button>
          </div>
        )}
        <div className="mt-6 text-md font-semibold">Agent-side filters that touch this workspace</div>
        <div className="mt-1 text-xs2 text-zinc-500">Agents can narrow themselves. Their filters beat anything this workspace grants.</div>
        <ul className="mt-3 mb-0 flex list-none flex-col gap-2 pl-0 text-xs">
          {notes.map((n) => (
            <li key={n.id}>
              <Link to={`/agents/${n.id}`} className="font-mono">
                {n.label}
              </Link>{' '}
              <span className="text-zinc-400">
                {[
                  n.blocks_workspace && `blocks ${ws.name} — it can’t enter even though ${n.member ? 'it’s a member' : 'it could be invited'}`,
                  (!n.read || !n.write) && `has turned ${!n.read ? 'reading' : 'writing'} off for itself`,
                  n.blocks_authors.length > 0 && `doesn’t receive messages from ${n.blocks_authors.join(', ')}`,
                ]
                  .filter(Boolean)
                  .join('; ')}
                .
              </span>
            </li>
          ))}
          {!notes.length && <li className="text-zinc-500">None.</li>}
        </ul>
      </Panel>

      <Panel className="p-5">
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
          <Segmented size="sm" label="Operation" value={op} onChange={setOp} options={[{ value: 'read', label: 'read' }, { value: 'write', label: 'write' }, { value: 'admin', label: 'admin' }]} />
        </div>
        {!agents.length && <div className="mt-4 text-sm2 text-zinc-500">No agents in this organization yet.</div>}
        {ladder.state === 'ready' && (
          <>
            <ol className="mt-4 mb-0 flex list-none flex-col gap-0 pl-0">
              {ladder.data.steps.map((s, i) => {
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
            <div className={cx('mt-3 rounded-lg border px-3.5 py-2.5 text-sm2', ladder.data.allowed ? 'border-green-500/30 bg-green-500/[0.06] text-green-400' : 'border-red-500/35 bg-red-500/[0.06] text-red-400')}>
              {ladder.data.allowed ? `Allowed — ${agents.find((a) => a.id === who)?.label} can ${op} in ${ws.name}.` : `403 — ${ladder.data.reason}`}
            </div>
          </>
        )}
        {ladder.state === 'error' && <div className="mt-4 text-sm2 text-red-400">Couldn’t check access.</div>}
      </Panel>
      <ImpactDialog
        open={!!confirm}
        onClose={() => setConfirm(null)}
        title={confirm?.block ? `Block ${confirm.label} in ${ws.name}?` : `Unblock ${confirm?.label} in ${ws.name}?`}
        rows={
          confirm?.block
            ? [
                ['Membership', 'Kept, but refused while blocked — the block wins', 'amber'],
                ['Workspace token', 'Stays valid, refused from now on'],
              ]
            : [['Membership', 'Its membership and token work again']]
        }
        body={confirm?.block ? 'Every refused attempt is logged with the rule. What it already received, read or acknowledged stays as recorded.' : 'Messages filtered while it was blocked don’t come back.'}
        confirmLabel={confirm?.block ? 'Block agent' : 'Unblock agent'}
        danger={!!confirm?.block}
        onConfirm={async () => {
          await manage.setBlocked(me.csrf_token, org.id, ws.id, confirm!.id, confirm!.block)
          setPick('')
          retry()
          setWho(confirm!.id)
          reload()
        }}
      />
    </div>
  )
}
