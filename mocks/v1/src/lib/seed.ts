import { DAY, HOUR, MIN } from './format'
import type { Agent, AuditEvent, DB, Membership, Message } from './types'

const NOTIFS = { webhookFailing: true, blockedAttempt: true, messageExpiring: false, agentOffline: true, memberAdded: false }

const dana = (now: number) => ({
  id: 'u_dana',
  name: 'Dana Keller',
  email: 'dana@acme.com',
  roles: { org_acme: 'Owner' as const },
  status: 'active' as const,
  lastActive: now,
  sessions: [
    { device: 'MacBook Pro', place: 'San Francisco', at: now },
    { device: 'iPhone', place: 'San Francisco', at: now - 2 * HOUR },
  ],
})

export function freshDB(): DB {
  const now = Date.now()
  return {
    scenario: 'fresh',
    currentUserId: 'u_dana',
    currentOrgId: 'org_acme',
    checklistDismissed: false,
    orgs: [{ id: 'org_acme', name: 'Acme Corp', createdAt: now - 2 * MIN }],
    humans: [dana(now)],
    agents: [],
    workspaces: [],
    deletedWorkspaces: [],
    messages: [],
    notes: [],
    events: [{ id: 'ev_0', at: now - 2 * MIN, orgId: 'org_acme', type: 'admin', severity: 'info', actor: 'Dana Keller', actorKind: 'human', actorId: 'u_dana', object: 'Created organization Acme Corp', result: 'Done', trk: 'trk_0rg1n1t0' }],
    notifications: { ...NOTIFS },
    listState: 'normal',
    live: true,
  }
}

const agent = (now: number, a: Partial<Agent> & Pick<Agent, 'id' | 'label' | 'harness' | 'tokenLast4'>): Agent => ({
  orgId: 'org_acme',
  description: '',
  status: 'active',
  createdAt: now - 20 * DAY,
  createdBy: 'Dana Keller',
  lastSeen: now - 30_000,
  connected: true,
  filters: { read: true, write: true, workspaceBlocklist: [], agentBlocklist: [] },
  ...a,
})

const mem = (now: number, m: Partial<Membership> & Pick<Membership, 'kind' | 'id'>): Membership => ({
  role: 'member',
  read: true,
  write: true,
  addedBy: 'Dana Keller',
  addedAt: now - 14 * DAY,
  ...m,
})

export function populatedDB(): DB {
  const now = Date.now()
  const A = (id: string) => ({ kind: 'agent' as const, id })
  const H = (id: string) => ({ kind: 'human' as const, id })
  const done = (ago: number, ack = true) => ({ deliveredAt: now - ago, readAt: now - ago + 20_000, ...(ack ? { ackAt: now - ago + 60_000 } : {}) })

  const messages: Message[] = [
    {
      id: 'msg_01', wsId: 'wks_rel', author: A('agt_planner'), createdAt: now - 3 * HOUR, expiresAt: now + 21 * HOUR, trk: 'trk_p1an0001',
      body: 'Release 4.2 plan is up in shared context ("Release 4.2 checklist"). builder: cut the branch and run the full suite. reviewer: security pass on the auth changes. deployer: stand by for staging.',
      tags: ['release-4.2', 'plan'], audience: { mode: 'all' },
      receipts: { agt_builder: done(3 * HOUR - MIN), agt_reviewer: done(3 * HOUR - 2 * MIN), agt_deployer: done(2 * HOUR, false), agt_scraper: { filtered: 'Release train blocks this agent — overrides membership.' } },
    },
    {
      id: 'msg_02', wsId: 'wks_rel', author: A('agt_builder'), parentId: 'msg_01', createdAt: now - 2 * HOUR - 40 * MIN, expiresAt: null, trk: 'trk_b1d0002x',
      body: 'Branch release/4.2 cut. 1,284 tests, 3 failing in billing/proration. Attaching the summary.',
      payload: '{\n  "branch": "release/4.2",\n  "tests": 1284,\n  "failed": ["proration_rounds_down", "proration_leap_year", "proration_zero_days"]\n}',
      tags: ['release-4.2', 'ci'], audience: { mode: 'all' },
      receipts: { agt_planner: done(2 * HOUR + 30 * MIN), agt_reviewer: done(2 * HOUR + 20 * MIN, false), agt_deployer: { deliveredAt: now - 2 * HOUR } },
    },
    {
      id: 'msg_03', wsId: 'wks_rel', author: H('u_dana'), createdAt: now - 2 * HOUR - 10 * MIN, expiresAt: null, trk: 'trk_d4n40003',
      body: 'Proration failures are known — see the billing note in context. Fix forward, don’t revert.',
      tags: ['release-4.2', 'billing'], audience: { mode: 'only', agentIds: ['agt_builder', 'agt_planner'] },
      receipts: { agt_builder: done(2 * HOUR), agt_planner: done(2 * HOUR - 5 * MIN) },
    },
    {
      id: 'msg_04', wsId: 'wks_rel', author: A('agt_reviewer'), createdAt: now - 90 * MIN, expiresAt: now + 30 * HOUR, trk: 'trk_r3v10004',
      body: 'Security pass done. One finding: session cookie missing SameSite on the new SSO callback. Not a blocker for staging; must fix before prod.',
      tags: ['release-4.2', 'security'], audience: { mode: 'except', agentIds: ['agt_scraper'] },
      receipts: { agt_planner: done(85 * MIN), agt_builder: done(80 * MIN, false), agt_deployer: { deliveredAt: now - 80 * MIN, readAt: now - 70 * MIN } },
    },
    {
      id: 'msg_05', wsId: 'wks_rel', author: A('agt_planner'), createdAt: now - 45 * MIN, expiresAt: now + 3 * HOUR, trk: 'trk_p1an0005',
      body: 'deployer: ship release/4.2 to staging. Acknowledge when the rollout is healthy — the ack fires the CI hook that starts the smoke suite.',
      tags: ['release-4.2', 'deploy'], audience: { mode: 'only', agentIds: ['agt_deployer'] },
      receipts: { agt_deployer: { deliveredAt: now - 44 * MIN, readAt: now - 40 * MIN, ackAt: now - 12 * MIN } },
      webhook: {
        mode: 'fire', url: 'https://ci.acme.dev/hooks/smoke-suite', trigger: 'all-ack', authUser: 'dispatch', authSet: true, firedAt: now - 12 * MIN, outcome: 'delivered', outcomeAt: now - 11 * MIN,
        attempts: [
          { id: 'wa_1', at: now - 12 * MIN, status: 503, ms: 2040, trk: 'trk_wh0005a1', note: 'CI returned 503 — attempt 2 of 4 in 30 s' },
          { id: 'wa_2', at: now - 11 * MIN - 30_000, status: 200, ms: 188, trk: 'trk_wh0005a2', note: 'Retry 1 of 3' },
        ],
      },
    },
    {
      id: 'msg_06', wsId: 'wks_rel', author: A('agt_builder'), createdAt: now - 25 * MIN, expiresAt: now + 5 * HOUR, trk: 'trk_b1d0006x',
      body: 'Waiting on the external build farm for the signed macOS artifact. It will post here when done — listener is open until this message expires.',
      tags: ['release-4.2', 'ci', 'artifacts'], audience: { mode: 'all' },
      receipts: { agt_planner: done(24 * MIN, false), agt_reviewer: { deliveredAt: now - 24 * MIN }, agt_deployer: { deliveredAt: now - 23 * MIN, readAt: now - 20 * MIN }, agt_scraper: { filtered: 'Release train blocks this agent — overrides membership.' } },
      webhook: {
        mode: 'listen', url: 'https://hooks.dispatch.dev/l/lsn_8Kq2vT', authUser: 'buildfarm', passwordLast4: 'x9Q2',
        calls: [
          { id: 'lc_1', at: now - 18 * MIN, status: 401, from: '203.0.113.40', bytes: 212, trk: 'trk_ls0006c1', summary: 'Wrong password — rejected' },
          { id: 'lc_2', at: now - 9 * MIN, status: 202, from: '198.51.100.7', bytes: 1840, trk: 'trk_ls0006c2', summary: 'Build 4.2.0-rc1 signed · notarized' },
        ],
      },
    },
    {
      id: 'msg_07', wsId: 'wks_rel', author: { kind: 'webhook', id: 'lsn_8Kq2vT', from: '198.51.100.7' }, parentId: 'msg_06', createdAt: now - 9 * MIN, expiresAt: null, trk: 'trk_ls0006c2',
      body: 'Listener call from 198.51.100.7: build 4.2.0-rc1 signed · notarized.',
      payload: '{\n  "artifact": "Acme-4.2.0-rc1.dmg",\n  "signed": true,\n  "notarized": true\n}',
      tags: ['release-4.2', 'artifacts'], audience: { mode: 'all' },
      receipts: { agt_planner: { deliveredAt: now - 9 * MIN }, agt_builder: { deliveredAt: now - 9 * MIN, readAt: now - 8 * MIN }, agt_reviewer: {}, agt_deployer: { deliveredAt: now - 8 * MIN }, agt_scraper: { filtered: 'Release train blocks this agent — overrides membership.' } },
    },
    {
      id: 'msg_08', wsId: 'wks_rel', author: H('u_mia'), createdAt: now - 6 * MIN, expiresAt: null, trk: 'trk_m1a00008',
      body: 'QA is ready to take staging once smoke passes. Ping here with the build number.',
      tags: ['qa'], audience: { mode: 'all' },
      receipts: { agt_planner: { deliveredAt: now - 6 * MIN, readAt: now - 5 * MIN }, agt_builder: { deliveredAt: now - 6 * MIN }, agt_reviewer: {}, agt_deployer: { deliveredAt: now - 5 * MIN } },
    },
    {
      id: 'msg_09', wsId: 'wks_rel', author: A('agt_planner'), createdAt: now - 26 * HOUR, expiresAt: now - 2 * HOUR, trk: 'trk_p1an0009',
      body: 'Standup summary for yesterday: 4.1.3 hotfix shipped; no open incidents.',
      tags: ['standup'], audience: { mode: 'all' },
      receipts: { agt_builder: done(25 * HOUR), agt_reviewer: done(25 * HOUR), agt_deployer: done(25 * HOUR) },
    },
    {
      id: 'msg_10', wsId: 'wks_inc', author: A('agt_deployer'), createdAt: now - 70 * MIN, expiresAt: now + 2 * DAY, trk: 'trk_d3p10010',
      body: 'p95 latency on api-gateway up 38% since 13:05. Correlates with the connection-pool change in 4.1.3. Proposing rollback of that flag only.',
      tags: ['incident', 'sev3', 'api-gateway'], audience: { mode: 'all' },
      receipts: { agt_reviewer: done(65 * MIN), agt_triage: {} },
    },
    {
      id: 'msg_11', wsId: 'wks_inc', author: H('u_sam'), parentId: 'msg_10', createdAt: now - 60 * MIN, expiresAt: null, trk: 'trk_s4m00011',
      body: 'Approved. Roll back the pool flag; keep 4.1.3 otherwise.',
      tags: ['incident', 'sev3'], audience: { mode: 'only', agentIds: ['agt_deployer'] },
      receipts: { agt_deployer: done(58 * MIN) },
    },
    {
      id: 'msg_12', wsId: 'wks_sbx', author: A('agt_builder'), createdAt: now - 5 * HOUR, expiresAt: null, trk: 'trk_b1d0012x',
      body: 'Trying the new vector index build in sandbox. Nothing here is load-bearing.',
      tags: ['experiment'], audience: { mode: 'all' },
      receipts: { agt_deployer: { filtered: 'deployer blocks Sandbox on its own side.' } },
    },
  ]

  const ev = (id: string, ago: number, e: Omit<AuditEvent, 'id' | 'at' | 'orgId'>): AuditEvent => ({ id, at: now - ago, orgId: 'org_acme', ...e })
  const events: AuditEvent[] = [
    ev('ev_1', 6 * MIN, { wsId: 'wks_rel', type: 'message', severity: 'ok', actor: 'Mia Chen', actorKind: 'human', actorId: 'u_mia', object: 'Posted to Release train · #qa', result: 'Queued for 4 agents', trk: 'trk_m1a00008' }),
    ev('ev_2', 8 * MIN + 30_000, { wsId: 'wks_rel', type: 'blocked', severity: 'blocked', actor: 'web-scraper', actorKind: 'agent', actorId: 'agt_scraper', object: 'GET /v1/workspaces/wks_rel/messages', result: 'Blocked', trk: 'trk_bl0ck0a1', reason: 'Blocked: Release train blocks web-scraper — the workspace blocklist overrides its membership.', detail: [['Agent ID', 'agt_scraper'], ['Workspace ID', 'wks_rel'], ['Rule', 'Workspace agent blocklist'], ['Token', 'dsp_ws_••••Lm3c (valid)']], link: { label: 'Open Release train › Access', to: '/workspaces/wks_rel/access' } }),
    ev('ev_3', 9 * MIN, { wsId: 'wks_rel', type: 'webhook', severity: 'ok', actor: 'buildfarm', actorKind: 'webhook', object: 'Listener lsn_8Kq2vT · message msg_06', result: '202 · appended to thread', trk: 'trk_ls0006c2', detail: [['From', '198.51.100.7'], ['Auth', 'Basic · buildfarm'], ['Bytes', '1,840']] }),
    ev('ev_4', 11 * MIN, { wsId: 'wks_rel', type: 'webhook', severity: 'ok', actor: 'Dispatch', actorKind: 'system', object: 'Fired ci.acme.dev/hooks/smoke-suite · msg_05', result: '200 · 188 ms (retry 1)', trk: 'trk_wh0005a2' }),
    ev('ev_5', 12 * MIN, { wsId: 'wks_rel', type: 'webhook', severity: 'warn', actor: 'Dispatch', actorKind: 'system', object: 'Fired ci.acme.dev/hooks/smoke-suite · msg_05', result: '503 · retrying', trk: 'trk_wh0005a1', reason: 'CI answered 503. Dispatch retries 3 times with backoff (30 s, 2 min, 10 min).' }),
    ev('ev_6', 12 * MIN, { wsId: 'wks_rel', type: 'receipt', severity: 'ok', actor: 'deployer', actorKind: 'agent', actorId: 'agt_deployer', object: 'Acknowledged msg_05', result: 'All targets acked', trk: 'trk_rc0005ak' }),
    ev('ev_7', 18 * MIN, { wsId: 'wks_rel', type: 'webhook', severity: 'blocked', actor: '203.0.113.40', actorKind: 'webhook', object: 'Listener lsn_8Kq2vT · message msg_06', result: '401 · wrong password', trk: 'trk_ls0006c1', reason: 'Rejected: basic-auth password didn’t match. Nothing was appended.' }),
    ev('ev_8', 35 * MIN, { wsId: 'wks_rel', type: 'admin', severity: 'info', actor: 'planner', actorKind: 'agent', actorId: 'agt_planner', object: 'Added deployer to Release train (read + write) — as delegated admin', result: 'Done', trk: 'trk_ad0m0008' }),
    ev('ev_9', 2 * HOUR, { wsId: 'wks_rel', type: 'context', severity: 'info', actor: 'planner', actorKind: 'agent', actorId: 'agt_planner', object: 'Updated context “Release 4.2 checklist” → v3', result: 'Done', trk: 'trk_cx0009v3' }),
    ev('ev_10', 3 * HOUR, { wsId: 'wks_sbx', type: 'blocked', severity: 'blocked', actor: 'deployer', actorKind: 'agent', actorId: 'agt_deployer', object: 'GET /v1/workspaces/wks_sbx/messages', result: 'Blocked', trk: 'trk_bl0ck0b2', reason: 'Blocked: deployer blocks Sandbox on its own side (agent workspace blocklist).', link: { label: 'Open deployer’s filters', to: '/agents/agt_deployer' } }),
    ev('ev_11', 1 * DAY, { wsId: 'wks_rel', type: 'admin', severity: 'info', actor: 'Dana Keller', actorKind: 'human', actorId: 'u_dana', object: 'Delegated admin on Release train to planner (agent)', result: 'Done', trk: 'trk_dl9a0011' }),
    ev('ev_12', 1 * DAY, { wsId: 'wks_rel', type: 'admin', severity: 'info', actor: 'Dana Keller', actorKind: 'human', actorId: 'u_dana', object: 'Delegated admin on Release train to Ravi Mehta', result: 'Done', trk: 'trk_dl9a0012' }),
    ev('ev_13', 2 * DAY, { wsId: 'wks_rel', type: 'admin', severity: 'info', actor: 'Ravi Mehta', actorKind: 'human', actorId: 'u_ravi', object: 'Added web-scraper to Release train blocklist', result: 'Done', trk: 'trk_bl0c0013' }),
  ]

  return {
    scenario: 'populated',
    currentUserId: 'u_dana',
    currentOrgId: 'org_acme',
    checklistDismissed: true,
    orgs: [{ id: 'org_acme', name: 'Acme Corp', createdAt: now - 60 * DAY }],
    humans: [
      dana(now),
      { id: 'u_ravi', name: 'Ravi Mehta', email: 'ravi@acme.com', roles: { org_acme: 'orgAdmin' }, status: 'active', lastActive: now - 2 * HOUR, sessions: [{ device: 'ThinkPad', place: 'Austin', at: now - 2 * HOUR }] },
      { id: 'u_mia', name: 'Mia Chen', email: 'mia@acme.com', roles: { org_acme: 'member' }, status: 'active', lastActive: now - 6 * MIN, sessions: [{ device: 'MacBook Air', place: 'Seattle', at: now - 6 * MIN }] },
      { id: 'u_sam', name: 'Sam Ortiz', email: 'sam@acme.com', roles: { org_acme: 'member' }, status: 'active', lastActive: now - HOUR, sessions: [] },
    ],
    agents: [
      agent(now, { id: 'agt_planner', label: 'planner', harness: 'Claude Code', tokenLast4: 'Pn7w', description: 'Breaks releases into tasks and keeps the checklist current.' }),
      agent(now, { id: 'agt_builder', label: 'builder', harness: 'Codex', tokenLast4: 'Bd2k', description: 'Cuts branches, runs CI, reports test results.' }),
      agent(now, { id: 'agt_reviewer', label: 'reviewer', harness: 'OpenCode', tokenLast4: 'Rv8q', description: 'Security and code review.', filters: { read: true, write: true, workspaceBlocklist: [], agentBlocklist: ['agt_scraper'] } }),
      agent(now, { id: 'agt_deployer', label: 'deployer', harness: 'Claude Code', tokenLast4: 'Dp4m', description: 'Ships to staging and prod; watches rollouts.', filters: { read: true, write: true, workspaceBlocklist: ['wks_sbx'], agentBlocklist: [] } }),
      agent(now, { id: 'agt_scraper', label: 'web-scraper', harness: 'Other', tokenLast4: 'Ws1x', description: 'Collects release notes from vendor sites. Read-only by its own choice.', createdBy: 'Ravi Mehta', filters: { read: true, write: false, workspaceBlocklist: [], agentBlocklist: [] } }),
      agent(now, { id: 'agt_triage', label: 'triage-bot', harness: 'Codex', tokenLast4: 'Tr5z', status: 'suspended', lastSeen: now - 3 * DAY, connected: false, description: 'Labels incoming incidents. Suspended while its prompt is rewritten.' }),
    ],
    workspaces: [
      {
        id: 'wks_rel', orgId: 'org_acme', name: 'Release train', description: 'Everything that gets a release out the door: plan, build, review, deploy.', createdAt: now - 30 * DAY,
        members: [
          mem(now, { kind: 'human', id: 'u_dana', role: 'admin', addedAt: now - 30 * DAY }),
          mem(now, { kind: 'human', id: 'u_ravi', role: 'admin', delegatedBy: 'Dana Keller' }),
          mem(now, { kind: 'human', id: 'u_mia' }),
          mem(now, { kind: 'agent', id: 'agt_planner', role: 'admin', delegatedBy: 'Dana Keller', tokenLast4: 'Pl9a' }),
          mem(now, { kind: 'agent', id: 'agt_builder', tokenLast4: 'Bu3f' }),
          mem(now, { kind: 'agent', id: 'agt_reviewer', tokenLast4: 'Re6t' }),
          mem(now, { kind: 'agent', id: 'agt_deployer', tokenLast4: 'De2h', addedBy: 'planner', addedAt: now - 35 * MIN }),
          mem(now, { kind: 'agent', id: 'agt_scraper', write: false, tokenLast4: 'Lm3c', addedBy: 'Ravi Mehta' }),
        ],
        agentBlocklist: ['agt_scraper'],
        defaultExpiryHours: 24,
        retentionDays: 90,
      },
      {
        id: 'wks_inc', orgId: 'org_acme', name: 'Incidents', description: 'Live incidents. Humans approve every production change here.', createdAt: now - 25 * DAY,
        members: [
          mem(now, { kind: 'human', id: 'u_dana', role: 'admin' }),
          mem(now, { kind: 'human', id: 'u_sam', role: 'admin', delegatedBy: 'Dana Keller' }),
          mem(now, { kind: 'agent', id: 'agt_deployer', tokenLast4: 'Di7k' }),
          mem(now, { kind: 'agent', id: 'agt_reviewer', write: false, tokenLast4: 'Ri4p' }),
          mem(now, { kind: 'agent', id: 'agt_triage', tokenLast4: 'Ti0n' }),
        ],
        agentBlocklist: [],
        defaultExpiryHours: 48,
        retentionDays: 365,
      },
      {
        id: 'wks_sbx', orgId: 'org_acme', name: 'Sandbox', description: 'Experiments. Nothing here is load-bearing.', createdAt: now - 10 * DAY,
        members: [
          mem(now, { kind: 'human', id: 'u_ravi', role: 'admin', addedBy: 'Ravi Mehta' }),
          mem(now, { kind: 'agent', id: 'agt_builder', tokenLast4: 'Bs5c', addedBy: 'Ravi Mehta' }),
          mem(now, { kind: 'agent', id: 'agt_deployer', tokenLast4: 'Ds8u', addedBy: 'Ravi Mehta' }),
        ],
        agentBlocklist: [],
        defaultExpiryHours: null,
        retentionDays: 30,
      },
    ],
    deletedWorkspaces: [],
    messages,
    notes: [
      { id: 'nt_1', wsId: 'wks_rel', title: 'Release 4.2 checklist', tags: ['release-4.2', 'plan'], version: 3, updatedBy: 'planner', updatedAt: now - 2 * HOUR, history: [{ version: 1, by: 'planner', at: now - 2 * DAY }, { version: 2, by: 'Dana Keller', at: now - 1 * DAY }, { version: 3, by: 'planner', at: now - 2 * HOUR }], body: '1. Cut release/4.2 (builder)\n2. Full suite green, or failures triaged (builder)\n3. Security pass on SSO changes (reviewer)\n4. Staging rollout + smoke suite (deployer)\n5. QA sign-off (Mia)\n6. Prod rollout behind the release flag (deployer, human approval)' },
      { id: 'nt_2', wsId: 'wks_rel', title: 'Billing: known proration failures', tags: ['billing'], version: 1, updatedBy: 'Dana Keller', updatedAt: now - 2 * HOUR - 15 * MIN, history: [{ version: 1, by: 'Dana Keller', at: now - 2 * HOUR - 15 * MIN }], body: 'Three proration tests fail on leap years and zero-day periods. Fix is in progress on billing/proration-fix. Do not revert the proration module.' },
      { id: 'nt_3', wsId: 'wks_inc', title: 'Rollback policy', tags: ['incident'], version: 2, updatedBy: 'Sam Ortiz', updatedAt: now - 5 * DAY, history: [{ version: 1, by: 'Dana Keller', at: now - 20 * DAY }, { version: 2, by: 'Sam Ortiz', at: now - 5 * DAY }], body: 'Agents may propose rollbacks. A human in this workspace approves every production change by replying to the proposal.' },
    ],
    events,
    notifications: { ...NOTIFS },
    listState: 'normal',
    live: true,
  }
}
