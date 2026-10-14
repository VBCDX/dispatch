// The agent token's actions on the agent page (pages/agents.tsx): rotate
// it, shown once, or revoke the agent everywhere. Organization Owners and
// user admins only, because the agent token works in every workspace.
import { useState } from 'react'
import { messaging } from '../api'
import { CodeBlock, Confirm, SecretLine, SecretPanel, demoCommand, errorText } from '../secret'
import { useSession } from '../session'
import { Button } from '../ui'

export function AgentTokenActions({ agent, masked, onChanged }: { agent: { id: string; label: string; status: string }; masked: string; onChanged: () => void }) {
  const { org, me, onError } = useSession()
  const [token, setToken] = useState<{ token: string; oldUntil: string | null } | null>(null)
  const [pending, setPending] = useState<'rotate' | 'revoke' | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const orgAdmin = org?.role === 'Owner' || org?.role === 'userAdmin'

  async function run() {
    if (!org || !pending) return
    setBusy(true)
    setError(null)
    try {
      if (pending === 'rotate') {
        const r = await messaging.rotateAgentToken(org.id, me.csrf_token, agent.id)
        setToken({ token: r.agent_token, oldUntil: r.old_token_valid_until })
      }
      else await messaging.revokeAgent(org.id, me.csrf_token, agent.id)
      setPending(null)
      if (pending === 'revoke') onChanged()
    } catch (err) {
      onError(err)
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mt-2 flex flex-col gap-2 font-sans tracking-normal">
      {orgAdmin && agent.status !== 'revoked' && !pending && !token && (
        <span className="flex gap-2">
          <Button size="sm" onClick={() => setPending('rotate')}>Rotate agent token</Button>
          <Button size="sm" variant="ghost" onClick={() => setPending('revoke')}>Revoke agent</Button>
        </span>
      )}
      {pending && (
        <Confirm
          danger={pending === 'revoke'}
          busy={busy}
          title={pending === 'rotate' ? `Rotate ${agent.label}’s agent token?` : `Revoke ${agent.label}?`}
          body={
            pending === 'rotate'
              ? `The current token (${masked}) keeps working for 10 minutes, in every workspace, so a running ${agent.label} can switch to the new one; then it stops and ${agent.label} is disconnected until it uses the new one. Workspace tokens are unchanged.`
              : `${agent.label}’s agent token stops working for good, in every workspace, and its connections close now. This can’t be undone.`
          }
          confirmLabel={pending === 'rotate' ? 'Rotate token' : 'Revoke agent'}
          onCancel={() => setPending(null)}
          onConfirm={run}
        />
      )}
      {token && (
        <SecretPanel title={`${agent.label}’s new agent token`} onDone={() => { setToken(null); onChanged() }}>
          <SecretLine label="Agent token" value={token.token} />
          <div className="text-xs text-zinc-400">
            {token.oldUntil ? `The old token keeps working until ${new Date(token.oldUntil).toLocaleTimeString()}. ` : 'The old token stopped working. '}
            Use the new one with each workspace token this agent already has (from a workspace’s Connect tab):
          </div>
          <CodeBlock text={demoCommand(location.origin, token.token)} />
        </SecretPanel>
      )}
      {error && <div role="alert" className="text-xs text-red-400">{error}</div>}
    </div>
  )
}
