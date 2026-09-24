import { useEffect, useState, useSyncExternalStore } from 'react'
import { evaluate, filteredReason, targets } from './access'
import { HOUR, MIN, clock, newAgentToken, newHookPassword, newWsToken, shortId, trackingCode, uid } from './format'
import { freshDB, populatedDB } from './seed'
import type { Agent, AgentFilters, Audience, AuditEvent, Author, ContextNote, DB, FireTrigger, Harness, Human, Membership, MemberRole, Message, OrgRole, Principal, Webhook, Workspace } from './types'

const LS_KEY = 'dispatch-mocks-v1'
const VERSION = 3

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
export const isOrgAdmin = (d: DB) => ['Owner', 'orgAdmin'].includes(myOrgRole(d) ?? '')
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
/** Admin of this workspace: its own admin role, or org Owner/orgAdmin. */
export const canAdmin = (d: DB, w: Workspace) => isOrgAdmin(d) || myMembership(d, w)?.role === 'admin'
export const canPost = (d: DB, w: Workspace) => isOrgAdmin(d) || !!myMembership(d, w)?.write

export const isOnline = (a: Agent) => a.status === 'active' && a.connected

export const isExpired = (m: Message, now = Date.now()) => m.expiresAt != null && m.expiresAt <= now
export type ReceiptState = 'queued' | 'delivered' | 'read' | 'acked' | 'filtered' | 'expired'
/** A receipt's state. Pass the message: one that expired before delivery reads "never delivered", not "queued". */
export function receiptState(r: Message['receipts'][string] | undefined, m?: Message, now = Date.now()): ReceiptState {
  if (r?.filtered) return 'filtered'
  if (m && isExpired(m, now) && !r?.deliveredAt) return 'expired'
  if (!r) return 'queued'
  if (r.ackAt) return 'acked'
  if (r.readAt) return 'read'
  if (r.deliveredAt) return 'delivered'
  return 'queued'
}

/* ------------------------------------------------------------------ */
/* Logging                                                             */
/* ------------------------------------------------------------------ */
export function log(d: DB, e: Partial<AuditEvent> & Pick<AuditEvent, 'object'>) {
  const ev: AuditEvent = {
    id: uid('ev'),
    at: Date.now(),
    orgId: d.currentOrgId,
    type: 'admin',
    severity: 'info',
    actor: me(d)?.name ?? 'Someone',
    actorKind: 'human',
    actorId: d.currentUserId,
    result: 'Done',
    trk: trackingCode(),
    ...e,
  }
  d.events.unshift(ev)
  return ev
}

/** Recompute who a message is for and mark filtered recipients. */
function initReceipts(d: DB, w: Workspace, msg: Message) {
  for (const id of targets(w, msg)) {
    const a = agentById(d, id)
    if (!a) continue
    const why = filteredReason(d, w, msg, a)
    msg.receipts[id] = why ? { filtered: why } : {}
    if (!why && isOnline(a)) msg.receipts[id].deliveredAt = Date.now()
  }
}

/**
 * Re-runs the access ladder for receipts that are still pending (not yet
 * acknowledged) on live messages. Access can change after a message was
 * sent — a block, a removal, a revoke, a filter — and a pending receipt
 * follows the rule that applies now: it becomes Filtered, naming the rule.
 * Filtered is final for that message; lifting the block affects later
 * messages. Returns how many receipts were filtered.
 */
export function recheckReceipts(d: DB, scope: { wsId?: string; agentId?: string } = {}): number {
  let n = 0
  const now = Date.now()
  for (const m of d.messages) {
    if ((scope.wsId && m.wsId !== scope.wsId) || isExpired(m, now)) continue
    const w = wsById(d, m.wsId)
    if (!w) continue
    let touched = false
    for (const [aid, r] of Object.entries(m.receipts)) {
      if ((scope.agentId && aid !== scope.agentId) || r.filtered || r.ackAt) continue
      const a = agentById(d, aid)
      const why = a ? filteredReason(d, w, m, a) : 'The agent no longer exists.'
      if (!why) continue
      r.filtered = why
      r.filteredAt = now
      touched = true
      n++
    }
    if (touched) maybeFire(d, m)
  }
  return n
}
const filteredNote = (n: number) => (n ? ` · ${n} pending receipt${n === 1 ? '' : 's'} filtered` : '')

/* Outbound webhooks: one call when the trigger is met, then up to 3 retries. */
export const RETRY_DELAYS = [30_000, 2 * MIN, 10 * MIN]
export const MAX_ATTEMPTS = RETRY_DELAYS.length + 1
const TRIGGER_TEXT: Record<FireTrigger, string> = { send: 'On send', 'all-read': 'When every target has read it', 'all-ack': 'When every target has acknowledged it' }
type FireHook = Extract<Webhook, { mode: 'fire' }>

/**
 * Where a fire webhook stands, for the UI. Filtered targets (blocked,
 * removed, revoked, suspended, filtered by the agent) drop out of "every
 * target"; if nobody is left, the hook can never fire and says so.
 */
export type FireState =
  | { k: 'waiting'; pending: string[]; total: number }
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
  if (h.outcome === 'expired' || isExpired(m, now)) return { k: 'expired', attempts: h.attempts.length }
  if (h.firedAt) return { k: 'retrying', next: h.nextAttemptAt ?? now, attempt: h.attempts.length + 1 }
  const live = Object.entries(m.receipts).filter(([, r]) => !r.filtered)
  if (h.trigger !== 'send' && !live.length) return { k: 'no-targets' }
  const pending = live.filter(([, r]) => !(h.trigger === 'all-read' ? r.readAt : r.ackAt)).map(([id]) => id)
  return { k: 'waiting', pending, total: live.length }
}

function settleHook(d: DB, msg: Message, hook: FireHook, outcome: 'no-targets' | 'expired') {
  hook.outcome = outcome
  hook.outcomeAt = Date.now()
  hook.nextAttemptAt = undefined
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
  const live = Object.values(msg.receipts).filter((r) => !r.filtered)
  if (hook.trigger !== 'send' && !live.length) return settleHook(d, msg, hook, 'no-targets')
  const ok = hook.trigger === 'send' || live.every((r) => (hook.trigger === 'all-read' ? r.readAt : r.ackAt))
  if (!ok) return
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
/** Expiring a message: its author (with write), or a workspace admin. */
export function mayExpire(d: DB, m: Message, by?: Actor) {
  const a = by ?? { kind: 'human' as const, id: d.currentUserId }
  const own = m.author.kind === a.kind && m.author.id === a.id
  return (own && mayWrite(d, m.wsId, by)) || mayAdmin(d, m.wsId, by)
}
export const hasHumanAdmin = (w: Workspace) => w.members.some((m) => m.kind === 'human' && m.role === 'admin')
/** Agent-only admin is allowed (agent parity), but it's flagged: org admins are then the only human backstop. */
function flagNoHumanAdmin(d: DB, w: Workspace, hadHuman: boolean, by?: Actor) {
  const admins = w.members.filter((m) => m.role === 'admin')
  if (!hadHuman || hasHumanAdmin(w) || !admins.length) return
  const names = admins.map((m) => principalName(d, m)).join(', ')
  log(d, { ...who(d, by).ev, wsId: w.id, severity: 'warn', object: `${w.name} now has no human admin — only ${names}`, result: 'Allowed · flagged', reason: `Agent admins can do everything a human admin can. Org Owners and orgAdmins keep admin on ${w.name} and can still step in.` })
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
    update((d) => void (d.currentUserId = id))
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
      d.workspaces.push({ id, orgId: d.currentOrgId, name: w.name, description: w.description, createdAt: Date.now(), members: [{ kind: 'human', id: d.currentUserId, role: 'admin', read: true, write: true, addedBy: me(d).name, addedAt: Date.now() }], agentBlocklist: [], defaultExpiryHours: w.defaultExpiryHours, retentionDays: 90 })
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
      if (!w) return
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
      const m: Membership = { kind: p.kind, id: p.id, role, read: p.kind === 'human' ? true : read, write, addedBy: a.ev.actor, addedAt: Date.now(), delegatedBy: role === 'admin' ? a.ev.actor : undefined }
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
      // A workspace always keeps at least one admin.
      if (patch.role === 'member' && m.role === 'admin' && w.members.filter((x) => x.role === 'admin').length === 1) return
      const a = who(d, by)
      const hadHuman = hasHumanAdmin(w)
      const was = m.role
      Object.assign(m, patch)
      if (m.kind === 'human') m.read = true
      if (patch.role === 'admin' && was !== 'admin') {
        m.delegatedBy = a.ev.actor
        log(d, { ...a.ev, wsId, object: `Delegated admin on ${w.name} to ${principalName(d, p)} (${p.kind})${a.asAdmin}` })
      } else if (patch.role === 'member' && was === 'admin') {
        m.delegatedBy = undefined
        log(d, { ...a.ev, wsId, object: `Removed admin on ${w.name} from ${principalName(d, p)}${a.asAdmin}` })
      } else {
        const n = p.kind === 'agent' ? recheckReceipts(d, { wsId, agentId: p.id }) : 0
        log(d, { ...a.ev, wsId, object: `Changed ${principalName(d, p)}'s access in ${w.name} → ${m.read ? 'read' : ''}${m.read && m.write ? ' + ' : ''}${m.write ? 'write' : ''}${!m.read && !m.write ? 'none' : ''}${a.asAdmin}`, result: `Done${filteredNote(n)}` })
      }
      flagNoHumanAdmin(d, w, hadHuman, by)
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
  removeMember(wsId: string, p: Principal, by?: Actor) {
    update((d) => {
      const w = wsById(d, wsId)
      const m = w?.members.find((x) => x.kind === p.kind && x.id === p.id)
      if (!w || !m || !mayAdmin(d, wsId, by)) return
      if (m.role === 'admin' && w.members.filter((x) => x.role === 'admin').length === 1) return
      const a = who(d, by)
      const hadHuman = hasHumanAdmin(w)
      w.members = w.members.filter((x) => x !== m)
      const n = p.kind === 'agent' ? recheckReceipts(d, { wsId, agentId: p.id }) : 0
      log(d, { ...a.ev, wsId, object: `Removed ${principalName(d, p)} from ${w.name}${p.kind === 'agent' ? ' — its workspace token stops working now' : ''}${a.asAdmin}`, result: `Done${filteredNote(n)}` })
      flagNoHumanAdmin(d, w, hadHuman, by)
    })
  },
  setWsBlocklist(wsId: string, ids: string[], by?: Actor) {
    update((d) => {
      const w = wsById(d, wsId)
      if (!w || !mayAdmin(d, wsId, by)) return
      const a = who(d, by)
      const added = ids.filter((x) => !w.agentBlocklist.includes(x))
      const removed = w.agentBlocklist.filter((x) => !ids.includes(x))
      w.agentBlocklist = ids
      for (const id of added) log(d, { ...a.ev, wsId, object: `Added ${agentById(d, id)?.label ?? id} to ${w.name} blocklist${a.asAdmin}`, result: `Done${filteredNote(recheckReceipts(d, { wsId, agentId: id }))}` })
      for (const id of removed) log(d, { ...a.ev, wsId, object: `Removed ${agentById(d, id)?.label ?? id} from ${w.name} blocklist${a.asAdmin}` })
    })
  },

  /* Agents */
  createAgent(a: { label: string; harness: Harness; description: string }) {
    const token = newAgentToken()
    const id = shortId('agt')
    sessionSecrets.set(`agent:${id}`, token)
    update((d) => {
      if (labelTaken(d, a.label)) return
      d.agents.push({ id, orgId: d.currentOrgId, label: a.label, harness: a.harness, description: a.description, tokenLast4: token.slice(-4), status: 'active', createdAt: Date.now(), createdBy: me(d).name, lastSeen: null, connected: false, filters: { read: true, write: true, workspaceBlocklist: [], agentBlocklist: [] } })
      log(d, { object: `Registered agent ${a.label} (${a.harness}) · ${id}` })
    })
    return { id, token }
  },
  /** New agent token. The old one keeps working for 10 minutes so a running agent can switch over. */
  rotateAgentToken(id: string, by?: Actor): string | null {
    const token = newAgentToken()
    let ok = false
    update((d) => {
      const a = agentById(d, id)
      if (!a || a.status === 'revoked' || !(by?.kind === 'agent' ? by.id === id : isOrgAdmin(d))) return
      const w = who(d, by)
      a.prevTokenLast4 = a.tokenLast4
      a.prevTokenUntil = Date.now() + TOKEN_GRACE
      a.tokenLast4 = token.slice(-4)
      const old = sessionSecrets.get(`agent:${id}`)
      if (old) sessionSecrets.set(`agent-prev:${id}`, old)
      else sessionSecrets.delete(`agent-prev:${id}`)
      sessionSecrets.set(`agent:${id}`, token)
      ok = true
      log(d, { ...w.ev, object: `Rotated agent token for ${a.label} → ••••${a.tokenLast4}`, result: `Old ••••${a.prevTokenLast4} works until ${clock(a.prevTokenUntil)}`, detail: [['Agent ID', a.id], ...w.detail] })
    })
    return ok ? token : null
  },
  setAgentStatus(id: string, status: Agent['status']) {
    update((d) => {
      const a = agentById(d, id)
      if (!a) return
      a.status = status
      if (status !== 'active') a.connected = false
      const n = status === 'active' ? 0 : recheckReceipts(d, { agentId: id })
      log(d, { object: `${status === 'active' ? 'Resumed' : status === 'suspended' ? 'Suspended' : 'Revoked'} agent ${a.label}`, result: `Done${filteredNote(n)}` })
    })
  },
  setAgentFilters(id: string, f: AgentFilters, by?: Actor) {
    update((d) => {
      const a = agentById(d, id)
      if (!a || !(by?.kind === 'agent' ? by.id === id : isOrgAdmin(d))) return
      a.filters = f
      const n = recheckReceipts(d, { agentId: id })
      log(d, { ...who(d, by).ev, object: `Updated ${a.label}'s own filters · read ${f.read ? 'on' : 'off'} · write ${f.write ? 'on' : 'off'} · ${f.workspaceBlocklist.length} blocked workspaces · ${f.agentBlocklist.length} blocked agents`, result: `Done${filteredNote(n)}` })
    })
  },
  renameAgent(id: string, label: string) {
    update((d) => {
      const a = agentById(d, id)
      if (!a || !label.trim() || labelTaken(d, label, id)) return
      const old = a.label
      a.label = label.trim()
      log(d, { object: `Renamed agent ${old} → ${a.label} · ${a.id}` })
    })
  },
  /** Prototype: the agent opens its MCP session / starts polling. Queued messages get delivered. */
  connectAgent(id: string, on = true) {
    update((d) => {
      const a = agentById(d, id)
      if (!a || a.status !== 'active') return
      a.connected = on
      a.lastSeen = Date.now()
      if (!on) return
      // Delivery re-checks access: whatever changed while the agent was away decides now.
      const filtered = recheckReceipts(d, { agentId: id })
      let n = 0
      for (const m of d.messages) {
        const r = m.receipts[id]
        if (r && !r.filtered && !r.deliveredAt && !isExpired(m)) {
          r.deliveredAt = Date.now()
          n++
        }
      }
      log(d, { type: 'access', severity: 'ok', actor: a.label, actorKind: 'agent', actorId: id, object: `Connected over ${a.harness === 'Other' ? 'REST' : 'MCP'}`, result: (n ? `${n} queued message${n === 1 ? '' : 's'} delivered` : 'Nothing queued') + filteredNote(filtered) })
    })
  },

  /* People */
  inviteHuman(email: string, role: OrgRole) {
    update((d) => {
      if (emailTaken(d, email)) return
      d.humans.push({ id: uid('u'), name: email.split('@')[0].replace(/^./, (c) => c.toUpperCase()), email, roles: { [d.currentOrgId]: role }, status: 'invited', lastActive: null, sessions: [] })
      log(d, { object: `Invited ${email} as ${role}` })
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
      log(d, {
        wsId: w.id,
        type: 'message',
        severity: 'ok',
        ...who(d, as).ev,
        object: `Posted to ${w.name}${m.tags.length ? ' · ' + m.tags.map((t) => '#' + t).join(' ') : ''}`,
        result: `For ${queued} agent${queued === 1 ? '' : 's'}${filtered ? ` · ${filtered} filtered` : ''}`,
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
      log(d, { ...w.ev, wsId: m.wsId, type: 'message', object: `Expired ${m.id} early${m.author.kind === w.ev.actorKind && m.author.id === w.ev.actorId ? '' : ` (${principalName(d, m.author)}’s message)`}${w.asAdmin && !(m.author.kind === 'agent' && m.author.id === w.ev.actorId) ? w.asAdmin : ''}`, result: [m.webhook?.mode === 'listen' ? 'Listener closed' : m.webhook?.mode === 'fire' && !m.webhook.outcome ? 'Webhook won’t fire' : 'Done', pending ? `${pending} never delivered` : ''].filter(Boolean).join(' · '), detail: w.detail.length ? w.detail : undefined })
      if (m.webhook?.mode === 'fire') maybeFire(d, m)
    })
  },
  /** Issues a new basic-auth password for a message's listener. The old one stops working now. */
  rotateListenerPassword(msgId: string, by?: Actor): string | null {
    const password = newHookPassword()
    let ok = false
    update((d) => {
      const m = d.messages.find((x) => x.id === msgId)
      if (!m || m.webhook?.mode !== 'listen' || isExpired(m) || !mayExpire(d, m, by)) return
      const w = who(d, by)
      const old = m.webhook.passwordLast4
      m.webhook.passwordLast4 = password.slice(-4)
      sessionSecrets.set(`hook:${m.id}`, password)
      ok = true
      log(d, { ...w.ev, wsId: m.wsId, type: 'webhook', severity: 'info', object: `Rotated listener password ${m.webhook.url.split('/').pop()} · message ${m.id}${m.author.id === w.ev.actorId ? '' : w.asAdmin}`, result: `••••${old} → ••••${m.webhook.passwordLast4}`, reason: 'The old password stops working now; calls using it get 401.', link: { label: 'Open the message', to: `/workspaces/${m.wsId}/messages?m=${m.id}` } })
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
      const why = w ? filteredReason(d, w, m, a) : 'The workspace no longer exists.'
      if (why) {
        if (!r.ackAt) {
          r.filtered = why
          r.filteredAt = Date.now()
        }
        log(d, { wsId: m.wsId, type: 'blocked', severity: 'blocked', actor: a.label, actorKind: 'agent', actorId: a.id, object: `${kind === 'ack' ? 'Acknowledge' : 'Read'} ${m.id}`, result: 'Refused · receipt filtered', reason: `Blocked: ${why}` })
        maybeFire(d, m)
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
      log(d, {
        wsId: e.wsId,
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
      filtered = recheckReceipts(d, { wsId, agentId })
      for (const m of d.messages) {
        const r = m.receipts[agentId]
        if (m.wsId !== wsId || !r || r.filtered || r.deliveredAt || isExpired(m)) continue
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
      if (!name.trim() || u.name === name.trim()) return
      const old = u.name
      u.name = name.trim()
      log(d, { object: `Renamed themselves ${old} → ${u.name}`, detail: [['Human ID', u.id]] })
    })
  },
  renameOrg(name: string) {
    update((d) => {
      const o = org(d)
      if (!o || !name.trim() || o.name === name.trim()) return
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
    // Access is re-checked before any receipt moves.
    recheckReceipts(d)
    webhookTick(d, now)
    // Progress receipts for online agents, one step at a time.
    for (const m of d.messages) {
      if (isExpired(m, now)) continue
      for (const [aid, r] of Object.entries(m.receipts)) {
        const a = agentById(d, aid)
        if (!a || !isOnline(a) || r.filtered || Math.random() < 0.55) continue
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
