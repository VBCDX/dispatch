import { useEffect, useState, useSyncExternalStore } from 'react'
import { accessVerdict, evaluate, targets } from './access'
import { HOUR, MIN, clock, newAgentToken, newHookPassword, newWsToken, shortId, trackingCode, uid } from './format'
import { freshDB, populatedDB } from './seed'
import type { PersonStatus, Agent, AgentFilters, Audience, AuditEvent, Author, ContextNote, DB, FireTrigger, AgentClient, Human, Membership, MemberRole, Message, OrgRole, Principal, Webhook, Workspace } from './types'

const LS_KEY = 'dispatch-mocks-v1'
const VERSION = 7

function load(): DB {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (raw) {
      const p = JSON.parse(raw)
      if (p.v === VERSION) return p.db as DB
    }
  } catch {
    /* storage unavailable */
  }
  return populatedDB()
}

let db: DB = load()
const listeners = new Set<() => void>()
function save() {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({ v: VERSION, db }))
  } catch {
    /* ignore */
  }
}
export const getDB = () => db
export function update(recipe: (d: DB) => void) {
  const draft = structuredClone(db)
  recipe(draft)
  db = draft
  save()
  listeners.forEach((l) => l())
}
const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => listeners.delete(l)
}
export const useDB = () => useSyncExternalStore(subscribe, getDB)

export function useNow(ms = 15_000) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms)
    // Any data change (an expiry, a receipt) also refreshes the clock, so derived states never lag behind it.
    const off = subscribe(() => setNow(Date.now()))
    return () => {
      clearInterval(t)
      off()
    }
  }, [ms])
  return now
}

/* Session-only secrets: full tokens are kept in memory for this tab so a config download can include them. */
const sessionSecrets = new Map<string, string>()
export const sessionSecret = (key: string) => sessionSecrets.get(key) ?? null

/* ------------------------------------------------------------------ */
/* Selectors                                                           */
/* ------------------------------------------------------------------ */
export const me = (d: DB) => d.humans.find((u) => u.id === d.currentUserId)!
export const myOrgRole = (d: DB): OrgRole | null => me(d)?.roles[d.currentOrgId] ?? null
/** Owners and userAdmins administer every workspace in the organization (a suspended person administers nothing). */
export const ORG_ADMIN_ROLES: OrgRole[] = ['Owner', 'userAdmin']
/** Only active people act. A suspended (or not yet accepted) account can look, but can't change anything. */
/** A person's status in one organization (null when they aren't in it). Suspension never crosses organizations. */
export const statusIn = (h: Human | undefined, orgId: string): PersonStatus | null => (h?.roles[orgId] ? (h.orgStatus?.[orgId] ?? 'active') : null)
export const isActive = (h: Human | undefined, orgId: string) => statusIn(h, orgId) === 'active'
/** Checks default to the current org; pass a record's own org to check against that org instead. */
export const iAmActive = (d: DB, orgId = d.currentOrgId) => isActive(me(d), orgId)
export const isOrgAdmin = (d: DB, orgId = d.currentOrgId) => iAmActive(d, orgId) && ORG_ADMIN_ROLES.includes(me(d)?.roles[orgId] as OrgRole)
/** Active Owners and userAdmins of the current organization. */
export const orgAdmins = (d: DB) => d.humans.filter((h) => isActive(h, d.currentOrgId) && ORG_ADMIN_ROLES.includes(h.roles[d.currentOrgId]))
export const owners = (d: DB) => d.humans.filter((h) => h.roles[d.currentOrgId] === 'Owner')
export const org = (d: DB) => d.orgs.find((o) => o.id === d.currentOrgId)
export const agentById = (d: DB, id: string | undefined) => d.agents.find((a) => a.id === id)
export const humanById = (d: DB, id: string | undefined) => d.humans.find((h) => h.id === id)
export const wsById = (d: DB, id: string | undefined) => d.workspaces.find((w) => w.id === id)
export const orgAgents = (d: DB) => d.agents.filter((a) => a.orgId === d.currentOrgId)
export const orgHumans = (d: DB) => d.humans.filter((h) => h.roles[d.currentOrgId])
export const orgEvents = (d: DB) => d.events.filter((e) => e.orgId === d.currentOrgId)
/** A workspace's name for display, including deleted ones ("Incidents (deleted)"). */
export const wsLabel = (d: DB, id: string | undefined) => {
  if (!id) return undefined
  const w = wsById(d, id)
  if (w) return w.name
  const t = d.deletedWorkspaces.find((x) => x.id === id)
  return t ? `${t.name} (deleted)` : id
}
/** An audit row's actor under its current name — rows store the ID, so renames don't split or orphan history. */
export function actorLabel(d: DB, e: AuditEvent) {
  if (e.actorKind === 'agent') return agentById(d, e.actorId)?.label ?? e.actor
  if (e.actorKind === 'human') return humanById(d, e.actorId)?.name ?? e.actor
  return e.actor
}
export const actorKey = (e: AuditEvent) => `${e.actorKind}:${e.actorId ?? e.actor}`
/** Agent labels are unique in an org, case-insensitively and including revoked agents. */
export const labelTaken = (d: DB, label: string, except?: string) => orgAgents(d).some((a) => a.id !== except && a.label.toLowerCase() === label.trim().toLowerCase())
export const emailTaken = (d: DB, email: string) => orgHumans(d).some((h) => h.email.toLowerCase() === email.trim().toLowerCase())
export const principalName = (d: DB, p: Author) => (p.kind === 'agent' ? (agentById(d, p.id)?.label ?? p.id) : p.kind === 'webhook' ? `listener ${p.id}` : (humanById(d, p.id)?.name ?? p.id))

/** Workspaces the current human can see: org admins see all, others see their memberships. */
export const myWorkspaces = (d: DB) => {
  const all = d.workspaces.filter((w) => w.orgId === d.currentOrgId)
  if (isOrgAdmin(d)) return all
  return all.filter((w) => w.members.some((m) => m.kind === 'human' && m.id === d.currentUserId))
}
export const myMembership = (d: DB, w: Workspace) => w.members.find((m) => m.kind === 'human' && m.id === d.currentUserId)
/** Admin of this workspace: its own admin role, or org Owner/userAdmin. */
// Workspace permissions are checked against the workspace's own organization, whichever org is on screen.
export const canAdmin = (d: DB, w: Workspace) => isOrgAdmin(d, w.orgId) || (iAmActive(d, w.orgId) && myMembership(d, w)?.role === 'admin')
export const canPost = (d: DB, w: Workspace) => isOrgAdmin(d, w.orgId) || (iAmActive(d, w.orgId) && !!myMembership(d, w)?.write)
/** Active humans explicitly made admin of this workspace. A suspended admin doesn't count as the workspace's human admin. */
export const explicitHumanAdmins = (d: DB, w: Workspace) => w.members.filter((m) => m.kind === 'human' && m.role === 'admin' && isActive(humanById(d, m.id), w.orgId))
/**
 * Every workspace has at least one human admin. With no explicit human admin,
 * the organization's Owners and userAdmins are its admins by default. Agents
 * can hold admin too, but never replace the human admin.
 */
export const defaultAdmins = (d: DB, w: Workspace) => (explicitHumanAdmins(d, w).length ? [] : orgAdmins(d))

export const isOnline = (a: Agent) => a.status === 'active' && a.connected
/** The client an agent reported when it last connected, e.g. "Claude Code 2.1.4 · MCP", or "Not connected yet". */
export const clientLabel = (a: Agent | undefined) => (a?.client ? `${a.client.via === 'REST' ? 'REST' : `${a.client.name}${a.client.version ? ` ${a.client.version}` : ''} · MCP`}` : 'Not connected yet')

export const isExpired = (m: Message, now = Date.now()) => m.expiresAt != null && m.expiresAt <= now
export type ReceiptState = 'queued' | 'held' | 'delivered' | 'read' | 'acked' | 'filtered' | 'expired'
/** A receipt's state. Pass the message: one that expired before delivery reads "never delivered", not "queued". */
export function receiptState(r: Message['receipts'][string] | undefined, m?: Message, now = Date.now()): ReceiptState {
  if (r?.filtered) return 'filtered'
  if (m && isExpired(m, now) && !r?.deliveredAt) return 'expired'
  if (!r) return 'queued'
  if (r.held) return 'held'
  if (r.ackAt) return 'acked'
  if (r.readAt) return 'read'
  if (r.deliveredAt) return 'delivered'
  return 'queued'
}

/* ------------------------------------------------------------------ */
/* Logging                                                             */
/* ------------------------------------------------------------------ */
export function log(d: DB, e: Partial<AuditEvent> & Pick<AuditEvent, 'object'>) {
  // Audit rows belong to the record's organization: the workspace's when there is one, else the one given, else the current org.
  const { orgId: given, ...rest } = e
  const recordOrg = e.wsId ? (wsById(d, e.wsId)?.orgId ?? d.deletedWorkspaces.find((x) => x.id === e.wsId)?.orgId) : undefined
  const ev: AuditEvent = {
    id: uid('ev'),
    at: Date.now(),
    type: 'admin',
    severity: 'info',
    actor: me(d)?.name ?? 'Someone',
    actorKind: 'human',
    actorId: d.currentUserId,
    result: 'Done',
    trk: trackingCode(),
    ...rest,
    orgId: recordOrg ?? given ?? d.currentOrgId,
  }
  d.events.unshift(ev)
  return ev
}

/** Work out who a message is for: filtered (a final refusal), held (a reversible one), or deliverable. */
function initReceipts(d: DB, w: Workspace, msg: Message) {
  for (const id of targets(w, msg)) {
    const a = agentById(d, id)
    if (!a) continue
    const v = accessVerdict(d, w, msg, a)
    msg.receipts[id] = !v ? {} : v.final ? { filtered: v.reason, filteredCause: v.cause } : { held: v.reason, heldCause: v.cause, heldAt: Date.now() }
    if (!v && isOnline(a)) msg.receipts[id].deliveredAt = Date.now()
  }
}

/** What a re-check changed. */
export type Recheck = { filtered: number; held: number; released: number; removed: number; restored: number }
const noChange = (): Recheck => ({ filtered: 0, held: 0, released: 0, removed: 0, restored: 0 })

/**
 * Re-runs the access ladder for receipts on live messages. Access can change
 * after a message was sent, and refusals only act on what hasn't happened yet:
 * - never delivered + final refusal (block, removal, revoke) → Filtered;
 * - never delivered + reversible refusal (suspended, read off) → Held, then
 *   released when access returns (and delivered on the next delivery);
 * - already delivered, read or acknowledged → kept exactly as recorded, with
 *   an "access removed" note while access is refused.
 */
export function recheckReceipts(d: DB, scope: { wsId?: string; agentId?: string } = {}): Recheck {
  const c = noChange()
  const now = Date.now()
  for (const m of d.messages) {
    if ((scope.wsId && m.wsId !== scope.wsId) || isExpired(m, now)) continue
    const w = wsById(d, m.wsId)
    if (!w) continue
    let touched = false
    for (const [aid, r] of Object.entries(m.receipts)) {
      if ((scope.agentId && aid !== scope.agentId) || r.filtered) continue
      const a = agentById(d, aid)
      const v = a ? accessVerdict(d, w, m, a) : { reason: 'The agent no longer exists.', final: true, cause: 'deleted' }
      if (!r.deliveredAt) {
        if (v?.final) {
          r.filtered = v.reason
          r.filteredAt = now
          r.filteredCause = v.cause
          delete r.held
          delete r.heldCause
          delete r.heldAt
          c.filtered++
        } else if (v) {
          if (r.held === v.reason) continue
          r.held = v.reason
          r.heldCause = v.cause
          r.heldAt ??= now
          c.held++
        } else if (r.held) {
          delete r.held
          delete r.heldCause
          delete r.heldAt
          c.released++
        } else continue
      } else if (v) {
        if (r.removed?.reason === v.reason) continue
        r.removed = { at: r.removed?.at ?? now, reason: v.reason, final: v.final, cause: v.cause }
        c.removed++
      } else if (r.removed) {
        delete r.removed
        c.restored++
      } else continue
      touched = true
    }
    if (touched) maybeFire(d, m)
  }
  return c
}
/**
 * What losing access would do to one agent's receipts (in one workspace, or
 * everywhere): queued ones are filtered (final) or held (reversible); delivered
 * and read ones keep what they recorded; fire webhooks still waiting on it
 * won't fire (final) or stay pending (reversible).
 */
export function accessImpact(d: DB, agentId: string, wsId?: string) {
  const now = Date.now()
  const msgs = d.messages.filter((m) => (!wsId || m.wsId === wsId) && !isExpired(m, now) && m.receipts[agentId] && !m.receipts[agentId].filtered)
  const r = (m: Message) => m.receipts[agentId]
  const hooks = msgs.filter((m) => m.webhook?.mode === 'fire' && !m.webhook.firedAt && !m.webhook.outcome && m.webhook.trigger !== 'send' && !(m.webhook.trigger === 'all-read' ? r(m).readAt : r(m).ackAt))
  return {
    queued: msgs.filter((m) => !r(m).deliveredAt).length,
    delivered: msgs.filter((m) => r(m).deliveredAt && !r(m).readAt && !r(m).ackAt).length,
    read: msgs.filter((m) => r(m).readAt && !r(m).ackAt).length,
    acked: msgs.filter((m) => r(m).ackAt).length,
    hooks: hooks.map((m) => ({ id: m.id, url: m.webhook!.url.replace(/^https?:\/\//, '') })),
  }
}

/** One wording for delivered receipts that lose access, shared by previews and audit rows (they count the same set). */
export const ALREADY_DELIVERED = 'already delivered — kept as recorded, marked “access removed”'

/** " · 2 queued filtered · 1 held · 3 delivered kept (access removed)" for audit results. */
export function recheckNote(c: Recheck) {
  const parts = [
    c.filtered && `${c.filtered} queued filtered`,
    c.held && `${c.held} held`,
    c.removed && `${c.removed} ${ALREADY_DELIVERED}`,
    c.released && `${c.released} released`,
    c.restored && `${c.restored} regained access`,
  ].filter(Boolean)
  return parts.length ? ` · ${parts.join(' · ')}` : ''
}
const anyChange = (c: Recheck) => c.filtered + c.held + c.released + c.removed + c.restored > 0
/** A receipt that can move forward right now (not filtered, held, or cut off after delivery). */
const deliverable = (r: Message['receipts'][string]) => !r.filtered && !r.held && !r.removed

/* Outbound webhooks: one call when the trigger is met, then up to 3 retries. */
export const RETRY_DELAYS = [30_000, 2 * MIN, 10 * MIN]
export const MAX_ATTEMPTS = RETRY_DELAYS.length + 1
const TRIGGER_TEXT: Record<FireTrigger, string> = { send: 'On send', 'all-read': 'When every target has read it', 'all-ack': 'When every target has acknowledged it' }
type FireHook = Extract<Webhook, { mode: 'fire' }>

/**
 * Where a fire webhook stands, for the UI. A refusal never counts as
 * completion: if a target that hasn't met the trigger can no longer receive
 * the message (blocked, removed, revoked), the hook won't fire and names it.
 * Held targets (suspended, read off) keep it pending. Agents already
 * filtered when the message was sent were never targets.
 */
export type FireState =
  | { k: 'waiting'; pending: string[]; held: string[]; total: number }
  | { k: 'target-lost'; dropped: { agentId: string; cause: string }[] }
  | { k: 'retrying'; next: number; attempt: number }
  | { k: 'delivered'; at: number; attempt: number }
  | { k: 'gave-up'; attempts: number }
  | { k: 'no-targets' }
  | { k: 'expired'; attempts: number }
export function fireState(m: Message, now = Date.now()): FireState | null {
  const h = m.webhook
  if (!h || h.mode !== 'fire') return null
  const okAt = h.attempts.findIndex((a) => a.status < 300)
  if (h.outcome === 'delivered' || okAt >= 0) return { k: 'delivered', at: h.attempts[okAt]?.at ?? h.outcomeAt ?? now, attempt: okAt + 1 }
  if (h.outcome === 'gave-up') return { k: 'gave-up', attempts: h.attempts.length }
  if (h.outcome === 'no-targets') return { k: 'no-targets' }
  if (h.outcome === 'target-lost') return { k: 'target-lost', dropped: h.dropped ?? [] }
  if (h.outcome === 'expired' || isExpired(m, now)) return { k: 'expired', attempts: h.attempts.length }
  if (h.firedAt) return { k: 'retrying', next: h.nextAttemptAt ?? now, attempt: h.attempts.length + 1 }
  const t = hookTargets(m, h)
  if (h.trigger !== 'send' && !t.live.length) return { k: 'no-targets' }
  if (t.lost.length) return { k: 'target-lost', dropped: t.lost.map(([id, r]) => ({ agentId: id, cause: r.filteredCause ?? r.removed?.cause ?? 'refused' })) }
  return { k: 'waiting', pending: t.pending.map(([id]) => id), held: t.pending.filter(([, r]) => r.held || r.removed).map(([id]) => id), total: t.live.length }
}

/** A fire hook's targets: live ones, the ones still pending, and the ones lost to a final refusal before meeting the trigger. */
function hookTargets(m: Message, h: FireHook) {
  // Filtered when the message was sent (no filteredAt): never a target.
  const live = Object.entries(m.receipts).filter(([, r]) => !r.filtered || r.filteredAt)
  const done = (r: Message['receipts'][string]) => (h.trigger === 'all-read' ? r.readAt : r.ackAt)
  const open = live.filter(([, r]) => !done(r))
  const lost = open.filter(([, r]) => r.filtered || r.removed?.final)
  return { live, pending: open.filter((x) => !lost.includes(x)), lost }
}

function settleHook(d: DB, msg: Message, hook: FireHook, outcome: 'no-targets' | 'expired' | 'target-lost') {
  hook.outcome = outcome
  hook.outcomeAt = Date.now()
  hook.nextAttemptAt = undefined
  if (outcome === 'target-lost') {
    const names = (hook.dropped ?? []).map((x) => `${agentById(d, x.agentId)?.label ?? x.agentId} (${x.cause})`).join(', ')
    log(d, {
      wsId: msg.wsId,
      type: 'webhook',
      severity: 'warn',
      actor: 'Dispatch',
      actorKind: 'system',
      object: `Won’t fire ${hook.url.replace(/^https?:\/\//, '')} · ${msg.id}`,
      result: `Target can no longer receive it · ${names}`,
      reason: `A refusal never counts as completion: ${names} can no longer ${hook.trigger === 'all-read' ? 'read' : 'acknowledge'} this message, so “${TRIGGER_TEXT[hook.trigger].toLowerCase()}” can’t be met.`,
      detail: [['Trigger', TRIGGER_TEXT[hook.trigger]], ...(hook.dropped ?? []).map((x) => [`Dropped ${x.agentId}`, x.reason] as [string, string])],
      link: { label: 'Open the message', to: `/workspaces/${msg.wsId}/messages?m=${msg.id}` },
    })
    return
  }
  log(d, {
    wsId: msg.wsId,
    type: 'webhook',
    severity: 'warn',
    actor: 'Dispatch',
    actorKind: 'system',
    object: `Won’t fire ${hook.url.replace(/^https?:\/\//, '')} · ${msg.id}`,
    result: outcome === 'no-targets' ? 'No deliverable targets' : hook.attempts.length ? 'Message expired · retries stopped' : 'Message expired',
    reason:
      outcome === 'no-targets'
        ? 'Every addressed agent was filtered (or none were addressed), so its trigger can never be met.'
        : hook.attempts.length
          ? `The message expired after ${hook.attempts.length} failed attempt${hook.attempts.length === 1 ? '' : 's'}. Nothing fires after expiry.`
          : 'The message expired before its trigger was met. Nothing fires after expiry.',
    detail: [['Trigger', TRIGGER_TEXT[hook.trigger]]],
    link: { label: 'Open the message', to: `/workspaces/${msg.wsId}/messages?m=${msg.id}` },
  })
}

/** Makes one call to a fire webhook's URL (simulated: URLs containing fail/down/500 time out). */
function attemptWebhook(d: DB, msg: Message, hook: FireHook, manualBy?: Pick<AuditEvent, 'actor' | 'actorKind' | 'actorId'>) {
  const manual = !!manualBy
  const now = Date.now()
  const n = hook.attempts.length + 1
  const failing = /fail|down|500/.test(hook.url)
  const trk = trackingCode()
  const ms = failing ? 10_000 : 120 + Math.floor(Math.random() * 200)
  let note: string | undefined
  if (!failing) {
    hook.outcome = 'delivered'
    hook.outcomeAt = now
    hook.nextAttemptAt = undefined
    note = manual ? 'Manual retry' : n > 1 ? `Retry ${n - 1} of ${RETRY_DELAYS.length}` : undefined
  } else if (manual) {
    note = `Timed out after 10 s (manual retry)${hook.nextAttemptAt ? ` — scheduled retry still at ${clock(hook.nextAttemptAt)}` : ''}`
  } else if (n < MAX_ATTEMPTS) {
    hook.nextAttemptAt = now + RETRY_DELAYS[n - 1]
    note = `Timed out after 10 s — attempt ${n + 1} of ${MAX_ATTEMPTS} at ${clock(hook.nextAttemptAt)}`
  } else {
    hook.outcome = 'gave-up'
    hook.outcomeAt = now
    hook.nextAttemptAt = undefined
    note = `Timed out after 10 s — gave up after ${MAX_ATTEMPTS} attempts`
  }
  hook.attempts.push({ id: uid('wa'), at: now, status: failing ? 504 : 200, ms, trk, note })
  const host = hook.url.replace(/^https?:\/\//, '')
  log(d, {
    wsId: msg.wsId,
    type: 'webhook',
    severity: failing ? 'warn' : 'ok',
    ...(manualBy ?? { actor: 'Dispatch', actorKind: 'system' as const, actorId: undefined }),
    object: `${manual ? 'Retried' : 'Fired'} ${host} · ${msg.id}${n > 1 ? ` (attempt ${n})` : ''}`,
    result: failing ? `504 · ${hook.outcome === 'gave-up' ? 'gave up' : hook.nextAttemptAt ? 'retrying' : 'failed'}` : `200 · ${ms} ms`,
    trk,
    reason: failing ? note : undefined,
    detail: [['Trigger', TRIGGER_TEXT[hook.trigger]], ['Auth', hook.authSet ? `Basic · ${hook.authUser}` : 'None'], ['Attempt', manual ? `${n} (manual)` : `${n} of ${MAX_ATTEMPTS}`]],
    link: { label: 'Open the message', to: `/workspaces/${msg.wsId}/messages?m=${msg.id}` },
  })
}

/** Fires a message's outbound webhook once its trigger is satisfied, or settles it when it never can be. */
export function maybeFire(d: DB, msg: Message) {
  const hook = msg.webhook
  if (!hook || hook.mode !== 'fire' || hook.firedAt || hook.outcome) return
  if (isExpired(msg)) return settleHook(d, msg, hook, 'expired')
  if (hook.trigger !== 'send') {
    const t = hookTargets(msg, hook)
    if (!t.live.length) return settleHook(d, msg, hook, 'no-targets')
    if (t.lost.length) {
      hook.dropped = t.lost.map(([id, r]) => ({ agentId: id, cause: r.filteredCause ?? r.removed?.cause ?? 'refused', reason: r.filtered ?? r.removed?.reason ?? '', at: r.filteredAt ?? r.removed?.at ?? Date.now() }))
      return settleHook(d, msg, hook, 'target-lost')
    }
    if (t.pending.length) return
  }
  hook.firedAt = Date.now()
  attemptWebhook(d, msg, hook)
}

/** Runs due retries and settles hooks whose message expired. Driven by the simulation tick. */
function webhookTick(d: DB, now: number) {
  for (const m of d.messages) {
    const hook = m.webhook
    if (hook?.mode !== 'fire' || hook.outcome) continue
    if (isExpired(m, now)) settleHook(d, m, hook, 'expired')
    else if (hook.firedAt && hook.nextAttemptAt && hook.nextAttemptAt <= now) attemptWebhook(d, m, hook)
  }
}

/**
 * Writing without reading makes no sense: turning read off also turns write off, and turning write on while
 * read is off turns read on too. Applies to memberships (UI and API) and to an agent's own filters.
 */
export function coupleReadWrite<T extends { read?: boolean; write?: boolean }>(cur: { read: boolean; write: boolean }, patch: T): T {
  const next = { ...patch }
  const read = patch.read ?? cur.read
  const write = patch.write ?? cur.write
  if (patch.read === false && write) next.write = false
  else if (patch.write === true && !read) next.read = true
  else if (patch.read === undefined && patch.write === undefined) return next
  else if (!read && write) next.write = false
  return next
}

/* ------------------------------------------------------------------ */
/* Who acts                                                            */
/* ------------------------------------------------------------------ */
/**
 * The principal behind an action. Humans act in the web app; agents act over
 * the REST API or MCP, and an agent's admin actions are audited as agent
 * actions ("planner … — as delegated admin"). viaHumanId marks a request a
 * human sent from the API console with that agent's credentials.
 */
export type Actor = { kind: 'human'; id: string } | { kind: 'agent'; id: string; viaHumanId?: string }
export const TOKEN_GRACE = 10 * MIN

function who(d: DB, by?: Actor) {
  if (by?.kind === 'agent') {
    const label = agentById(d, by.id)?.label ?? by.id
    const via = by.viaHumanId ? humanById(d, by.viaHumanId) : undefined
    return {
      ev: { actor: label, actorKind: 'agent' as const, actorId: by.id, ...(by.viaHumanId ? { viaHumanId: by.viaHumanId } : {}) },
      asAdmin: ' — as delegated admin',
      detail: [['Agent ID', by.id], ...(via ? [['Sent by', `${via.name} (${via.id}) via API console`]] : [])] as [string, string][],
    }
  }
  const id = by?.id ?? d.currentUserId
  return { ev: { actor: humanById(d, id)?.name ?? id, actorKind: 'human' as const, actorId: id }, asAdmin: '', detail: [] as [string, string][] }
}
function mayAdmin(d: DB, wsId: string, by?: Actor) {
  const w = wsById(d, wsId)
  if (!w) return false
  return by?.kind === 'agent' ? evaluate(d, by.id, wsId, 'admin').allowed : canAdmin(d, w)
}
function mayWrite(d: DB, wsId: string, by?: Actor) {
  const w = wsById(d, wsId)
  if (!w) return false
  return by?.kind === 'agent' ? evaluate(d, by.id, wsId, 'write').allowed : canPost(d, w)
}
/**
 * Expiring a message ends it for everyone (queued receipts, listeners, pending gates), so only workspace admins —
 * human or agent — may do it, on any message including their own. Authorship and write access grant nothing (rule 3).
 */
export function mayExpire(d: DB, m: Message, by?: Actor) {
  return mayAdmin(d, m.wsId, by)
}
/** Rotating a listener's password hands out a credential, so it's reserved for workspace admins. */
export function mayRotateListener(d: DB, m: Message, by?: Actor) {
  return mayAdmin(d, m.wsId, by)
}
/**
 * What a person did that stays in place if they lose access (rule 4): agents
 * they registered, admin they delegated, members they added, messages they sent.
 * "Created by" is audit-only — none of it belongs to them.
 */
export function humanFootprint(d: DB, h: Human) {
  const mine = (id: string | undefined, name: string | undefined) => (id ? id === h.id : name === h.name)
  const ws = d.workspaces.filter((w) => w.orgId === d.currentOrgId)
  return {
    agents: orgAgents(d).filter((a) => mine(a.createdById, a.createdBy)),
    delegations: ws.flatMap((w) => w.members.filter((m) => m.role === 'admin' && !(m.kind === 'human' && m.id === h.id) && mine(m.delegatedById, m.delegatedBy)).map((m) => ({ w, m }))),
    added: ws.flatMap((w) => w.members.filter((m) => !(m.kind === 'human' && m.id === h.id) && mine(m.addedById, m.addedBy)).map((m) => ({ w, m }))),
    messages: d.messages.filter((m) => m.author.kind === 'human' && m.author.id === h.id && ws.some((w) => w.id === m.wsId)).length,
    memberships: ws.filter((w) => w.members.some((m) => m.kind === 'human' && m.id === h.id)),
    lastExplicitAdminIn: ws.filter((w) => explicitHumanAdmins(d, w).length === 1 && explicitHumanAdmins(d, w)[0].id === h.id),
  }
}
/**
 * Only active people count. Suspending, demoting or removing the last *active* Owner is refused, whatever
 * suspended or invited Owners exist — otherwise nobody could recover the organization. Ownership can be transferred.
 */
export const activeOwners = (d: DB) => owners(d).filter((o) => isActive(o, d.currentOrgId))
export const isLastOwner = (d: DB, h: Human) => h.roles[d.currentOrgId] === 'Owner' && isActive(h, d.currentOrgId) && activeOwners(d).length <= 1
/** Whether the current human may change this person's org access. Only (active) Owners act on Owners; nobody on themselves. */
export const canManageHuman = (d: DB, h: Human) => isOrgAdmin(d) && h.id !== d.currentUserId && (h.roles[d.currentOrgId] !== 'Owner' || myOrgRole(d) === 'Owner')

/** Logs the fallback when the last explicit human admin goes: the org's Owners and userAdmins become default admins. */
function logDefaultAdmins(d: DB, w: Workspace, hadExplicit: boolean, by?: Actor) {
  if (!hadExplicit || explicitHumanAdmins(d, w).length) return
  const names = orgAdmins(d).map((h) => h.name).join(', ')
  log(d, { ...who(d, by).ev, wsId: w.id, severity: 'info', object: `${w.name} has no explicit human admin — default admins: ${names} (org Owners/userAdmins)`, result: 'Default admins', reason: 'Every workspace has at least one human admin. Agent admins keep their role but never replace the human admin.', detail: [['Explicit human admins before', 'yes'], ['After', `none — default admins ${names}`]] })
}

/* ------------------------------------------------------------------ */
/* Actions                                                             */
/* ------------------------------------------------------------------ */
export const actions = {
  reset(s: 'fresh' | 'populated') {
    sessionSecrets.clear()
    const next = s === 'fresh' ? freshDB() : populatedDB()
    update((d) => Object.assign(d, next))
  },
  setPersona(id: string) {
    update((d) => {
      d.currentUserId = id
      const h = humanById(d, id)
      // A persona that isn't in the current organization opens in one of theirs.
      if (h && !h.roles[d.currentOrgId]) d.currentOrgId = Object.keys(h.roles)[0] ?? d.currentOrgId
    })
  },
  /** Switch to another organization the current person belongs to (suspended there or not — they can still look). */
  switchOrg(orgId: string) {
    update((d) => {
      if (me(d)?.roles[orgId]) d.currentOrgId = orgId
    })
  },
  setListState(s: DB['listState']) {
    update((d) => void (d.listState = s))
  },
  setLive(on: boolean) {
    update((d) => void (d.live = on))
  },
  dismissChecklist() {
    update((d) => void (d.checklistDismissed = true))
  },

  /* Workspaces */
  createWorkspace(w: { name: string; description: string; defaultExpiryHours: number | null }) {
    const id = shortId('wks')
    update((d) => {
      if (!iAmActive(d)) return
      d.workspaces.push({ id, orgId: d.currentOrgId, name: w.name, description: w.description, createdAt: Date.now(), members: [{ kind: 'human', id: d.currentUserId, role: 'admin', read: true, write: true, addedBy: me(d).name, addedById: d.currentUserId, addedAt: Date.now() }], agentBlocklist: [], defaultExpiryHours: w.defaultExpiryHours, retentionDays: 90 })
      log(d, { wsId: id, object: `Created workspace ${w.name}` })
    })
    return id
  },
  updateWorkspace(id: string, patch: Partial<Pick<Workspace, 'name' | 'description' | 'defaultExpiryHours' | 'retentionDays'>>, by?: Actor) {
    update((d) => {
      const w = wsById(d, id)
      if (!w || !mayAdmin(d, id, by)) return
      const a = who(d, by)
      const changed = (Object.keys(patch) as (keyof typeof patch)[]).filter((k) => patch[k] !== w[k])
      if (!changed.length) return
      const before = changed.map((k) => `${k} ${String(w[k])}`).join(', ')
      Object.assign(w, patch)
      log(d, { ...a.ev, wsId: id, object: `Changed ${w.name} settings · ${changed.map((k) => `${k} → ${String(w[k])}`).join(', ')}${a.asAdmin}`, detail: [['Before', before], ...a.detail] })
    })
  },
  deleteWorkspace(id: string) {
    update((d) => {
      const w = wsById(d, id)
      if (!w || !canAdmin(d, w)) return
      const msgs = d.messages.filter((m) => m.wsId === id)
      const detail: [string, string][] = [
        ['Members', `${w.members.filter((m) => m.kind === 'human').length} humans · ${w.members.filter((m) => m.kind === 'agent').length} agents (workspace tokens revoked)`],
        ['Messages deleted', String(msgs.length)],
        ['Open listeners closed', String(msgs.filter((m) => m.webhook?.mode === 'listen' && !isExpired(m)).length)],
        ['Shared context deleted', String(d.notes.filter((n) => n.wsId === id).length)],
        ['Workspace ID', id],
      ]
      d.workspaces = d.workspaces.filter((x) => x.id !== id)
      d.messages = d.messages.filter((m) => m.wsId !== id)
      d.notes = d.notes.filter((n) => n.wsId !== id)
      d.deletedWorkspaces.push({ id, orgId: w.orgId, name: w.name, deletedAt: Date.now(), deletedBy: me(d).name })
      log(d, { wsId: id, severity: 'warn', object: `Deleted workspace ${w.name}`, result: 'Deleted · audit kept', detail })
    })
  },

  /** Adds an agent or human. Agents get a per-membership workspace token, returned once. */
  addMember(wsId: string, p: Principal, role: MemberRole, read: boolean, write: boolean, by?: Actor): string | null {
    let token: string | null = null
    update((d) => {
      const w = wsById(d, wsId)
      if (!w || !mayAdmin(d, wsId, by) || w.members.some((m) => m.kind === p.kind && m.id === p.id)) return
      const a = who(d, by)
      // Humans in a workspace always read everything; only writing is optional.
      const m: Membership = { kind: p.kind, id: p.id, role, read: p.kind === 'human' ? true : read, write, addedBy: a.ev.actor, addedById: a.ev.actorId, addedAt: Date.now(), delegatedBy: role === 'admin' ? a.ev.actor : undefined, delegatedById: role === 'admin' ? a.ev.actorId : undefined }
      if (p.kind === 'agent') {
        token = newWsToken()
        sessionSecrets.set(`ws:${wsId}:${p.id}`, token)
        m.tokenLast4 = token.slice(-4)
      }
      w.members.push(m)
      log(d, { ...a.ev, wsId, object: `Added ${principalName(d, p)} (${p.kind}) to ${w.name} as ${role}${p.kind === 'agent' ? ` · token ••••${m.tokenLast4}` : ''}${a.asAdmin}` })
    })
    return token
  },
  setMember(wsId: string, p: Principal, patch: Partial<Pick<Membership, 'role' | 'read' | 'write'>>, by?: Actor) {
    update((d) => {
      const w = wsById(d, wsId)
      const m = w?.members.find((x) => x.kind === p.kind && x.id === p.id)
      if (!w || !m || !mayAdmin(d, wsId, by)) return
      const a = who(d, by)
      const hadExplicit = explicitHumanAdmins(d, w).length > 0
      const was = m.role
      const access = (x: Pick<Membership, 'read' | 'write'>) => [x.read && 'read', x.write && 'write'].filter(Boolean).join(' + ') || 'none'
      const before = access(m)
      Object.assign(m, coupleReadWrite(m, patch))
      if (m.kind === 'human') m.read = true
      if (patch.role === 'admin' && was !== 'admin') {
        m.delegatedBy = a.ev.actor
        m.delegatedById = a.ev.actorId
        log(d, { ...a.ev, wsId, object: `Delegated admin on ${w.name} to ${principalName(d, p)} (${p.kind})${a.asAdmin}`, detail: [['Before', 'member'], ['After', 'admin'], ...a.detail] })
      } else if (patch.role === 'member' && was === 'admin') {
        // Admin rights this member delegated to others stand: nothing cascades from losing admin.
        m.delegatedBy = undefined
        m.delegatedById = undefined
        log(d, { ...a.ev, wsId, object: `Removed admin on ${w.name} from ${principalName(d, p)}${a.asAdmin}`, detail: [['Before', 'admin'], ['After', 'member'], ...a.detail] })
      } else {
        const n = p.kind === 'agent' ? recheckReceipts(d, { wsId, agentId: p.id }) : noChange()
        log(d, { ...a.ev, wsId, object: `Changed ${principalName(d, p)}'s access in ${w.name} → ${access(m)}${a.asAdmin}`, result: `Done${recheckNote(n)}`, detail: [['Before', before], ['After', access(m)], ...a.detail] })
      }
      logDefaultAdmins(d, w, hadExplicit, by)
    })
  },
  /** New workspace token for one membership. The old one keeps working for 10 minutes, like agent tokens. */
  rotateMemberToken(wsId: string, agentId: string, by?: Actor): string | null {
    const token = newWsToken()
    let ok = false
    update((d) => {
      const m = wsById(d, wsId)?.members.find((x) => x.kind === 'agent' && x.id === agentId)
      if (!m || !mayAdmin(d, wsId, by)) return
      const a = who(d, by)
      m.prevTokenLast4 = m.tokenRevoked ? undefined : m.tokenLast4
      m.prevTokenUntil = m.tokenRevoked ? undefined : Date.now() + TOKEN_GRACE
      m.tokenLast4 = token.slice(-4)
      m.tokenRevoked = false
      const old = sessionSecrets.get(`ws:${wsId}:${agentId}`)
      if (old && m.prevTokenLast4) sessionSecrets.set(`ws-prev:${wsId}:${agentId}`, old)
      else sessionSecrets.delete(`ws-prev:${wsId}:${agentId}`)
      sessionSecrets.set(`ws:${wsId}:${agentId}`, token)
      ok = true
      log(d, { ...a.ev, wsId, object: `Rotated ${agentById(d, agentId)?.label}'s workspace token → ••••${m.tokenLast4}${a.asAdmin}`, result: m.prevTokenLast4 ? `Old ••••${m.prevTokenLast4} works until ${clock(m.prevTokenUntil!)}` : 'Done' })
    })
    return ok ? token : null
  },
  /** Returns what the access re-check changed (null when nothing was removed). */
  removeMember(wsId: string, p: Principal, by?: Actor): Recheck | null {
    let result: Recheck | null = null
    update((d) => {
      const w = wsById(d, wsId)
      const m = w?.members.find((x) => x.kind === p.kind && x.id === p.id)
      if (!w || !m || !mayAdmin(d, wsId, by)) return
      const a = who(d, by)
      const hadExplicit = explicitHumanAdmins(d, w).length > 0
      w.members = w.members.filter((x) => x !== m)
      const n = p.kind === 'agent' ? recheckReceipts(d, { wsId, agentId: p.id }) : noChange()
      result = n
      log(d, { ...a.ev, wsId, object: `Removed ${principalName(d, p)} from ${w.name}${p.kind === 'agent' ? ' — its workspace token stops working now' : ''}${a.asAdmin}`, result: `Done${recheckNote(n)}`, detail: [['Before', `${m.role} · ${m.read ? 'read' : ''}${m.write ? ' + write' : ''}`], ['After', 'not a member'], ...a.detail] })
      logDefaultAdmins(d, w, hadExplicit, by)
    })
    return result
  },
  setWsBlocklist(wsId: string, ids: string[], by?: Actor) {
    update((d) => {
      const w = wsById(d, wsId)
      if (!w || !mayAdmin(d, wsId, by)) return
      const a = who(d, by)
      const added = ids.filter((x) => !w.agentBlocklist.includes(x))
      const removed = w.agentBlocklist.filter((x) => !ids.includes(x))
      const names = (list: string[]) => list.map((x) => agentById(d, x)?.label ?? x).join(', ') || 'none'
      const before = names(w.agentBlocklist)
      w.agentBlocklist = ids
      const detail: [string, string][] = [['Before', before], ['After', names(ids)], ...a.detail]
      for (const id of added) log(d, { ...a.ev, wsId, object: `Added ${agentById(d, id)?.label ?? id} to ${w.name} blocklist${a.asAdmin}`, result: `Done${recheckNote(recheckReceipts(d, { wsId, agentId: id }))}`, detail })
      for (const id of removed) log(d, { ...a.ev, wsId, object: `Removed ${agentById(d, id)?.label ?? id} from ${w.name} blocklist${a.asAdmin}`, detail })
    })
  },

  /* Agents */
  createAgent(a: { label: string; description: string }) {
    const token = newAgentToken()
    const id = shortId('agt')
    sessionSecrets.set(`agent:${id}`, token)
    update((d) => {
      if (!isOrgAdmin(d) || labelTaken(d, a.label)) return
      d.agents.push({ id, orgId: d.currentOrgId, label: a.label, client: null, description: a.description, tokenLast4: token.slice(-4), status: 'active', createdAt: Date.now(), createdBy: me(d).name, createdById: d.currentUserId, lastSeen: null, connected: false, filters: { read: true, write: true, workspaceBlocklist: [], agentBlocklist: [] } })
      log(d, { object: `Registered agent ${a.label} · ${id}` })
    })
    return { id, token }
  },
  /** New agent token. The old one keeps working for 10 minutes so a running agent can switch over. */
  rotateAgentToken(id: string, by?: Actor): string | null {
    const token = newAgentToken()
    let ok = false
    update((d) => {
      const a = agentById(d, id)
      if (!a || a.status === 'revoked' || !(by?.kind === 'agent' ? by.id === id : isOrgAdmin(d, a.orgId))) return
      const w = who(d, by)
      a.prevTokenLast4 = a.tokenLast4
      a.prevTokenUntil = Date.now() + TOKEN_GRACE
      a.tokenLast4 = token.slice(-4)
      const old = sessionSecrets.get(`agent:${id}`)
      if (old) sessionSecrets.set(`agent-prev:${id}`, old)
      else sessionSecrets.delete(`agent-prev:${id}`)
      sessionSecrets.set(`agent:${id}`, token)
      ok = true
      log(d, { orgId: a.orgId,  ...w.ev, object: `Rotated agent token for ${a.label} → ••••${a.tokenLast4}`, result: `Old ••••${a.prevTokenLast4} works until ${clock(a.prevTokenUntil)}`, detail: [['Agent ID', a.id], ...w.detail] })
    })
    return ok ? token : null
  },
  setAgentStatus(id: string, status: Agent['status']) {
    update((d) => {
      const a = agentById(d, id)
      if (!a || !isOrgAdmin(d, a.orgId) || a.status === status) return
      const before = a.status
      a.status = status
      if (status !== 'active') a.connected = false
      const n = recheckReceipts(d, { agentId: id })
      log(d, { orgId: a.orgId,  object: `${status === 'active' ? 'Resumed' : status === 'suspended' ? 'Suspended' : 'Revoked'} agent ${a.label}`, result: `Done${recheckNote(n)}`, detail: [['Agent ID', a.id], ['Before', before], ['After', status]] })
    })
  },
  setAgentFilters(id: string, f: AgentFilters, by?: Actor) {
    update((d) => {
      const a = agentById(d, id)
      if (!a || !(by?.kind === 'agent' ? by.id === id : isOrgAdmin(d, a.orgId))) return
      const show = (x: AgentFilters) =>
        `read ${x.read ? 'on' : 'off'} · write ${x.write ? 'on' : 'off'} · blocked workspaces: ${x.workspaceBlocklist.map((w) => wsById(d, w)?.name ?? w).join(', ') || 'none'} · blocked authors: ${x.agentBlocklist.map((g) => agentById(d, g)?.label ?? g).join(', ') || 'none'}`
      const before = show(a.filters)
      a.filters = { ...f, ...coupleReadWrite(a.filters, f) }
      const n = recheckReceipts(d, { agentId: id })
      const w = who(d, by)
      log(d, { orgId: a.orgId,  ...w.ev, detail: [['Agent ID', a.id], ['Before', before], ['After', show(f)], ...w.detail], object: `Updated ${a.label}'s own filters · read ${f.read ? 'on' : 'off'} · write ${f.write ? 'on' : 'off'} · ${f.workspaceBlocklist.length} blocked workspaces · ${f.agentBlocklist.length} blocked agents`, result: `Done${recheckNote(n)}` })
    })
  },
  renameAgent(id: string, label: string) {
    update((d) => {
      const a = agentById(d, id)
      if (!a || !isOrgAdmin(d, a.orgId) || !label.trim() || d.agents.some((x) => x.orgId === a.orgId && x.id !== id && x.label.toLowerCase() === label.trim().toLowerCase())) return
      const old = a.label
      a.label = label.trim()
      log(d, { orgId: a.orgId,  object: `Renamed agent ${old} → ${a.label} · ${a.id}` })
    })
  },
  /** Prototype: the agent opens its MCP session / starts polling. Queued messages get delivered. */
  /** The agent connects and reports its client (MCP clientInfo, or REST); the report is stored as-is, for display only. */
  connectAgent(id: string, on = true, client?: AgentClient) {
    update((d) => {
      const a = agentById(d, id)
      if (!a || a.status !== 'active') return
      a.connected = on
      a.lastSeen = Date.now()
      if (!on) return
      a.client = { ...(client ?? a.client ?? { name: 'REST', via: 'REST' as const }), at: Date.now() }
      // Delivery re-checks access: whatever changed while the agent was away decides now.
      const filtered = recheckReceipts(d, { agentId: id })
      let n = 0
      for (const m of d.messages) {
        const r = m.receipts[id]
        if (r && deliverable(r) && !r.deliveredAt && !isExpired(m)) {
          r.deliveredAt = Date.now()
          n++
        }
      }
      log(d, { orgId: a.orgId,  type: 'access', severity: 'ok', actor: a.label, actorKind: 'agent', actorId: id, object: `Connected over ${a.client.via}${a.client.via === 'MCP' ? ` · reports ${a.client.name}${a.client.version ? ` ${a.client.version}` : ''}` : ''}`, result: (n ? `${n} queued message${n === 1 ? '' : 's'} delivered` : 'Nothing queued') + recheckNote(filtered) })
    })
  },

  /* People */
  inviteHuman(email: string, role: OrgRole) {
    update((d) => {
      if (!isOrgAdmin(d) || emailTaken(d, email)) return
      // Someone already in another organization is the same person: they gain a membership here, invited.
      const existing = d.humans.find((h) => h.email.toLowerCase() === email.trim().toLowerCase())
      if (existing) {
        existing.roles[d.currentOrgId] = role
        existing.orgStatus = { ...existing.orgStatus, [d.currentOrgId]: 'invited' }
      } else d.humans.push({ id: uid('u'), name: email.split('@')[0].replace(/^./, (c) => c.toUpperCase()), email, roles: { [d.currentOrgId]: role }, orgStatus: { [d.currentOrgId]: 'invited' }, lastActive: null, sessions: [] })
      log(d, { object: `Invited ${email} as ${role}` })
    })
  },

  /** user ↔ userAdmin. An Owner's role changes only by transferring ownership. */
  setOrgRole(humanId: string, role: 'userAdmin' | 'user') {
    update((d) => {
      const h = humanById(d, humanId)
      const cur = h?.roles[d.currentOrgId]
      if (!h || !cur || cur === role || cur === 'Owner' || !canManageHuman(d, h)) return
      h.roles[d.currentOrgId] = role
      log(d, { object: `Changed ${h.name}'s org role ${cur} → ${role}`, detail: [['Human ID', h.id], ['Before', cur], ['After', role]] })
    })
  },
  /** Makes someone else Owner; the current Owner becomes a userAdmin. */
  transferOwnership(toId: string) {
    update((d) => {
      const from = me(d)
      const to = humanById(d, toId)
      const o = org(d)
      // Only an active Owner transfers, only to an active person who isn't already an Owner.
      if (!to || !o || !iAmActive(d) || myOrgRole(d) !== 'Owner' || !to.roles[d.currentOrgId] || to.roles[d.currentOrgId] === 'Owner' || !isActive(to, d.currentOrgId) || to.id === from.id) return
      const before = to.roles[d.currentOrgId]
      to.roles[d.currentOrgId] = 'Owner'
      from.roles[d.currentOrgId] = 'userAdmin'
      log(d, { severity: 'warn', object: `Transferred ownership of ${o.name} to ${to.name}`, result: `${from.name} is now a userAdmin`, detail: [['From', `${from.name} (${from.id}) · Owner → userAdmin`], ['To', `${to.name} (${to.id}) · ${before} → Owner`]] })
    })
  },
  /** Suspending a person stops what they can do next. Nothing they created or granted changes. */
  /** 'suspended' suspends; 'active' resumes — back to the status they had before (an invitee stays invited). */
  setHumanStatus(id: string, status: 'active' | 'suspended') {
    update((d) => {
      const h = humanById(d, id)
      const org_ = d.currentOrgId
      const cur = statusIn(h, org_)
      // Only this organization's membership changes; the person's other organizations are untouched.
      if (!h || !cur || !canManageHuman(d, h)) return
      if (status === 'suspended' ? cur === 'suspended' || isLastOwner(d, h) : cur !== 'suspended') return
      const before = cur
      const lastIn = humanFootprint(d, h).lastExplicitAdminIn
      if (status === 'suspended') {
        h.suspendedFrom = { ...h.suspendedFrom, [org_]: cur }
        h.orgStatus = { ...h.orgStatus, [org_]: 'suspended' }
      } else {
        const back = h.suspendedFrom?.[org_] ?? 'active'
        h.orgStatus = { ...h.orgStatus, [org_]: back }
        if (h.suspendedFrom) delete h.suspendedFrom[org_]
      }
      const after = statusIn(h, org_)!
      // Suspending the only active explicit human admin of a workspace hands it to the default admins.
      if (status === 'suspended') for (const w of lastIn) logDefaultAdmins(d, w, true)
      const f = humanFootprint(d, h)
      log(d, { severity: status === 'suspended' ? 'warn' : 'info', object: `${status === 'suspended' ? 'Suspended' : 'Resumed'} ${h.name}`, result: status === 'suspended' ? `Unaffected: ${f.agents.length} agents they registered, ${f.delegations.length} admin delegations` : after === 'invited' ? 'Back to invited — still has to accept' : 'Done', detail: [['Human ID', h.id], ['Before', before], ['After', after]] })
    })
  },
  /** The current person accepts their invitation to the current organization. Only then do they get any access. */
  acceptInvite() {
    update((d) => {
      const u = me(d)
      const o = org(d)
      if (!u || !o || statusIn(u, d.currentOrgId) !== 'invited') return
      u.orgStatus = { ...u.orgStatus, [d.currentOrgId]: 'active' }
      log(d, { object: `${u.name} accepted the invitation to ${o.name}`, detail: [['Human ID', u.id], ['Before', 'invited'], ['After', 'active']] })
    })
  },
  /**
   * Removes a person from the organization: their org role and their own workspace memberships go.
   * Nothing cascades to what they did — agents they registered, members they added, admin they
   * delegated and messages they sent all stay, and the audit log keeps their name on it.
   */
  removeHuman(id: string) {
    update((d) => {
      const h = humanById(d, id)
      const role = h?.roles[d.currentOrgId]
      if (!h || !role || !canManageHuman(d, h) || isLastOwner(d, h)) return
      const f = humanFootprint(d, h)
      const hadExplicit = new Map(f.memberships.map((w) => [w.id, explicitHumanAdmins(d, w).length > 0]))
      delete h.roles[d.currentOrgId]
      if (h.orgStatus) delete h.orgStatus[d.currentOrgId]
      for (const w of f.memberships) {
        w.members = w.members.filter((m) => !(m.kind === 'human' && m.id === h.id))
        logDefaultAdmins(d, w, hadExplicit.get(w.id) ?? false)
      }
      log(d, {
        severity: 'warn',
        object: `Removed ${h.name} from ${org(d)?.name}`,
        result: `Unaffected: ${f.agents.length} agents, ${f.delegations.length} delegations, ${f.messages} messages`,
        reason: 'Losing permission doesn’t undo what was already done. Agents belong to the organization; delegated admin rights stand.',
        detail: [
          ['Human ID', h.id],
          ['Before', `${role} · member of ${f.memberships.map((w) => w.name).join(', ') || 'no workspaces'}`],
          ['After', 'not in the organization'],
          ['Agents they registered', f.agents.map((a) => a.label).join(', ') || 'none'],
          ['Delegations that stand', f.delegations.map(({ w, m }) => `${principalName(d, m)} on ${w.name}`).join(', ') || 'none'],
        ],
      })
    })
  },

  /* Messages */
  postMessage(m: { wsId: string; body: string; payload?: string; tags: string[]; audience: Audience; expiresInHours: number | null; parentId?: string; webhook?: { mode: 'fire'; url: string; trigger: FireTrigger; authUser: string; authSet: boolean } | { mode: 'listen'; authUser: string } }, as?: Actor) {
    const id = shortId('msg')
    let hookPassword: string | null = null
    let listenUrl: string | null = null
    update((d) => {
      const w = wsById(d, m.wsId)
      if (!w) return
      if (!mayWrite(d, m.wsId, as)) return
      const author: Principal = as ? { kind: as.kind, id: as.id } : { kind: 'human', id: d.currentUserId }
      let webhook: Webhook | undefined
      if (m.webhook?.mode === 'fire') webhook = { ...m.webhook, attempts: [] }
      if (m.webhook?.mode === 'listen') {
        hookPassword = newHookPassword()
        sessionSecrets.set(`hook:${id}`, hookPassword)
        listenUrl = `https://hooks.dispatch.dev/l/lsn_${shortId('lsn').slice(4)}`
        webhook = { mode: 'listen', url: listenUrl, authUser: m.webhook.authUser, passwordLast4: hookPassword.slice(-4), calls: [] }
      }
      const msg: Message = { id, wsId: m.wsId, author, body: m.body, payload: m.payload || undefined, tags: m.tags, audience: m.audience, createdAt: Date.now(), expiresAt: m.expiresInHours ? Date.now() + m.expiresInHours * HOUR : null, parentId: m.parentId, receipts: {}, webhook, trk: trackingCode(), ...(as?.kind === 'agent' && as.viaHumanId ? { sentVia: { channel: 'api-console' as const, humanId: as.viaHumanId } } : {}) }
      initReceipts(d, w, msg)
      d.messages.push(msg)
      const rs = Object.values(msg.receipts)
      const queued = rs.filter((r) => !r.filtered).length
      const filtered = rs.length - queued
      const held = rs.filter((r) => r.held).length
      log(d, {
        wsId: w.id,
        type: 'message',
        severity: 'ok',
        ...who(d, as).ev,
        object: `Posted to ${w.name}${m.tags.length ? ' · ' + m.tags.map((t) => '#' + t).join(' ') : ''}`,
        result: `For ${queued} agent${queued === 1 ? '' : 's'}${held ? ` · ${held} held` : ''}${filtered ? ` · ${filtered} filtered` : ''}`,
        trk: msg.trk,
        link: { label: 'Open the message', to: `/workspaces/${w.id}/messages?m=${id}` },
      })
      maybeFire(d, msg)
    })
    return { id, hookPassword: hookPassword as string | null, listenUrl: listenUrl as string | null }
  },
  /** Human read-state is informational; the receipt lists track agents. */
  /** Ends a message's life now: undelivered receipts stay undelivered, its listener closes (410), a pending fire hook won't fire. */
  expireNow(msgId: string, by?: Actor) {
    update((d) => {
      const m = d.messages.find((x) => x.id === msgId)
      if (!m || isExpired(m) || !mayExpire(d, m, by)) return
      const w = who(d, by)
      const pending = Object.values(m.receipts).filter((r) => !r.filtered && !r.deliveredAt).length
      m.expiresAt = Date.now()
      log(d, { ...w.ev, wsId: m.wsId, type: 'message', object: `Expired ${m.id} early${m.author.kind === w.ev.actorKind && m.author.id === w.ev.actorId ? '' : ` (${principalName(d, m.author)}’s message)`}`, result: [m.webhook?.mode === 'listen' ? 'Listener closed' : m.webhook?.mode === 'fire' && !m.webhook.outcome ? 'Webhook won’t fire' : 'Done', pending ? `${pending} never delivered` : ''].filter(Boolean).join(' · '), detail: w.detail.length ? w.detail : undefined })
      if (m.webhook?.mode === 'fire') maybeFire(d, m)
    })
  },
  /** Issues a new basic-auth password for a message's listener. The old one stops working now. */
  rotateListenerPassword(msgId: string, by?: Actor): string | null {
    const password = newHookPassword()
    let ok = false
    update((d) => {
      const m = d.messages.find((x) => x.id === msgId)
      if (!m || m.webhook?.mode !== 'listen' || isExpired(m) || !mayRotateListener(d, m, by)) return
      const w = who(d, by)
      const old = m.webhook.passwordLast4
      m.webhook.passwordLast4 = password.slice(-4)
      sessionSecrets.set(`hook:${m.id}`, password)
      ok = true
      log(d, { ...w.ev, wsId: m.wsId, type: 'webhook', severity: 'info', object: `Rotated listener password ${m.webhook.url.split('/').pop()} · message ${m.id}${w.asAdmin}`, result: `••••${old} → ••••${m.webhook.passwordLast4}`, reason: 'The old password stops working now; calls using it get 401.', link: { label: 'Open the message', to: `/workspaces/${m.wsId}/messages?m=${m.id}` } })
    })
    return ok ? password : null
  },
  /** Calls a fire webhook's URL once more, now (outside the retry schedule). */
  retryWebhook(msgId: string, by?: Actor) {
    update((d) => {
      const m = d.messages.find((x) => x.id === msgId)
      if (!m || m.webhook?.mode !== 'fire' || isExpired(m) || m.webhook.outcome === 'delivered' || !m.webhook.firedAt || !mayWrite(d, m.wsId, by)) return
      attemptWebhook(d, m, m.webhook, who(d, by).ev)
    })
  },
  /** Prototype: simulate an external system calling a message's listener. */
  callListener(msgId: string, goodAuth: boolean) {
    update((d) => {
      const m = d.messages.find((x) => x.id === msgId)
      if (!m || m.webhook?.mode !== 'listen') return
      const w = wsById(d, m.wsId)!
      const trk = trackingCode()
      const expired = isExpired(m)
      const status: 202 | 401 | 410 = expired ? 410 : goodAuth ? 202 : 401
      const from = `198.51.100.${10 + Math.floor(Math.random() * 200)}`
      const summary = status === 202 ? 'Status update received' : status === 401 ? 'Wrong password — rejected' : 'Listener closed — message expired'
      m.webhook.calls.push({ id: uid('lc'), at: Date.now(), status, from, bytes: 300 + Math.floor(Math.random() * 1500), trk, summary })
      log(d, {
        wsId: m.wsId,
        type: 'webhook',
        severity: status === 202 ? 'ok' : 'blocked',
        actor: from,
        actorKind: 'webhook',
        actorId: m.webhook.url.split('/').pop(),
        object: `Listener ${m.webhook.url.split('/').pop()} · message ${m.id}`,
        result: status === 202 ? '202 · appended to thread' : status === 401 ? '401 · wrong password' : '410 · listener closed',
        trk,
        reason: status === 401 ? 'Rejected: basic-auth password didn’t match. Nothing was appended.' : status === 410 ? 'Rejected: the message expired, so its listener is closed.' : undefined,
        link: { label: 'Open the message', to: `/workspaces/${m.wsId}/messages?m=${m.id}` },
      })
      if (status === 202) {
        // The outside system is its own principal — never the message's author.
        const reply: Message = { id: shortId('msg'), wsId: m.wsId, author: { kind: 'webhook', id: m.webhook.url.split('/').pop()!, from }, parentId: m.id, body: `Listener call from ${from}: status update received.`, payload: '{\n  "status": "ok",\n  "source": "external"\n}', tags: m.tags, audience: m.audience, createdAt: Date.now(), expiresAt: null, receipts: {}, trk }
        initReceipts(d, w, reply)
        d.messages.push(reply)
      }
    })
  },

  /** An agent marks a message read or acknowledged (API / MCP). */
  agentReceipt(msgId: string, agentId: string, kind: 'read' | 'ack') {
    update((d) => {
      const m = d.messages.find((x) => x.id === msgId)
      const r = m?.receipts[agentId]
      const a = agentById(d, agentId)
      if (!m || !r || r.filtered || !a) return
      const w = wsById(d, m.wsId)
      const v = w ? accessVerdict(d, w, m, a) : { reason: 'The workspace no longer exists.', final: true, cause: 'deleted' }
      if (v) {
        // Re-checked at the moment of the action; what it already recorded stays as it is.
        const c = recheckReceipts(d, { wsId: m.wsId, agentId })
        log(d, { wsId: m.wsId, type: 'blocked', severity: 'blocked', actor: a.label, actorKind: 'agent', actorId: a.id, object: `${kind === 'ack' ? 'Acknowledge' : 'Read'} ${m.id}`, result: `Refused${recheckNote(c)}`, reason: `Blocked: ${v.reason}` })
        return
      }
      const now = Date.now()
      r.deliveredAt ??= now
      r.readAt ??= now
      if (kind === 'ack') r.ackAt ??= now
      log(d, { wsId: m.wsId, type: 'receipt', severity: 'ok', actor: a.label, actorKind: 'agent', actorId: a.id, object: `${kind === 'ack' ? 'Acknowledged' : 'Read'} ${m.id}`, result: kind === 'ack' ? 'Acknowledged' : 'Read' })
      maybeFire(d, m)
    })
  },
  /** Records an API call in the audit log, allowed or refused — with the human who sent it from the console. */
  logApiCall(e: { agentId: string; wsId?: string; line: string; allowed: boolean; reason?: string | null; rule?: string; status: number; viaHumanId?: string }) {
    update((d) => {
      const a = agentById(d, e.agentId)
      const h = humanById(d, e.viaHumanId)
      // Console calls are audited in the org where they were made; a workspace ID from another org isn't attributed there.
      log(d, {
        wsId: e.wsId && wsById(d, e.wsId)?.orgId === d.currentOrgId ? e.wsId : undefined,
        type: e.allowed ? 'access' : 'blocked',
        severity: e.allowed ? (e.status >= 400 ? 'warn' : 'ok') : 'blocked',
        actor: a?.label ?? e.agentId,
        actorKind: 'agent',
        actorId: e.agentId,
        viaHumanId: e.viaHumanId,
        object: e.line,
        result: e.allowed ? `${e.status}` : `${e.status} · refused`,
        reason: e.allowed ? (e.reason ?? undefined) : `Blocked: ${e.reason}`,
        detail: [['Agent ID', e.agentId], ...(e.wsId ? ([['Workspace ID', e.wsId]] as [string, string][]) : []), ...(e.rule ? ([['Rule', e.rule]] as [string, string][]) : []), ['Source', h ? `API console — sent by ${h.name} (${h.id}) with ${a?.label ?? e.agentId}’s credentials` : 'API']],
      })
    })
  },
  /** An agent reads its inbox: access is re-checked, then everything addressed to it here is marked delivered. */
  deliverInbox(agentId: string, wsId: string) {
    let delivered = 0
    let filtered = 0
    update((d) => {
      const a = agentById(d, agentId)
      if (!a || a.status !== 'active') return
      a.lastSeen = Date.now()
      const c = recheckReceipts(d, { wsId, agentId })
      filtered = c.filtered
      for (const m of d.messages) {
        const r = m.receipts[agentId]
        if (m.wsId !== wsId || !r || !deliverable(r) || r.deliveredAt || isExpired(m)) continue
        r.deliveredAt = Date.now()
        delivered++
      }
    })
    return { delivered, filtered }
  },

  /* Context */
  saveNote(n: { id?: string; wsId: string; title: string; body: string; tags: string[] }, actor?: Actor) {
    update((d) => {
      if (!mayWrite(d, n.wsId, actor)) return
      const w = who(d, actor)
      const by = w.ev.actor
      if (n.id) {
        const ex = d.notes.find((x) => x.id === n.id)
        if (!ex) return
        Object.assign(ex, { title: n.title, body: n.body, tags: n.tags, version: ex.version + 1, updatedBy: by, updatedAt: Date.now() })
        ex.history.push({ version: ex.version, by, at: Date.now() })
        log(d, { ...w.ev, wsId: n.wsId, type: 'context', object: `Updated context “${n.title}” → v${ex.version}`, detail: w.detail.length ? w.detail : undefined })
      } else {
        const note: ContextNote = { id: uid('nt'), wsId: n.wsId, title: n.title, body: n.body, tags: n.tags, version: 1, updatedBy: by, updatedAt: Date.now(), history: [{ version: 1, by, at: Date.now() }] }
        d.notes.push(note)
        log(d, { ...w.ev, wsId: n.wsId, type: 'context', object: `Added context “${n.title}”`, detail: w.detail.length ? w.detail : undefined })
      }
    })
  },

  /* Settings */
  toggleNotification(k: string) {
    update((d) => void (d.notifications[k] = !d.notifications[k]))
  },
  renameMe(name: string) {
    update((d) => {
      const u = me(d)
      if (!iAmActive(d) || !name.trim() || u.name === name.trim()) return
      const old = u.name
      u.name = name.trim()
      log(d, { object: `Renamed themselves ${old} → ${u.name}`, detail: [['Human ID', u.id]] })
    })
  },
  renameOrg(name: string) {
    update((d) => {
      const o = org(d)
      if (!o || !isOrgAdmin(d) || !name.trim() || o.name === name.trim()) return
      const old = o.name
      o.name = name.trim()
      log(d, { object: `Renamed organization ${old} → ${o.name}`, detail: [['Org ID', o.id]] })
    })
  },
}

/* ------------------------------------------------------------------ */
/* Simulated agent traffic                                             */
/* ------------------------------------------------------------------ */
const CHATTER: { tags: string[]; body: string }[] = [
  { tags: ['ci'], body: 'Re-ran the flaky integration shard; green on the second attempt. Filing it as flaky.' },
  { tags: ['security'], body: 'Dependency audit: 0 critical, 2 moderate (dev-only). No action for this release.' },
  { tags: ['deploy'], body: 'Staging rollout at 50%. Error rate flat, p95 +4 ms. Continuing.' },
  { tags: ['handoff'], body: 'Leaving for the night shift: proration fix is on billing/proration-fix, 2 of 3 tests passing.' },
  { tags: ['qa'], body: 'Smoke suite passed on staging build 4.2.0-rc1. QA can start.' },
]

export function liveTick() {
  update((d) => {
    const now = Date.now()
    for (const a of d.agents) if (isOnline(a)) a.lastSeen = now
    // Access is re-checked before any receipt moves, and whatever the re-check changes is logged.
    for (const w of d.workspaces) {
      const c = recheckReceipts(d, { wsId: w.id })
      if (anyChange(c)) log(d, { wsId: w.id, type: 'access', severity: c.filtered ? 'warn' : 'info', actor: 'Dispatch', actorKind: 'system', object: `Re-checked access at delivery in ${w.name}`, result: recheckNote(c).slice(3), reason: 'Access changed since these messages were sent. Queued receipts are held or filtered; delivered ones keep what they recorded.' })
    }
    webhookTick(d, now)
    // Progress receipts for online agents, one step at a time.
    for (const m of d.messages) {
      if (isExpired(m, now)) continue
      for (const [aid, r] of Object.entries(m.receipts)) {
        const a = agentById(d, aid)
        if (!a || !isOnline(a) || !deliverable(r) || Math.random() < 0.55) continue
        if (!r.deliveredAt) r.deliveredAt = now
        else if (!r.readAt && now - r.deliveredAt > 3000) {
          r.readAt = now
          log(d, { wsId: m.wsId, type: 'receipt', severity: 'ok', actor: a.label, actorKind: 'agent', actorId: a.id, object: `Read ${m.id}`, result: 'Read', trk: trackingCode() })
        } else if (r.readAt && !r.ackAt && now - r.readAt > 4000 && Math.random() < 0.5) {
          r.ackAt = now
          log(d, { wsId: m.wsId, type: 'receipt', severity: 'ok', actor: a.label, actorKind: 'agent', actorId: a.id, object: `Acknowledged ${m.id}`, result: 'Acknowledged', trk: trackingCode() })
        }
      }
      maybeFire(d, m)
    }
    // Occasionally an agent posts, or the blocked agent tries again.
    const roll = Math.random()
    const ws = d.workspaces.filter((w) => w.orgId === d.currentOrgId)
    if (roll < 0.1 && d.scenario === 'populated') {
      const w = ws[Math.floor(Math.random() * ws.length)]
      const posters = w?.members.filter((m) => m.kind === 'agent' && evaluate(d, m.id, w.id, 'write').allowed && isOnline(agentById(d, m.id)!))
      if (w && posters?.length) {
        const p = posters[Math.floor(Math.random() * posters.length)]
        const c = CHATTER[Math.floor(Math.random() * CHATTER.length)]
        const msg: Message = { id: shortId('msg'), wsId: w.id, author: { kind: 'agent', id: p.id }, body: c.body, tags: c.tags, audience: { mode: 'all' }, createdAt: now, expiresAt: w.defaultExpiryHours ? now + w.defaultExpiryHours * HOUR : null, receipts: {}, trk: trackingCode() }
        initReceipts(d, w, msg)
        d.messages.push(msg)
        log(d, { wsId: w.id, type: 'message', severity: 'ok', actor: principalName(d, msg.author), actorKind: 'agent', actorId: p.id, object: `Posted to ${w.name} · ${c.tags.map((t) => '#' + t).join(' ')}`, result: `For ${Object.values(msg.receipts).filter((r) => !r.filtered).length} agents`, trk: msg.trk, link: { label: 'Open the message', to: `/workspaces/${w.id}/messages?m=${msg.id}` } })
      }
    } else if (roll < 0.16) {
      for (const w of ws)
        for (const id of w.agentBlocklist) {
          const a = agentById(d, id)
          if (!a || a.status !== 'active') continue
          log(d, { wsId: w.id, type: 'blocked', severity: 'blocked', actor: a.label, actorKind: 'agent', actorId: a.id, object: `GET /v1/workspaces/${w.id}/messages`, result: 'Blocked', reason: `Blocked: ${w.name} blocks ${a.label} — the workspace blocklist overrides its membership.`, detail: [['Agent ID', a.id], ['Workspace ID', w.id], ['Rule', 'Workspace agent blocklist']], link: { label: `Open ${w.name} › Access`, to: `/workspaces/${w.id}/access` } })
          return
        }
    }
  })
}

export type { Human }
