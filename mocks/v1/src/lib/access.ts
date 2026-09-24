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

/**
 * Why a targeted agent can't receive a message right now, or null when it can.
 * `final` refusals (a block, a removal, a revocation) filter what hasn't been
 * delivered yet. Reversible ones (a suspension, membership read turned off,
 * the agent's own read filter) only hold it until access returns.
 * `cause` is the short name used in webhook and preview copy.
 */
export type Verdict = { reason: string; final: boolean; cause: string }
export function accessVerdict(d: DB, w: Workspace, msg: Pick<Message, 'author'>, recipient: Agent): Verdict | null {
  const acc = evaluate(d, recipient.id, w.id, 'read')
  if (!acc.allowed) {
    const i = acc.steps.findIndex((s) => !s.pass)
    const member = w.members.some((m) => m.kind === 'agent' && m.id === recipient.id)
    const [final, cause] =
      i === 0
        ? recipient.status === 'suspended'
          ? [false, 'suspended']
          : [true, recipient.status === 'revoked' ? 'revoked' : 'unknown agent']
        : i === 1
          ? [true, 'blocks this workspace']
          : i === 2
            ? [true, 'blocked']
            : i === 3
              ? [true, member ? 'token revoked' : 'removed']
              : i === 4
                ? [false, 'membership read off']
                : [false, 'turned reading off']
    return { reason: acc.reason!, final, cause }
  }
  if (msg.author.kind === 'agent' && recipient.filters.agentBlocklist.includes(msg.author.id)) return { reason: `${recipient.label} blocks messages from this author.`, final: true, cause: 'blocks this author' }
  return null
}
/** Why a targeted agent can't receive a message right now, or null when it can. */
export const filteredReason = (d: DB, w: Workspace, msg: Pick<Message, 'author'>, recipient: Agent) => accessVerdict(d, w, msg, recipient)?.reason ?? null

/**
 * What an agent can see of a workspace's messages: what is addressed to it
 * and not filtered for it, plus what it wrote itself. The inbox, search and
 * GET /messages/{id} all apply this one rule. Humans see everything.
 */
export function visibleToAgent(m: Pick<Message, 'author' | 'receipts'>, agentId: string) {
  if (m.author.kind === 'agent' && m.author.id === agentId) return true
  const r = m.receipts[agentId]
  return !!r && !r.filtered && !r.held
}

export function audienceLabel(d: DB, aud: Audience) {
  const names = (ids: string[]) => ids.map((id) => d.agents.find((a) => a.id === id)?.label ?? id).join(', ')
  if (aud.mode === 'all') return 'All agents'
  if (aud.mode === 'only') return `Only ${names(aud.agentIds)}`
  return `All agents except ${names(aud.agentIds)}`
}
