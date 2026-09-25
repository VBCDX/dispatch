import { evaluate, visibleToAgent } from './access'
import type { Endpoint, PathParam } from './api'
import { actions, agentById, fireState, getDB, defaultAdmins, explicitHumanAdmins, humanById, isActive, isExpired, mayExpire, mayRotateListener, receiptState, sessionSecret, wsById, type Actor } from './store'
import type { Agent, Audience, DB, FireTrigger, Message, Workspace } from './types'

/*
 * The API console's "server". Requests are sent as an agent: they present
 * that agent's real tokens, walk the same access ladder as any agent call,
 * and every call is audited with the human who sent it from the console.
 */

export type ConsoleRequest = {
  ep: Endpoint
  agentId: string
  wsId: string
  agentToken: string
  wsToken: string
  params: Partial<Record<PathParam, string>>
  body: string
  humanId: string
}
export type ConsoleResponse = { status: number; body: unknown }

type Fail = { status: number; error: string; message: string; rule?: string; field?: string }
const fail = (status: number, error: string, message: string, extra: Partial<Fail> = {}): Fail => ({ status, error, message, ...extra })
const iso = (t: number | null | undefined) => (t ? new Date(t).toISOString() : null)

/** Checks a presented token against the ones this tab knows (current, or previous within its grace window). */
function tokenProblem(presented: string, current: string | null, previous: string | null, prevUntil: number | undefined, last4: string, what: string): string | null {
  const t = presented.trim()
  if (!t) return `Missing ${what}.`
  if (current && t === current) return null
  if (previous && t === previous && prevUntil && prevUntil > Date.now()) return null
  if (!current && t.endsWith(last4)) return `This prototype can only verify ${what === 'agent token' ? 'an' : 'a'} ${what} issued in this browser tab. Rotate it to get one it can check.`
  return `The ${what} doesn't match.`
}
export const agentTokenOk = (a: Agent, tok: string) => !tokenProblem(tok, sessionSecret(`agent:${a.id}`), sessionSecret(`agent-prev:${a.id}`), a.prevTokenUntil, a.tokenLast4, 'agent token')

export function messageJson(d: DB, m: Message, forAgent?: string) {
  const w = m.webhook
  return {
    id: m.id,
    workspace_id: m.wsId,
    author: m.author,
    body: m.body,
    payload: m.payload ? safeJson(m.payload) : null,
    tags: m.tags,
    audience: m.audience.mode === 'all' ? { mode: 'all' } : { mode: m.audience.mode, agent_ids: m.audience.agentIds },
    ...(m.parentId ? { parent_id: m.parentId } : {}),
    created_at: iso(m.createdAt),
    expires_at: iso(m.expiresAt),
    tracking_code: m.trk,
    ...(m.sentVia ? { sent_via: 'api-console' } : {}),
    receipts: Object.fromEntries(
      Object.entries(m.receipts).map(([id, r]) => {
        const s = receiptState(r, m)
        return [id, { state: s === 'expired' ? 'never_delivered' : s, delivered_at: iso(r.deliveredAt), read_at: iso(r.readAt), ack_at: iso(r.ackAt), ...(r.filtered ? { rule: r.filtered } : r.held ? { rule: r.held } : {}), ...(r.removed ? { access_removed_at: iso(r.removed.at), access_removed_reason: r.removed.reason } : {}) }]
      }),
    ),
    ...(w ? { webhook: w.mode === 'fire' ? { mode: 'fire', url: w.url, trigger: w.trigger, state: fireState(m)?.k, attempts: w.attempts.length } : { mode: 'listen', url: w.url, user: w.authUser, open: !isExpired(m), calls: w.calls.length } } : {}),
    ...(forAgent ? { thread: d.messages.filter((x) => x.parentId === m.id && visibleToAgent(x, forAgent)).map((x) => ({ id: x.id, author: x.author, body: x.body, created_at: iso(x.createdAt) })) } : {}),
  }
}
function safeJson(s: string) {
  try {
    return JSON.parse(s)
  } catch {
    return s
  }
}

/** Strict durations: 30m, 6h, 7d, or "never". Anything else is 422 — never a silent default. */
export function parseExpiresIn(v: unknown, w: Workspace): { hours: number | null } | Fail {
  if (v === undefined) return { hours: w.defaultExpiryHours }
  if (v === null || v === 'never') return { hours: null }
  const m = typeof v === 'string' ? /^([1-9]\d*)(m|h|d)$/.exec(v.trim()) : null
  if (!m) return fail(422, 'invalid_expires_in', `expires_in must look like 30m, 6h or 7d (or "never"); got ${JSON.stringify(v)}.`, { field: 'expires_in' })
  const n = Number(m[1])
  return { hours: m[2] === 'm' ? n / 60 : m[2] === 'h' ? n : n * 24 }
}

function parseBody(text: string): Record<string, unknown> | Fail {
  if (!text.trim()) return {}
  try {
    const v = JSON.parse(text)
    if (!v || typeof v !== 'object' || Array.isArray(v)) return fail(400, 'invalid_json', 'The body must be a JSON object.')
    return v
  } catch (e) {
    return fail(400, 'invalid_json', (e as Error).message)
  }
}
const isFail = (x: unknown): x is Fail => !!x && typeof x === 'object' && 'error' in x && 'status' in x

function parseAudience(v: unknown, w: Workspace): Audience | Fail {
  if (v === undefined) return { mode: 'all' }
  const a = v as { mode?: string; agent_ids?: unknown }
  if (!a || typeof a !== 'object' || !['all', 'only', 'except'].includes(a.mode ?? '')) return fail(422, 'invalid_audience', 'audience.mode must be "all", "only" or "except".', { field: 'audience.mode' })
  if (a.mode === 'all') return { mode: 'all' }
  const ids = a.agent_ids
  if (!Array.isArray(ids) || !ids.length || !ids.every((x) => typeof x === 'string')) return fail(422, 'invalid_audience', `audience.agent_ids must list at least one agent for "${a.mode}".`, { field: 'audience.agent_ids' })
  const unknown = ids.filter((id) => !w.members.some((m) => m.kind === 'agent' && m.id === id))
  if (unknown.length) return fail(422, 'unknown_agent_ids', `Not agents in ${w.name}: ${unknown.join(', ')}.`, { field: 'audience.agent_ids' })
  return { mode: a.mode as 'only' | 'except', agentIds: ids as string[] }
}

export function runConsole(req: ConsoleRequest): ConsoleResponse {
  const { ep, agentId, humanId } = req
  const d0 = getDB()
  const a = agentById(d0, agentId)
  const wsId = req.wsId
  const needsWs = ep.auth !== 'agent'
  const path = ep.path
    .replace('{workspace_id}', wsId)
    .replace('{message_id}', req.params.message_id ?? '{message_id}')
    .replace('{principal_id}', req.params.principal_id ?? '{principal_id}')
    .replace('{note_id}', req.params.note_id ?? '{note_id}')
  const line = `${ep.method} ${path}`
  const by: Actor = { kind: 'agent', id: agentId, viaHumanId: humanId }
  const audit = (status: number, allowed: boolean, reason?: string | null, rule?: string) => actions.logApiCall({ agentId, wsId: needsWs ? wsId : undefined, line, allowed, reason, rule, status, viaHumanId: humanId })
  const refuse = (f: Fail): ConsoleResponse => {
    audit(f.status, !(f.status === 401 || f.status === 403), f.message, f.rule)
    const { status, ...body } = f
    return { status, body }
  }

  // Only an active person can send from the console (suspended people can't act anywhere in the UI).
  const sender = humanById(d0, humanId)
  if (!isActive(sender, d0.currentOrgId)) return { status: 403, body: { error: 'console_user_inactive', message: 'Your account isn’t active, so the console won’t send requests for you.' } }

  // Rule 1: agent ID + agent token, and an active agent. The console only acts inside the org on screen.
  if (!a || a.orgId !== d0.currentOrgId) return refuse(fail(401, 'unauthorized', 'Unknown agent ID.', { rule: 'Agent ID + agent token' }))
  const tokErr = tokenProblem(req.agentToken, sessionSecret(`agent:${a.id}`), sessionSecret(`agent-prev:${a.id}`), a.prevTokenUntil, a.tokenLast4, 'agent token')
  if (tokErr) return refuse(fail(401, 'unauthorized', tokErr, { rule: 'Agent ID + agent token' }))
  if (a.status !== 'active') return refuse(fail(401, 'agent_inactive', `${a.label} is ${a.status}.`, { rule: 'Agent ID + agent token' }))

  const parsed = ep.request ? parseBody(req.body) : {}
  if (isFail(parsed)) return refuse(parsed)
  const body = parsed as Record<string, unknown>
  const ok = (status: number, out: unknown, note?: string): ConsoleResponse => {
    audit(status, true, note)
    return { status, body: out }
  }

  /* ---------------- Agent-only flows ---------------- */
  if (!needsWs) {
    if (ep.id === 'me') return ok(200, { id: a.id, label: a.label, client: a.client ?? null, status: a.status, filters: filtersJson(a) })
    if (ep.id === 'my-workspaces') {
      const d = getDB()
      const list = d.workspaces.filter((x) => x.orgId === a.orgId && x.members.some((m) => m.kind === 'agent' && m.id === a.id))
      return ok(200, { workspaces: list.map((x) => { const r = evaluate(d, a.id, x.id, 'read'); const m = x.members.find((mm) => mm.id === a.id)!; return { id: x.id, name: x.name, role: m.role, read: r.allowed, write: evaluate(d, a.id, x.id, 'write').allowed, blocked: r.allowed ? null : r.reason } }) })
    }
    if (ep.id === 'filters') {
      const f = { ...a.filters }
      for (const [k, key] of [['read', 'read'], ['write', 'write']] as const) {
        if (body[k] === undefined) continue
        if (typeof body[k] !== 'boolean') return refuse(fail(422, 'invalid_field', `${k} must be true or false.`, { field: k }))
        f[key] = body[k] as boolean
      }
      for (const [k, key, kind] of [['workspace_blocklist', 'workspaceBlocklist', 'wks'], ['agent_blocklist', 'agentBlocklist', 'agt']] as const) {
        if (body[k] === undefined) continue
        const v = body[k]
        if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) return refuse(fail(422, 'invalid_field', `${k} must be a list of IDs.`, { field: k }))
        const d = getDB()
        const unknown = (v as string[]).filter((id) => (kind === 'wks' ? !d.workspaces.some((w) => w.id === id && w.orgId === a.orgId) : !d.agents.some((x) => x.id === id && x.orgId === a.orgId)))
        if (unknown.length) return refuse(fail(422, 'unknown_ids', `Unknown IDs in ${k}: ${unknown.join(', ')}.`, { field: k }))
        f[key] = v as string[]
      }
      actions.setAgentFilters(a.id, f, by)
      return ok(200, filtersJson(agentById(getDB(), a.id)!))
    }
    if (ep.id === 'heartbeat') {
      const before = getDB()
      const wasOnline = agentById(before, a.id)!.connected
      actions.connectAgent(a.id, true, { name: 'REST', via: 'REST' })
      const d = getDB()
      const filtered = d.messages.filter((m) => m.receipts[a.id]?.filteredAt && m.receipts[a.id].filteredAt! >= Date.now() - 1000).length
      return ok(200, { online: true, was_online: wasOnline, queued_now: d.messages.filter((m) => m.receipts[a.id] && !m.receipts[a.id].filtered && !m.receipts[a.id].deliveredAt && !isExpired(m)).length, filtered_now: filtered })
    }
    if (ep.id === 'rotate') {
      const t = actions.rotateAgentToken(a.id, by)
      const after = agentById(getDB(), a.id)!
      return ok(200, { token: t, old_token_valid_until: iso(after.prevTokenUntil), note: 'Shown once. The console’s agent token field now needs this value.' })
    }
    return refuse(fail(404, 'not_found', 'No such endpoint.'))
  }

  /* ---------------- Workspace flows: the ladder, with the membership token at rule 4 ---------------- */
  const w = wsById(getDB(), wsId)
  if (!w || w.orgId !== a.orgId) return refuse(fail(403, 'forbidden', 'Unknown workspace ID.', { rule: 'Workspace ID + membership token' }))
  const op = ep.op ?? 'read'
  const res = evaluate(getDB(), a.id, wsId, op)
  for (let i = 1; i < res.steps.length; i++) {
    const s = res.steps[i]
    if (i === 3 && s.pass) {
      const m = w.members.find((x) => x.kind === 'agent' && x.id === a.id)!
      const wsErr = tokenProblem(req.wsToken, sessionSecret(`ws:${wsId}:${a.id}`), sessionSecret(`ws-prev:${wsId}:${a.id}`), m.prevTokenUntil, m.tokenLast4 ?? '', 'workspace token')
      if (wsErr) return refuse(fail(401, 'unauthorized', wsErr, { rule: s.rule }))
    }
    if (!s.pass) return refuse(fail(i === 3 && s.detail.includes('revoked') ? 401 : 403, 'forbidden', s.detail, { rule: s.rule }))
  }

  const d = getDB()
  const msgParam = req.params.message_id
  // Agents only see what the inbox shows them; anything else is indistinguishable from a missing message.
  const visibleMsg = () => {
    const m = d.messages.find((x) => x.id === msgParam && x.wsId === wsId)
    return m && visibleToAgent(m, a.id) ? m : null
  }
  // Admin actions on a message (expire, retry, listener password): an agent admin can act on any message in its
  // workspace, like a human admin. Non-admins still only reach what's addressed to them — anything else is 404.
  const adminAgent = evaluate(d, a.id, wsId, 'admin').allowed
  const actionableMsg = () => {
    const m = d.messages.find((x) => x.id === msgParam && x.wsId === wsId)
    return m && (adminAgent || visibleToAgent(m, a.id)) ? m : null
  }

  const notFound = () => refuse(fail(404, 'not_found', `No message ${msgParam} for ${a.label} in ${w.name}.`))

  switch (ep.id) {
    case 'list': {
      const r = actions.deliverInbox(a.id, wsId)
      const d2 = getDB()
      const mine = d2.messages.filter((m) => m.wsId === wsId && m.receipts[a.id] && !m.receipts[a.id].filtered).sort((x, y) => y.createdAt - x.createdAt)
      return ok(200, { messages: mine.slice(0, 10).map((m) => messageJson(d2, m)), delivered_now: r.delivered, filtered_now: r.filtered, next_cursor: mine.length > 10 ? 'cur_10' : null }, `${r.delivered} delivered${r.filtered ? ` · ${r.filtered} filtered` : ''}`)
    }
    case 'send': {
      if (typeof body.body !== 'string' || !body.body.trim()) return refuse(fail(422, 'body_required', 'body must be a non-empty string.', { field: 'body' }))
      if (body.tags !== undefined && (!Array.isArray(body.tags) || !body.tags.every((t) => typeof t === 'string'))) return refuse(fail(422, 'invalid_tags', 'tags must be a list of strings.', { field: 'tags' }))
      const aud = parseAudience(body.audience, w)
      if (isFail(aud)) return refuse(aud)
      const exp = parseExpiresIn(body.expires_in, w)
      if (isFail(exp)) return refuse(exp)
      let parentId: string | undefined
      if (body.parent_id !== undefined) {
        const p = d.messages.find((x) => x.id === body.parent_id && x.wsId === wsId)
        if (!p || !visibleToAgent(p, a.id)) return refuse(fail(404, 'not_found', `No message ${String(body.parent_id)} for ${a.label} in ${w.name}.`, { field: 'parent_id' }))
        parentId = p.id
      }
      let webhook: Parameters<typeof actions.postMessage>[0]['webhook']
      if (body.webhook !== undefined) {
        const h = body.webhook as { mode?: string; url?: unknown; trigger?: unknown; auth?: { user?: unknown; password?: unknown } }
        const user = typeof h?.auth?.user === 'string' ? h.auth.user.trim() : ''
        if (h?.mode === 'fire') {
          if (typeof h.url !== 'string' || !/^https:\/\/\S+\.\S+/.test(h.url)) return refuse(fail(422, 'invalid_webhook', 'webhook.url must be an https:// URL.', { field: 'webhook.url' }))
          const trigger = (h.trigger ?? 'send') as FireTrigger
          if (!['send', 'all-read', 'all-ack'].includes(trigger)) return refuse(fail(422, 'invalid_webhook', 'webhook.trigger must be send, all-read or all-ack.', { field: 'webhook.trigger' }))
          if (h.auth && (!user || typeof h.auth.password !== 'string')) return refuse(fail(422, 'invalid_webhook', 'webhook.auth needs both user and password.', { field: 'webhook.auth' }))
          webhook = { mode: 'fire', url: h.url, trigger, authUser: user, authSet: !!h.auth }
        } else if (h?.mode === 'listen') {
          if (!user) return refuse(fail(422, 'invalid_webhook', 'A listener needs webhook.auth.user.', { field: 'webhook.auth.user' }))
          if (exp.hours == null) return refuse(fail(422, 'invalid_webhook', 'A listener needs an expiry — set expires_in.', { field: 'expires_in' }))
          webhook = { mode: 'listen', authUser: user }
        } else return refuse(fail(422, 'invalid_webhook', 'webhook.mode must be "fire" or "listen".', { field: 'webhook.mode' }))
      }
      const r = actions.postMessage({ wsId, body: body.body.trim(), payload: body.payload === undefined ? undefined : JSON.stringify(body.payload, null, 2), tags: ((body.tags as string[] | undefined) ?? []).map((t) => t.trim().replace(/^#/, '').toLowerCase()).filter(Boolean), audience: aud, expiresInHours: exp.hours, parentId, webhook }, by)
      const d2 = getDB()
      const m = d2.messages.find((x) => x.id === r.id)
      if (!m) return refuse(fail(403, 'forbidden', 'Refused while sending.'))
      const reachable = Object.values(m.receipts).filter((x) => !x.filtered).length
      const out = { ...messageJson(d2, m), ...(r.hookPassword ? { webhook: { mode: 'listen', url: r.listenUrl, user: webhook?.authUser, password: r.hookPassword, note: 'Shown once.' } } : {}), ...(reachable ? {} : { warnings: ['no_reachable_agents'] }) }
      if (m.webhook?.mode === 'fire' && m.webhook.outcome === 'no-targets') Object.assign(out, { warnings: ['no_reachable_agents', 'webhook_will_not_fire'] })
      return ok(201, out)
    }
    case 'get': {
      const m = visibleMsg()
      return m ? ok(200, messageJson(d, m, a.id)) : notFound()
    }
    case 'expire': {
      const m = actionableMsg()
      if (!m) return notFound()
      if (isExpired(m)) return refuse(fail(409, 'already_expired', `${m.id} already expired.`))
      if (!mayExpire(d, m, by)) return refuse(fail(403, 'forbidden', 'Only workspace admins can expire a message — authorship and write access grant nothing here.', { rule: 'Membership allows admin' }))
      const pending = Object.values(m.receipts).filter((r) => !r.filtered && !r.deliveredAt).length
      actions.expireNow(m.id, by)
      return ok(200, { id: m.id, expires_at: iso(getDB().messages.find((x) => x.id === m.id)?.expiresAt), never_delivered: pending })
    }
    case 'read':
    case 'ack': {
      const m = visibleMsg()
      if (!m) return notFound()
      const r = m.receipts[a.id]
      if (!r) return refuse(fail(409, 'not_a_target', `${a.label} wrote ${m.id}; there is no receipt to mark.`))
      if (isExpired(m)) return refuse(fail(409, 'expired', `${m.id} expired.`))
      actions.agentReceipt(m.id, a.id, ep.id)
      const after = getDB().messages.find((x) => x.id === m.id)!
      const r2 = after.receipts[a.id]
      const refusal = r2.filtered ?? r2.held ?? r2.removed?.reason
      if (refusal || (ep.id === 'ack' ? !r2.ackAt : !r2.readAt)) return refuse(fail(403, 'forbidden', refusal ?? 'Refused.', { rule: 'Re-checked at the moment of the action' }))
      return ok(200, { message_id: m.id, state: ep.id === 'ack' ? 'acked' : 'read', webhook: after.webhook?.mode === 'fire' ? fireState(after)?.k : undefined })
    }
    case 'receipts': {
      const m = visibleMsg()
      if (!m) return notFound()
      const e = Object.entries(m.receipts)
      const pick = (f: (r: Message['receipts'][string]) => unknown) => e.filter(([, r]) => !r.filtered && f(r)).map(([id]) => id)
      return ok(200, { held: e.filter(([, r]) => r.held).map(([id, r]) => ({ agent_id: id, rule: r.held })), delivered: pick((r) => r.deliveredAt), read: pick((r) => r.readAt), acknowledged: pick((r) => r.ackAt), never_delivered: isExpired(m) ? pick((r) => !r.deliveredAt) : [], filtered: e.filter(([, r]) => r.filtered).map(([id, r]) => ({ agent_id: id, rule: r.filtered })) })
    }
    case 'retry': {
      const m = actionableMsg()
      if (!m) return notFound()
      const s = fireState(m)
      if (!s) return refuse(fail(409, 'no_fire_webhook', `${m.id} has no fire webhook.`))
      if (s.k !== 'retrying' && s.k !== 'gave-up') return refuse(fail(409, 'nothing_to_retry', `The webhook is ${s.k.replace('-', ' ')} — nothing to retry.`))
      actions.retryWebhook(m.id, by)
      const h = getDB().messages.find((x) => x.id === m.id)!.webhook
      const last = h?.mode === 'fire' ? h.attempts[h.attempts.length - 1] : undefined
      return ok(200, { attempt: h?.mode === 'fire' ? h.attempts.length : 0, status: last?.status, ms: last?.ms, tracking_code: last?.trk, state: fireState(getDB().messages.find((x) => x.id === m.id)!)?.k })
    }
    case 'listener-password': {
      const m = actionableMsg()
      if (!m) return notFound()
      if (m.webhook?.mode !== 'listen') return refuse(fail(409, 'no_listener', `${m.id} has no listener.`))
      if (isExpired(m)) return refuse(fail(409, 'expired', `${m.id} expired; its listener is closed.`))
      if (!mayRotateListener(d, m, by)) return refuse(fail(403, 'forbidden', 'Rotating a listener password is reserved for workspace admins.', { rule: 'Membership allows admin' }))
      const pw = actions.rotateListenerPassword(m.id, by)
      return ok(200, { url: m.webhook.url, user: m.webhook.authUser, password: pw, note: 'Shown once. The old password stops working now.' })
    }
    case 'search': {
      const q = typeof body.q === 'string' ? body.q.trim().toLowerCase() : ''
      const tag = typeof body.tag === 'string' ? body.tag : ''
      const hits = d.messages
        .filter((m) => m.wsId === wsId && visibleToAgent(m, a.id) && (!tag || m.tags.includes(tag)) && (!q || [m.body, m.payload ?? '', m.id, m.trk, ...m.tags].some((x) => x.toLowerCase().includes(q))))
        .sort((x, y) => y.createdAt - x.createdAt)
      const notes = d.notes.filter((n) => n.wsId === wsId && (!tag || n.tags.includes(tag)) && (!q || [n.title, n.body, ...n.tags].some((x) => x.toLowerCase().includes(q))))
      return ok(200, { q, results: [...hits.slice(0, 8).map((m) => ({ kind: 'message', id: m.id, snippet: m.body.slice(0, 90) })), ...notes.slice(0, 4).map((n) => ({ kind: 'context', id: n.id, title: n.title, version: n.version }))], note: 'Messages addressed to this agent (or written by it), and shared context — the same rule as the inbox.' })
    }
    case 'context':
      return ok(200, { notes: d.notes.filter((n) => n.wsId === wsId).map((n) => ({ id: n.id, title: n.title, tags: n.tags, version: n.version, updated_by: n.updatedBy, updated_at: iso(n.updatedAt) })) })
    case 'context-put': {
      const nid = req.params.note_id
      const existing = d.notes.find((n) => n.id === nid && n.wsId === wsId)
      if (nid !== 'new' && !existing) return refuse(fail(404, 'not_found', `No note ${nid} in ${w.name}. Use "new" to create one.`))
      if (typeof body.title !== 'string' || !body.title.trim()) return refuse(fail(422, 'title_required', 'title must be a non-empty string.', { field: 'title' }))
      if (typeof body.body !== 'string' || !body.body.trim()) return refuse(fail(422, 'body_required', 'body must be a non-empty string.', { field: 'body' }))
      const before = new Set(d.notes.map((n) => n.id))
      actions.saveNote({ id: existing?.id, wsId, title: body.title.trim(), body: body.body, tags: Array.isArray(body.tags) ? (body.tags as string[]) : (existing?.tags ?? []) }, by)
      const after = getDB().notes.find((n) => (existing ? n.id === existing.id : n.wsId === wsId && !before.has(n.id)))
      return ok(existing ? 200 : 201, { id: after?.id, version: after?.version })
    }
    case 'members':
      return ok(200, { members: w.members.map((m) => ({ kind: m.kind, id: m.id, label: m.kind === 'agent' ? agentById(d, m.id)?.label : humanById(d, m.id)?.name, role: m.role, read: m.read, write: m.write, ...(m.tokenLast4 ? { token_last4: m.tokenLast4 } : {}) })), default_admins: defaultAdmins(d, w).map((h) => ({ id: h.id, name: h.name, org_role: h.roles[w.orgId] })) })
    case 'add-member': {
      const kind = body.kind
      const pid = body.id
      if (kind !== 'agent' && kind !== 'human') return refuse(fail(422, 'invalid_kind', 'kind must be "agent" or "human".', { field: 'kind' }))
      if (typeof pid !== 'string') return refuse(fail(422, 'id_required', 'id is required.', { field: 'id' }))
      const exists = kind === 'agent' ? d.agents.some((x) => x.id === pid && x.orgId === w.orgId && x.status !== 'revoked') : d.humans.some((h) => h.id === pid && h.roles[w.orgId])
      if (!exists) return refuse(fail(422, 'unknown_principal', `No ${kind} ${pid} in this org${kind === 'agent' ? ' (or it is revoked)' : ''}.`, { field: 'id' }))
      if (w.members.some((m) => m.kind === kind && m.id === pid)) return refuse(fail(409, 'already_member', `${pid} is already a member.`))
      const role = body.role === 'admin' ? 'admin' : 'member'
      const t = actions.addMember(wsId, { kind, id: pid }, role, body.read !== false, body.write !== false, by)
      return ok(201, { kind, id: pid, role, ...(t ? { workspace_token: t, note: 'Shown once.' } : {}) })
    }
    case 'set-member':
    case 'remove-member':
    case 'rotate-member-token': {
      const pid = req.params.principal_id
      const m = w.members.find((x) => x.id === pid)
      if (!m) return refuse(fail(404, 'not_found', `${pid} is not a member of ${w.name}.`))
      const p = { kind: m.kind, id: m.id }
      if (ep.id === 'rotate-member-token') {
        if (m.kind !== 'agent') return refuse(fail(409, 'not_an_agent', 'Humans sign in with SSO; they have no workspace token.'))
        const t = actions.rotateMemberToken(wsId, m.id, by)
        const after = wsById(getDB(), wsId)?.members.find((x) => x.id === m.id)
        return ok(200, { workspace_token: t, old_token_valid_until: iso(after?.prevTokenUntil), note: 'Shown once.' })
      }
      // Demoting or removing the last explicit human admin is allowed — the org's Owners and userAdmins become the
      // workspace's default admins, so it never ends up administered by agents alone.
      const hadExplicit = explicitHumanAdmins(d, w).length > 0
      const fallback = () => {
        const w2 = wsById(getDB(), wsId)!
        return hadExplicit && !explicitHumanAdmins(getDB(), w2).length ? { default_admins: defaultAdmins(getDB(), w2).map((h) => ({ id: h.id, name: h.name, org_role: h.roles[w2.orgId] })) } : {}
      }
      if (ep.id === 'remove-member') {
        // Counts come from the re-check itself: only queued receipts are filtered; delivered ones keep their state.
        const c = actions.removeMember(wsId, p, by)
        return ok(200, { removed: true, filtered_receipts: c?.filtered ?? 0, delivered_kept: c?.removed ?? 0, ...fallback() })
      }
      const patch: { role?: 'admin' | 'member'; read?: boolean; write?: boolean } = {}
      if (body.role !== undefined) {
        if (body.role !== 'admin' && body.role !== 'member') return refuse(fail(422, 'invalid_role', 'role must be "admin" or "member".', { field: 'role' }))
        patch.role = body.role
      }
      for (const k of ['read', 'write'] as const) {
        if (body[k] === undefined) continue
        if (typeof body[k] !== 'boolean') return refuse(fail(422, 'invalid_field', `${k} must be true or false.`, { field: k }))
        patch[k] = body[k] as boolean
      }
      if (!Object.keys(patch).length) return refuse(fail(422, 'empty_patch', 'Send at least one of role, read, write.'))
      if (m.kind === 'human' && patch.read === false) return refuse(fail(422, 'humans_always_read', 'Humans in a workspace always read every message.', { field: 'read' }))
      actions.setMember(wsId, p, patch, by)
      const w2 = wsById(getDB(), wsId)!
      const m2 = w2.members.find((x) => x.id === pid)!
      return ok(200, { kind: m2.kind, id: m2.id, role: m2.role, read: m2.read, write: m2.write, ...fallback() })
    }
    case 'blocklist': {
      const ids = body.agent_ids
      if (!Array.isArray(ids) || !ids.every((x) => typeof x === 'string')) return refuse(fail(422, 'invalid_field', 'agent_ids must be a list of agent IDs.', { field: 'agent_ids' }))
      const unknown = (ids as string[]).filter((id) => !d.agents.some((x) => x.id === id && x.orgId === w.orgId))
      if (unknown.length) return refuse(fail(422, 'unknown_agent_ids', `Unknown agent IDs: ${unknown.join(', ')}.`, { field: 'agent_ids' }))
      const before = d.messages.reduce((n, m) => n + Object.values(m.receipts).filter((r) => r.filtered).length, 0)
      actions.setWsBlocklist(wsId, Array.from(new Set(ids as string[])), by)
      const after = getDB().messages.reduce((n, m) => n + Object.values(m.receipts).filter((r) => r.filtered).length, 0)
      return ok(200, { agent_ids: wsById(getDB(), wsId)?.agentBlocklist, filtered_receipts: after - before, ...(ids.includes(a.id) ? { warnings: ['you_blocked_yourself'] } : {}) })
    }
    case 'settings': {
      const patch: Partial<Pick<Workspace, 'name' | 'description' | 'defaultExpiryHours' | 'retentionDays'>> = {}
      if (body.name !== undefined) {
        if (typeof body.name !== 'string' || !body.name.trim()) return refuse(fail(422, 'invalid_field', 'name must be a non-empty string.', { field: 'name' }))
        if (d.workspaces.some((x) => x.id !== wsId && x.orgId === w.orgId && x.name.toLowerCase() === (body.name as string).trim().toLowerCase())) return refuse(fail(422, 'name_taken', 'Another workspace already has that name.', { field: 'name' }))
        patch.name = body.name.trim()
      }
      if (body.description !== undefined) {
        if (typeof body.description !== 'string') return refuse(fail(422, 'invalid_field', 'description must be a string.', { field: 'description' }))
        patch.description = body.description
      }
      if (body.default_expiry_hours !== undefined) {
        const v = body.default_expiry_hours
        if (v !== null && !(Number.isInteger(v) && (v as number) > 0)) return refuse(fail(422, 'invalid_field', 'default_expiry_hours must be a positive integer or null.', { field: 'default_expiry_hours' }))
        patch.defaultExpiryHours = v as number | null
      }
      if (body.retention_days !== undefined) {
        if (!(Number.isInteger(body.retention_days) && (body.retention_days as number) > 0)) return refuse(fail(422, 'invalid_field', 'retention_days must be a positive integer.', { field: 'retention_days' }))
        patch.retentionDays = body.retention_days as number
      }
      if (!Object.keys(patch).length) return refuse(fail(422, 'empty_patch', 'Send at least one of name, description, default_expiry_hours, retention_days.'))
      actions.updateWorkspace(wsId, patch, by)
      const w2 = wsById(getDB(), wsId)!
      return ok(200, { id: w2.id, name: w2.name, description: w2.description, default_expiry_hours: w2.defaultExpiryHours, retention_days: w2.retentionDays })
    }
    case 'audit': {
      const evs = getDB().events.filter((e) => e.wsId === wsId).slice(0, 20)
      return ok(200, { events: evs.map((e) => ({ at: iso(e.at), type: e.type, severity: e.severity, actor_kind: e.actorKind, actor_id: e.actorId ?? null, actor: e.actor, ...(e.viaHumanId ? { via_human_id: e.viaHumanId } : {}), object: e.object, result: e.result, ...(e.reason ? { reason: e.reason } : {}), tracking_code: e.trk })) })
    }
  }
  return refuse(fail(404, 'not_found', 'No such endpoint.'))
}

function filtersJson(a: Agent) {
  return { read: a.filters.read, write: a.filters.write, workspace_blocklist: a.filters.workspaceBlocklist, agent_blocklist: a.filters.agentBlocklist }
}
