// The workspace's Webhooks tab: outgoing webhooks that receive this
// workspace's messages (signed, retried, dead-lettered), and listeners that
// outside systems post messages to. Signing secrets are shown once. The
// scheme is in docs/webhooks.md.
import { useState, type FormEvent } from 'react'
import { useParams } from 'react-router-dom'
import { hooks, type DeadLetter, type Listener, type Webhook, type WebhookDelivery, type WebhookFilter, type WebhooksTab } from '../api'
import { Callout, Checkbox, Footer, FormField, Modal, Select, TextInput, ago } from '../kit'
import { CodeBlock, Confirm, SecretLine, SecretPanel, errorText } from '../secret'
import { useLoad, useSession } from '../session'
import { Button, ErrorBox, Pill, Row, SkeletonRows, Table, cx, plural } from '../ui'

const HOOK_COLS = '1.3fr 1.6fr 1.1fr 0.9fr 2.1fr'
const DELIVERY_COLS = '1.1fr 1.3fr 0.9fr 1.8fr 0.8fr'
const DEAD_COLS = '1.1fr 1.3fr 2fr 0.9fr 0.8fr'
const LISTENER_COLS = '1.1fr 2.3fr 0.6fr 0.9fr 1.7fr'
const CALL_COLS = '1fr 1fr 0.6fr 2fr 1fr'

const SECRET_NOTE = 'Shown once. Dispatch keeps it encrypted to sign and check calls, and never shows it again: store it now. You can replace it with a new one.'

type Issued = { title: string; secret: string; url?: string }
type Pending =
  | { kind: 'delete-hook'; hook: Webhook }
  | { kind: 'rotate-hook'; hook: Webhook }
  | { kind: 'delete-listener'; listener: Listener }
  | { kind: 'rotate-listener'; listener: Listener }

export function WsWebhooks() {
  const { wsId = '' } = useParams()
  const { org, me, onError } = useSession()
  const orgId = org?.id
  const [tab, reload] = useLoad(orgId ? () => hooks.tab(orgId, wsId) : null, [orgId, wsId])
  const [editing, setEditing] = useState<Webhook | 'new' | null>(null)
  const [issued, setIssued] = useState<Issued | null>(null)
  const [pending, setPending] = useState<Pending | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function act(fn: () => Promise<Issued | null | void>) {
    setBusy(true)
    setError(null)
    try {
      const out = await fn()
      if (out) setIssued(out)
      setPending(null)
      reload()
      return true
    } catch (err) {
      onError(err)
      setError(errorText(err))
      return false
    } finally {
      setBusy(false)
    }
  }

  if (tab.state === 'error') return <div className="mt-5"><ErrorBox what="this workspace’s webhooks" onRetry={reload} /></div>
  const d = tab.state === 'ready' ? tab.data : null
  const admin = !!d?.can_admin && !!orgId && d.available
  const csrf = me.csrf_token
  const hookName = (id: string) => d?.webhooks.find((h) => h.id === id)?.name ?? id
  const listenerName = (id: string) => d?.listeners.find((l) => l.id === id)?.name ?? id

  return (
    <div className="mt-5 grid grid-cols-[1fr_300px] gap-6">
      <div className="flex min-w-0 flex-col gap-4">
        {issued && (
          <SecretPanel title={issued.title} note={SECRET_NOTE} onDone={() => setIssued(null)}>
            {issued.url && <SecretLine label="Listener URL" value={issued.url} />}
            <SecretLine label="Signing secret" value={issued.secret} />
          </SecretPanel>
        )}
        {error && <div role="alert" className="rounded-[10px] border border-red-500/30 bg-red-500/[0.04] px-4 py-3 text-xs text-red-300">{error}</div>}
        {d && !d.available && <Callout tone="red">Webhooks are unavailable on this server: its secret key could not be set up. Check the server log.</Callout>}
        {d && <Failing d={d} />}
        {pending && orgId && <PendingConfirm pending={pending} busy={busy} onCancel={() => setPending(null)} onConfirm={() => act(() => confirmAction(pending, csrf, orgId, wsId))} />}

        <section>
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-[13px] font-semibold text-zinc-200">Outgoing webhooks</h2>
            {admin && <Button size="sm" variant="primary" onClick={() => setEditing('new')}>Add webhook</Button>}
          </div>
          <Table cols={HOOK_COLS} head={['Name', 'URL', 'Sends', 'Last delivery', '']}>
            {!d ? (
              <SkeletonRows cols={HOOK_COLS} />
            ) : d.webhooks.length === 0 ? (
              <div className="p-8 text-center text-[13px] text-zinc-400">No webhooks yet.{admin ? ' Add one to send this workspace’s messages to a URL.' : ''}</div>
            ) : (
              d.webhooks.map((h) => {
                const last = d.deliveries.find((x) => x.webhook_id === h.id)
                return (
                  <Row key={h.id} cols={HOOK_COLS} className={cx(h.paused && 'opacity-70')}>
                    <div className="min-w-0">
                      <div className="truncate font-medium text-zinc-100">{h.name}</div>
                      <div className="font-mono text-2xs text-zinc-600">secret ••••{h.secret_last4}</div>
                    </div>
                    <div className="truncate font-mono text-xs text-zinc-300" title={h.url}>{h.url}</div>
                    <div className="text-xs text-zinc-400">{describeFilter(h.filter)}</div>
                    <div className="text-xs">{h.paused ? <Pill tone="amber">paused</Pill> : last ? <DeliveryState d={last} /> : <span className="text-zinc-500">Nothing yet</span>}</div>
                    <div className="flex justify-end gap-1.5">
                      {admin && (
                        <>
                          <Button size="sm" onClick={() => setEditing(h)}>Edit</Button>
                          <Button size="sm" onClick={() => act(() => hooks.update(csrf, orgId!, wsId, h.id, { paused: !h.paused }).then(() => null))}>{h.paused ? 'Resume' : 'Pause'}</Button>
                          <Button size="sm" variant="ghost" onClick={() => setPending({ kind: 'rotate-hook', hook: h })}>New secret</Button>
                          <Button size="sm" variant="ghost" onClick={() => setPending({ kind: 'delete-hook', hook: h })}>Delete</Button>
                        </>
                      )}
                    </div>
                  </Row>
                )
              })
            )}
          </Table>
        </section>

        {d && d.dead_letters.length > 0 && (
          <section>
            <h2 className="mb-2 text-[13px] font-semibold text-zinc-200">Dead letters</h2>
            <Table cols={DEAD_COLS} head={['Webhook', 'Message', 'Last attempt', 'Gave up', '']}>
              {d.dead_letters.map((x) => (
                <DeadRow key={x.id} x={x} hook={hookName(x.webhook_id)} admin={admin} busy={busy} onRedeliver={() => act(() => hooks.redeliver(csrf, orgId!, wsId, x.id).then(() => null))} />
              ))}
            </Table>
          </section>
        )}

        <section>
          <h2 className="mb-2 text-[13px] font-semibold text-zinc-200">Recent deliveries</h2>
          <Table cols={DELIVERY_COLS} head={['Webhook', 'Message', 'State', 'Last attempt', 'When']}>
            {!d ? (
              <SkeletonRows cols={DELIVERY_COLS} />
            ) : d.deliveries.length === 0 ? (
              <div className="p-6 text-center text-xs text-zinc-500">No deliveries yet.</div>
            ) : (
              d.deliveries.map((x) => {
                const a = x.attempts[x.attempts.length - 1]
                return (
                  <Row key={x.id} cols={DELIVERY_COLS}>
                    <div className="truncate text-zinc-200">{hookName(x.webhook_id)}</div>
                    <div className="truncate font-mono text-2xs text-zinc-500">{x.message_id}</div>
                    <div><DeliveryState d={x} /></div>
                    <div className="min-w-0 text-xs text-zinc-400">
                      {a ? <AttemptLine a={a} n={x.attempt_count} /> : '—'}
                      {x.state === 'retrying' && x.next_attempt_at && <div className="text-2xs text-zinc-500">next try {until(x.next_attempt_at)}</div>}
                    </div>
                    <div className="text-xs text-zinc-500">{ago(x.updated_at)}</div>
                  </Row>
                )
              })
            )}
          </Table>
        </section>

        <section>
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-[13px] font-semibold text-zinc-200">Listeners</h2>
          </div>
          {admin && <NewListener busy={busy} onCreate={(name) => act(() => hooks.createListener(csrf, orgId!, wsId, name).then((r) => ({ title: `Listener ${r.listener.name}`, secret: r.secret, url: r.listener.url })))} />}
          <Table cols={LISTENER_COLS} head={['Name', 'URL', 'Calls', 'Last call', '']} className="mt-3">
            {!d ? (
              <SkeletonRows cols={LISTENER_COLS} />
            ) : d.listeners.length === 0 ? (
              <div className="p-6 text-center text-xs text-zinc-500">No listeners yet.{admin ? ' A listener gives outside systems a URL that posts messages here.' : ''}</div>
            ) : (
              d.listeners.map((l) => (
                <Row key={l.id} cols={LISTENER_COLS} className={cx(l.paused && 'opacity-70')}>
                  <div className="min-w-0">
                    <div className="truncate font-medium text-zinc-100">{l.name}</div>
                    <div className="font-mono text-2xs text-zinc-600">secret ••••{l.secret_last4}</div>
                  </div>
                  <div className="truncate font-mono text-xs text-zinc-300" title={l.url}>{l.url}</div>
                  <div className="text-xs text-zinc-400">{l.call_count}</div>
                  <div className="text-xs">{l.paused ? <Pill tone="amber">paused</Pill> : <span className="text-zinc-500">{l.last_call_at ? ago(l.last_call_at) : 'Never'}</span>}</div>
                  <div className="flex justify-end gap-1.5">
                    {admin && (
                      <>
                        <Button size="sm" onClick={() => act(() => hooks.updateListener(csrf, orgId!, wsId, l.id, { paused: !l.paused }).then(() => null))}>{l.paused ? 'Resume' : 'Pause'}</Button>
                        <Button size="sm" variant="ghost" onClick={() => setPending({ kind: 'rotate-listener', listener: l })}>New secret</Button>
                        <Button size="sm" variant="ghost" onClick={() => setPending({ kind: 'delete-listener', listener: l })}>Delete</Button>
                      </>
                    )}
                  </div>
                </Row>
              ))
            )}
          </Table>
        </section>

        {d && d.listener_calls.length > 0 && (
          <section>
            <h2 className="mb-2 text-[13px] font-semibold text-zinc-200">Recent listener calls</h2>
            <Table cols={CALL_COLS} head={['Listener', 'When', 'Status', 'Message', 'From']}>
              {d.listener_calls.map((c) => (
                <Row key={c.id} cols={CALL_COLS}>
                  <div className="truncate text-zinc-200">{listenerName(c.listener_id)}</div>
                  <div className="text-xs text-zinc-500">{ago(c.at)}</div>
                  <div><Pill tone={c.status === 202 ? 'green' : c.status === 410 ? 'amber' : 'red'}>{c.status}</Pill></div>
                  <div className="min-w-0 truncate text-xs text-zinc-400" title={c.summary}>{c.summary || '—'}</div>
                  <div className="font-mono text-2xs text-zinc-500">{c.from_ip ?? '—'}</div>
                </Row>
              ))}
            </Table>
          </section>
        )}
      </div>

      <aside className="flex flex-col gap-3">
        <div className="rounded-[10px] border border-edge bg-panel p-4 text-xs2 leading-relaxed text-zinc-500">
          <div className="mb-1 font-semibold text-zinc-300">Signed</div>
          Every delivery is a POST with a <span className="font-mono">Dispatch-Signature</span> header: <span className="font-mono">t=&lt;unix&gt;,v1=&lt;hex&gt;</span>, an HMAC-SHA256 of <span className="font-mono">t + "." + body</span> with the webhook’s secret. Calls to a listener are signed the same way with the listener’s secret.
        </div>
        <div className="rounded-[10px] border border-edge bg-panel p-4 text-xs2 leading-relaxed text-zinc-500">
          <div className="mb-1 font-semibold text-zinc-300">Retries</div>
          A delivery that doesn’t get a 2xx within 10 seconds is retried after 10 s, 30 s, 2 min, 10 min, 30 min, 1 h and 2 h, then becomes a dead letter you can redeliver. Sending a message never waits for a webhook.
        </div>
        {d && !d.allow_private && (
          <div className="rounded-[10px] border border-edge bg-panel p-4 text-xs2 leading-relaxed text-zinc-500">
            <div className="mb-1 font-semibold text-zinc-300">Public addresses only</div>
            This server won’t deliver to private, loopback or link-local addresses. Its operator can allow them with <span className="font-mono">WEBHOOK_ALLOW_PRIVATE=true</span>.
          </div>
        )}
        <div className="rounded-[10px] border border-edge bg-panel p-4 text-xs2 leading-relaxed text-zinc-500">
          <div className="mb-1 font-semibold text-zinc-300">Calling a listener</div>
          <CodeBlock text={LISTENER_EXAMPLE} />
          <div className="mt-1.5">The full scheme is in <a href="https://github.com/VBCDX/dispatch/blob/main/docs/webhooks.md" target="_blank" rel="noreferrer">docs/webhooks.md</a>.</div>
        </div>
      </aside>

      {editing && orgId && (
        <HookEditor
          hook={editing === 'new' ? null : editing}
          busy={busy}
          onClose={() => setEditing(null)}
          onSave={async (input) => {
            const ok = await act(async () => {
              if (editing === 'new') {
                const r = await hooks.create(csrf, orgId, wsId, input)
                return { title: `Webhook ${r.webhook.name}`, secret: r.secret }
              }
              await hooks.update(csrf, orgId, wsId, editing.id, input)
              return null
            })
            if (ok) setEditing(null)
          }}
        />
      )}
    </div>
  )
}

const LISTENER_EXAMPLE = `body='{"body":"Build 4.2 is green"}'
t=$(date +%s)
sig=$(printf '%s.%s' "$t" "$body" | openssl dgst -sha256 -hmac "$SECRET" | cut -d' ' -f2)
curl -X POST "$LISTENER_URL" \\
  -H "Dispatch-Signature: t=$t,v1=$sig" \\
  -H 'Content-Type: application/json' -d "$body"`

function confirmAction(p: Pending, csrf: string, org: string, ws: string): Promise<Issued | null | void> {
  switch (p.kind) {
    case 'delete-hook':
      return hooks.remove(csrf, org, ws, p.hook.id)
    case 'rotate-hook':
      return hooks.rotate(csrf, org, ws, p.hook.id).then((r) => ({ title: `New signing secret for ${r.webhook.name}`, secret: r.secret }))
    case 'delete-listener':
      return hooks.removeListener(csrf, org, ws, p.listener.id)
    case 'rotate-listener':
      return hooks.rotateListener(csrf, org, ws, p.listener.id).then((r) => ({ title: `New signing secret for ${r.listener.name}`, secret: r.secret, url: r.listener.url }))
  }
}

function PendingConfirm({ pending: p, busy, onCancel, onConfirm }: { pending: Pending; busy: boolean; onCancel: () => void; onConfirm: () => void }) {
  const [title, body, label, danger] =
    p.kind === 'delete-hook'
      ? [`Delete webhook ${p.hook.name}?`, 'Deliveries stop now, including any being retried, and its delivery history and dead letters are removed.', 'Delete webhook', true]
      : p.kind === 'rotate-hook'
        ? [`New signing secret for ${p.hook.name}?`, `Deliveries are signed with the new secret from now on; ••••${p.hook.secret_last4} stops being used at once. Update the receiver first, or accept a few failed checks.`, 'Issue new secret', false]
        : p.kind === 'delete-listener'
          ? [`Delete listener ${p.listener.name}?`, 'Its URL stops working now (404) and its call history is removed. Messages it already posted stay.', 'Delete listener', true]
          : [`New signing secret for ${p.listener.name}?`, `Calls signed with ••••${p.listener.secret_last4} are refused from now on.`, 'Issue new secret', false]
  return <Confirm title={title} body={body} confirmLabel={label} danger={danger} busy={busy} onCancel={onCancel} onConfirm={onConfirm} />
}

function Failing({ d }: { d: WebhooksTab }) {
  const retrying = new Set(d.deliveries.filter((x) => x.state === 'retrying').map((x) => x.webhook_id)).size
  const dead = d.dead_letters.length
  if (!retrying && !dead) return null
  return (
    <Callout tone={dead ? 'red' : 'amber'}>
      {retrying ? `${plural(retrying, 'webhook')} failing and retrying on schedule.` : ''}
      {retrying && dead ? ' ' : ''}
      {dead ? `${plural(dead, 'delivery', 'deliveries')} gave up; redeliver ${dead === 1 ? 'it' : 'them'} below once the receiver is fixed.` : ''}
    </Callout>
  )
}

function DeliveryState({ d }: { d: WebhookDelivery }) {
  const tone = d.state === 'delivered' ? 'green' : d.state === 'retrying' ? 'amber' : d.state === 'dead' ? 'red' : 'neutral'
  const label = d.state === 'dead' ? 'gave up' : d.state
  return <Pill tone={tone}>{label}</Pill>
}

function AttemptLine({ a, n }: { a: { status: number; ms: number; note?: string }; n: number }) {
  return (
    <div className="truncate" title={a.note}>
      <span className={cx('font-mono', a.status >= 200 && a.status < 300 ? 'text-green-400' : 'text-amber-400')}>{a.status || 'no answer'}</span>
      <span className="text-zinc-500"> · {a.ms} ms · attempt {n}</span>
      {a.note && <span className="text-zinc-500"> · {a.note}</span>}
    </div>
  )
}

function DeadRow({ x, hook, admin, busy, onRedeliver }: { x: DeadLetter; hook: string; admin: boolean; busy: boolean; onRedeliver: () => void }) {
  const a = x.attempts[x.attempts.length - 1]
  return (
    <Row cols={DEAD_COLS}>
      <div className="truncate text-zinc-200">{hook}</div>
      <div className="truncate font-mono text-2xs text-zinc-500">{x.message_id}</div>
      <div className="min-w-0 text-xs text-zinc-400">{a ? <AttemptLine a={a} n={x.attempts.length} /> : '—'}</div>
      <div className="text-xs text-zinc-500">{ago(x.dead_at)}</div>
      <div className="flex justify-end">{admin && <Button size="sm" disabled={busy} onClick={onRedeliver}>Redeliver</Button>}</div>
    </Row>
  )
}

function describeFilter(f: WebhookFilter) {
  const who = f.author_kinds.length === 3 ? 'Everyone' : f.author_kinds.map((k) => ({ agent: 'Agents', user: 'People', listener: 'Listeners' })[k]).join(' + ')
  const parts = [who]
  if (f.author_ids.length) parts.push(`${plural(f.author_ids.length, 'author')} only`)
  if (f.threads !== 'all') parts.push(f.threads === 'roots' ? 'new threads' : 'replies')
  if (f.contains) parts.push(`“${f.contains}”`)
  return parts.join(' · ')
}

function until(iso: string) {
  const s = Math.max(0, Math.round((Date.parse(iso) - Date.now()) / 1000))
  return s < 90 ? `in ${s} s` : s < 5400 ? `in ${Math.round(s / 60)} min` : `in ${Math.round(s / 3600)} h`
}

function NewListener({ busy, onCreate }: { busy: boolean; onCreate: (name: string) => void }) {
  const [name, setName] = useState('')
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (name.trim()) onCreate(name.trim())
    setName('')
  }
  return (
    <form onSubmit={submit} className="flex items-end gap-3 rounded-[10px] border border-edge bg-panel p-4">
      <div className="flex-1">
        <FormField label="Add a listener">
          <TextInput value={name} onChange={(e) => setName(e.target.value)} placeholder="Who will call it, e.g. GitHub" maxLength={80} />
        </FormField>
      </div>
      <Button type="submit" variant="primary" disabled={busy || !name.trim()}>
        Create listener
      </Button>
    </form>
  )
}

const KINDS = [
  { value: 'agent', label: 'Agents' },
  { value: 'user', label: 'People' },
  { value: 'listener', label: 'Listeners' },
] as const

function HookEditor({ hook, busy, onClose, onSave }: { hook: Webhook | null; busy: boolean; onClose: () => void; onSave: (w: { name: string; url: string; filter: WebhookFilter }) => void }) {
  const [name, setName] = useState(hook?.name ?? '')
  const [url, setURL] = useState(hook?.url ?? 'https://')
  const [kinds, setKinds] = useState<WebhookFilter['author_kinds']>(hook?.filter.author_kinds ?? ['agent', 'user'])
  const [ids, setIDs] = useState((hook?.filter.author_ids ?? []).join(', '))
  const [threads, setThreads] = useState<WebhookFilter['threads']>(hook?.filter.threads ?? 'all')
  const [contains, setContains] = useState(hook?.filter.contains ?? '')
  const submit = (e: FormEvent) => {
    e.preventDefault()
    onSave({
      name: name.trim(),
      url: url.trim(),
      filter: { author_kinds: kinds, author_ids: ids.split(/[\s,]+/).filter(Boolean), threads, contains: contains.trim() },
    })
  }
  const toggle = (k: (typeof KINDS)[number]['value'], on: boolean) => setKinds((cur) => (on ? [...cur.filter((x) => x !== k), k] : cur.filter((x) => x !== k)))
  return (
    <Modal open onClose={onClose} title={hook ? `Edit ${hook.name}` : 'Add a webhook'} width={520}>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <FormField label="Name">
          <TextInput value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Release notifier" maxLength={80} required />
        </FormField>
        <FormField label="URL" hint="https only (http is allowed for localhost). Dispatch POSTs each matching message here.">
          <TextInput mono value={url} onChange={(e) => setURL(e.target.value)} required />
        </FormField>
        <FormField label="Messages from" hint="Messages from listeners are off by default, so a webhook can’t loop into a listener.">
          <div className="flex gap-4">
            {KINDS.map((k) => (
              <Checkbox key={k.value} label={k.label} checked={kinds.includes(k.value)} onChange={(on) => toggle(k.value, on)} />
            ))}
          </div>
        </FormField>
        <FormField label="Only these authors" optional hint="Agent or person IDs, separated by commas. Empty means anyone.">
          <TextInput mono value={ids} onChange={(e) => setIDs(e.target.value)} placeholder="ag_…, u_…" />
        </FormField>
        <div className="grid grid-cols-2 gap-3">
          <FormField label="Threads">
            <Select value={threads} onChange={(e) => setThreads(e.target.value as WebhookFilter['threads'])}>
              <option value="all">Every message</option>
              <option value="roots">New threads only</option>
              <option value="replies">Replies only</option>
            </Select>
          </FormField>
          <FormField label="Containing" optional>
            <TextInput value={contains} onChange={(e) => setContains(e.target.value)} placeholder="e.g. deploy" maxLength={200} />
          </FormField>
        </div>
        {!kinds.length && <Callout tone="amber">Pick at least one kind of author.</Callout>}
        <Footer>
          <Button type="button" onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={busy || !name.trim() || !url.trim() || !kinds.length}>
            {busy ? 'Saving…' : hook ? 'Save' : 'Add webhook'}
          </Button>
        </Footer>
      </form>
    </Modal>
  )
}
