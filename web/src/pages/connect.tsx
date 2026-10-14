// The workspace's Connect tab, after the mock (mocks/v1/src/pages/
// wsAccess.tsx, WsConnect): connect a new agent, which issues its agent
// token and its workspace token once, and rotate or revoke each agent
// member's workspace token. The example agent's command is filled in with
// the tokens while they are on screen.
import { useState, type FormEvent } from 'react'
import { Link, useParams } from 'react-router-dom'
import { messaging, type AgentMember, type Connection } from '../api'
import { CodeBlock, Confirm, SecretLine, SecretPanel, demoCommand, errorText, maskToken } from '../secret'
import { useLoad, useSession } from '../session'
import { Button, ErrorBox, Field, Input, Pill, Row, SkeletonRows, Table, cx } from '../ui'

const COLS = '1.3fr 1fr 1.2fr 0.9fr 1.3fr'

type Pending = { kind: 'rotate' | 'revoke'; agent: AgentMember }

export function WsConnect() {
  const { wsId = '' } = useParams()
  const { org, me, onError } = useSession()
  const orgId = org?.id
  const [list, reload] = useLoad(orgId ? () => messaging.agents(orgId, wsId) : null, [orgId, wsId])
  const [issued, setIssued] = useState<Connection | null>(null)
  const [pending, setPending] = useState<Pending | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function act(fn: () => Promise<Connection | null>) {
    setBusy(true)
    setError(null)
    try {
      const c = await fn()
      if (c) setIssued(c)
      setPending(null)
      reload()
    } catch (err) {
      onError(err)
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  if (list.state === 'error') return <div className="mt-5"><ErrorBox what="this workspace’s agents" onRetry={reload} /></div>
  const data = list.state === 'ready' ? list.data : null
  const serverURL = data?.server_url ?? location.origin

  return (
    <div className="mt-5 grid grid-cols-[1fr_300px] gap-6">
      <div className="flex min-w-0 flex-col gap-4">
        {issued && <Issued c={issued} onDone={() => setIssued(null)} />}
        {error && <div role="alert" className="rounded-[10px] border border-red-500/30 bg-red-500/[0.04] px-4 py-3 text-xs text-red-300">{error}</div>}
        {data?.can_admin && orgId && <NewAgent busy={busy} onConnect={(label) => act(() => messaging.connectNew(orgId, wsId, me.csrf_token, label))} />}
        {pending && orgId && (
          <Confirm
            danger={pending.kind === 'revoke'}
            busy={busy}
            title={pending.kind === 'rotate' ? `Rotate ${pending.agent.label}’s workspace token?` : `Revoke ${pending.agent.label}’s workspace token?`}
            body={
              pending.kind === 'rotate'
                ? pending.agent.token_last4 && !pending.agent.token_revoked_at
                  ? `The current token (${maskToken(pending.agent.token_prefix, pending.agent.token_last4)}) keeps working for 10 minutes so a running ${pending.agent.label} can switch to the new one; then it stops and ${pending.agent.label} is disconnected until it uses the new one. Its agent token is unchanged.`
                  : `${pending.agent.label} gets a new workspace token. Its agent token is unchanged.`
                : `${pending.agent.label} is disconnected now and can’t reconnect to this workspace until you rotate the token. It stays a member.`
            }
            confirmLabel={pending.kind === 'rotate' ? 'Rotate token' : 'Revoke token'}
            onCancel={() => setPending(null)}
            onConfirm={() =>
              act(async () =>
                pending.kind === 'rotate'
                  ? messaging.rotateWorkspaceToken(orgId, wsId, me.csrf_token, pending.agent.agent_id).then((c) => ({ ...c, agent: { id: pending.agent.agent_id, name: pending.agent.label } }))
                  : messaging.revokeWorkspaceToken(orgId, wsId, me.csrf_token, pending.agent.agent_id).then(() => null),
              )
            }
          />
        )}
        <Table cols={COLS} head={['Agent', 'Connection', 'Workspace token', 'Access', '']}>
          {!data ? (
            <SkeletonRows cols={COLS} />
          ) : data.agents.length === 0 ? (
            <div className="p-8 text-center text-[13px] text-zinc-400">No agents in this workspace yet.{data.can_admin ? ' Connect one above.' : ''}</div>
          ) : (
            data.agents.map((a) => {
              const cut = !!a.token_revoked_at || a.status !== 'active' || !a.token_last4
              return (
                <Row key={a.agent_id} cols={COLS}>
                  <div>
                    <Link to={`/agents/${a.agent_id}`} className="font-mono font-medium text-zinc-100 hover:text-white">{a.label}</Link>
                    <div className="font-mono text-2xs text-zinc-600">{a.agent_id}</div>
                  </div>
                  <div className="flex items-center gap-2 text-xs">
                    <span aria-hidden className={cx('h-2 w-2 rounded-full', a.online ? 'bg-green-400' : 'bg-zinc-700')} />
                    {a.online ? <span className="text-green-400">Connected</span> : <span className="text-zinc-500">Not connected</span>}
                  </div>
                  <div className="font-mono text-xs text-zinc-400">
                    {a.status === 'revoked' ? <Pill tone="red">agent revoked</Pill> : a.token_revoked_at ? <Pill tone="red">revoked</Pill> : !a.token_last4 ? <Pill tone="amber">not issued</Pill> : maskToken(a.token_prefix, a.token_last4)}
                  </div>
                  <div className="text-xs text-zinc-400">{[a.read && 'read', a.write && 'write'].filter(Boolean).join(' + ') || 'none'}</div>
                  <div className="flex justify-end gap-2">
                    {data.can_admin && a.status !== 'revoked' && (
                      <>
                        <Button size="sm" onClick={() => setPending({ kind: 'rotate', agent: a })}>{!a.token_last4 ? 'Issue token' : cut ? 'Issue new token' : 'Rotate'}</Button>
                        {!cut && <Button size="sm" variant="ghost" onClick={() => setPending({ kind: 'revoke', agent: a })}>Revoke</Button>}
                      </>
                    )}
                  </div>
                </Row>
              )
            })
          )}
        </Table>
        <div>
          <div className="mb-1.5 text-xs font-medium text-zinc-300">Run the example agent</div>
          <CodeBlock text={demoCommand(serverURL)} />
          <div className="mt-1.5 text-xs2 text-zinc-500">
            <span className="font-mono">dispatch agent demo</span> prints what it receives, acknowledges it and replies in the thread to each new message. Run two with different agents to watch them talk on the Messages tab. Agents in other languages follow the <a href="https://github.com/VBCDX/dispatch/blob/main/docs/agent-protocol.md" target="_blank" rel="noreferrer">agent protocol</a>.
          </div>
        </div>
      </div>
      <aside className="flex flex-col gap-3">
        <div className="rounded-[10px] border border-edge bg-panel p-4 text-xs2 leading-relaxed text-zinc-500">
          <div className="mb-1 font-semibold text-zinc-300">Two credentials</div>
          An agent presents its <span className="font-mono">agent token</span> (who it is, in every workspace) and a <span className="font-mono">workspace token</span> (its membership here). Revoking either disconnects the agent within a second. Rotating keeps the old token working for 10 minutes, then disconnects anything still using it.
        </div>
        <div className="rounded-[10px] border border-edge bg-panel p-4 text-xs2 leading-relaxed text-zinc-500">
          <div className="mb-1 font-semibold text-zinc-300">Endpoints</div>
          <div className="font-mono text-zinc-400">{serverURL.replace(/^http/, 'ws')}/agent/v1/ws</div>
          <div className="mt-1 font-mono text-zinc-400">POST {serverURL}/agent/v1/messages</div>
        </div>
      </aside>
    </div>
  )
}

function NewAgent({ busy, onConnect }: { busy: boolean; onConnect: (label: string) => void }) {
  const [label, setLabel] = useState('')
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (label.trim()) onConnect(label.trim())
  }
  return (
    <form onSubmit={submit} className="flex items-end gap-3 rounded-[10px] border border-edge bg-panel p-4">
      <div className="flex-1">
        <Field label="Connect a new agent" htmlFor="new-agent">
          <Input id="new-agent" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Its name, e.g. builder" maxLength={64} pattern="[A-Za-z0-9 ._\-]+" title="Letters, digits, spaces, '.', '_' or '-'" />
        </Field>
      </div>
      <Button type="submit" variant="primary" disabled={busy || !label.trim()}>
        {busy ? 'Connecting…' : 'Connect agent'}
      </Button>
    </form>
  )
}

function Issued({ c, onDone }: { c: Connection; onDone: () => void }) {
  const what = c.agent_token ? 'tokens' : 'new workspace token'
  return (
    <SecretPanel title={`${c.agent.name || c.agent.id}’s ${what} for ${c.workspace.name}`} onDone={onDone}>
      {c.agent_token && <SecretLine label="Agent token" value={c.agent_token} />}
      {c.workspace_token && <SecretLine label="Workspace token" value={c.workspace_token} />}
      <div className="mt-1 text-xs text-zinc-400">To run the example agent with {c.agent_token ? 'them' : 'it'}:</div>
      <CodeBlock text={demoCommand(c.server_url, c.agent_token, c.workspace_token)} />
      {!c.agent_token && <div className="text-xs2 text-zinc-500">Use the agent token you stored when it was issued, or rotate it on the agent’s page.</div>}
      {c.old_token_valid_until && <div className="text-xs2 text-amber-400">The old workspace token keeps working until {new Date(c.old_token_valid_until).toLocaleTimeString()}.</div>}
    </SecretPanel>
  )
}
