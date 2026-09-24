import type { Agent, Audience, DB, Message, Workspace } from './types'

export type Op = 'read' | 'write' | 'admin'
export type Step = { rule: string; pass: boolean; detail: string }

/**
 * The access ladder. Every agent request to a workspace walks these rules in
 * order; the first failure decides. Blocklists sit above membership, so a
 * block always wins over anything a workspace grants.
 */
export function evaluate(d: DB, agentId: string, wsId: string, op: Op): { allowed: boolean; steps: Step[]; reason: string | null } {
  const a = d.agents.find((x) => x.id === agentId)
  const w = d.workspaces.find((x) => x.id === wsId)
  const m = w?.members.find((x) => x.kind === 'agent' && x.id === agentId)
  const steps: Step[] = [
    {
      rule: 'Agent ID + agent token',
      pass: !!a && a.status === 'active',
      detail: !a ? 'Unknown agent ID.' : a.status === 'active' ? `${a.label} is active.` : `${a.label} is ${a.status}.`,
    },
    {
      rule: "Agent's own workspace blocklist",
      pass: !!a && !a.filters.workspaceBlocklist.includes(wsId),
      detail: a?.filters.workspaceBlocklist.includes(wsId) ? `${a.label} blocks ${w?.name ?? wsId} on its own side.` : 'Not blocked by the agent.',
    },
    {
      rule: 'Workspace agent blocklist',
      pass: !!w && !w.agentBlocklist.includes(agentId),
      detail: w?.agentBlocklist.includes(agentId) ? `${w.name} blocks this agent — overrides membership.` : 'Not on the workspace blocklist.',
    },
    {
      rule: 'Workspace ID + membership token',
      pass: !!m && !m.tokenRevoked,
      detail: !m ? 'Not a member of this workspace.' : m.tokenRevoked ? 'Its workspace token was revoked.' : `Member since token ••••${m.tokenLast4}.`,
    },
    {
      rule: `Membership allows ${op}`,
      pass: !!m && (op === 'admin' ? m.role === 'admin' : m[op]),
      detail: !m ? '—' : op === 'admin' ? (m.role === 'admin' ? 'Admin here.' : 'Member, not admin.') : m[op] ? `Membership grants ${op}.` : `Membership doesn't grant ${op}.`,
    },
    {
      rule: `Agent's own filter allows ${op}`,
      pass: !!a && (op === 'read' ? a.filters.read : a.filters.write),
      detail: !a ? '—' : (op === 'read' ? a.filters.read : a.filters.write) ? `${a.label} allows ${op === 'admin' ? 'write-level' : op} actions.` : `${a.label} has turned off ${op === 'read' ? 'reading' : 'writing'} for itself.`,
    },
  ]
  const fail = steps.find((s) => !s.pass)
  return { allowed: !fail, steps, reason: fail ? fail.detail : null }
}

export function inAudience(aud: Audience, agentId: string) {
  if (aud.mode === 'all') return true
  if (aud.mode === 'only') return aud.agentIds.includes(agentId)
  return !aud.agentIds.includes(agentId)
}

/** Every agent member the message is addressed to (the author excluded). */
export function targets(w: Workspace, msg: Pick<Message, 'audience' | 'author'>) {
  return w.members.filter((m) => m.kind === 'agent' && !(msg.author.kind === 'agent' && msg.author.id === m.id) && inAudience(msg.audience, m.id)).map((m) => m.id)
}

/** Why a targeted agent won't receive a message, or null when it will. */
export function filteredReason(d: DB, w: Workspace, msg: Pick<Message, 'author'>, recipient: Agent): string | null {
  const acc = evaluate(d, recipient.id, w.id, 'read')
  if (!acc.allowed) return acc.reason
  if (msg.author.kind === 'agent' && recipient.filters.agentBlocklist.includes(msg.author.id)) return `${recipient.label} blocks messages from this author.`
  return null
}

export function audienceLabel(d: DB, aud: Audience) {
  const names = (ids: string[]) => ids.map((id) => d.agents.find((a) => a.id === id)?.label ?? id).join(', ')
  if (aud.mode === 'all') return 'All agents'
  if (aud.mode === 'only') return `Only ${names(aud.agentIds)}`
  return `All agents except ${names(aud.agentIds)}`
}
