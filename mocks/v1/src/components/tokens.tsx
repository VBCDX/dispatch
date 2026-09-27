/** Freshly issued tokens go to the root secret host, shown once (several queue one after another). */
import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { showSecret } from '../lib/secrets'
import { agentById, getDB } from '../lib/store'
import type { Agent } from '../lib/types'

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

export function showAgentToken(a: Agent, token: string) {
  showSecret({ kind: 'token', title: 'Agent token rotated', token, subtitle: `${a.label} · ${a.id}`, note: 'The old token keeps working for 10 minutes so a running agent can switch over. Workspace tokens are unchanged.' })
}

