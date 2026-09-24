import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { audienceLabel, filteredReason, targets } from '../lib/access'
import { ago, clock, maskHookPassword, plural, until } from '../lib/format'
import { actions, agentById, canAdmin, canPost, fireState, isExpired, MAX_ATTEMPTS, isOnline, orgEvents, principalName, receiptState, useDB, useNow, type ReceiptState } from '../lib/store'
import type { Audience, FireTrigger, Message, Workspace } from '../lib/types'
import { CopyChip, SECRET_LINE, SecretField } from './credential'
import { showSecret } from '../lib/secrets'
import { ImpactDialog, LogRow, PrincipalChip, Tag } from './shared'
import { Button, Callout, Checkbox, Field, Footer, Input, Pill, Segmented, Select, SlideOver, Textarea, Toggle, cx } from './ui'

/* ------------------------------------------------------------------ */
/* Receipts — tracked per agent                                        */
/* ------------------------------------------------------------------ */
const STATE_STYLE: Record<ReceiptState, string> = {
  queued: 'border-zinc-700 text-zinc-500 border-dashed',
  expired: 'border-zinc-800 text-zinc-500 border-dashed',
  delivered: 'border-zinc-600 text-zinc-300 bg-line',
  read: 'border-signal/40 text-signal-light bg-signal/10',
  acked: 'border-green-500/40 text-green-400 bg-green-500/10',
  filtered: 'border-zinc-800 text-zinc-600 line-through',
}
const STATE_LABEL: Record<ReceiptState, string> = { queued: 'Queued', delivered: 'Delivered', read: 'Read', acked: 'Acknowledged', filtered: 'Filtered', expired: 'Never delivered' }

export function ReceiptPills({ m, max = 8 }: { m: Message; max?: number }) {
  const d = useDB()
  const entries = Object.entries(m.receipts)
  return (
    <span className="flex flex-wrap items-center gap-1">
      {entries.slice(0, max).map(([id, r]) => {
        const s = receiptState(r, m)
        const a = agentById(d, id)
        return (
          <span key={id} title={`${a?.label}: ${STATE_LABEL[s]}${r.filtered ? ` — ${r.filtered}` : ''}`} className={cx('rounded border px-1.5 py-px font-mono text-[10.5px]', STATE_STYLE[s])}>
            {a?.label ?? id}
            {s === 'acked' ? ' ✓✓' : s === 'read' ? ' ✓' : ''}
          </span>
        )
      })}
      {entries.length > max && <span className="text-2xs text-zinc-500">+{entries.length - max}</span>}
    </span>
  )
}

export function receiptCounts(m: Message, now = Date.now()) {
  const rs = Object.values(m.receipts).filter((r) => !r.filtered)
  const expired = isExpired(m, now)
  return { total: rs.length, delivered: rs.filter((r) => r.deliveredAt).length, read: rs.filter((r) => r.readAt).length, acked: rs.filter((r) => r.ackAt).length, filtered: Object.values(m.receipts).length - rs.length, expired, neverDelivered: expired ? rs.filter((r) => !r.deliveredAt).length : 0 }
}

/** One line for where a fire webhook stands — the same words on the card, the drawer and the Webhooks tab. */
export function fireSummary(m: Message, now: number, name: (id: string) => string): { tone: 'neutral' | 'green' | 'amber' | 'red'; short: string; long: string } | null {
  const s = fireState(m, now)
  if (!s || m.webhook?.mode !== 'fire') return null
  const verb = m.webhook.trigger === 'all-read' ? 'read' : 'acknowledge'
  switch (s.k) {
    case 'waiting':
      return { tone: 'neutral', short: 'waiting', long: m.webhook.trigger === 'send' ? 'Firing…' : `Not fired yet — waiting for ${s.pending.map(name).join(', ')} to ${verb} it (${s.total - s.pending.length} of ${s.total} done). Filtered targets drop out of “every target”.` }
    case 'delivered':
      return { tone: 'green', short: '200', long: `Delivered on attempt ${s.attempt} at ${clock(s.at)}.` }
    case 'retrying': {
      const secs = Math.max(0, Math.round((s.next - now) / 1000))
      return { tone: 'amber', short: 'retrying', long: `Failing — attempt ${s.attempt} of ${MAX_ATTEMPTS} at ${clock(s.next)}${secs ? ` (in ${secs < 90 ? `${secs} s` : `${Math.round(secs / 60)} min`})` : ' (due now)'}.` }
    }
    case 'gave-up':
      return { tone: 'red', short: 'gave up', long: `Gave up after ${s.attempts} attempts. Nothing more is scheduled; Retry now calls it once more.` }
    case 'no-targets':
      return { tone: 'neutral', short: 'won’t fire', long: 'Won’t fire: no deliverable targets. Every addressed agent was filtered, so nobody can meet the trigger.' }
    case 'expired':
      return { tone: 'neutral', short: 'won’t fire', long: s.attempts ? `Stopped: the message expired after ${s.attempts} failed attempt${s.attempts === 1 ? '' : 's'}. Nothing fires after expiry.` : 'Won’t fire: the message expired before its trigger was met.' }
  }
}

function WebhookBadge({ m }: { m: Message }) {
  const d = useDB()
  const now = useNow(5000)
  const h = m.webhook
  if (!h) return null
  if (h.mode === 'fire') {
    const f = fireSummary(m, now, (id) => agentById(d, id)?.label ?? id)!
    const trig = { send: 'on send', 'all-read': 'when all read', 'all-ack': 'when all ack' }[h.trigger]
    return <Pill tone={f.tone}>⇢ fire {trig} · {f.short}</Pill>
  }
  const open = !isExpired(m)
  return <Pill tone={open ? 'blue' : 'neutral'}>⇠ listening{open ? '' : ' · closed'} · {plural(h.calls.length, 'call')}</Pill>
}

/* ------------------------------------------------------------------ */
/* Message card                                                        */
/* ------------------------------------------------------------------ */
export function MessageCard({ m, onOpen, replies, onTag, activeTags }: { m: Message; onOpen: () => void; replies: number; onTag?: (t: string) => void; activeTags?: string[] }) {
  const d = useDB()
  const now = useNow(10_000)
  const c = receiptCounts(m, now)
  const expired = isExpired(m, now)
  const soon = !expired && m.expiresAt && m.expiresAt - now < 2 * 3_600_000
  return (
    <article className={cx('rounded-[10px] border border-edge bg-panel px-4 py-3.5 transition-colors hover:border-zinc-700', expired && 'opacity-55')}>
      <header className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
        <PrincipalChip p={m.author} />
        {m.author.kind === 'human' && <Pill className="!py-0">human</Pill>}
        {m.author.kind === 'webhook' && <Pill tone="blue" className="!py-0">via listener</Pill>}
        <span className="text-xs text-zinc-600">→</span>
        <span className="text-xs text-zinc-400">{audienceLabel(d, m.audience)}</span>
        <span className="ml-auto flex items-center gap-2 text-xs text-zinc-500">
          <span title={new Date(m.createdAt).toLocaleString()}>{clock(m.createdAt).slice(0, 5)} · {ago(m.createdAt, now).toLowerCase()}</span>
        </span>
      </header>
      <button type="button" onClick={onOpen} className="mt-2 block w-full text-left text-[13.5px] leading-relaxed whitespace-pre-wrap text-zinc-200 hover:text-white">
        {m.body}
      </button>
      {m.payload && <pre className="mt-2 mb-0 max-h-28 overflow-auto rounded-md border border-line bg-rail px-3 py-2 font-mono text-xs2 text-zinc-400">{m.payload}</pre>}
      <footer className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-2">
        {m.tags.map((t) => (
          <Tag key={t} t={t} on={activeTags?.includes(t)} onClick={onTag ? () => onTag(t) : undefined} />
        ))}
        <WebhookBadge m={m} />
        <span className={cx('text-xs', expired ? 'text-zinc-500' : soon ? 'text-amber-400' : 'text-zinc-500')}>{m.expiresAt ? (expired ? 'Expired' : `Expires ${until(m.expiresAt, now).toLowerCase()}`) : 'No expiry'}</span>
        <span className="ml-auto flex items-center gap-3">
          {replies > 0 && (
            <button type="button" onClick={onOpen} className="text-xs text-signal hover:text-signal-light">
              {plural(replies, 'reply', 'replies')}
            </button>
          )}
          <CopyChip value={m.trk} />
        </span>
      </footer>
      {c.total + c.filtered > 0 && (
        <button type="button" onClick={onOpen} className="mt-2.5 flex w-full flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-line pt-2.5 text-left">
          <span className="text-xs text-zinc-500">
            {c.expired && <span>Expired · </span>}
            Read by <span className="text-zinc-300">{c.read}</span> of {c.total} · acked <span className="text-zinc-300">{c.acked}</span>
            {c.neverDelivered > 0 && <span> · {c.neverDelivered} never delivered</span>}
            {c.filtered > 0 && <span> · {c.filtered} filtered</span>}
          </span>
          <ReceiptPills m={m} />
        </button>
      )}
    </article>
  )
}

/* ------------------------------------------------------------------ */
/* Audience + tags inputs                                              */
/* ------------------------------------------------------------------ */
export function AudiencePicker({ ws, value, onChange }: { ws: Workspace; value: Audience; onChange: (a: Audience) => void }) {
  const d = useDB()
  const agentMembers = ws.members.filter((m) => m.kind === 'agent').map((m) => agentById(d, m.id)!).filter(Boolean)
  const ids = value.mode === 'all' ? [] : value.agentIds
  return (
    <div className="flex flex-col gap-2">
      <Segmented
        size="sm"
        label="Audience"
        value={value.mode}
        onChange={(mode) => onChange(mode === 'all' ? { mode } : { mode, agentIds: ids })}
        options={[
          { value: 'all', label: 'All agents' },
          { value: 'only', label: 'Only…' },
          { value: 'except', label: 'All except…' },
        ]}
      />
      {value.mode !== 'all' && (
        <div className="flex flex-wrap gap-1.5">
          {agentMembers.map((a) => {
            const on = ids.includes(a.id)
            return (
              <button
                key={a.id}
                type="button"
                aria-pressed={on}
                onClick={() => onChange({ mode: value.mode, agentIds: on ? ids.filter((x) => x !== a.id) : [...ids, a.id] })}
                className={cx('rounded-md border px-2 py-0.5 font-mono text-xs', on ? (value.mode === 'only' ? 'border-signal/50 bg-signal/15 text-signal-light' : 'border-red-500/40 bg-red-500/10 text-red-400 line-through') : 'border-edge text-zinc-400 hover:text-zinc-200')}
              >
                {a.label}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

export function TagInput({ value, onChange, suggestions }: { value: string[]; onChange: (t: string[]) => void; suggestions: string[] }) {
  const [draft, setDraft] = useState('')
  const add = (t: string) => {
    const clean = t.trim().replace(/^#/, '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-')
    if (clean && !value.includes(clean)) onChange([...value, clean])
    setDraft('')
  }
  const sugg = suggestions.filter((s) => !value.includes(s) && s.includes(draft.toLowerCase())).slice(0, 8)
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-zinc-700 bg-page px-2 py-1.5 focus-within:border-zinc-500">
        {value.map((t) => (
          <span key={t} className="inline-flex items-center gap-1 rounded-md border border-chip bg-line px-1.5 py-px font-mono text-2xs text-zinc-300">
            #{t}
            <button type="button" aria-label={`Remove ${t}`} className="text-zinc-600 hover:text-zinc-300" onClick={() => onChange(value.filter((x) => x !== t))}>
              ✕
            </button>
          </span>
        ))}
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if ((e.key === 'Enter' || e.key === ',' || e.key === ' ') && draft.trim()) {
              e.preventDefault()
              add(draft)
            }
            if (e.key === 'Backspace' && !draft && value.length) onChange(value.slice(0, -1))
          }}
          placeholder={value.length ? '' : 'Add tags — Enter to add'}
          aria-label="Tags"
          className="min-w-24 flex-1 bg-transparent font-mono text-xs text-zinc-200 outline-none placeholder:font-sans placeholder:text-zinc-600"
        />
      </div>
      {sugg.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {sugg.map((s) => (
            <button key={s} type="button" onClick={() => add(s)} className="rounded border border-line px-1.5 py-px font-mono text-[10.5px] text-zinc-500 hover:text-zinc-300">
              +#{s}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Composer                                                            */
/* ------------------------------------------------------------------ */
const EXPIRY: [string, number | null][] = [
  ['1 hour', 1],
  ['6 hours', 6],
  ['24 hours', 24],
  ['7 days', 168],
  ['No expiry', null],
]

export function Composer({ ws, parent, onSent, compact }: { ws: Workspace; parent?: Message; onSent?: (id: string) => void; compact?: boolean }) {
  const d = useDB()
  const [open, setOpen] = useState(!!parent || !compact)
  const [body, setBody] = useState('')
  const [payload, setPayload] = useState('')
  const [showPayload, setShowPayload] = useState(false)
  const [tags, setTags] = useState<string[]>(parent?.tags ?? [])
  const [audience, setAudience] = useState<Audience>(parent?.audience ?? { mode: 'all' })
  const [expiry, setExpiry] = useState<string>(String(ws.defaultExpiryHours ?? 'none'))
  const [hookOn, setHookOn] = useState(false)
  const [hookMode, setHookMode] = useState<'fire' | 'listen'>('fire')
  const [url, setUrl] = useState('https://ci.acme.dev/hooks/')
  const [trigger, setTrigger] = useState<FireTrigger>('all-ack')
  const [authUser, setAuthUser] = useState('dispatch')
  const [pwLen, setPwLen] = useState(0)
  const [nonce, setNonce] = useState(0)
  const allTags = useMemo(() => Array.from(new Set(d.messages.filter((m) => m.wsId === ws.id).flatMap((m) => m.tags))).sort(), [d.messages, ws.id])

  const preview = useMemo(() => {
    const draft = { audience, author: { kind: 'human' as const, id: d.currentUserId } }
    const ids = targets(ws, draft)
    const filtered = ids.map((id) => ({ id, why: filteredReason(d, ws, draft, agentById(d, id)!) })).filter((x) => x.why)
    const offline = ids.filter((id) => !filtered.some((f) => f.id === id) && !isOnline(agentById(d, id)!))
    return { total: ids.length, filtered, offline }
  }, [d, ws, audience])

  const expiryHours = expiry === 'none' ? null : Number(expiry)
  const needsExpiry = hookOn && hookMode === 'listen' && !expiryHours
  const badUrl = hookOn && hookMode === 'fire' && !/^https:\/\/\S+\.\S+/.test(url)
  const allowed = canPost(d, ws)
  const reachable = preview.total - preview.filtered.length
  const deadHook = hookOn && hookMode === 'fire' && trigger !== 'send' && reachable === 0
  const ok = allowed && body.trim() && (audience.mode === 'all' || audience.agentIds.length) && !needsExpiry && !badUrl && !deadHook

  const send = () => {
    const res = actions.postMessage({
      wsId: ws.id,
      body: body.trim(),
      payload: showPayload ? payload : undefined,
      tags,
      audience,
      expiresInHours: expiryHours,
      parentId: parent?.id,
      webhook: hookOn ? (hookMode === 'fire' ? { mode: 'fire', url, trigger, authUser, authSet: pwLen > 0 } : { mode: 'listen', authUser }) : undefined,
    })
    if (res.hookPassword && res.listenUrl) showSecret({ kind: 'listener', title: 'Listener created', url: res.listenUrl, user: authUser, password: res.hookPassword })
    setBody('')
    setPayload('')
    setShowPayload(false)
    setHookOn(false)
    setPwLen(0)
    setNonce((n) => n + 1)
    if (!parent) setTags([])
    onSent?.(res.id)
    if (compact) setOpen(false)
  }

  if (!allowed) return <Callout tone="neutral">You can read and search this workspace, but your membership doesn’t include writing.</Callout>
  if (!open)
    return (
      <>
        <button type="button" onClick={() => setOpen(true)} className="w-full rounded-[10px] border border-edge bg-panel px-4 py-3 text-left text-[13px] text-zinc-500 hover:border-zinc-700 hover:text-zinc-300">
          Write to {ws.name}…
        </button>
      </>
    )

  return (
    <div className="flex flex-col gap-3 rounded-[10px] border border-zinc-700 bg-panel p-4">
      <Textarea
        autoFocus={!parent}
        rows={parent ? 2 : 3}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => (e.metaKey || e.ctrlKey) && e.key === 'Enter' && ok && send()}
        placeholder={parent ? 'Reply in thread…' : `Message ${ws.name} — addressed to the workspace, delivered to agents even if they aren’t connected yet`}
        className="bg-page"
      />
      {showPayload && <Textarea rows={3} value={payload} onChange={(e) => setPayload(e.target.value)} placeholder='{ "json": "payload" }' className="bg-page font-mono text-xs" />}
      <div className="grid grid-cols-[1fr_1fr] gap-4">
        <Field label="To">
          <AudiencePicker ws={ws} value={audience} onChange={setAudience} />
        </Field>
        <Field label="Tags" optional="filters, not channels">
          <TagInput value={tags} onChange={setTags} suggestions={allTags} />
        </Field>
      </div>
      <div className="flex flex-wrap items-center gap-4">
        <label className="flex items-center gap-2 text-xs text-zinc-400">
          Expires
          <select aria-label="Expiry" value={expiry} onChange={(e) => setExpiry(e.target.value)} className="rounded-md border border-edge bg-page px-2 py-1 text-xs text-zinc-200 outline-none">
            {EXPIRY.map(([l, h]) => (
              <option key={l} value={h ?? 'none'}>
                {l}
                {h === ws.defaultExpiryHours ? ' (workspace default)' : ''}
              </option>
            ))}
          </select>
        </label>
        <Checkbox checked={showPayload} onChange={setShowPayload} label={<span className="text-xs">JSON payload</span>} />
        <span className="flex items-center gap-2 text-xs text-zinc-400">
          <Toggle on={hookOn} onChange={setHookOn} label="Webhook" />
          Webhook
        </span>
      </div>
      {hookOn && (
        <div className="flex flex-col gap-3 rounded-lg border border-edge bg-rail p-3.5">
          <Segmented
            size="sm"
            label="Webhook mode"
            value={hookMode}
            onChange={setHookMode}
            options={[
              { value: 'fire', label: '⇢ Fire — call a URL' },
              { value: 'listen', label: '⇠ Listen — get a URL' },
            ]}
          />
          {hookMode === 'fire' ? (
            <>
              <div className="grid grid-cols-[2fr_1fr] gap-3">
                <Field label="URL" error={badUrl ? 'Use an https:// address.' : null}>
                  <Input mono value={url} onChange={(e) => setUrl(e.target.value)} />
                </Field>
                <Field label="Fire">
                  <Select value={trigger} onChange={(e) => setTrigger(e.target.value as FireTrigger)}>
                    <option value="send">On send</option>
                    <option value="all-read">When every target has read it</option>
                    <option value="all-ack">When every target has acked it</option>
                  </Select>
                </Field>
              </div>
              <div className="grid grid-cols-[1fr_2fr] gap-3">
                <Field label="Basic auth user">
                  <Input mono value={authUser} onChange={(e) => setAuthUser(e.target.value)} />
                </Field>
                <Field label="Password" optional hint={SECRET_LINE}>
                  <SecretField key={nonce} onLength={setPwLen} compact />
                </Field>
              </div>
              {deadHook ? (
                <div className="text-xs2 text-amber-400">No agent can receive this message, so “{trigger === 'all-read' ? 'every target has read it' : 'every target has acked it'}” could never be met and the webhook would never fire. Fire on send, or change who it’s to.</div>
              ) : (
                <div className="text-xs2 text-zinc-500">Fires once. Failed calls retry 3 times (30 s, 2 min, 10 min), then give up. Filtered targets drop out of “every target”. Nothing fires after the message expires. Every attempt is logged with its status and tracking code.</div>
              )}
            </>
          ) : (
            <>
              <div className="grid grid-cols-[1fr_2fr] items-end gap-3">
                <Field label="Basic auth user">
                  <Input mono value={authUser} onChange={(e) => setAuthUser(e.target.value)} />
                </Field>
                <div className="pb-2.5 text-xs2 text-zinc-500">A listener URL and password are created when you send. The password is shown once.</div>
              </div>
              <div className={cx('text-xs2', needsExpiry ? 'text-amber-400' : 'text-zinc-500')}>
                {needsExpiry ? 'A listener needs an expiry — pick one above. It closes (410) when the message expires.' : `Open until the message expires (${EXPIRY.find(([, h]) => h === expiryHours)?.[0]}). Each accepted call is appended to this message’s thread and logged; wrong passwords get 401.`}
              </div>
            </>
          )}
        </div>
      )}
      <div className="flex items-center justify-between gap-4">
        <div className="text-xs text-zinc-500">
          Reaches {plural(preview.total - preview.filtered.length, 'agent')}
          {preview.offline.length > 0 && <> · {preview.offline.length} offline — queued until they connect</>}
          {preview.filtered.length > 0 && (
            <span className="text-amber-400" title={preview.filtered.map((f) => `${agentById(d, f.id)?.label}: ${f.why}`).join('\n')}>
              {' '}
              · {preview.filtered.length} filtered ({preview.filtered.map((f) => agentById(d, f.id)?.label).join(', ')})
            </span>
          )}
          . Humans in the workspace always see it.
        </div>
        <div className="flex gap-2">
          {compact && (
            <Button size="sm" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          )}
          <Button variant="primary" size="sm" disabled={!ok} onClick={send}>
            {parent ? 'Reply' : 'Send message'}
          </Button>
        </div>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Message drawer: receipts, webhook observability, thread, audit      */
/* ------------------------------------------------------------------ */
export function MessageDrawer({ msgId, onClose, ws }: { msgId: string | null; onClose: () => void; ws: Workspace }) {
  const d = useDB()
  const now = useNow(5000)
  const m = d.messages.find((x) => x.id === msgId)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [rotating, setRotating] = useState(false)
  useEffect(() => setExpanded(null), [msgId])
  if (!m) return null
  const thread = d.messages.filter((x) => x.parentId === m.id).sort((a, b) => a.createdAt - b.createdAt)
  const expired = isExpired(m, now)
  const c = receiptCounts(m, now)
  const list = (key: 'deliveredAt' | 'readAt' | 'ackAt') =>
    Object.entries(m.receipts)
      .filter(([, r]) => r[key] && !r.filtered)
      .map(([id]) => agentById(d, id)?.label ?? id)
  const fire = fireSummary(m, now, (id) => agentById(d, id)?.label ?? id)
  const events = orgEvents(d).filter((e) => e.object.includes(m.id) || e.trk === m.trk || (m.webhook?.mode === 'listen' && e.object.includes(m.webhook.url.split('/').pop()!)))
  const hook = m.webhook

  return (
    <SlideOver open={!!msgId} onClose={onClose} width={640} title={<span className="flex items-center gap-2.5">Message <span className="font-mono text-xs font-normal text-zinc-500">{m.id}</span></span>}>
      <div className="flex flex-wrap items-center gap-2.5">
        <PrincipalChip p={m.author} withKind />
        <span className="text-xs text-zinc-600">→</span>
        <span className="text-xs text-zinc-400">{audienceLabel(d, m.audience)}</span>
        <span className="ml-auto text-xs text-zinc-500">{new Date(m.createdAt).toLocaleString()}</span>
      </div>
      <div className="text-[13.5px] leading-relaxed whitespace-pre-wrap">{m.body}</div>
      {m.payload && <pre className="m-0 rounded-md border border-line bg-rail px-3 py-2 font-mono text-xs2 text-zinc-400">{m.payload}</pre>}
      <div className="flex flex-wrap items-center gap-2">
        {m.tags.map((t) => (
          <Tag key={t} t={t} />
        ))}
        <span className={cx('text-xs', expired ? 'text-zinc-500' : 'text-zinc-400')}>{m.expiresAt ? (expired ? `Expired ${ago(m.expiresAt, now).toLowerCase()}` : `Expires ${until(m.expiresAt, now).toLowerCase()} · ${new Date(m.expiresAt).toLocaleString()}`) : 'No expiry'}</span>
        {!expired && m.expiresAt && (
          <button type="button" className="text-xs text-zinc-500 hover:text-red-400" onClick={() => actions.expireNow(m.id)}>
            Expire now
          </button>
        )}
        <span className="ml-auto">
          <CopyChip value={m.trk} />
        </span>
      </div>

      <section>
        <div className="eyebrow">Receipts · per agent</div>
        <div className="mt-2 grid grid-cols-3 gap-2 text-xs">
          {(
            [
              ['Delivered', list('deliveredAt')],
              ['Read', list('readAt')],
              ['Acknowledged', list('ackAt')],
            ] as const
          ).map(([k, names]) => (
            <div key={k} className="rounded-lg border border-edge bg-rail px-3 py-2">
              <div className="text-zinc-500">
                {k} · {names.length}/{c.total}
              </div>
              <div className="mt-1 font-mono text-[11.5px] text-zinc-300">{names.join(', ') || '—'}</div>
            </div>
          ))}
        </div>
        <div className="mt-2 overflow-hidden rounded-[10px] border border-edge">
          <div className="grid grid-cols-[1.2fr_0.9fr_0.8fr_0.8fr_0.8fr] gap-3 border-b border-line bg-panel px-3.5 py-2">
            {['Agent', 'State', 'Delivered', 'Read', 'Acked'].map((h) => (
              <div key={h} className="th">
                {h}
              </div>
            ))}
          </div>
          {Object.entries(m.receipts).map(([id, r]) => {
            const s = receiptState(r, m, now)
            const a = agentById(d, id)
            return (
              <div key={id} className="border-b border-line px-3.5 py-2 text-xs last:border-b-0">
                <div className="grid grid-cols-[1.2fr_0.9fr_0.8fr_0.8fr_0.8fr] items-center gap-3">
                  <PrincipalChip p={{ kind: 'agent', id }} size={18} />
                  <span>
                    <span className={cx('rounded border px-1.5 py-px font-mono text-[10.5px]', STATE_STYLE[s])}>{STATE_LABEL[s]}</span>
                    {s === 'queued' && a && !isOnline(a) && <span className="ml-1.5 text-2xs text-zinc-500">offline</span>}
                    {expired && (s === 'delivered' || s === 'read') && <span className="ml-1.5 text-2xs text-zinc-500">expired · never {s === 'delivered' ? 'read' : 'acked'}</span>}
                  </span>
                  {(['deliveredAt', 'readAt', 'ackAt'] as const).map((k) => (
                    <span key={k} className="font-mono text-zinc-500">
                      {r[k] ? clock(r[k]!) : '—'}
                    </span>
                  ))}
                </div>
                {r.filtered && (
                  <div className="mt-1 pl-[26px] text-2xs text-zinc-500">
                    {r.filteredAt && <span className="text-amber-400">Filtered at {clock(r.filteredAt)}, after it was sent — access changed. </span>}
                    {r.filtered}
                  </div>
                )}
              </div>
            )
          })}
          {!Object.keys(m.receipts).length && <div className="px-3.5 py-3 text-xs text-zinc-500">No agents targeted.</div>}
        </div>
      </section>

      {hook && (
        <section>
          <div className="flex items-center justify-between">
            <div className="eyebrow">Webhook · {hook.mode === 'fire' ? 'fire' : 'listener'}</div>
            <WebhookBadge m={m} />
          </div>
          <div className="mt-2 grid grid-cols-[110px_1fr] gap-x-3 gap-y-1.5 rounded-lg border border-edge bg-rail p-3.5 text-xs">
            <span className="text-zinc-500">URL</span>
            <span>{hook.mode === 'listen' ? <CopyChip value={hook.url} variant="inline" /> : <span className="font-mono text-zinc-300">{hook.url}</span>}</span>
            {hook.mode === 'fire' && (
              <>
                <span className="text-zinc-500">Trigger</span>
                <span>{{ send: 'On send', 'all-read': 'When every target has read it', 'all-ack': 'When every target has acknowledged it' }[hook.trigger]}</span>
              </>
            )}
            <span className="text-zinc-500">Basic auth</span>
            <span className="font-mono text-zinc-300">
              {hook.mode === 'fire' ? (hook.authSet ? `${hook.authUser} · ••••••••` : 'None') : `${hook.authUser} · ${maskHookPassword(hook.passwordLast4)}`}
            </span>
            <span className="text-zinc-500">{hook.mode === 'listen' ? 'Open until' : 'Stops at'}</span>
            <span>{m.expiresAt ? `${new Date(m.expiresAt).toLocaleString()}${expired ? ' · closed' : ''}` : 'Never expires'}</span>
          </div>
          {fire && (
            <div role="status" className={cx('mt-2 text-xs', fire.tone === 'red' ? 'text-red-400' : fire.tone === 'amber' ? 'text-amber-400' : fire.tone === 'green' ? 'text-green-400' : 'text-zinc-400')}>
              {fire.long}
              {fire.tone === 'amber' && !d.live && <span className="text-zinc-500"> Prototype: retries run while the simulation is running.</span>}
            </div>
          )}
          <div className="mt-2 overflow-hidden rounded-[10px] border border-edge">
            {hook.mode === 'fire' ? (
              hook.attempts.length ? (
                hook.attempts.map((at, i) => (
                  <div key={at.id} className="flex items-center gap-3 border-b border-line px-3.5 py-2 text-xs last:border-b-0">
                    <span className="font-mono text-zinc-500">{clock(at.at)}</span>
                    <span className="text-zinc-500">#{i + 1}</span>
                    <span className={at.status < 300 ? 'text-green-400' : 'text-amber-400'}>{at.status}</span>
                    <span className="text-zinc-500">{at.ms} ms</span>
                    <span className="truncate text-zinc-400">{at.note}</span>
                    <span className="ml-auto">
                      <CopyChip value={at.trk} />
                    </span>
                  </div>
                ))
              ) : (
                <div className="px-3.5 py-3 text-xs text-zinc-500">No attempts.</div>
              )
            ) : hook.calls.length ? (
              hook.calls.map((call) => (
                <div key={call.id} className="flex items-center gap-3 border-b border-line px-3.5 py-2 text-xs last:border-b-0">
                  <span className="font-mono text-zinc-500">{clock(call.at)}</span>
                  <span className={call.status === 202 ? 'text-green-400' : 'text-red-400'}>{call.status}</span>
                  <span className="font-mono text-zinc-500">{call.from}</span>
                  <span className="truncate text-zinc-400">{call.summary}</span>
                  <span className="ml-auto">
                    <CopyChip value={call.trk} />
                  </span>
                </div>
              ))
            ) : (
              <div className="px-3.5 py-3 text-xs text-zinc-500">No calls yet.</div>
            )}
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            {fire && (fire.short === 'retrying' || fire.short === 'gave up') && (
              <Button size="sm" onClick={() => actions.retryWebhook(m.id)}>
                Retry now
              </Button>
            )}
            {hook.mode === 'listen' && (
              <>
                <Button size="sm" onClick={() => actions.callListener(m.id, true)}>
                  Simulate a call
                </Button>
                <Button size="sm" onClick={() => actions.callListener(m.id, false)}>
                  Simulate a wrong password
                </Button>
                <span className="self-center text-2xs text-zinc-600">Prototype: stands in for the outside system.</span>
                {!expired && (canAdmin(d, ws) || (m.author.kind === 'human' && m.author.id === d.currentUserId && canPost(d, ws))) && (
                  <Button size="sm" className="ml-auto" onClick={() => setRotating(true)}>
                    Rotate password
                  </Button>
                )}
              </>
            )}
          </div>
          {hook.mode === 'listen' && (
            <ImpactDialog
              open={rotating}
              onClose={() => setRotating(false)}
              title="Rotate the listener password?"
              rows={[
                ['Listener', <span className="font-mono">{hook.url.split('/').pop()}</span>],
                ['Current password', `${maskHookPassword(hook.passwordLast4)} — stops working now`, 'amber'],
                ['Open until', m.expiresAt ? new Date(m.expiresAt).toLocaleString() : '—'],
              ]}
              body="The new password is shown once. Until the outside system has it, its calls get 401 and nothing is appended."
              confirmLabel="Rotate password"
              onConfirm={() => {
                const pw = actions.rotateListenerPassword(m.id)
                if (pw) showSecret({ kind: 'listener', title: 'Listener password rotated', subtitle: 'Same URL and user. Give the new password to the outside system.', url: hook.url, user: hook.authUser, password: pw })
              }}
            />
          )}
        </section>
      )}

      <section>
        <div className="eyebrow">Thread · {thread.length}</div>
        <div className="mt-2 flex flex-col gap-2">
          {thread.map((r) => (
            <div key={r.id} className="rounded-lg border border-edge bg-rail px-3.5 py-2.5">
              <div className="flex items-center gap-2 text-xs">
                <PrincipalChip p={r.author} size={18} />
                {r.author.kind === 'webhook' && <Pill tone="blue" className="!py-0">via listener</Pill>}
                <span className="ml-auto text-zinc-500">{ago(r.createdAt, now).toLowerCase()}</span>
              </div>
              <div className="mt-1.5 text-[13px] whitespace-pre-wrap text-zinc-200">{r.body}</div>
              {r.payload && <pre className="mt-1.5 mb-0 rounded border border-line bg-panel px-2.5 py-1.5 font-mono text-[11px] text-zinc-400">{r.payload}</pre>}
              <div className="mt-1.5 flex items-center gap-2 text-2xs text-zinc-500">
                Read by {receiptCounts(r).read} of {receiptCounts(r).total} · {principalName(d, r.author)}
              </div>
            </div>
          ))}
          <Composer ws={ws} parent={m} />
        </div>
      </section>

      <section>
        <div className="eyebrow">Audit · this message</div>
        <div className="mt-2 overflow-hidden rounded-[10px] border border-edge bg-panel [&>*:last-child]:border-b-0">
          {events.length ? events.map((e) => <LogRow key={e.id} e={e} expanded={expanded === e.id} onToggle={() => setExpanded(expanded === e.id ? null : e.id)} />) : <div className="px-4 py-3 text-xs text-zinc-500">No audit rows yet.</div>}
        </div>
        <Link to={`/workspaces/${ws.id}/audit`} className="mt-2 inline-block text-xs">
          Full workspace audit →
        </Link>
      </section>
      <Footer>
        <Button size="lg" onClick={onClose}>
          Close
        </Button>
      </Footer>
    </SlideOver>
  )
}
