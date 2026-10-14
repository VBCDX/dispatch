#!/usr/bin/env node
// Converts the mock's populated demo database (populatedDB() in
// mocks/v1/src/lib/seed.ts) into internal/seed/demo.json: rows for the SQL
// tables in internal/store/migrations, in foreign-key order.
//
//   node scripts/seed-from-mock.mjs > internal/seed/demo.json
//
// Needs esbuild to read the TypeScript: it uses ESBUILD if set, else
// `npx --yes esbuild@0.25.10`.
//
// The mock is evaluated with Date.now() = 0, so every instant it produces
// is an offset from "now". Each instant is written as {"$t": offset}, and
// the loader adds the time the seed runs. Instants inside JSON columns are
// written the same way and become Unix milliseconds.

import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const entry = path.join(root, 'mocks/v1/src/lib/seed.ts')
const esbuild = process.env.ESBUILD ? [process.env.ESBUILD] : ['npx', '--yes', 'esbuild@0.25.10']
const js = execFileSync(esbuild[0], [...esbuild.slice(1), entry, '--bundle', '--format=esm', '--platform=neutral', '--log-level=warning'], { encoding: 'utf8' })

const realNow = Date.now
Date.now = () => 0
const { populatedDB } = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'))
const db = populatedDB()
Date.now = realNow

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const AUDIT_RETENTION = 365 * DAY
const LISTENER_CALL_RETENTION = 90 * DAY
const SESSION_LIFETIME = 30 * DAY

const T = (ms) => (ms === null || ms === undefined ? null : { $t: ms })

// The mock's IDs use agt_ and wks_; the schema's use ag_ and ws_.
const id = (x) => x.replace(/^agt_/, 'ag_').replace(/^wks_/, 'ws_')
const short = (x) => x.replace(/^[a-z]+_/, '')

const humans = new Map(db.humans.map((h) => [h.id, h]))
const agents = new Map(db.agents.map((a) => [a.id, a]))
const workspaces = new Map(db.workspaces.map((w) => [w.id, w]))
const messages = new Map(db.messages.map((m) => [m.id, m]))

// A principal ref from a mock "…ById": u_ is a user, agt_ an agent.
const principal = (mockId) => (mockId?.startsWith('agt_') ? { kind: 'agent', id: id(mockId) } : { kind: 'user', id: mockId })
// An actor from a display label ("planner", "Dana Keller").
const actorByLabel = (label) => {
  const a = db.agents.find((x) => x.label === label)
  if (a) return { kind: 'agent', id: id(a.id), label }
  const h = db.humans.find((x) => x.name === label)
  if (h) return { kind: 'user', id: h.id, label }
  return { kind: 'system', id: null, label }
}
const flatActor = (prefix, a) => ({
  [`${prefix}_kind`]: a.kind,
  [`${prefix}_id`]: a.id ?? null,
  [`${prefix}_label`]: a.label,
  [`${prefix}_via_kind`]: a.via?.kind ?? null,
  [`${prefix}_via_id`]: a.via?.id ?? null,
  [`${prefix}_via_label`]: a.via?.label ?? null,
})
// A token digest for a seeded token. Only the last four are known; the hash
// is a placeholder no real token's HMAC can equal (it is not base64url of
// 32 bytes), so a seeded token never authenticates.
const digest = (prefix, kind, owner, last4, issuedAt) => ({
  [`${prefix}_alg`]: 'sha256',
  [`${prefix}_hash`]: `seed-unusable:${kind}:${owner}`,
  [`${prefix}_pepper_version`]: 1,
  [`${prefix}_prefix`]: kind,
  [`${prefix}_last4`]: last4,
  [`${prefix}_issued_at`]: T(issuedAt),
  [`${prefix}_expires_at`]: null,
})
const previousDigest = (prefix, kind, owner, last4, until, issuedAt) =>
  last4
    ? { ...digest(`${prefix}_previous_digest`, kind, owner + ':prev', last4, issuedAt), [`${prefix}_previous_grace_until`]: T(until) }
    : {}

const orgOf = (wsId) => workspaces.get(wsId).orgId
const retentionMs = (wsId) => workspaces.get(wsId).retentionDays * DAY

const tables = []
const table = (name, rows) => tables.push({ name, rows })

// --- orgs, users, org memberships, sessions --------------------------------
const orgCreator = { org_acme: 'u_dana', org_nw: 'u_leo' }
table('orgs', db.orgs.map((o) => ({
  id: o.id, name: o.name, status: 'active', audit_retention_days: 365,
  created_at: T(o.createdAt), created_by_kind: 'user', created_by_id: orgCreator[o.id],
  updated_at: T(o.createdAt), rev: 0,
})))

table('users', db.humans.map((h) => ({
  id: h.id, email: h.email, email_lower: h.email.toLowerCase(), name: h.name,
  status: Object.values(h.orgStatus).every((s) => s === 'invited') ? 'pending' : 'active',
  last_sign_in_at: T(h.sessions[0]?.at ?? null),
  created_at: T(-60 * DAY), updated_at: T(-60 * DAY),
})))

const orgMemberships = []
for (const h of db.humans) {
  for (const [orgId, role] of Object.entries(h.roles)) {
    const status = h.orgStatus[orgId]
    orgMemberships.push({
      id: `om_${short(orgId)}_${short(h.id)}`, org_id: orgId, user_id: h.id, role, status,
      suspended_from: status === 'suspended' ? h.suspendedFrom?.[orgId] ?? 'active' : null,
      joined_at: status === 'invited' ? null : T(db.orgs.find((o) => o.id === orgId).createdAt),
      created_at: T(db.orgs.find((o) => o.id === orgId).createdAt),
      updated_at: T(db.orgs.find((o) => o.id === orgId).createdAt), rev: 0,
    })
  }
}
table('org_memberships', orgMemberships)

// Other people's devices, for My Settings and People. The key is not a
// SHA-256 hex digest, so no cookie can ever match it.
table('sessions', db.humans.flatMap((h) => h.sessions.map((s, i) => ({
  id_hash: `seed-session:${h.id}:${i}`, user_id: h.id, method: 'zitadel', csrf_token: 'seed',
  client: 'web:dispatch', device: s.device, place: s.place,
  created_at: T(s.at - HOUR), last_seen_at: T(s.at), expires_at: T(s.at + SESSION_LIFETIME),
}))))

table('org_settings', db.orgs.map((o) => ({
  id: o.id,
  notifications_webhook_failing: db.notifications.webhookFailing,
  notifications_blocked_attempt: db.notifications.blockedAttempt,
  notifications_message_expiring: db.notifications.messageExpiring,
  notifications_agent_offline: db.notifications.agentOffline,
  notifications_member_added: db.notifications.memberAdded,
  updated_at: T(o.createdAt), updated_by_kind: 'user', updated_by_id: orgCreator[o.id],
})))

// --- workspaces ----------------------------------------------------------------
const wsCreator = (w) => w.members.find((m) => m.kind === 'human' && m.role === 'admin')?.addedById ?? orgCreator[w.orgId]
table('workspaces', db.workspaces.map((w) => ({
  id: id(w.id), org_id: w.orgId, name: w.name, status: 'active',
  created_at: T(w.createdAt), created_by_kind: 'user', created_by_id: wsCreator(w),
  updated_at: T(w.createdAt), rev: 0,
})))
table('workspace_settings', db.workspaces.map((w) => ({
  id: id(w.id), org_id: w.orgId, description: w.description,
  default_expiry_hours: w.defaultExpiryHours, retention_days: w.retentionDays,
  updated_at: T(w.createdAt), ...flatActor('updated_by', actorByLabel(humans.get(wsCreator(w)).name)), rev: 0,
})))
table('workspace_settings_agent_blocklist', db.workspaces.flatMap((w) => w.agentBlocklist.map((a) => ({
  workspace_id: id(w.id), org_id: w.orgId, agent_id: id(a),
}))))

// --- agents ------------------------------------------------------------------
table('agents', db.agents.map((a) => ({
  id: id(a.id), org_id: a.orgId, label: a.label, label_lower: a.label.toLowerCase(),
  created_at: T(a.createdAt), created_by_kind: 'user', created_by_id: a.createdById, created_by_label: a.createdBy,
  updated_at: T(a.createdAt), rev: 0,
})))
table('agent_profiles', db.agents.map((a) => ({
  id: id(a.id), org_id: a.orgId, status: a.status, description: a.description,
  ...digest('token_current', 'dsp_agent_', id(a.id), a.tokenLast4, a.createdAt),
  ...previousDigest('token', 'dsp_agent_', id(a.id), a.prevTokenLast4, a.prevTokenUntil, a.createdAt),
  token_rotation_count: 0, token_delivery: 'shown_once',
  filters_read: a.filters.read, filters_write: a.filters.write,
  filters_workspace_blocklist: a.filters.workspaceBlocklist.map(id),
  client_name: a.client?.name ?? null, client_version: a.client?.version ?? null, client_via: a.client?.via ?? null,
  client_at: T(a.client ? a.lastSeen : null),
  last_transport_via: a.lastTransport?.via ?? a.client?.via ?? null,
  last_transport_at: T(a.lastTransport?.at ?? a.lastSeen),
  last_seen_at: T(a.lastSeen), config_format: a.configFormat ?? null,
  suspended_at: T(a.status === 'suspended' ? a.lastSeen : null),
  revoked_at: T(a.status === 'revoked' ? a.lastSeen : null),
  created_at: T(a.createdAt), updated_at: T(a.createdAt), rev: 0,
})))
table('agent_profiles_agent_blocklist', db.agents.flatMap((a) => a.filters.agentBlocklist.map((b) => ({
  agent_profile_id: id(a.id), org_id: a.orgId, agent_id: id(b),
}))))

// --- workspace memberships and Dispatch access ---------------------------------
const wmId = (wsId, memberId) => `wm_${short(wsId)}_${short(memberId)}`
const memberships = db.workspaces.flatMap((w) => w.members.map((m) => ({ w, m })))
table('workspace_memberships', memberships.map(({ w, m }) => {
  const delegated = m.delegatedById ? principal(m.delegatedById) : null
  return {
    id: wmId(w.id, m.id), org_id: w.orgId, workspace_id: id(w.id),
    member_kind: m.kind === 'human' ? 'user' : 'agent', member_id: id(m.id),
    // Agent admin is Dispatch-only (membership_access.agent_role).
    role: m.kind === 'human' && m.role === 'admin' ? 'workspace_admin' : 'member',
    added_at: T(m.addedAt), ...flatPrincipal('added_by', principal(m.addedById)),
    delegated_by_kind: delegated?.kind ?? null, delegated_by_id: delegated?.id ?? null,
    delegated_at: T(delegated ? m.addedAt : null),
    updated_at: T(m.addedAt), rev: 0,
  }
}))
function flatPrincipal(prefix, p) {
  return { [`${prefix}_kind`]: p.kind, [`${prefix}_id`]: p.id }
}
table('membership_access', memberships.map(({ w, m }) => {
  const agent = m.kind === 'agent'
  const delegated = m.delegatedById ? principal(m.delegatedById) : null
  return {
    id: wmId(w.id, m.id), org_id: w.orgId, workspace_id: id(w.id),
    member_kind: agent ? 'agent' : 'user', member_id: id(m.id),
    read: agent ? m.read : true, write: m.write,
    agent_role: agent ? (m.role === 'admin' ? 'workspace_admin' : 'member') : null,
    delegated_by_kind: agent ? delegated?.kind ?? null : null, delegated_by_id: agent ? delegated?.id ?? null : null,
    ...(agent ? digest('token_current', 'dsp_ws_', wmId(w.id, m.id), m.tokenLast4, m.addedAt) : {}),
    ...(agent ? previousDigest('token', 'dsp_ws_', wmId(w.id, m.id), m.prevTokenLast4, m.prevTokenUntil, m.addedAt) : {}),
    token_rotation_count: agent ? 0 : null,
    token_revoked_at: T(agent && m.tokenRevoked ? m.addedAt : null),
    token_delivery: agent ? 'shown_once' : null,
    updated_at: T(m.addedAt), rev: 0,
  }
}))

// --- messages ------------------------------------------------------------------
const author = (a) =>
  a.kind === 'human' ? { author_kind: 'user', author_id: a.id, author_from: null }
  : a.kind === 'agent' ? { author_kind: 'agent', author_id: id(a.id), author_from: null }
  : { author_kind: 'listener', author_id: a.id, author_from: a.from }
const authorRef = (a) => (a.kind === 'human' ? { kind: 'user', id: a.id } : a.kind === 'agent' ? { kind: 'agent', id: id(a.id) } : { kind: 'listener', id: a.id, from: a.from })
const rootOf = (m) => (m.parentId ? rootOf(messages.get(m.parentId)) : m)
const isExpired = (m) => m.expiresAt !== null && m.expiresAt <= 0

function receiptState(r, m) {
  if (r.filtered) return 'filtered'
  if (r.held) return 'held'
  if (r.ackAt) return 'acked'
  if (r.readAt) return 'read'
  if (r.deliveredAt) return 'delivered'
  return isExpired(m) ? 'never_delivered' : 'queued'
}
function counts(m) {
  const c = { targets: 0, queued: 0, held: 0, delivered: 0, read: 0, acked: 0, filtered: 0, never_delivered: 0 }
  for (const r of Object.values(m.receipts)) {
    c.targets++
    const s = receiptState(r, m)
    c[s]++
  }
  // delivered/read/acked are cumulative in the snapshot: an acked receipt
  // was also read and delivered.
  c.read += c.acked
  c.delivered += c.read
  return c
}

const webhookId = (m) => `wh_${short(m.id)}`
table('messages', db.messages.map((m) => {
  const c = counts(m)
  const del = m.createdAt + retentionMs(m.wsId)
  return {
    id: m.id, org_id: orgOf(m.wsId), workspace_id: id(m.wsId), ...author(m.author),
    body_storage: 'inline', body_text: m.body,
    payload_storage: m.payload ? 'inline' : null, payload_json: m.payload ? JSON.parse(m.payload) : null,
    audience_mode: m.audience.mode, audience_agent_ids: m.audience.mode === 'all' ? null : m.audience.agentIds.map(id),
    parent_id: m.parentId ?? null, thread_root_id: m.parentId ? rootOf(m).id : null,
    created_at: T(m.createdAt), expires_at: T(m.expiresAt), trk: m.trk,
    sent_via_channel: m.sentVia ? 'api_console' : null, sent_via_user_id: m.sentVia?.humanId ?? null,
    webhook_id: m.webhook ? webhookId(m) : null,
    receipt_counts_targets: c.targets, receipt_counts_queued: c.queued, receipt_counts_held: c.held,
    receipt_counts_delivered: c.delivered, receipt_counts_read: c.read, receipt_counts_acked: c.acked,
    receipt_counts_filtered: c.filtered, receipt_counts_never_delivered: c.never_delivered,
    delete_at: T(del),
  }
}))
table('message_tags', db.messages.flatMap((m) => m.tags.map((tag) => ({
  message_id: m.id, org_id: orgOf(m.wsId), workspace_id: id(m.wsId), tag, created_at: T(m.createdAt),
}))))

// Which rule filtered or held a receipt, from the mock's reason text.
const filterRule = (text) =>
  /blocks this agent|workspace blocklist/i.test(text) ? 'workspace agent blocklist'
  : /on its own side/i.test(text) ? 'agent workspace blocklist'
  : 'filter'
table('receipts', db.messages.flatMap((m) => Object.entries(m.receipts).map(([agentId, r]) => {
  const state = receiptState(r, m)
  return {
    id: `${m.id}:${id(agentId)}`, org_id: orgOf(m.wsId), workspace_id: id(m.wsId), message_id: m.id, agent_id: id(agentId), state,
    delivered_at: T(r.deliveredAt ?? null), read_at: T(r.readAt ?? null), ack_at: T(r.ackAt ?? null),
    delivered_via_transport: r.deliveredAt ? 'mcp' : null,
    held_rule: r.held ? 'agent suspended' : null, held_cause: r.held ? r.heldCause : null, held_at: T(r.held ? r.heldAt ?? m.createdAt : null),
    filtered_rule: r.filtered ? filterRule(r.filtered) : null, filtered_cause: r.filtered ? r.filteredCause ?? r.filtered : null,
    filtered_at: T(r.filtered ? r.filteredAt ?? m.createdAt : null), filtered_after_send: r.filtered ? Boolean(r.filteredAt) : null,
    removed_at: T(r.removed?.at ?? null), removed_reason: r.removed?.reason ?? null, removed_final: r.removed?.final ?? null, removed_cause: r.removed?.cause ?? null,
    created_at: T(m.createdAt), updated_at: T(Math.max(m.createdAt, r.ackAt ?? r.readAt ?? r.deliveredAt ?? r.heldAt ?? r.filteredAt ?? m.createdAt)),
    delete_at: T(m.createdAt + retentionMs(m.wsId)),
  }
})))

const roots = db.messages.filter((m) => db.messages.some((r) => r.parentId && rootOf(r).id === m.id))
table('threads', roots.map((root) => {
  const replies = db.messages.filter((r) => r.parentId && rootOf(r).id === root.id)
  const participants = []
  for (const a of [root.author, ...replies.map((r) => r.author)]) {
    const ref = authorRef(a)
    if (!participants.some((p) => p.kind === ref.kind && p.id === ref.id)) participants.push(ref)
  }
  const last = Math.max(...replies.map((r) => r.createdAt))
  return {
    id: root.id, org_id: orgOf(root.wsId), workspace_id: id(root.wsId), reply_count: replies.length,
    last_reply_at: T(last), participants, updated_at: T(last), delete_at: T(root.createdAt + retentionMs(root.wsId)),
  }
}))

const tagRows = new Map()
for (const m of db.messages) {
  for (const tag of m.tags) {
    const key = `${id(m.wsId)}:${tag}`
    const t = tagRows.get(key) ?? { id: key, org_id: orgOf(m.wsId), workspace_id: id(m.wsId), tag, message_count: 0, last_used_at: -Infinity }
    t.message_count++
    t.last_used_at = Math.max(t.last_used_at, m.createdAt)
    tagRows.set(key, t)
  }
}
table('tags', [...tagRows.values()].map((t) => ({ ...t, last_used_at: T(t.last_used_at) })))

// --- webhooks --------------------------------------------------------------------
const fireState = { delivered: 'delivered', 'gave-up': 'gave_up', 'no-targets': 'no_targets', expired: 'expired', 'target-lost': 'target_lost' }
const sealed = []
table('webhooks', db.messages.filter((m) => m.webhook).map((m) => {
  const h = m.webhook
  const base = {
    id: webhookId(m), org_id: orgOf(m.wsId), workspace_id: id(m.wsId), message_id: m.id, mode: h.mode,
    created_at: T(m.createdAt), ...flatActor('created_by', m.author.kind === 'agent' ? { kind: 'agent', id: id(m.author.id), label: agents.get(m.author.id).label } : { kind: 'user', id: m.author.id, label: humans.get(m.author.id).name }),
    updated_at: T(h.outcomeAt ?? h.calls?.at(-1)?.at ?? m.createdAt), expires_at: T(m.expiresAt),
    delete_at: T(m.createdAt + retentionMs(m.wsId)),
  }
  if (h.mode === 'fire') {
    const secId = `sec_${webhookId(m)}`
    if (h.authSet) {
      sealed.push({
        id: secId, org_id: orgOf(m.wsId), purpose: 'webhook_basic_auth', owner_kind: 'webhook', owner_id: webhookId(m),
        // A placeholder envelope: it decrypts nothing. Seeded webhooks
        // that need a password must have it set again.
        envelope: { alg: 'AES-256-GCM', nonce: 'AAAAAAAAAAAAAAAA', ciphertext: 'AAAAAAAAAAAAAAAAAAAAAA==', aad: `${orgOf(m.wsId)}|${secId}|${webhookId(m)}`, dek: { wrapped: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', kmsKeyRef: 'transit:dispatch/demo-seed' } },
        created_at: T(m.createdAt), ...flatActor('created_by', { kind: 'system', id: null, label: 'demo seed' }),
        destroy_at: T((m.expiresAt ?? m.createdAt + retentionMs(m.wsId)) + 7 * DAY),
      })
    }
    return {
      ...base,
      fire_url: h.url, fire_trigger: h.trigger, fire_auth_user: h.authUser || null,
      fire_auth_password: h.authSet ? { kind: 'sealed', uri: `dss://${secId}`, kmsKeyRef: 'transit:dispatch/demo-seed', version: 1, setAt: T(m.createdAt), setBy: { kind: 'system', id: 'demo-seed' } } : null,
      fire_delivery_mode: 'push',
      fire_state: h.outcome ? fireState[h.outcome] : h.attempts.length ? 'retrying' : 'waiting',
      fire_fired_at: T(h.firedAt ?? null), fire_next_attempt_at: T(h.nextAttemptAt ?? null),
      fire_attempt_count: h.attempts.length,
      fire_attempts: h.attempts.map((a) => ({ id: a.id, at: T(a.at), status: a.status, ms: a.ms, trk: a.trk, ...(a.note ? { note: a.note } : {}) })),
      fire_outcome_at: T(h.outcomeAt ?? null),
      fire_dropped: h.dropped ? h.dropped.map((d) => ({ agentId: id(d.agentId), cause: d.cause, reason: d.reason, at: T(d.at) })) : null,
    }
  }
  const listenerId = h.url.split('/').pop()
  return {
    ...base,
    listen_listener_id: listenerId, listen_url: h.url, listen_user: h.authUser,
    ...digest('listen_password', 'dsp_hook_', listenerId, h.passwordLast4, m.createdAt),
    listen_state: isExpired(m) ? 'closed' : 'open',
    listen_call_count: h.calls.length, listen_last_call_at: T(h.calls.at(-1)?.at ?? null),
  }
}))
table('listener_calls', db.messages.filter((m) => m.webhook?.mode === 'listen').flatMap((m) => m.webhook.calls.map((c) => ({
  id: c.id, org_id: orgOf(m.wsId), workspace_id: id(m.wsId), webhook_id: webhookId(m), listener_id: m.webhook.url.split('/').pop(),
  message_id: m.id, at: T(c.at), status: c.status, from_ip: c.from, bytes: c.bytes,
  appended_message_id: c.status === 202 ? db.messages.find((x) => x.parentId === m.id && x.trk === c.trk)?.id ?? null : null,
  trk: c.trk, summary: c.summary ?? null, delete_at: T(c.at + LISTENER_CALL_RETENTION),
}))))
table('sealed_secrets', sealed)

// --- context notes -----------------------------------------------------------------
table('context_notes', db.notes.map((n) => {
  const first = n.history[0]
  return {
    id: n.id, org_id: orgOf(n.wsId), workspace_id: id(n.wsId), title: n.title, body: n.body, tags: n.tags, version: n.version,
    created_at: T(first.at), ...flatActor('created_by', actorByLabel(first.by)),
    updated_at: T(n.updatedAt), ...flatActor('updated_by', actorByLabel(n.updatedBy)),
  }
}))
// The mock keeps only {version, by, at} for older versions, so each version
// carries the note's current title and body.
table('context_note_versions', db.notes.flatMap((n) => n.history.map((v) => ({
  id: `${n.id}@${v.version}`, org_id: orgOf(n.wsId), workspace_id: id(n.wsId), note_id: n.id, version: v.version,
  title: n.title, body: n.body, tags: n.tags, at: T(v.at), ...flatActor('by', actorByLabel(v.by)),
}))))

// --- audit ---------------------------------------------------------------------------
const actorKind = { human: 'user', agent: 'agent', webhook: 'listener', system: 'system' }
const pairs = (e) => Object.fromEntries(e.detail ?? [])
// The mock's detail is display pairs; the schema's is structured
// (dispatch/audit_detail.schema.json). The two seeded rows with pairs map
// by hand.
function detail(e) {
  if (!e.detail) return null
  const p = pairs(e)
  if (e.type === 'blocked') {
    return { kind: 'access', op: 'read', steps: [
      { rule: 'Agent token', pass: true },
      { rule: p.Rule ?? 'Workspace agent blocklist', pass: false, detail: e.reason },
      { rule: 'Workspace token', pass: true, detail: p.Token },
    ] }
  }
  if (e.type === 'webhook') {
    const m = db.messages.find((x) => x.webhook?.mode === 'listen' && x.webhook.url.endsWith(e.actorId))
    return { kind: 'webhook', webhookId: webhookId(m), auth: p.Auth, attempt: 1, status: Number(e.result.slice(0, 3)), fromIp: p.From }
  }
  return null
}
// Shared facts (a workspace membership or human workspace role) are shared
// rows; everything else is Dispatch's own.
const sharedEvents = new Set(['ev_8', 'ev_12'])
table('audit_events', db.events.map((e) => {
  const shared = sharedEvents.has(e.id)
  return {
    id: e.id, org_id: e.orgId, workspace_id: e.wsId ? id(e.wsId) : null, app: 'dispatch', shared,
    type: e.type, severity: e.severity, at: T(e.at),
    actor_kind: actorKind[e.actorKind], actor_id: e.actorId ? id(e.actorId) : null, actor_label: e.actor,
    actor_via_kind: e.viaHumanId ? 'api_console' : null, actor_via_id: e.viaHumanId ?? null,
    object: e.object, result: e.result, reason: e.reason ?? null, trk: e.trk,
    detail: shared ? null : detail(e),
    link_label: shared ? null : e.link?.label ?? null, link_to: shared ? null : e.link?.to ?? null,
    expire_at: T(e.at + AUDIT_RETENTION),
  }
}))

// One row per line; null columns are left out (they load as NULL).
const row = (r) => JSON.stringify(Object.fromEntries(Object.entries(r).filter(([, v]) => v !== null)))
const out = [
  '{',
  ' "$comment": "Generated by scripts/seed-from-mock.mjs from populatedDB() in mocks/v1/src/lib/seed.ts. Do not edit by hand. {\\"$t\\": ms} is an instant relative to when the seed runs.",',
  ' "tables": [',
  tables.map((t) => `  {"name": ${JSON.stringify(t.name)}, "rows": [\n${t.rows.map((r) => '   ' + row(r)).join(',\n')}\n  ]}`).join(',\n'),
  ' ]',
  '}',
]
process.stdout.write(out.join('\n') + '\n')
