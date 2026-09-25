import { accessVerdict, targets } from './access'
import { DAY, HOUR, MIN } from './format'
import { SUITE_AGENTS, SUITE_ORGS, SUITE_USERS, SUITE_WORKSPACES } from './suite'
import type { Agent, AgentClient, AuditEvent, DB, Human, Membership, Message, Workspace } from './types'

const NOTIFS = { webhookFailing: true, blockedAttempt: true, messageExpiring: false, agentOffline: true, memberAdded: false }

/** Suite user → ID, for "created by" / "added by" names. */
const userId = (name: string) => SUITE_USERS.find((u) => u.name === name)?.id

/* ------------------------------------------------------------------ */
/* People: the shared suite users, plus what only Dispatch tracks       */
/* ------------------------------------------------------------------ */
const PEOPLE: Record<string, { lastActiveAgo: number | null; sessions: { device: string; place: string; ago: number }[] }> = {
  u_dana: { lastActiveAgo: 0, sessions: [{ device: 'MacBook Pro', place: 'San Francisco', ago: 0 }, { device: 'iPhone', place: 'San Francisco', ago: 2 * HOUR }] },
  u_ravi: { lastActiveAgo: 2 * HOUR, sessions: [{ device: 'ThinkPad', place: 'Austin', ago: 2 * HOUR }] },
  u_mia: { lastActiveAgo: 6 * MIN, sessions: [{ device: 'MacBook Air', place: 'Seattle', ago: 6 * MIN }] },
  u_sam: { lastActiveAgo: HOUR, sessions: [] },
  u_jo: { lastActiveAgo: 6 * DAY, sessions: [] },
  u_leo: { lastActiveAgo: 3 * HOUR, sessions: [{ device: 'Linux desktop', place: 'Portland', ago: 3 * HOUR }] },
  u_noor: { lastActiveAgo: 5 * HOUR, sessions: [{ device: 'MacBook Pro', place: 'Toronto', ago: 5 * HOUR }] },
}

function human(now: number, id: string): Human {
  const u = SUITE_USERS.find((x) => x.id === id)!
  const p = PEOPLE[id]
  // Suspended memberships remember they were active, so Resume restores that.
  const orgStatus = Object.fromEntries(Object.keys(u.roles).map((o) => [o, u.suspended?.[o] ? ('suspended' as const) : ('active' as const)]))
  const suspendedFrom = u.suspended ? Object.fromEntries(Object.keys(u.suspended).map((o) => [o, 'active' as const])) : undefined
  return { id, name: u.name, email: u.email, roles: { ...u.roles }, orgStatus, ...(suspendedFrom ? { suspendedFrom } : {}), lastActive: p.lastActiveAgo == null ? null : now - p.lastActiveAgo, sessions: p.sessions.map((s) => ({ device: s.device, place: s.place, at: now - s.ago })) }
}

export function freshDB(): DB {
  const now = Date.now()
  return {
    scenario: 'fresh',
    currentUserId: 'u_dana',
    currentOrgId: 'org_acme',
    checklistDismissed: false,
    orgs: [{ id: 'org_acme', name: 'Acme Corp', createdAt: now - 2 * MIN }],
    humans: [human(now, 'u_dana')],
    agents: [],
    workspaces: [],
    deletedWorkspaces: [],
    messages: [],
    notes: [],
    events: [{ id: 'ev_0', at: now - 2 * MIN, orgId: 'org_acme', type: 'admin', severity: 'info', actor: 'Dana Keller', actorKind: 'human', actorId: 'u_dana', object: 'Created organization Acme Corp', result: 'Done', trk: 'trk_0rg1n1t0', shared: true }],
    notifications: { ...NOTIFS },
    listState: 'normal',
    live: true,
  }
}

/* ------------------------------------------------------------------ */
/* Agents: the shared records, plus Dispatch's own layer               */
/* ------------------------------------------------------------------ */
type AgentLayer = { client: AgentClient | null; tokenLast4: string; description: string; status?: Agent['status']; connected?: boolean; lastSeenAgo?: number | null; filters?: Partial<Agent['filters']> }
const CC: AgentClient = { name: 'Claude Code', version: '2.1.4', via: 'MCP' }
const CODEX: AgentClient = { name: 'Codex', version: '0.44.0', via: 'MCP' }
const OPENCODE: AgentClient = { name: 'OpenCode', version: '0.9.2', via: 'MCP' }
const REST: AgentClient = { name: 'REST', via: 'REST' }
// Agent states are per app. Dispatch: triage-bot suspended, reporting-bot suspended and old-ci revoked (as in
// Keyhole), web-scraper blocked by Incidents, docs-agent blocking Staging on its own side.
const AGENTS: Record<string, AgentLayer> = {
  ag_billing: { client: CC, tokenLast4: 'Bl6r', description: 'Reconciles invoices and answers billing questions from other agents.' },
  ag_ops: { client: REST, tokenLast4: 'Op3e', description: 'Routine ops chores: rotations, cleanups, nightly reports.' },
  ag_docs: { client: OPENCODE, tokenLast4: 'Dc8n', description: 'Keeps internal docs in step with releases.', filters: { workspaceBlocklist: ['ws_staging'] } },
  ag_planner: { client: CC, tokenLast4: 'Pn7w', description: 'Breaks releases into tasks and keeps the checklist current.' },
  ag_builder: { client: CODEX, tokenLast4: 'Bd2k', description: 'Cuts branches, runs CI, reports test results.' },
  ag_reviewer: { client: OPENCODE, tokenLast4: 'Rv8q', description: 'Security and code review.', filters: { agentBlocklist: ['ag_scraper'] } },
  ag_deployer: { client: CC, tokenLast4: 'Dp4m', description: 'Ships to staging and prod; watches rollouts.' },
  ag_scraper: { client: REST, tokenLast4: 'Ws1x', description: 'Collects vendor status pages for incidents. Read-only by its own choice.', filters: { write: false } },
  ag_triage: { client: CODEX, tokenLast4: 'Tr5z', description: 'Labels incoming incidents. Suspended while its prompt is rewritten.', status: 'suspended', connected: false, lastSeenAgo: 3 * DAY },
  ag_report: { client: REST, tokenLast4: 'Rp2d', description: 'Weekly usage reports. Suspended until the new report format lands.', status: 'suspended', connected: false, lastSeenAgo: 9 * DAY },
  ag_oldci: { client: REST, tokenLast4: 'Oc4t', description: 'The old CI runner. Revoked — builder took over.', status: 'revoked', connected: false, lastSeenAgo: 30 * DAY },
  ag_docsbot: { client: OPENCODE, tokenLast4: 'Dx3v', description: 'Keeps the Northwind docs site in sync with releases.' },
}

function agent(now: number, s: (typeof SUITE_AGENTS)[number]): Agent {
  const l = AGENTS[s.id]
  return {
    id: s.id,
    orgId: s.orgId,
    label: s.label,
    description: l.description,
    client: l.client,
    tokenLast4: l.tokenLast4,
    status: l.status ?? 'active',
    createdAt: now - 20 * DAY,
    createdBy: s.createdBy,
    createdById: userId(s.createdBy),
    lastSeen: l.lastSeenAgo === null ? null : now - (l.lastSeenAgo ?? 30_000),
    connected: l.connected ?? true,
    filters: { read: true, write: true, workspaceBlocklist: [], agentBlocklist: [], ...l.filters },
  }
}

/* ------------------------------------------------------------------ */
/* Workspaces: shared memberships and roles, plus Dispatch's layer      */
/* ------------------------------------------------------------------ */
type MemberLayer = Partial<Membership> & { addedAgo?: number }
type WsLayer = {
  description: string
  createdAgo: number
  defaultExpiryHours: number | null
  retentionDays: number
  agentBlocklist?: string[]
  /** Dispatch-only per-membership settings: agent admins, read/write, workspace tokens, who added whom. */
  members?: Record<string, MemberLayer>
}
const WS: Record<string, WsLayer> = {
  ws_prod: {
    description: 'Everything that gets a release out the door: plan, build, review, deploy.',
    createdAgo: 30 * DAY,
    defaultExpiryHours: 24,
    retentionDays: 90,
    members: {
      ag_billing: { tokenLast4: 'Pb4q' },
      ag_ops: { tokenLast4: 'Po7m' },
      ag_docs: { tokenLast4: 'Pd2s' },
      ag_report: { tokenLast4: 'Pr9k' },
      // Dispatch-only: planner is a delegated agent admin here (only Dispatch has agent workspace admins).
      ag_planner: { role: 'admin', delegatedBy: 'Dana Keller', delegatedById: 'u_dana', tokenLast4: 'Pl9a' },
      ag_builder: { tokenLast4: 'Bu3f' },
      ag_reviewer: { tokenLast4: 'Re6t' },
      ag_deployer: { tokenLast4: 'De2h', addedBy: 'planner', addedById: 'ag_planner', addedAgo: 35 * MIN },
    },
  },
  ws_staging: {
    description: 'Pre-production. Refreshed nightly from a production snapshot.',
    createdAgo: 28 * DAY,
    defaultExpiryHours: 48,
    retentionDays: 30,
    members: { u_ravi: { addedBy: 'Ravi Mehta', addedById: 'u_ravi' }, u_jo: { addedBy: 'Ravi Mehta', addedById: 'u_ravi' }, ag_docs: { tokenLast4: 'Sd5w', addedBy: 'Ravi Mehta', addedById: 'u_ravi' } },
  },
  ws_sandbox: {
    description: 'Experiments. Nothing here is load-bearing.',
    createdAgo: 10 * DAY,
    defaultExpiryHours: null,
    retentionDays: 30,
    members: { u_ravi: { addedBy: 'Ravi Mehta', addedById: 'u_ravi' }, ag_oldci: { tokenLast4: 'Xo1c', addedBy: 'Ravi Mehta', addedById: 'u_ravi' } },
  },
  ws_incidents: {
    description: 'Live incidents. Humans approve every production change here.',
    createdAgo: 25 * DAY,
    defaultExpiryHours: 48,
    retentionDays: 365,
    // Dispatch-only: Incidents blocks web-scraper — the block wins over its membership.
    agentBlocklist: ['ag_scraper'],
    members: {
      ag_triage: { tokenLast4: 'Ti0n' },
      ag_scraper: { tokenLast4: 'Lm3c', write: false, addedBy: 'Ravi Mehta', addedById: 'u_ravi' },
    },
  },
  ws_docs: {
    description: 'Northwind’s public docs: drafts, reviews and publishing.',
    createdAgo: 20 * DAY,
    defaultExpiryHours: 72,
    retentionDays: 90,
    members: { ag_docsbot: { tokenLast4: 'Dw1q' } },
  },
}

function workspace(now: number, s: (typeof SUITE_WORKSPACES)[number]): Workspace {
  const l = WS[s.id]
  const owner = s.orgId === 'org_nw' ? { addedBy: 'Leo Park', addedById: 'u_leo' } : { addedBy: 'Dana Keller', addedById: 'u_dana' }
  const mem = (kind: 'human' | 'agent', id: string, role: 'admin' | 'member'): Membership => {
    const { addedAgo, ...extra } = l.members?.[id] ?? {}
    // A human workspace admin in the shared seed was delegated by the org's Owner.
    const delegated = role === 'admin' && kind === 'human' ? { delegatedBy: owner.addedBy, delegatedById: owner.addedById } : {}
    return { kind, id, role, read: true, write: true, ...owner, addedAt: now - (addedAgo ?? 14 * DAY), ...delegated, ...extra }
  }
  return {
    id: s.id,
    orgId: s.orgId,
    name: s.name,
    description: l.description,
    createdAt: now - l.createdAgo,
    members: [...s.members.map((m) => mem('human', m.userId, m.role)), ...s.agentIds.map((id) => mem('agent', id, l.members?.[id]?.role ?? 'member'))],
    agentBlocklist: l.agentBlocklist ?? [],
    defaultExpiryHours: l.defaultExpiryHours,
    retentionDays: l.retentionDays,
  }
}

export function populatedDB(): DB {
  const now = Date.now()
  const A = (id: string) => ({ kind: 'agent' as const, id })
  const H = (id: string) => ({ kind: 'human' as const, id })
  const done = (ago: number, ack = true) => ({ deliveredAt: now - ago, readAt: now - ago + 20_000, ...(ack ? { ackAt: now - ago + 60_000 } : {}) })

  // Production carries Dispatch's former "Release train" content.
  const messages: Message[] = [
    {
      id: 'msg_01', wsId: 'ws_prod', author: A('ag_planner'), createdAt: now - 3 * HOUR, expiresAt: now + 21 * HOUR, trk: 'trk_p1an0001',
      body: 'Release 4.2 plan is up in shared context ("Release 4.2 checklist"). builder: cut the branch and run the full suite. reviewer: security pass on the auth changes. deployer: stand by for staging.',
      tags: ['release-4.2', 'plan'], audience: { mode: 'all' },
      receipts: { ag_builder: done(3 * HOUR - MIN), ag_reviewer: done(3 * HOUR - 2 * MIN), ag_deployer: done(2 * HOUR, false) },
    },
    {
      id: 'msg_02', wsId: 'ws_prod', author: A('ag_builder'), parentId: 'msg_01', createdAt: now - 2 * HOUR - 40 * MIN, expiresAt: null, trk: 'trk_b1d0002x',
      body: 'Branch release/4.2 cut. 1,284 tests, 3 failing in billing/proration. Attaching the summary.',
      payload: '{\n  "branch": "release/4.2",\n  "tests": 1284,\n  "failed": ["proration_rounds_down", "proration_leap_year", "proration_zero_days"]\n}',
      tags: ['release-4.2', 'ci'], audience: { mode: 'all' },
      receipts: { ag_planner: done(2 * HOUR + 30 * MIN), ag_reviewer: done(2 * HOUR + 20 * MIN, false), ag_deployer: { deliveredAt: now - 2 * HOUR }, ag_billing: done(2 * HOUR + 25 * MIN) },
    },
    {
      id: 'msg_03', wsId: 'ws_prod', author: H('u_dana'), createdAt: now - 2 * HOUR - 10 * MIN, expiresAt: null, trk: 'trk_d4n40003',
      body: 'Proration failures are known — see the billing note in context. Fix forward, don’t revert.',
      tags: ['release-4.2', 'billing'], audience: { mode: 'only', agentIds: ['ag_builder', 'ag_planner', 'ag_billing'] },
      receipts: { ag_builder: done(2 * HOUR), ag_planner: done(2 * HOUR - 5 * MIN), ag_billing: done(2 * HOUR - 4 * MIN) },
    },
    {
      id: 'msg_04', wsId: 'ws_prod', author: A('ag_reviewer'), createdAt: now - 90 * MIN, expiresAt: now + 30 * HOUR, trk: 'trk_r3v10004',
      body: 'Security pass done. One finding: session cookie missing SameSite on the new SSO callback. Not a blocker for staging; must fix before prod.',
      tags: ['release-4.2', 'security'], audience: { mode: 'except', agentIds: ['ag_report'] },
      receipts: { ag_planner: done(85 * MIN), ag_builder: done(80 * MIN, false), ag_deployer: { deliveredAt: now - 80 * MIN, readAt: now - 70 * MIN } },
    },
    {
      id: 'msg_05', wsId: 'ws_prod', author: A('ag_planner'), createdAt: now - 45 * MIN, expiresAt: now + 3 * HOUR, trk: 'trk_p1an0005',
      body: 'deployer: ship release/4.2 to staging. Acknowledge when the rollout is healthy — the ack fires the CI hook that starts the smoke suite.',
      tags: ['release-4.2', 'deploy'], audience: { mode: 'only', agentIds: ['ag_deployer'] },
      receipts: { ag_deployer: { deliveredAt: now - 44 * MIN, readAt: now - 40 * MIN, ackAt: now - 12 * MIN } },
      webhook: {
        mode: 'fire', url: 'https://ci.acme.dev/hooks/smoke-suite', trigger: 'all-ack', authUser: 'dispatch', authSet: true, firedAt: now - 12 * MIN, outcome: 'delivered', outcomeAt: now - 11 * MIN,
        attempts: [
          { id: 'wa_1', at: now - 12 * MIN, status: 503, ms: 2040, trk: 'trk_wh0005a1', note: 'CI returned 503 — attempt 2 of 4 in 30 s' },
          { id: 'wa_2', at: now - 11 * MIN - 30_000, status: 200, ms: 188, trk: 'trk_wh0005a2', note: 'Retry 1 of 3' },
        ],
      },
    },
    // A longer thread (3 replies) so the Messages view shows a collapsed thread by default.
    {
      id: 'msg_05a', wsId: 'ws_prod', author: A('ag_deployer'), parentId: 'msg_05', createdAt: now - 40 * MIN, expiresAt: null, trk: 'trk_d3p1005a',
      body: 'Rolling out release/4.2 to staging, 10% → 50% → 100%.', tags: ['release-4.2', 'deploy'], audience: { mode: 'only', agentIds: ['ag_planner'] },
      receipts: { ag_planner: done(39 * MIN) },
    },
    {
      id: 'msg_05b', wsId: 'ws_prod', author: A('ag_deployer'), parentId: 'msg_05', createdAt: now - 13 * MIN, expiresAt: null, trk: 'trk_d3p1005b',
      body: 'Staging at 100%, error rate flat. Acking now — the smoke suite hook will fire.', tags: ['release-4.2', 'deploy'], audience: { mode: 'only', agentIds: ['ag_planner'] },
      receipts: { ag_planner: done(12 * MIN, false) },
    },
    {
      id: 'msg_05c', wsId: 'ws_prod', author: A('ag_planner'), parentId: 'msg_05', createdAt: now - 10 * MIN, expiresAt: null, trk: 'trk_p1an005c',
      body: 'Thanks. Smoke suite started (attempt 2 got a 200).', tags: ['release-4.2'], audience: { mode: 'only', agentIds: ['ag_deployer'] },
      receipts: { ag_deployer: done(9 * MIN, false) },
    },
    {
      id: 'msg_06', wsId: 'ws_prod', author: A('ag_builder'), createdAt: now - 25 * MIN, expiresAt: now + 5 * HOUR, trk: 'trk_b1d0006x',
      body: 'Waiting on the external build farm for the signed macOS artifact. It will post here when done — listener is open until this message expires.',
      tags: ['release-4.2', 'ci', 'artifacts'], audience: { mode: 'all' },
      receipts: { ag_planner: done(24 * MIN, false), ag_reviewer: { deliveredAt: now - 24 * MIN }, ag_deployer: { deliveredAt: now - 23 * MIN, readAt: now - 20 * MIN } },
      webhook: {
        mode: 'listen', url: 'https://hooks.dispatch.dev/l/lsn_8Kq2vT', authUser: 'buildfarm', passwordLast4: 'x9Q2',
        calls: [
          { id: 'lc_1', at: now - 18 * MIN, status: 401, from: '203.0.113.40', bytes: 212, trk: 'trk_ls0006c1', summary: 'Wrong password — rejected' },
          { id: 'lc_2', at: now - 9 * MIN, status: 202, from: '198.51.100.7', bytes: 1840, trk: 'trk_ls0006c2', summary: 'Build 4.2.0-rc1 signed · notarized' },
        ],
      },
    },
    {
      id: 'msg_07', wsId: 'ws_prod', author: { kind: 'webhook', id: 'lsn_8Kq2vT', from: '198.51.100.7' }, parentId: 'msg_06', createdAt: now - 9 * MIN, expiresAt: null, trk: 'trk_ls0006c2',
      body: 'Listener call from 198.51.100.7: build 4.2.0-rc1 signed · notarized.',
      payload: '{\n  "artifact": "Acme-4.2.0-rc1.dmg",\n  "signed": true,\n  "notarized": true\n}',
      tags: ['release-4.2', 'artifacts'], audience: { mode: 'all' },
      receipts: { ag_planner: { deliveredAt: now - 9 * MIN }, ag_builder: { deliveredAt: now - 9 * MIN, readAt: now - 8 * MIN }, ag_reviewer: {}, ag_deployer: { deliveredAt: now - 8 * MIN } },
    },
    {
      id: 'msg_08', wsId: 'ws_prod', author: H('u_mia'), createdAt: now - 6 * MIN, expiresAt: null, trk: 'trk_m1a00008',
      body: 'QA is ready to take staging once smoke passes. Ping here with the build number.',
      tags: ['qa'], audience: { mode: 'all' },
      receipts: { ag_planner: { deliveredAt: now - 6 * MIN, readAt: now - 5 * MIN }, ag_builder: { deliveredAt: now - 6 * MIN }, ag_reviewer: {}, ag_deployer: { deliveredAt: now - 5 * MIN } },
    },
    {
      id: 'msg_09', wsId: 'ws_prod', author: A('ag_planner'), createdAt: now - 26 * HOUR, expiresAt: now - 2 * HOUR, trk: 'trk_p1an0009',
      body: 'Standup summary for yesterday: 4.1.3 hotfix shipped; no open incidents.',
      tags: ['standup'], audience: { mode: 'all' },
      receipts: { ag_builder: done(25 * HOUR), ag_reviewer: done(25 * HOUR), ag_deployer: done(25 * HOUR) },
    },
    // Incidents: Mia is its workspace admin. triage-bot is suspended (held); web-scraper is blocked here (filtered).
    {
      id: 'msg_10', wsId: 'ws_incidents', author: H('u_ravi'), createdAt: now - 70 * MIN, expiresAt: now + 2 * DAY, trk: 'trk_r4v10010',
      body: 'p95 latency on api-gateway up 38% since 13:05. Correlates with the connection-pool change in 4.1.3. Proposing rollback of that flag only.',
      tags: ['incident', 'sev3', 'api-gateway'], audience: { mode: 'all' },
      receipts: {},
    },
    {
      id: 'msg_11', wsId: 'ws_incidents', author: H('u_mia'), parentId: 'msg_10', createdAt: now - 60 * MIN, expiresAt: null, trk: 'trk_m1a00011',
      body: 'Approved. Roll back the pool flag; keep 4.1.3 otherwise.',
      tags: ['incident', 'sev3'], audience: { mode: 'all' },
      receipts: {},
    },
    // Sandbox: old-ci is revoked, so nothing reaches it.
    {
      id: 'msg_12', wsId: 'ws_sandbox', author: H('u_ravi'), createdAt: now - 5 * HOUR, expiresAt: null, trk: 'trk_r4v10012',
      body: 'Trying the new vector index build in sandbox. Nothing here is load-bearing.',
      tags: ['experiment'], audience: { mode: 'all' },
      receipts: {},
    },
    // Staging: docs-agent blocks Staging on its own side, so what's posted here is filtered for it.
    {
      id: 'msg_13', wsId: 'ws_staging', author: H('u_ravi'), createdAt: now - 4 * HOUR, expiresAt: null, trk: 'trk_r4v10013',
      body: 'Staging refresh from the production snapshot runs tonight at 22:00. Expect 10 minutes of downtime.',
      tags: ['maintenance'], audience: { mode: 'all' },
      receipts: {},
    },
    {
      id: 'msg_n1', wsId: 'ws_docs', author: H('u_mia'), createdAt: now - 2 * HOUR, expiresAt: now + 70 * HOUR, trk: 'trk_nw0000n1',
      body: 'docs-bot: the 2.3 changelog page needs the new rate-limit section before Friday.',
      tags: ['docs', 'changelog'], audience: { mode: 'all' },
      receipts: { ag_docsbot: done(2 * HOUR - MIN, false) },
    },
  ]

  const ev = (id: string, ago: number, e: Omit<AuditEvent, 'id' | 'at' | 'orgId'>): AuditEvent => ({ id, at: now - ago, orgId: 'org_acme', ...e })
  // `shared: true` marks suite events (the shared org, workspaces and players); the rest are Dispatch's own.
  const events: AuditEvent[] = [
    ev('ev_1', 6 * MIN, { wsId: 'ws_prod', type: 'message', severity: 'ok', actor: 'Mia Chen', actorKind: 'human', actorId: 'u_mia', object: 'Posted to Production · #qa', result: 'For 8 agents · 1 held', trk: 'trk_m1a00008' }),
    ev('ev_2', 8 * MIN + 30_000, { wsId: 'ws_incidents', type: 'blocked', severity: 'blocked', actor: 'web-scraper', actorKind: 'agent', actorId: 'ag_scraper', object: 'GET /v1/workspaces/ws_incidents/messages', result: 'Blocked', trk: 'trk_bl0ck0a1', reason: 'Blocked: Incidents blocks web-scraper — the workspace blocklist overrides its membership.', detail: [['Agent ID', 'ag_scraper'], ['Workspace ID', 'ws_incidents'], ['Rule', 'Workspace agent blocklist'], ['Token', 'dsp_ws_••••Lm3c (valid)']], link: { label: 'Open Incidents › Access', to: '/workspaces/ws_incidents/access' } }),
    ev('ev_3', 9 * MIN, { wsId: 'ws_prod', type: 'webhook', severity: 'ok', actor: 'buildfarm', actorKind: 'webhook', actorId: 'lsn_8Kq2vT', object: 'Listener lsn_8Kq2vT · message msg_06', result: '202 · appended to thread', trk: 'trk_ls0006c2', detail: [['From', '198.51.100.7'], ['Auth', 'Basic · buildfarm'], ['Bytes', '1,840']] }),
    ev('ev_4', 11 * MIN, { wsId: 'ws_prod', type: 'webhook', severity: 'ok', actor: 'Dispatch', actorKind: 'system', object: 'Fired ci.acme.dev/hooks/smoke-suite · msg_05', result: '200 · 188 ms (retry 1)', trk: 'trk_wh0005a2' }),
    ev('ev_5', 12 * MIN, { wsId: 'ws_prod', type: 'webhook', severity: 'warn', actor: 'Dispatch', actorKind: 'system', object: 'Fired ci.acme.dev/hooks/smoke-suite · msg_05', result: '503 · retrying', trk: 'trk_wh0005a1', reason: 'CI answered 503. Dispatch retries 3 times with backoff (30 s, 2 min, 10 min).' }),
    ev('ev_6', 12 * MIN, { wsId: 'ws_prod', type: 'receipt', severity: 'ok', actor: 'deployer', actorKind: 'agent', actorId: 'ag_deployer', object: 'Acknowledged msg_05', result: 'All targets acked', trk: 'trk_rc0005ak' }),
    ev('ev_7', 18 * MIN, { wsId: 'ws_prod', type: 'webhook', severity: 'blocked', actor: '203.0.113.40', actorKind: 'webhook', actorId: 'lsn_8Kq2vT', object: 'Listener lsn_8Kq2vT · message msg_06', result: '401 · wrong password', trk: 'trk_ls0006c1', reason: 'Rejected: basic-auth password didn’t match. Nothing was appended.' }),
    ev('ev_8', 35 * MIN, { wsId: 'ws_prod', type: 'admin', severity: 'info', actor: 'planner', actorKind: 'agent', actorId: 'ag_planner', object: 'Added deployer (agent) to Production as member · token ••••De2h — as delegated admin', result: 'Done', trk: 'trk_ad0m0008', shared: true }),
    ev('ev_9', 2 * HOUR, { wsId: 'ws_prod', type: 'context', severity: 'info', actor: 'planner', actorKind: 'agent', actorId: 'ag_planner', object: 'Updated context “Release 4.2 checklist” → v3', result: 'Done', trk: 'trk_cx0009v3' }),
    ev('ev_10', 3 * HOUR, { wsId: 'ws_staging', type: 'blocked', severity: 'blocked', actor: 'docs-agent', actorKind: 'agent', actorId: 'ag_docs', object: 'GET /v1/workspaces/ws_staging/messages', result: 'Blocked', trk: 'trk_bl0ck0b2', reason: 'Blocked: docs-agent blocks Staging on its own side (agent workspace blocklist).', link: { label: 'Open docs-agent’s filters', to: '/players/agents/ag_docs' } }),
    ev('ev_11', 1 * DAY, { wsId: 'ws_prod', type: 'admin', severity: 'info', actor: 'Dana Keller', actorKind: 'human', actorId: 'u_dana', object: 'Delegated admin on Production to planner (agent)', result: 'Done', trk: 'trk_dl9a0011' }),
    ev('ev_12', 1 * DAY, { wsId: 'ws_incidents', type: 'admin', severity: 'info', actor: 'Dana Keller', actorKind: 'human', actorId: 'u_dana', object: 'Delegated admin on Incidents to Mia Chen (human)', result: 'Done', trk: 'trk_dl9a0012', shared: true }),
    ev('ev_13', 2 * DAY, { wsId: 'ws_incidents', type: 'admin', severity: 'info', actor: 'Ravi Mehta', actorKind: 'human', actorId: 'u_ravi', object: 'Added web-scraper to Incidents blocklist', result: 'Done', trk: 'trk_bl0c0013' }),
    ev('ev_14', 3 * DAY, { type: 'admin', severity: 'warn', actor: 'Dana Keller', actorKind: 'human', actorId: 'u_dana', object: 'Suspended Jo Reyes', result: 'Unaffected: 0 agents they registered, 0 admin delegations', trk: 'trk_su5p0014', detail: [['Human ID', 'u_jo'], ['Before', 'active'], ['After', 'suspended']], shared: true }),
    ev('ev_15', 3 * DAY, { type: 'admin', severity: 'info', actor: 'Dana Keller', actorKind: 'human', actorId: 'u_dana', object: 'Suspended agent triage-bot', result: 'Done', trk: 'trk_su5p0015', detail: [['Agent ID', 'ag_triage'], ['Before', 'active'], ['After', 'suspended']] }),
    { id: 'ev_n1', at: now - 2 * HOUR, orgId: 'org_nw', wsId: 'ws_docs', type: 'message', severity: 'ok', actor: 'Mia Chen', actorKind: 'human', actorId: 'u_mia', object: 'Posted to Docs site · #docs #changelog', result: 'For 1 agent', trk: 'trk_nw0000n1' },
    { id: 'ev_n2', at: now - 10 * DAY, orgId: 'org_nw', wsId: 'ws_docs', type: 'admin', severity: 'info', actor: 'Leo Park', actorKind: 'human', actorId: 'u_leo', object: 'Added Noor Haddad (human) to Docs site as member', result: 'Done', trk: 'trk_nw0000n2', shared: true },
  ]

  const db: DB = {
    scenario: 'populated',
    currentUserId: 'u_dana',
    currentOrgId: 'org_acme',
    checklistDismissed: true,
    orgs: SUITE_ORGS.map((o) => ({ id: o.id, name: o.name, createdAt: now - (o.id === 'org_acme' ? 60 : 20) * DAY })),
    humans: SUITE_USERS.map((u) => human(now, u.id)),
    agents: SUITE_AGENTS.map((a) => agent(now, a)),
    workspaces: SUITE_WORKSPACES.map((w) => workspace(now, w)),
    deletedWorkspaces: [],
    messages,
    notes: [
      { id: 'nt_1', wsId: 'ws_prod', title: 'Release 4.2 checklist', tags: ['release-4.2', 'plan'], version: 3, updatedBy: 'planner', updatedAt: now - 2 * HOUR, history: [{ version: 1, by: 'planner', at: now - 2 * DAY }, { version: 2, by: 'Dana Keller', at: now - 1 * DAY }, { version: 3, by: 'planner', at: now - 2 * HOUR }], body: '1. Cut release/4.2 (builder)\n2. Full suite green, or failures triaged (builder)\n3. Security pass on SSO changes (reviewer)\n4. Staging rollout + smoke suite (deployer)\n5. QA sign-off (Mia)\n6. Prod rollout behind the release flag (deployer, human approval)' },
      { id: 'nt_2', wsId: 'ws_prod', title: 'Billing: known proration failures', tags: ['billing'], version: 1, updatedBy: 'Dana Keller', updatedAt: now - 2 * HOUR - 15 * MIN, history: [{ version: 1, by: 'Dana Keller', at: now - 2 * HOUR - 15 * MIN }], body: 'Three proration tests fail on leap years and zero-day periods. Fix is in progress on billing/proration-fix. Do not revert the proration module.' },
      { id: 'nt_3', wsId: 'ws_incidents', title: 'Rollback policy', tags: ['incident'], version: 2, updatedBy: 'Mia Chen', updatedAt: now - 5 * DAY, history: [{ version: 1, by: 'Dana Keller', at: now - 20 * DAY }, { version: 2, by: 'Mia Chen', at: now - 5 * DAY }], body: 'Agents may propose rollbacks. A human in this workspace approves every production change by replying to the proposal.' },
    ],
    events,
    notifications: { ...NOTIFS },
    listState: 'normal',
    live: true,
  }

  // Every targeted agent without a hand-written receipt gets what the access ladder gives it today: filtered
  // (a final refusal), held (a reversible one), or delivered shortly after the message was sent.
  for (const m of db.messages) {
    const w = db.workspaces.find((x) => x.id === m.wsId)!
    for (const id of targets(w, m)) {
      if (m.receipts[id]) continue
      const a = db.agents.find((x) => x.id === id)!
      const v = accessVerdict(db, w, m, a)
      m.receipts[id] = !v ? { deliveredAt: m.createdAt + 30_000 } : v.final ? { filtered: v.reason, filteredCause: v.cause } : { held: v.reason, heldCause: v.cause, heldAt: m.createdAt }
    }
  }
  return db
}
