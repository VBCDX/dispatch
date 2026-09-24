import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { evaluate, type Op } from '../lib/access'
import { ago, maskAgentToken, maskWsToken, plural } from '../lib/format'
import { actions, agentById, canAdmin, humanById, isOnline, orgAgents, orgHumans, principalName, sessionSecret, useDB, useNow } from '../lib/store'
import type { Harness, Membership, MemberRole, Principal } from '../lib/types'
import { CopyChip, DispatchMark, KeyholeIcon, TokenPanel } from '../components/credential'
import { ImpactDialog, PrincipalChip } from '../components/shared'
import { Button, Callout, Card, Checkbox, Field, Footer, Menu, Modal, Pill, Row, Segmented, Select, Table, Toggle, cx } from '../components/ui'
import { useWorkspace } from './workspaces'

/* ------------------------------------------------------------------ */
/* Members                                                             */
/* ------------------------------------------------------------------ */
const M_COLS = '1.6fr 1.1fr 60px 60px 1.2fr 1.6fr 36px'

export function WsMembers() {
  const d = useDB()
  const w = useWorkspace()
  const now = useNow()
  const admin = canAdmin(d, w)
  const [adding, setAdding] = useState(false)
  const [token, setToken] = useState<{ title: string; token: string; agentId: string } | null>(null)
  const [removing, setRemoving] = useState<Membership | null>(null)
  const sorted = [...w.members].sort((a, b) => (a.kind === b.kind ? (a.role === b.role ? 0 : a.role === 'admin' ? -1 : 1) : a.kind === 'human' ? -1 : 1))
  const p = (m: Membership): Principal => ({ kind: m.kind, id: m.id })
  const admins = w.members.filter((m) => m.role === 'admin')

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
      <Table cols={M_COLS} head={['Member', 'Role', 'Read', 'Write', 'Workspace token', 'Effective access', '']} className="mt-4">
        {sorted.map((m) => {
          const a = m.kind === 'agent' ? agentById(d, m.id) : null
          const h = m.kind === 'human' ? humanById(d, m.id) : null
          const r = a ? evaluate(d, a.id, w.id, 'read') : null
          const wr = a ? evaluate(d, a.id, w.id, 'write') : null
          const lastAdmin = m.role === 'admin' && admins.length === 1
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
                {m.delegatedBy && <div className="mt-0.5 text-2xs text-zinc-500">delegated by {m.delegatedBy}</div>}
              </div>
              <div>
                {m.kind === 'human' ? <span className="text-2xs text-zinc-500" title="Humans in a workspace always see every message">Always</span> : <Toggle on={m.read} disabled={!admin} label={`Read for ${principalName(d, p(m))}`} onChange={(v) => actions.setMember(w.id, p(m), { read: v })} />}
              </div>
              <div>
                <Toggle on={m.write} disabled={!admin} label={`Write for ${principalName(d, p(m))}`} onChange={(v) => actions.setMember(w.id, p(m), { write: v })} />
              </div>
              <div className="masked-token text-xs text-zinc-400">{m.kind === 'agent' ? maskWsToken(m.tokenLast4 ?? '????') : <span className="font-sans tracking-normal text-zinc-600">Signs in with SSO</span>}</div>
              <div className="text-xs">
                {m.kind === 'human' ? (
                  <span className="text-zinc-400">Sees, searches and posts to every message{!m.write && ' (read-only)'}</span>
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
                    items={[
                      m.role === 'admin'
                        ? { label: 'Remove admin', disabled: lastAdmin, onClick: () => actions.setMember(w.id, p(m), { role: 'member' }) }
                        : { label: `Delegate admin to this ${m.kind}`, onClick: () => actions.setMember(w.id, p(m), { role: 'admin' }) },
                      m.kind === 'agent' ? { label: 'Rotate workspace token', onClick: () => setToken({ title: 'Workspace token rotated', token: actions.rotateMemberToken(w.id, m.id), agentId: m.id }) } : null,
                      { label: 'Remove from workspace', danger: true, disabled: lastAdmin, onClick: () => setRemoving(m) },
                    ]}
                  />
                )}
              </div>
            </Row>
          )
        })}
      </Table>
      {admins.length === 1 && <div className="mt-2 text-xs text-zinc-500">A workspace always keeps at least one admin.</div>}

      <AddMemberModal
        open={adding}
        onClose={() => setAdding(false)}
        onToken={(t, agentId) => setToken({ title: 'Agent added', token: t, agentId })}
      />
      <Modal open={!!token} onClose={() => {}} width={560} dismissable={false}>
        {token && (
          <TokenPanel
            token={token.token}
            title={token.title}
            subtitle={
              <span>
                <span className="font-mono">{agentById(d, token.agentId)?.label}</span> in {w.name}. This agent presents it together with its agent ID + agent token and <span className="font-mono">X-Dispatch-Workspace-Id: {w.id}</span>.
              </span>
            }
            note={<Link to={`/workspaces/${w.id}/connect?agent=${token.agentId}`}>Open connection instructions →</Link>}
            onDone={() => setToken(null)}
          />
        )}
      </Modal>
      <ImpactDialog
        open={!!removing}
        onClose={() => setRemoving(null)}
        title={`Remove ${removing ? principalName(d, { kind: removing.kind, id: removing.id }) : ''} from ${w.name}?`}
        rows={
          removing
            ? [
                ['Kind', removing.kind],
                ['Role', removing.role + (removing.delegatedBy ? ` (delegated by ${removing.delegatedBy})` : '')],
                ['Messages waiting for it', removing.kind === 'agent' ? String(d.messages.filter((m) => m.wsId === w.id && m.receipts[removing.id] && !m.receipts[removing.id].ackAt && !m.receipts[removing.id].filtered).length) : '—'],
                ['Workspace token', removing.kind === 'agent' ? `${maskWsToken(removing.tokenLast4 ?? '')} — stops working immediately` : '—', removing.kind === 'agent' ? 'amber' : undefined],
              ]
            : []
        }
        body="Its past messages and receipts stay in the workspace and the audit log."
        confirmLabel="Remove member"
        onConfirm={() => removing && actions.removeMember(w.id, { kind: removing.kind, id: removing.id })}
      />
    </div>
  )
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
                <button type="button" aria-label="Unblock" className="text-zinc-500 hover:text-zinc-200" onClick={() => actions.setWsBlocklist(w.id, w.agentBlocklist.filter((x) => x !== id))}>
                  ✕
                </button>
              )}
            </span>
          ))}
          {!w.agentBlocklist.length && <span className="text-sm2 text-zinc-500">No agents blocked.</span>}
        </div>
        {admin && (
          <select aria-label="Block an agent" value="" onChange={(e) => e.target.value && actions.setWsBlocklist(w.id, [...w.agentBlocklist, e.target.value])} className="mt-3 rounded-md border border-edge bg-page px-2.5 py-1.5 text-xs text-zinc-400 outline-none">
            <option value="">+ Block an agent by ID…</option>
            {agents
              .filter((a) => !w.agentBlocklist.includes(a.id))
              .map((a) => (
                <option key={a.id} value={a.id}>
                  {a.label} · {a.id}
                </option>
              ))}
          </select>
        )}
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
  const timer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  useEffect(() => {
    if (a) setH(a.harness === 'Other' ? 'REST' : a.harness)
    setWaiting(false)
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
  const queued = d.messages.filter((x) => x.wsId === w.id && x.receipts[a.id] && !x.receipts[a.id].deliveredAt && !x.receipts[a.id].filtered).length

  const download = () => {
    const cfg = configFor(h, { agentId: a.id, agentToken: agentTok ?? '<AGENT_TOKEN>', wsId: w.id, wsToken: wsTok ?? '<WORKSPACE_TOKEN>' })
    const url = URL.createObjectURL(new Blob([cfg.text], { type: 'text/plain' }))
    const el = document.createElement('a')
    el.href = url
    el.download = cfg.file
    el.click()
    URL.revokeObjectURL(url)
    if (!isOnline(a) && access.allowed) {
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
          <Segmented size="sm" value={h} onChange={setH} options={HARNESSES.map((x) => ({ value: x, label: x }))} className="mb-1" />
        </div>
        <div className="grid grid-cols-[170px_1fr] items-center gap-x-4 gap-y-2 rounded-[10px] border border-edge bg-panel p-4 text-sm2">
          <span className="text-zinc-500">Agent ID</span>
          <CopyChip value={a.id} variant="inline" />
          <span className="text-zinc-500">Agent token</span>
          <span className="masked-token text-xs text-zinc-400">{maskA}</span>
          <span className="text-zinc-500">Workspace ID</span>
          <CopyChip value={w.id} variant="inline" />
          <span className="text-zinc-500">Workspace token</span>
          <span className="masked-token text-xs text-zinc-400">{maskW}</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-zinc-300">{h === 'REST' ? 'Environment for REST calls' : `${h} · MCP server entry`}</span>
          <Button variant="primary" size="sm" onClick={download}>
            Download config
          </Button>
        </div>
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
              {!waiting && a.status === 'active' && (
                <button className="mt-2 text-xs text-signal hover:text-signal-light" onClick={() => actions.connectAgent(a.id)}>
                  Simulate the agent connecting
                </button>
              )}
            </div>
          </div>
        )}
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

