import { useEffect, useMemo, useState } from 'react'
import { Link, Outlet, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { ago, plural, until } from '../lib/format'
import { actions, agentById, canAdmin, canPost, isExpired, MAX_ATTEMPTS, isOnline, myMembership, myWorkspaces, orgEvents, useDB, useNow, wsById } from '../lib/store'
import type { Message } from '../lib/types'
import { Composer, MessageCard, MessageDrawer, fireSummary, receiptCounts } from '../components/messages'
import { AuditLog, ImpactDialog, ListBody, Tag } from '../components/shared'
import { Breadcrumb, Button, Callout, Card, Checkbox, Field, Footer, Input, Modal, PageTitle, Pill, Row, Select, Table, Tabs, Textarea, cx } from '../components/ui'
import { TagInput } from '../components/messages'

/* ------------------------------------------------------------------ */
/* List                                                                */
/* ------------------------------------------------------------------ */
const COLS = '1.5fr 1.4fr 1fr 1fr 0.9fr 0.8fr'
export function WorkspacesList() {
  const d = useDB()
  const nav = useNavigate()
  const now = useNow()
  const [params, setParams] = useSearchParams()
  const [creating, setCreating] = useState(params.get('new') === '1')
  useEffect(() => {
    if (params.get('new')) setParams({}, { replace: true })
  }, []) // eslint-disable-line
  const list = myWorkspaces(d)
  return (
    <div>
      <PageTitle actions={<Button variant="primary" onClick={() => setCreating(true)}>New workspace</Button>}>Workspaces</PageTitle>
      <div className="mt-1 max-w-[760px] text-sm2 text-zinc-500">A workspace is a permission space: who may read and write, which agents are blocked, and a full audit of what happened. Messages are addressed to the workspace, not to a running process.</div>
      <Table cols={COLS} head={['Name', 'Members', 'Messages · 24 h', 'Waiting on agents', 'Webhooks', 'Your role']} className="mt-5 max-w-[1080px]">
        <ListBody cols={COLS} what="workspaces" empty={list.length ? undefined : <div className="p-10 text-center text-[13px] text-zinc-400">No workspaces yet. Create one to give agents a place to leave each other messages.</div>}>
          {list.map((w) => {
            const msgs = d.messages.filter((m) => m.wsId === w.id)
            const day = msgs.filter((m) => now - m.createdAt < 86_400_000).length
            const waiting = msgs.filter((m) => !isExpired(m, now) && Object.values(m.receipts).some((r) => !r.filtered && !r.ackAt)).length
            const hooks = msgs.filter((m) => m.webhook && !isExpired(m, now)).length
            const agents = w.members.filter((m) => m.kind === 'agent')
            const online = agents.filter((m) => { const a = agentById(d, m.id); return a && isOnline(a) }).length
            const role = myMembership(d, w)?.role
            return (
              <Row key={w.id} cols={COLS} onClick={() => nav(`/workspaces/${w.id}/messages`)}>
                <div>
                  <div className="font-medium">{w.name}</div>
                  <div className="font-mono text-2xs text-zinc-600">{w.id}</div>
                </div>
                <div className="text-zinc-400">
                  {plural(w.members.filter((m) => m.kind === 'human').length, 'human')} · {plural(agents.length, 'agent')} <span className="text-zinc-600">({online} online)</span>
                  {w.agentBlocklist.length > 0 && <span className="ml-1.5 text-2xs text-red-400">{w.agentBlocklist.length} blocked</span>}
                </div>
                <div className="text-zinc-400">{day}</div>
                <div className={waiting ? 'text-amber-400' : 'text-zinc-500'}>{waiting ? plural(waiting, 'message') : 'None'}</div>
                <div className="text-zinc-400">{hooks || '—'}</div>
                <div>{role ? <Pill tone={role === 'admin' ? 'green' : 'neutral'}>{role}</Pill> : <span className="text-xs text-zinc-500">org admin</span>}</div>
              </Row>
            )
          })}
        </ListBody>
      </Table>
      <NewWorkspaceModal open={creating} onClose={() => setCreating(false)} />
    </div>
  )
}

function NewWorkspaceModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const d = useDB()
  const nav = useNavigate()
  const [name, setName] = useState('')
  const [desc, setDesc] = useState('')
  const [expiry, setExpiry] = useState('24')
  useEffect(() => {
    if (open) {
      setName(myWorkspaces(d).length ? '' : 'Release train')
      setDesc('')
      setExpiry('24')
    }
  }, [open]) // eslint-disable-line
  const clash = d.workspaces.some((w) => w.orgId === d.currentOrgId && w.name.toLowerCase() === name.trim().toLowerCase())
  return (
    <Modal open={open} onClose={onClose} width={500} title="New workspace">
      <Field label="Name" error={clash ? 'A workspace with that name exists.' : null}>
        <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
      </Field>
      <Field label="What it’s for" optional hint="Agents read this when they list their workspaces — write it for them.">
        <Textarea rows={2} value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="Everything that gets a release out the door." />
      </Field>
      <Field label="Default message expiry">
        <Select value={expiry} onChange={(e) => setExpiry(e.target.value)}>
          <option value="6">6 hours</option>
          <option value="24">24 hours</option>
          <option value="168">7 days</option>
          <option value="none">No expiry</option>
        </Select>
      </Field>
      <div className="text-xs text-zinc-500">You’ll be its first admin. Add agents and people next — each agent gets its own workspace token.</div>
      <Footer>
        <Button size="lg" onClick={onClose}>
          Cancel
        </Button>
        <Button
          size="lg"
          variant="primary"
          disabled={!name.trim() || clash}
          onClick={() => {
            const id = actions.createWorkspace({ name: name.trim(), description: desc, defaultExpiryHours: expiry === 'none' ? null : Number(expiry) })
            onClose()
            nav(`/workspaces/${id}/members`)
          }}
        >
          Create workspace
        </Button>
      </Footer>
    </Modal>
  )
}

/* ------------------------------------------------------------------ */
/* Detail shell                                                        */
/* ------------------------------------------------------------------ */
export function useWorkspace() {
  const d = useDB()
  const { wsId } = useParams()
  return wsById(d, wsId)!
}

export function WorkspaceDetail() {
  const d = useDB()
  const nav = useNavigate()
  const { wsId } = useParams()
  const w = wsById(d, wsId)
  const [deleting, setDeleting] = useState(false)
  if (!w || !myWorkspaces(d).some((x) => x.id === w.id)) return <div className="text-sm text-zinc-400">You’re not a member of this workspace. <Link to="/workspaces">Back to workspaces</Link></div>
  const base = `/workspaces/${w.id}`
  const agents = w.members.filter((m) => m.kind === 'agent')
  const online = agents.filter((m) => { const a = agentById(d, m.id); return a && isOnline(a) }).length
  const admin = canAdmin(d, w)
  return (
    <div className="max-w-[1120px]">
      <Breadcrumb items={[{ label: 'Workspaces', to: '/workspaces' }, { label: w.name }]} />
      <PageTitle
        sub={
          <span className="flex items-center gap-2 text-xs text-zinc-500">
            <span className="font-mono">{w.id}</span>·
            <span className={cx('size-1.5 rounded-full', online ? 'bg-green-500' : 'bg-zinc-600')} />
            {online} of {agents.length} agents connected
            {d.live && online > 0 && <span className="text-zinc-600">· live</span>}
          </span>
        }
        actions={admin && <Button variant="ghost" size="sm" className="text-zinc-500 hover:text-red-400" onClick={() => setDeleting(true)}>Delete workspace</Button>}
      >
        {w.name}
      </PageTitle>
      {w.description && <div className="mt-1 text-sm2 text-zinc-500">{w.description}</div>}
      <Tabs
        tabs={[
          { to: `${base}/messages`, label: 'Messages' },
          { to: `${base}/members`, label: `Members · ${w.members.length}` },
          { to: `${base}/access`, label: 'Access' },
          { to: `${base}/webhooks`, label: 'Webhooks' },
          { to: `${base}/context`, label: 'Context' },
          { to: `${base}/connect`, label: 'Connect' },
          { to: `${base}/audit`, label: 'Audit' },
        ]}
      />
      <Outlet />
      <ImpactDialog
        open={deleting}
        onClose={() => setDeleting(false)}
        title={`Delete ${w.name}?`}
        typeToConfirm={w.name}
        rows={[
          ['Members', `${plural(w.members.filter((m) => m.kind === 'human').length, 'human')} · ${plural(agents.length, 'agent')} — their workspace tokens stop working`, 'amber'],
          ['Messages', String(d.messages.filter((m) => m.wsId === w.id).length)],
          ['Open listeners', String(d.messages.filter((m) => m.wsId === w.id && m.webhook?.mode === 'listen' && !isExpired(m)).length)],
          ['Shared context', plural(d.notes.filter((n) => n.wsId === w.id).length, 'note')],
        ]}
        body={`Messages and context are deleted. The audit log keeps the record of what happened here — org admins find it in Audit as “${w.name} (deleted)”.`}
        confirmLabel="Delete workspace"
        onConfirm={() => {
          actions.deleteWorkspace(w.id)
          nav('/workspaces')
        }}
      />
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Messages tab                                                        */
/* ------------------------------------------------------------------ */
type StateFilter = '' | 'waiting' | 'unread' | 'webhook' | 'mine'
export function WsMessages() {
  const d = useDB()
  const w = useWorkspace()
  const now = useNow(10_000)
  const [params, setParams] = useSearchParams()
  const [open, setOpen] = useState<string | null>(params.get('m'))
  const [q, setQ] = useState('')
  const [tags, setTags] = useState<string[]>([])
  const [author, setAuthor] = useState('')
  const [state, setState] = useState<StateFilter>('')
  const [showExpired, setShowExpired] = useState(true)
  useEffect(() => {
    const m = params.get('m')
    if (m) setOpen(m)
  }, [params])

  const all = d.messages.filter((m) => m.wsId === w.id)
  const replies = (id: string) => all.filter((m) => m.parentId === id).length
  const tagCounts = useMemo(() => {
    const c: Record<string, number> = {}
    for (const m of all) for (const t of m.tags) c[t] = (c[t] ?? 0) + 1
    return Object.entries(c).sort((a, b) => b[1] - a[1])
  }, [all])
  const authors = Array.from(new Set(all.map((m) => `${m.author.kind}:${m.author.id}`)))
  const authorLabel = (k: string) => {
    const [kind, id] = k.split(':')
    return kind === 'agent' ? (agentById(d, id)?.label ?? id) : kind === 'webhook' ? `listener ${id}` : (d.humans.find((h) => h.id === id)?.name ?? id)
  }

  const list = all
    .filter((m) => !m.parentId)
    .filter((m) => {
      if (!showExpired && isExpired(m, now)) return false
      if (tags.length && !tags.every((t) => m.tags.includes(t))) return false
      if (author && `${m.author.kind}:${m.author.id}` !== author) return false
      const c = receiptCounts(m, now)
      if (state === 'waiting' && !(c.total > c.acked && !isExpired(m, now))) return false
      if (state === 'unread' && !(c.total > c.read && !isExpired(m, now))) return false
      if (state === 'webhook' && !m.webhook) return false
      if (state === 'mine' && !(m.author.kind === 'human' && m.author.id === d.currentUserId)) return false
      if (q) {
        const s = q.toLowerCase()
        const thread = all.filter((x) => x.parentId === m.id)
        if (![m, ...thread].some((x) => x.body.toLowerCase().includes(s) || x.id.includes(s) || x.trk.includes(s) || x.tags.some((t) => t.includes(s)))) return false
      }
      return true
    })
    .sort((a, b) => b.createdAt - a.createdAt)

  const toggleTag = (t: string) => setTags(tags.includes(t) ? tags.filter((x) => x !== t) : [...tags, t])
  const close = () => {
    setOpen(null)
    if (params.get('m')) setParams({}, { replace: true })
  }

  return (
    <div className="mt-5 grid grid-cols-[1fr_240px] gap-6">
      <div className="flex min-w-0 flex-col gap-3">
        <Composer ws={w} compact />
        <div className="flex flex-wrap items-center gap-2">
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search this workspace — text, tag, message ID, tracking code…" aria-label="Search messages" className="min-w-[220px] flex-1 rounded-lg border border-zinc-700 bg-panel px-3 py-2 text-[13px] outline-none placeholder:text-zinc-500 focus:border-zinc-500" />
          <select aria-label="Author" value={author} onChange={(e) => setAuthor(e.target.value)} className="rounded-lg border border-edge bg-panel px-3 py-2 text-sm2 text-zinc-400 outline-none">
            <option value="">Any author</option>
            {authors.map((k) => (
              <option key={k} value={k}>
                {authorLabel(k)}
              </option>
            ))}
          </select>
          <select aria-label="State" value={state} onChange={(e) => setState(e.target.value as StateFilter)} className="rounded-lg border border-edge bg-panel px-3 py-2 text-sm2 text-zinc-400 outline-none">
            <option value="">Any state</option>
            <option value="waiting">Waiting on an ack</option>
            <option value="unread">Not read by everyone</option>
            <option value="webhook">Has a webhook</option>
            <option value="mine">Sent by me</option>
          </select>
          <Checkbox checked={showExpired} onChange={setShowExpired} label={<span className="text-xs">Show expired</span>} />
        </div>
        {tags.length > 0 && (
          <div className="flex items-center gap-2 text-xs text-zinc-500">
            Showing messages tagged {tags.map((t) => <Tag key={t} t={t} on onClick={() => toggleTag(t)} />)}
            <button className="text-signal hover:text-signal-light" onClick={() => setTags([])}>
              Clear
            </button>
          </div>
        )}
        <ListBody cols="1fr 1fr 1fr" what="messages" rows={4}>
          {list.length === 0 ? (
            <Card className="p-10 text-center text-[13px] text-zinc-400">{all.length ? 'Nothing matches. Clear a filter to see more.' : 'No messages yet. Write the first one — agents that aren’t connected will get it when they are.'}</Card>
          ) : (
            list.map((m: Message) => <MessageCard key={m.id} m={m} replies={replies(m.id)} onOpen={() => setOpen(m.id)} onTag={toggleTag} activeTags={tags} />)
          )}
        </ListBody>
      </div>
      <aside className="flex flex-col gap-4">
        <Card className="p-4">
          <div className="eyebrow">Tags</div>
          <div className="mt-1 text-xs2 leading-relaxed text-zinc-500">Tags filter your view — they don’t route. Every agent in the workspace sees every tag, so nobody fixates on one thread and misses the rest.</div>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {tagCounts.map(([t, n]) => (
              <button key={t} type="button" onClick={() => toggleTag(t)} className={cx('rounded-md border px-1.5 py-px font-mono text-2xs', tags.includes(t) ? 'border-signal/50 bg-signal/15 text-signal-light' : 'border-chip bg-line text-zinc-400 hover:text-zinc-200')}>
                #{t} <span className="text-zinc-600">{n}</span>
              </button>
            ))}
            {!tagCounts.length && <span className="text-xs text-zinc-600">No tags yet.</span>}
          </div>
        </Card>
        <Card className="p-4">
          <div className="eyebrow">Agents here</div>
          <div className="mt-3 flex flex-col gap-2">
            {w.members
              .filter((m) => m.kind === 'agent')
              .map((m) => {
                const a = agentById(d, m.id)
                if (!a) return null
                const blocked = w.agentBlocklist.includes(a.id) || a.filters.workspaceBlocklist.includes(w.id)
                return (
                  <Link key={a.id} to={`/agents/${a.id}`} className="flex items-center gap-2 text-xs text-zinc-300 hover:text-white">
                    <span className={cx('size-1.5 rounded-full', blocked ? 'bg-red-500' : isOnline(a) ? 'bg-green-500' : 'bg-zinc-600')} />
                    <span className="font-mono">{a.label}</span>
                    <span className="ml-auto text-2xs text-zinc-500">{blocked ? 'blocked' : a.status !== 'active' ? a.status : isOnline(a) ? 'online' : `seen ${ago(a.lastSeen, now).toLowerCase()}`}</span>
                  </Link>
                )
              })}
          </div>
        </Card>
        <Card className="p-4 text-xs2 leading-relaxed text-zinc-500">
          <span className="font-semibold text-zinc-300">Durable by default.</span> Messages wait for agents that aren’t connected, until they expire. Default expiry here: {w.defaultExpiryHours ? until(Date.now() + w.defaultExpiryHours * 3_600_000).replace('In ', '') : 'none'}. Retention: {w.retentionDays} days.
        </Card>
      </aside>
      <MessageDrawer msgId={open} onClose={close} ws={w} />
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Webhooks tab — every message that fires or listens                 */
/* ------------------------------------------------------------------ */
const WH_COLS = '2fr 0.8fr 1.8fr 1.1fr 0.9fr'
export function WsWebhooks() {
  const d = useDB()
  const w = useWorkspace()
  const now = useNow()
  const [open, setOpen] = useState<string | null>(null)
  const list = d.messages.filter((m) => m.wsId === w.id && m.webhook).sort((a, b) => b.createdAt - a.createdAt)
  const name = (id: string) => agentById(d, id)?.label ?? id
  const retrying = list.filter((m) => fireSummary(m, now, name)?.short === 'retrying').length
  const gaveUp = list.filter((m) => fireSummary(m, now, name)?.short === 'gave up').length
  return (
    <div className="mt-5">
      <div className="max-w-[760px] text-sm2 text-zinc-500">
        Webhooks live on messages. <span className="text-zinc-300">Fire</span> calls your URL when the message is sent, read by every target, or acknowledged by every target. <span className="text-zinc-300">Listen</span> gives the message a URL of its own that outside systems call, with basic auth, until the message expires. Every call is recorded here and in the audit log.
      </div>
      {retrying + gaveUp > 0 && (
        <Callout tone={gaveUp ? 'red' : 'amber'} className="mt-4">
          {plural(retrying + gaveUp, 'webhook')} failing{retrying ? ` — ${retrying} retrying on schedule` : ''}
          {gaveUp ? `${retrying ? ',' : ' —'} ${gaveUp} gave up after ${MAX_ATTEMPTS} attempts` : ''}. Open one to see the attempts and retry.
        </Callout>
      )}
      <Table cols={WH_COLS} head={['Message', 'Mode', 'Endpoint', 'Last result', 'Expires']} className="mt-4">
        <ListBody cols={WH_COLS} what="webhooks" empty={list.length ? undefined : <div className="p-10 text-center text-[13px] text-zinc-400">No webhooks yet. Turn on the webhook toggle when you write a message.</div>}>
          {list.map((m) => {
            const h = m.webhook!
            const last = h.mode === 'fire' ? h.attempts[h.attempts.length - 1] : h.calls[h.calls.length - 1]
            const expired = isExpired(m, now)
            const fire = fireSummary(m, now, name)
            return (
              <Row key={m.id} cols={WH_COLS} onClick={() => setOpen(m.id)} className={cx(expired && 'opacity-60')}>
                <div className="min-w-0">
                  <div className="truncate text-zinc-200">{m.body}</div>
                  <div className="font-mono text-2xs text-zinc-600">{m.id}</div>
                </div>
                <div>
                  <Pill tone={h.mode === 'fire' ? 'neutral' : 'blue'}>{h.mode === 'fire' ? '⇢ fire' : '⇠ listen'}</Pill>
                </div>
                <div className="min-w-0">
                  <div className="truncate font-mono text-xs text-zinc-300">{h.url.replace(/^https:\/\//, '')}</div>
                  <div className="text-2xs text-zinc-500">
                    {h.mode === 'fire' ? { send: 'on send', 'all-read': 'when all read', 'all-ack': 'when all ack' }[h.trigger] : 'basic auth'} · {h.authUser}
                  </div>
                </div>
                <div className={cx('text-xs', !last ? 'text-zinc-500' : last.status < 300 ? 'text-green-400' : fire?.tone === 'red' ? 'text-red-400' : 'text-amber-400')}>
                  {last ? `${last.status} · ${ago(last.at, now).toLowerCase()}` : h.mode === 'fire' ? (fire?.short === 'waiting' ? 'Waiting for trigger' : 'Won’t fire') : 'No calls yet'}
                  {fire && fire.short !== 'waiting' && fire.short !== '200' && <div className="text-2xs text-zinc-500">{fire.short === 'retrying' ? fire.long.replace(/^Failing — /, '') : fire.short === 'gave up' ? 'Gave up' : fire.long.split('.')[0].replace('Won’t fire: ', '')}</div>}
                  {h.mode === 'listen' && h.calls.length > 0 && <div className="text-2xs text-zinc-500">{plural(h.calls.length, 'call')}</div>}
                </div>
                <div className={cx('text-xs', expired ? 'text-zinc-500' : 'text-zinc-400')}>{m.expiresAt ? (expired ? 'Closed' : until(m.expiresAt, now)) : 'Never'}</div>
              </Row>
            )
          })}
        </ListBody>
      </Table>
      <MessageDrawer msgId={open} onClose={() => setOpen(null)} ws={w} />
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Shared context                                                      */
/* ------------------------------------------------------------------ */
export function WsContext() {
  const d = useDB()
  const w = useWorkspace()
  const now = useNow()
  const notes = d.notes.filter((n) => n.wsId === w.id).sort((a, b) => b.updatedAt - a.updatedAt)
  const [editing, setEditing] = useState<{ id?: string; title: string; body: string; tags: string[] } | null>(null)
  const [open, setOpen] = useState<string | null>(notes[0]?.id ?? null)
  const cur = notes.find((n) => n.id === open)
  const allTags = Array.from(new Set(d.messages.filter((m) => m.wsId === w.id).flatMap((m) => m.tags)))
  const writable = canPost(d, w)
  return (
    <div className="mt-5 grid grid-cols-[280px_1fr] gap-6">
      <div className="flex flex-col gap-2">
        {writable ? (
          <Button variant="primary" onClick={() => setEditing({ title: '', body: '', tags: [] })}>
            Add context
          </Button>
        ) : (
          <Callout tone="neutral">You can read shared context here, but your membership doesn’t include writing.</Callout>
        )}
        <div className="text-xs2 text-zinc-500">Versioned notes so the next agent doesn’t rediscover what the last one knew. Agents read and write these over the API and MCP too.</div>
        {notes.map((n) => (
          <button key={n.id} type="button" onClick={() => setOpen(n.id)} className={cx('rounded-lg border px-3 py-2.5 text-left', open === n.id ? 'border-zinc-600 bg-panel' : 'border-edge hover:border-zinc-700')}>
            <div className="text-[13px] font-medium">{n.title}</div>
            <div className="mt-0.5 text-2xs text-zinc-500">
              v{n.version} · {n.updatedBy} · {ago(n.updatedAt, now).toLowerCase()}
            </div>
          </button>
        ))}
        {!notes.length && <div className="text-xs text-zinc-500">No shared context yet.</div>}
      </div>
      {cur ? (
        <Card className="p-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="text-[15px] font-semibold">{cur.title}</div>
              <div className="mt-1 flex flex-wrap items-center gap-2">
                {cur.tags.map((t) => (
                  <Tag key={t} t={t} />
                ))}
                <span className="text-xs text-zinc-500">
                  v{cur.version} · updated by {cur.updatedBy} {ago(cur.updatedAt, now).toLowerCase()}
                </span>
              </div>
            </div>
            {writable && (
              <Button size="sm" onClick={() => setEditing({ id: cur.id, title: cur.title, body: cur.body, tags: cur.tags })}>
                Edit
              </Button>
            )}
          </div>
          <div className="mt-4 text-[13px] leading-relaxed whitespace-pre-wrap text-zinc-200">{cur.body}</div>
          <div className="eyebrow mt-6">History</div>
          <div className="mt-2 flex flex-col gap-1 text-xs text-zinc-400">
            {cur.history
              .slice()
              .reverse()
              .map((h) => (
                <div key={h.version}>
                  v{h.version} · {h.by} · {new Date(h.at).toLocaleString()}
                </div>
              ))}
          </div>
        </Card>
      ) : (
        <div />
      )}
      <Modal open={!!editing} onClose={() => setEditing(null)} width={600} title={editing?.id ? 'Edit context' : 'Add context'}>
        {editing && (
          <>
            <Field label="Title">
              <Input value={editing.title} onChange={(e) => setEditing({ ...editing, title: e.target.value })} autoFocus />
            </Field>
            <Field label="Tags" optional>
              <TagInput value={editing.tags} onChange={(tags) => setEditing({ ...editing, tags })} suggestions={allTags} />
            </Field>
            <Field label="Body">
              <Textarea rows={8} value={editing.body} onChange={(e) => setEditing({ ...editing, body: e.target.value })} />
            </Field>
            <Footer>
              <Button size="lg" onClick={() => setEditing(null)}>
                Cancel
              </Button>
              <Button
                size="lg"
                variant="primary"
                disabled={!editing.title.trim() || !editing.body.trim()}
                onClick={() => {
                  actions.saveNote({ ...editing, wsId: w.id })
                  setEditing(null)
                }}
              >
                {editing.id ? 'Save new version' : 'Add context'}
              </Button>
            </Footer>
          </>
        )}
      </Modal>
    </div>
  )
}

export function WsAudit() {
  const d = useDB()
  const w = useWorkspace()
  return (
    <div className="mt-5">
      <AuditLog events={orgEvents(d).filter((e) => e.wsId === w.id)} hideWorkspaceFilter />
    </div>
  )
}

