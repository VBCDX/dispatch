// The workspace's Messages tab, after the mock (mocks/v1/src/components/
// messages.tsx): history from the API, new messages and acknowledgements
// live over the browser WebSocket, threads, and a composer for people.
//
// Receipts come from each agent's acknowledged position in the stream: a
// message is acknowledged by an agent once the agent's acked_seq reaches
// the message's seq. Per-message receipt states (held, filtered, read) are
// not tracked yet.
import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { Link, useParams } from 'react-router-dom'
import { messaging, type AgentMember, type Message } from '../api'
import { trackEvent } from '../analytics'
import { useWorkspaceLive, type LiveStatus } from '../live'
import { errorText } from '../secret'
import { useLoad, useSession } from '../session'
import { Button, ErrorBox, Pill, cx, plural } from '../ui'

const time = (iso: string) => {
  const d = new Date(iso)
  const today = new Date().toDateString() === d.toDateString()
  return today ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

/** The agents a message was delivered to: readers in the workspace when it was sent, except its author. */
function targets(m: Message, agents: AgentMember[]) {
  if (!m.seq) return []
  return agents.filter(
    (a) => a.read && a.status === 'active' && !a.token_revoked_at && Date.parse(a.added_at) <= Date.parse(m.created_at) && !(m.author.kind === 'agent' && m.author.id === a.agent_id),
  )
}

export function WsMessages() {
  const { wsId = '' } = useParams()
  const { org } = useSession()
  const orgId = org?.id
  const [page, reload] = useLoad(orgId ? () => messaging.messages(orgId, wsId) : null, [orgId, wsId])
  const [byId, setById] = useState<Map<string, Message>>(new Map())
  const [agents, setAgents] = useState<AgentMember[]>([])
  const [replyTo, setReplyTo] = useState<string | null>(null)

  // History and live messages merge by ID; a reload after a reconnect fills any gap.
  useEffect(() => {
    if (page.state !== 'ready') return
    setById((prev) => {
      const next = new Map(prev)
      for (const m of page.data.messages) next.set(m.id, { ...next.get(m.id), ...m })
      return next
    })
    setAgents(page.data.agents)
  }, [page])
  useEffect(() => setById(new Map()), [orgId, wsId])

  const add = (m: Message) => setById((prev) => new Map(prev).set(m.id, { ...prev.get(m.id), ...m }))
  const status = useWorkspaceLive(orgId, wsId, {
    onMessage: add,
    onEvent: (e) =>
      setAgents((prev) => {
        if (!prev.some((a) => a.agent_id === e.agent_id)) {
          reload() // an agent connected since the page loaded
          return prev
        }
        return prev.map((a) => (a.agent_id !== e.agent_id ? a : e.kind === 'ack' ? { ...a, acked_seq: Math.max(a.acked_seq, e.seq) } : { ...a, online: e.online }))
      }),
    onReconnect: reload,
  })

  const { roots, replies } = useMemo(() => {
    const all = [...byId.values()]
    const replies = new Map<string, Message[]>()
    const roots: Message[] = []
    for (const m of all) {
      if (m.thread_id && byId.has(m.thread_id)) replies.set(m.thread_id, [...(replies.get(m.thread_id) ?? []), m])
      else roots.push(m)
    }
    const newestFirst = (a: Message, b: Message) => (b.seq ?? 0) - (a.seq ?? 0) || b.created_at.localeCompare(a.created_at)
    roots.sort(newestFirst)
    for (const rs of replies.values()) rs.sort((a, b) => -newestFirst(a, b))
    return { roots, replies }
  }, [byId])

  if (page.state === 'error') return <div className="mt-5"><ErrorBox what="messages" onRetry={reload} /></div>
  const ready = page.state === 'ready'
  const waiting = roots.concat([...replies.values()].flat()).filter((m) => targets(m, agents).some((a) => a.acked_seq < (m.seq ?? 0))).length

  return (
    <div className="mt-5 grid grid-cols-[1fr_260px] gap-6">
      <div className="flex min-w-0 flex-col gap-3">
        {ready && page.data.can_post && orgId && <Composer org={orgId} ws={wsId} onSent={add} />}
        {!ready ? (
          <div className="flex flex-col gap-3" aria-busy="true" aria-label="Loading">
            {[0, 1, 2].map((i) => <div key={i} className="skeleton h-20 rounded-[10px]" />)}
          </div>
        ) : roots.length === 0 ? (
          <div className="rounded-[10px] border border-edge bg-panel p-10 text-center text-[13px] text-zinc-400">
            No messages yet. <Link to={`/workspaces/${wsId}/connect`}>Connect an agent</Link>
            {page.data.can_post ? ', or post the first one above.' : '.'}
          </div>
        ) : (
          roots.map((m) => (
            <MessageCard key={m.id} m={m} agents={agents} replies={replies.get(m.id) ?? []}
              canReply={page.data.can_post} replying={replyTo === m.id} onReply={() => setReplyTo(replyTo === m.id ? null : m.id)}
              composer={orgId && <Composer org={orgId} ws={wsId} threadId={m.id} onSent={(r) => { add(r); setReplyTo(null) }} compact />} />
          ))
        )}
      </div>
      <aside className="flex flex-col gap-3">
        <LiveBadge status={status} />
        <div className="rounded-[10px] border border-edge bg-panel p-4">
          <div className="th mb-2">Agents</div>
          {agents.length === 0 ? (
            <div className="text-xs text-zinc-500">
              None yet. <Link to={`/workspaces/${wsId}/connect`}>Connect one →</Link>
            </div>
          ) : (
            <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
              {agents.map((a) => (
                <li key={a.agent_id} className="flex items-center gap-2 text-[13px]">
                  <span aria-hidden className={cx('h-2 w-2 rounded-full', a.online ? 'bg-green-400' : 'bg-zinc-700')} />
                  <Link to={`/agents/${a.agent_id}`} className="font-mono text-zinc-200 hover:text-zinc-50">{a.label}</Link>
                  <span className="ml-auto text-2xs text-zinc-500">{a.token_revoked_at || a.status !== 'active' ? 'cut off' : a.online ? 'online' : 'offline'}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        {ready && waiting > 0 && (
          <div className="rounded-[10px] border border-amber-500/30 bg-amber-500/[0.05] p-4 text-xs text-amber-300">
            Waiting on agents: {plural(waiting, 'message')} not yet acknowledged by everyone.
          </div>
        )}
      </aside>
    </div>
  )
}

function LiveBadge({ status }: { status: LiveStatus }) {
  return (
    <div className="flex items-center gap-2 text-xs text-zinc-500" aria-live="polite">
      <span aria-hidden className={cx('h-2 w-2 rounded-full', status === 'live' ? 'bg-signal animate-khpulse' : status === 'connecting' ? 'bg-zinc-600' : 'bg-red-400')} />
      {status === 'live' ? 'Live' : status === 'connecting' ? 'Connecting…' : status === 'removed' ? 'Stopped: your access to this workspace was removed' : 'Offline: reconnecting'}
    </div>
  )
}

function AuthorChip({ m }: { m: Message }) {
  const label = m.author.label || m.author.id
  return (
    <span className="flex items-center gap-2">
      {m.author.kind === 'agent' ? (
        <Link to={`/agents/${m.author.id}`} className="font-mono text-[13px] font-semibold text-zinc-100 hover:text-white">{label}</Link>
      ) : (
        <span className="text-[13px] font-semibold text-zinc-100">{label}</span>
      )}
      {m.author.kind === 'user' && <Pill className="!py-0">human</Pill>}
      {m.author.kind === 'listener' && <Pill tone="blue" className="!py-0">via listener</Pill>}
    </span>
  )
}

function Receipts({ m, agents }: { m: Message; agents: AgentMember[] }) {
  const ts = targets(m, agents)
  if (!ts.length) return null
  const acked = ts.filter((a) => a.acked_seq >= (m.seq ?? 0))
  return (
    <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-line pt-2.5">
      <span className="text-xs text-zinc-500">
        Acknowledged by <span className="text-zinc-300">{acked.length}</span> of {ts.length}
      </span>
      <span className="flex flex-wrap gap-1">
        {ts.map((a) => {
          const done = a.acked_seq >= (m.seq ?? 0)
          return (
            <span key={a.agent_id}
              title={`${a.label}: ${done ? 'acknowledged' : a.online ? 'delivered, not acknowledged yet' : 'waiting for it to connect'}`}
              className={cx('rounded border px-1.5 py-px font-mono text-[10.5px]', done ? 'border-green-500/40 bg-green-500/10 text-green-400' : 'border-dashed border-amber-500/40 text-amber-400')}>
              {a.label}
              {done ? ' ✓✓' : ''}
            </span>
          )
        })}
      </span>
    </div>
  )
}

function Payload({ p }: { p: unknown }) {
  if (p === undefined || p === null) return null
  return <pre className="mt-2 mb-0 max-h-28 overflow-auto rounded-md border border-line bg-rail px-3 py-2 font-mono text-xs2 text-zinc-400">{JSON.stringify(p, null, 2)}</pre>
}

function MessageCard({ m, agents, replies, canReply, replying, onReply, composer }: {
  m: Message
  agents: AgentMember[]
  replies: Message[]
  canReply: boolean
  replying: boolean
  onReply: () => void
  composer: React.ReactNode
}) {
  const [open, setOpen] = useState(true)
  return (
    <article className="rounded-[10px] border border-edge bg-panel px-4 py-3.5" data-message={m.id}>
      <header className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
        <AuthorChip m={m} />
        {m.thread_id && <span className="text-2xs text-zinc-500">reply in a thread not loaded</span>}
        <span className="ml-auto text-xs text-zinc-500" title={new Date(m.created_at).toLocaleString()}>{time(m.created_at)}</span>
      </header>
      <div className="mt-2 text-[13.5px] leading-relaxed whitespace-pre-wrap text-zinc-200">{m.body}</div>
      <Payload p={m.payload} />
      <Receipts m={m} agents={agents} />
      {replies.length > 0 && (
        <div className="mt-2.5 border-t border-line pt-2">
          <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="flex items-center gap-2 text-xs text-signal hover:text-signal-light">
            <span aria-hidden className="w-2.5 text-[10px]">{open ? '▾' : '▸'}</span>
            {plural(replies.length, 'reply', 'replies')}
          </button>
          {open && (
            <div className="mt-2 flex flex-col gap-2 border-l border-line pl-3">
              {replies.map((r) => (
                <div key={r.id} className="rounded-lg border border-line bg-rail px-3 py-2" data-message={r.id}>
                  <div className="flex items-center gap-2 text-xs">
                    <AuthorChip m={r} />
                    <span className="ml-auto text-zinc-500">{time(r.created_at)}</span>
                  </div>
                  <div className="mt-1 text-[13px] whitespace-pre-wrap text-zinc-200">{r.body}</div>
                  <Payload p={r.payload} />
                  <Receipts m={r} agents={agents} />
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {canReply && (
        <div className="mt-2">
          {replying ? composer : (
            <button type="button" onClick={onReply} className="text-xs text-zinc-500 hover:text-zinc-300">Reply in thread</button>
          )}
        </div>
      )}
    </article>
  )
}

function Composer({ org, ws, threadId, onSent, compact }: { org: string; ws: string; threadId?: string; onSent: (m: Message) => void; compact?: boolean }) {
  const { me, onError } = useSession()
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function send(e?: FormEvent) {
    e?.preventDefault()
    if (!body.trim() || busy) return
    setBusy(true)
    setError(null)
    try {
      const { message, seq } = await messaging.post(org, ws, me.csrf_token, body, threadId)
      // Core-value event: body, thread and ids are never sent.
      trackEvent('message_sent')
      onSent({ ...message, seq })
      setBody('')
    } catch (err) {
      onError(err)
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={send} className={cx('flex flex-col gap-2', !compact && 'rounded-[10px] border border-edge bg-panel p-3')}>
      <label htmlFor={`compose-${threadId ?? 'root'}`} className="sr-only">{threadId ? 'Reply' : 'Message'}</label>
      <textarea
        id={`compose-${threadId ?? 'root'}`}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send()
        }}
        rows={compact ? 2 : 3}
        maxLength={32_000}
        placeholder={threadId ? 'Reply in the thread…' : 'Message every agent and person in this workspace…'}
        className="w-full resize-y rounded-lg border border-zinc-700 bg-page px-3 py-2 text-[13px] text-zinc-100 placeholder:text-zinc-600 outline-none focus:border-zinc-500"
      />
      {error && <div role="alert" className="text-xs text-red-400">{error}</div>}
      <div className="flex items-center justify-between">
        <span className="text-2xs text-zinc-600">Ctrl+Enter to send</span>
        <Button type="submit" variant="primary" size="sm" disabled={busy || !body.trim()}>
          {busy ? 'Sending…' : threadId ? 'Reply' : 'Send'}
        </Button>
      </div>
    </form>
  )
}
