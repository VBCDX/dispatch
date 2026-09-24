import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { ago, initials, plural } from '../lib/format'
import { actions, isExpired, isOnline, me, myWorkspaces, org, orgAgents, orgEvents, principalName, useDB, useNow, wsById } from '../lib/store'
import { DispatchMark } from '../components/credential'
import { fireSummary, receiptCounts } from '../components/messages'
import { AuditLog, LogFeed, PrincipalChip, Tag } from '../components/shared'
import { Avatar, Button, Card, CloseX, Field, Input, PageTitle, Toggle, cx } from '../components/ui'

/* ------------------------------------------------------------------ */
/* Home                                                                */
/* ------------------------------------------------------------------ */
function Checklist() {
  const d = useDB()
  const ws = myWorkspaces(d)
  const agents = orgAgents(d)
  const withAgents = ws.find((w) => w.members.filter((m) => m.kind === 'agent').length >= 2)
  const target = withAgents ?? ws[0]
  const steps = [
    { t: 'Create a workspace', sub: 'A permission space: who reads, who writes, who’s blocked — and a full audit', done: ws.length > 0, to: '/workspaces?new=1' },
    { t: 'Register two agents', sub: 'Different harnesses are fine — say Claude Code and Codex', done: agents.length >= 2, to: '/agents?new=1' },
    { t: 'Add them to the workspace', sub: 'Each gets its own workspace token', done: !!withAgents, to: target ? `/workspaces/${target.id}/members` : '/workspaces' },
    { t: 'Send a message to the workspace', sub: 'Address all agents or just some. It waits for anyone not connected yet', done: d.messages.some((m) => m.author.kind === 'human'), to: target ? `/workspaces/${target.id}/messages` : '/workspaces' },
    { t: 'Connect an agent', sub: 'Download its MCP or REST config — queued messages arrive the moment it connects', done: agents.some((a) => a.connected), to: target ? `/workspaces/${target.id}/connect` : '/workspaces' },
    { t: 'Watch it get read and acknowledged', sub: 'Receipts are tracked per agent', done: d.messages.some((m) => Object.values(m.receipts).some((r) => r.ackAt)), to: target ? `/workspaces/${target.id}/messages` : '/workspaces' },
  ]
  const next = steps.findIndex((s) => !s.done)
  return (
    <div className="relative mt-5 max-w-[720px] rounded-xl border border-edge bg-panel p-6">
      <div className="absolute top-4 right-4">
        <CloseX onClick={actions.dismissChecklist} />
      </div>
      {next === -1 ? (
        <div className="flex items-center gap-4">
          <DispatchMark size={26} />
          <div>
            <div className="text-sm font-semibold text-green-400">Two agents, one workspace, one conversation</div>
            <div className="mt-0.5 text-sm2 text-zinc-400">From here: webhooks, filters and blocklists, and the API. Everything is in the audit log.</div>
          </div>
        </div>
      ) : (
        <>
          <div className="text-sm font-semibold">Get agents talking</div>
          <div className="mt-0.5 text-sm2 text-zinc-400">Six steps to the first acknowledged message. Each checks off on its own.</div>
        </>
      )}
      <div className="mt-4 flex flex-col">
        {steps.map((s, i) => (
          <div key={s.t} className="flex items-start gap-3 border-t border-line py-2.5">
            <div className={cx('mt-px flex size-[22px] min-w-[22px] items-center justify-center rounded-full border text-2xs font-semibold', s.done ? 'border-green-500/40 bg-green-500/[0.12] text-green-400' : i === next ? 'border-signal/60 text-signal-light' : 'border-zinc-700 text-zinc-400')}>{s.done ? '✓' : i + 1}</div>
            <div>
              <Link to={s.to} className={cx('text-md font-medium', s.done ? 'text-zinc-500 line-through hover:text-zinc-400' : 'text-zinc-200 hover:text-zinc-50')}>
                {s.t}
              </Link>
              {!s.done && <div className="mt-0.5 text-xs text-zinc-500">{s.sub}</div>}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function Stat({ label, value, tone, to }: { label: string; value: React.ReactNode; tone?: 'red' | 'amber' | 'green'; to: string }) {
  return (
    <Link to={to} className={cx('flex-1 rounded-[10px] border bg-panel p-4 hover:border-zinc-700', tone === 'red' ? 'border-red-500/35' : 'border-edge')}>
      <div className="text-xs text-zinc-500">{label}</div>
      <div className={cx('mt-1.5 text-[22px] font-semibold', tone === 'red' ? 'text-red-400' : tone === 'amber' ? 'text-amber-400' : tone === 'green' ? 'text-green-400' : 'text-zinc-100')}>{value}</div>
    </Link>
  )
}

export function Home() {
  const d = useDB()
  const now = useNow()
  const ws = new Set(myWorkspaces(d).map((w) => w.id))
  const msgs = d.messages.filter((m) => ws.has(m.wsId))
  const events = orgEvents(d).filter((e) => !e.wsId || ws.has(e.wsId))
  const day = msgs.filter((m) => now - m.createdAt < 86_400_000).length
  const waiting = msgs.filter((m) => !isExpired(m, now) && receiptCounts(m).total > receiptCounts(m).acked).length
  const failing = msgs.filter((m) => ['retrying', 'gave up'].includes(fireSummary(m, now, (id) => id)?.short ?? '')).length
  const blocked = events.filter((e) => e.severity === 'blocked' && now - e.at < 86_400_000).length
  const agents = orgAgents(d).filter((a) => a.status === 'active')
  const online = agents.filter(isOnline).length
  return (
    <div className="max-w-[1080px]">
      <h1 className="m-0 text-lg font-semibold tracking-[-0.01em]">Home</h1>
      {!d.checklistDismissed && <Checklist />}
      <div className="mt-5 flex gap-4">
        <Stat label="Messages · 24 h" value={day} to="/workspaces" />
        <Stat label="Waiting on an ack" value={waiting} tone={waiting ? 'amber' : undefined} to="/search?state=waiting" />
        <Stat label="Webhooks failing" value={failing} tone={failing ? 'amber' : undefined} to="/audit" />
        <Stat label="Refused · 24 h" value={blocked} tone={blocked ? 'red' : undefined} to="/audit" />
        <Stat label="Agents online" value={`${online} / ${agents.length}`} tone={online ? 'green' : undefined} to="/agents" />
      </div>
      {myWorkspaces(d).length > 0 && (
        <div className="mt-7 grid grid-cols-3 gap-4">
          {myWorkspaces(d).map((w) => {
            const last = d.messages.filter((m) => m.wsId === w.id).sort((a, b) => b.createdAt - a.createdAt)[0]
            return (
              <Link key={w.id} to={`/workspaces/${w.id}/messages`} className="rounded-[10px] border border-edge bg-panel p-4 hover:border-zinc-700">
                <div className="text-md font-semibold text-zinc-100">{w.name}</div>
                <div className="mt-0.5 text-xs text-zinc-500">
                  {plural(w.members.filter((m) => m.kind === 'agent').length, 'agent')} · {plural(w.members.filter((m) => m.kind === 'human').length, 'human')}
                </div>
                {last ? (
                  <div className="mt-3 text-xs text-zinc-400">
                    <span className="font-mono text-zinc-300">{principalName(d, last.author)}</span>: <span className="line-clamp-2">{last.body}</span>
                    <span className="text-zinc-600">{ago(last.createdAt, now).toLowerCase()}</span>
                  </div>
                ) : (
                  <div className="mt-3 text-xs text-zinc-600">No messages yet.</div>
                )}
              </Link>
            )
          })}
        </div>
      )}
      {events.length > 1 ? (
        <div className="mt-7">
          <div className="flex items-center justify-between">
            <div className="eyebrow">Recent activity</div>
            <Link to="/audit" className="text-sm2">
              Open Audit
            </Link>
          </div>
          <div className="mt-2.5">
            <LogFeed events={events.slice(0, 10)} />
          </div>
        </div>
      ) : (
        <Card className="mt-6 p-8 text-center text-[13px] text-zinc-400">No activity yet. Messages, receipts, webhook calls and access decisions show up here as they happen.</Card>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Search — humans see and search every message in their workspaces    */
/* ------------------------------------------------------------------ */
function Hl({ text, q }: { text: string; q: string }) {
  if (!q) return <>{text}</>
  const i = text.toLowerCase().indexOf(q.toLowerCase())
  if (i < 0) return <>{text.length > 180 ? text.slice(0, 180) + '…' : text}</>
  const start = Math.max(0, i - 60)
  return (
    <>
      {start > 0 && '…'}
      {text.slice(start, i)}
      <mark className="rounded bg-signal/25 px-0.5 text-signal-light">{text.slice(i, i + q.length)}</mark>
      {text.slice(i + q.length, i + q.length + 120)}
      {i + q.length + 120 < text.length && '…'}
    </>
  )
}

export function SearchPage() {
  const d = useDB()
  const now = useNow()
  const init = new URLSearchParams(location.hash.split('?')[1] ?? '')
  const [q, setQ] = useState(init.get('q') ?? '')
  const [ws, setWs] = useState('')
  const [tag, setTag] = useState('')
  const [kind, setKind] = useState<'' | 'agent' | 'human' | 'context'>('')
  const [waitingOnly, setWaitingOnly] = useState(init.get('state') === 'waiting')
  const mine = myWorkspaces(d)
  const ids = new Set(mine.map((w) => w.id))
  const tags = Array.from(new Set(d.messages.filter((m) => ids.has(m.wsId)).flatMap((m) => m.tags))).sort()
  const results = useMemo(() => {
    const s = q.trim().toLowerCase()
    const msgs = kind === 'context' ? [] : d.messages.filter((m) => ids.has(m.wsId) && (!ws || m.wsId === ws) && (!tag || m.tags.includes(tag)) && (!kind || m.author.kind === kind) && (!waitingOnly || (!isExpired(m, now) && receiptCounts(m).total > receiptCounts(m).acked)) && (!s || [m.body, m.payload ?? '', m.id, m.trk, ...m.tags].some((x) => x.toLowerCase().includes(s))))
    const notes = kind && kind !== 'context' ? [] : d.notes.filter((n) => ids.has(n.wsId) && (!ws || n.wsId === ws) && (!tag || n.tags.includes(tag)) && !waitingOnly && (!s || [n.title, n.body, ...n.tags].some((x) => x.toLowerCase().includes(s))))
    return { msgs: msgs.sort((a, b) => b.createdAt - a.createdAt), notes }
  }, [d, q, ws, tag, kind, waitingOnly, now]) // eslint-disable-line
  const sel = 'rounded-lg border border-edge bg-panel px-3 py-2 text-sm2 text-zinc-400 outline-none'
  return (
    <div className="max-w-[1000px]">
      <PageTitle>Search</PageTitle>
      <div className="mt-1 text-sm2 text-zinc-500">Every message and note in your workspaces, whoever it was addressed to. Humans see everything; the audience only decides which agents receive it.</div>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <input value={q} onChange={(e) => setQ(e.target.value)} autoFocus placeholder="Search text, payloads, tags, message IDs, tracking codes…" aria-label="Search" className="min-w-[260px] flex-1 rounded-lg border border-zinc-700 bg-panel px-3 py-2 text-[13px] outline-none placeholder:text-zinc-500 focus:border-zinc-500" />
        <select aria-label="Workspace" value={ws} onChange={(e) => setWs(e.target.value)} className={sel}>
          <option value="">All my workspaces</option>
          {mine.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </select>
        <select aria-label="Tag" value={tag} onChange={(e) => setTag(e.target.value)} className={sel}>
          <option value="">Any tag</option>
          {tags.map((t) => (
            <option key={t} value={t}>
              #{t}
            </option>
          ))}
        </select>
        <select aria-label="Kind" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)} className={sel}>
          <option value="">Messages + context</option>
          <option value="agent">From agents</option>
          <option value="human">From humans</option>
          <option value="context">Shared context only</option>
        </select>
        <label className="flex items-center gap-2 text-xs text-zinc-400">
          <Toggle on={waitingOnly} onChange={setWaitingOnly} label="Waiting on an ack" /> Waiting on an ack
        </label>
      </div>
      <div className="mt-2 text-xs text-zinc-500">
        {plural(results.msgs.length, 'message')} · {plural(results.notes.length, 'note')}
      </div>
      <div className="mt-3 flex flex-col gap-2">
        {results.notes.map((n) => (
          <Link key={n.id} to={`/workspaces/${n.wsId}/context`} className="rounded-[10px] border border-edge bg-panel px-4 py-3 hover:border-zinc-700">
            <div className="flex items-center gap-2 text-xs text-zinc-500">
              <span className="rounded border border-chip px-1.5 text-2xs">context</span>
              {wsById(d, n.wsId)?.name} · v{n.version} · {n.updatedBy}
            </div>
            <div className="mt-1 text-[13px] font-medium text-zinc-100">
              <Hl text={n.title} q={q} />
            </div>
            <div className="mt-0.5 text-xs text-zinc-400">
              <Hl text={n.body} q={q} />
            </div>
          </Link>
        ))}
        {results.msgs.slice(0, 80).map((m) => (
          <Link key={m.id} to={`/workspaces/${m.wsId}/messages?m=${m.parentId ?? m.id}`} className={cx('rounded-[10px] border border-edge bg-panel px-4 py-3 hover:border-zinc-700', isExpired(m, now) && 'opacity-60')}>
            <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-500">
              <PrincipalChip p={m.author} size={18} />
              <span>in {wsById(d, m.wsId)?.name}</span>
              {m.parentId && <span>· reply</span>}
              {m.tags.map((t) => (
                <Tag key={t} t={t} on={t === tag} />
              ))}
              <span className="ml-auto">{ago(m.createdAt, now).toLowerCase()}</span>
            </div>
            <div className="mt-1.5 text-[13px] text-zinc-200">
              <Hl text={m.body} q={q} />
            </div>
            <div className="mt-1 text-2xs text-zinc-500">
              Read by {receiptCounts(m).read} of {receiptCounts(m).total} · acked {receiptCounts(m).acked} · {m.id}
            </div>
          </Link>
        ))}
        {!results.msgs.length && !results.notes.length && <Card className="p-10 text-center text-[13px] text-zinc-400">Nothing found. Try fewer words or clear a filter.</Card>}
      </div>
    </div>
  )
}

export function AuditPage() {
  const d = useDB()
  const ids = new Set(myWorkspaces(d).map((w) => w.id))
  return (
    <div className="max-w-[1120px]">
      <PageTitle>Audit</PageTitle>
      <div className="mt-1 text-sm2 text-zinc-500">Messages, per-agent receipts, webhook calls, access decisions and admin changes — including changes made by agents with delegated admin.</div>
      <div className="mt-4">
        <AuditLog events={orgEvents(d).filter((e) => !e.wsId || ids.has(e.wsId))} />
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */
const NOTIFS: [string, string][] = [
  ['webhookFailing', 'A webhook keeps failing'],
  ['blockedAttempt', 'An agent is refused'],
  ['agentOffline', 'An agent goes offline with messages queued'],
  ['messageExpiring', 'A message expires unacknowledged'],
  ['memberAdded', 'Someone is added to my workspaces'],
]
export function MySettings() {
  const d = useDB()
  const now = useNow()
  const u = me(d)
  const [name, setName] = useState(u.name)
  return (
    <div className="max-w-[920px]">
      <PageTitle>My Settings</PageTitle>
      <div className="mt-5 grid grid-cols-2 items-start gap-6">
        <Card className="flex flex-col gap-3.5 rounded-xl p-6">
          <div className="eyebrow-sm">Profile</div>
          <div className="flex items-center gap-3">
            <Avatar initials={initials(u.name)} size={40} />
            <div>
              <div className="text-md font-semibold">{u.name}</div>
              <div className="text-xs text-zinc-500">{u.email} · signs in with SSO</div>
            </div>
          </div>
          <Field label="Name">
            <div className="flex gap-2">
              <Input value={name} onChange={(e) => setName(e.target.value)} className="bg-rail" />
              <Button disabled={!name.trim() || name === u.name} onClick={() => actions.renameMe(name.trim())}>
                Save
              </Button>
            </div>
          </Field>
          <div className="eyebrow-sm mt-1">Active sessions</div>
          {u.sessions.map((s, i) => (
            <div key={i} className="text-sm2 text-zinc-400">
              {s.device} · {s.place} · {i === 0 ? 'now' : ago(s.at, now)}
            </div>
          ))}
        </Card>
        <Card className="flex flex-col gap-3 rounded-xl p-6">
          <div className="eyebrow-sm">Notify me when</div>
          {NOTIFS.map(([k, l]) => (
            <div key={k} className="flex items-center justify-between">
              <span className="text-[13px]">{l}</span>
              <Toggle on={!!d.notifications[k]} onChange={() => actions.toggleNotification(k)} label={l} />
            </div>
          ))}
        </Card>
      </div>
    </div>
  )
}

export function AccountSettings() {
  const d = useDB()
  const o = org(d)!
  const [name, setName] = useState(o.name)
  return (
    <div className="max-w-[480px]">
      <PageTitle>Account</PageTitle>
      <Card className="mt-5 flex flex-col gap-3.5 rounded-xl p-6">
        <Field label="Organization name">
          <div className="flex gap-2">
            <Input value={name} onChange={(e) => setName(e.target.value)} className="bg-rail" />
            <Button disabled={!name.trim() || name === o.name} onClick={() => actions.renameOrg(name)}>
              Rename
            </Button>
          </div>
        </Field>
        <div className="rounded-lg border border-edge bg-rail px-3.5 py-3 text-sm2 text-zinc-400">Identity — suite SSO over OIDC (IdP swappable). Workspace authorization stays in Dispatch.</div>
        <div className="rounded-lg border border-edge bg-rail px-3.5 py-3 text-sm2 text-zinc-400">Plan — open core, self-hosted · placeholder</div>
      </Card>
    </div>
  )
}
