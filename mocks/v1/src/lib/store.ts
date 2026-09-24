import { useEffect, useState, useSyncExternalStore } from 'react'
import { evaluate, filteredReason, targets } from './access'
import { HOUR, newAgentToken, newHookPassword, newWsToken, shortId, trackingCode, uid } from './format'
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
  const [now, setNow] = useState(Date.now())
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

/** Fires a message's outbound webhook once its trigger is satisfied. */
export function maybeFire(d: DB, msg: Message) {
  const hook = msg.webhook
  if (!hook || hook.mode !== 'fire' || hook.firedAt || isExpired(msg)) return
  const live = Object.values(msg.receipts).filter((r) => !r.filtered)
  const ok = hook.trigger === 'send' || (live.length > 0 && live.every((r) => (hook.trigger === 'all-read' ? r.readAt : r.ackAt)))
  if (!ok) return
  hook.firedAt = Date.now()
  const failing = /fail|down|500/.test(hook.url)
  const trk = trackingCode()
  const ms = failing ? 10_000 : 120 + Math.floor(Math.random() * 200)
  hook.attempts.push({ id: uid('wa'), at: Date.now(), status: failing ? 504 : 200, ms, trk, note: failing ? 'Timed out after 10 s — retrying in 30 s' : undefined })
  const host = hook.url.replace(/^https?:\/\//, '')
  log(d, {
    wsId: msg.wsId,
    type: 'webhook',
    severity: failing ? 'warn' : 'ok',
    actor: 'Dispatch',
    actorKind: 'system',
    object: `Fired ${host} · ${msg.id}`,
    result: failing ? '504 · retrying' : `200 · ${ms} ms`,
    trk,
    reason: failing ? 'The endpoint didn’t answer in 10 s. Dispatch retries 3 times with backoff (30 s, 2 min, 10 min).' : undefined,
    detail: [['Trigger', { send: 'On send', 'all-read': 'When every target has read it', 'all-ack': 'When every target has acknowledged it' }[hook.trigger]], ['Auth', hook.authSet ? `Basic · ${hook.authUser}` : 'None']],
    link: { label: 'Open the message', to: `/workspaces/${msg.wsId}/messages?m=${msg.id}` },
  })
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
  updateWorkspace(id: string, patch: Partial<Pick<Workspace, 'name' | 'description' | 'defaultExpiryHours' | 'retentionDays'>>) {
    update((d) => {
      const w = wsById(d, id)
      if (w) Object.assign(w, patch)
    })
  },
  deleteWorkspace(id: string) {
    update((d) => {
      const w = wsById(d, id)
      if (!w) return
      d.workspaces = d.workspaces.filter((x) => x.id !== id)
      d.messages = d.messages.filter((m) => m.wsId !== id)
      d.notes = d.notes.filter((n) => n.wsId !== id)
      log(d, { object: `Deleted workspace ${w.name}` })
    })
  },

  /** Adds an agent or human. Agents get a per-membership workspace token, returned once. */
  addMember(wsId: string, p: Principal, role: MemberRole, read: boolean, write: boolean): string | null {
    let token: string | null = null
    update((d) => {
      const w = wsById(d, wsId)
      if (!w || w.members.some((m) => m.kind === p.kind && m.id === p.id)) return
      // Humans in a workspace always read everything; only writing is optional.
      const m: Membership = { kind: p.kind, id: p.id, role, read: p.kind === 'human' ? true : read, write, addedBy: me(d).name, addedAt: Date.now(), delegatedBy: role === 'admin' ? me(d).name : undefined }
      if (p.kind === 'agent') {
        token = newWsToken()
        sessionSecrets.set(`ws:${wsId}:${p.id}`, token)
        m.tokenLast4 = token.slice(-4)
      }
      w.members.push(m)
      log(d, { wsId, object: `Added ${principalName(d, p)} (${p.kind}) to ${w.name} as ${role}${p.kind === 'agent' ? ` · token ••••${m.tokenLast4}` : ''}` })
    })
    return token
  },
  setMember(wsId: string, p: Principal, patch: Partial<Pick<Membership, 'role' | 'read' | 'write'>>) {
    update((d) => {
      const w = wsById(d, wsId)
      const m = w?.members.find((x) => x.kind === p.kind && x.id === p.id)
      if (!w || !m) return
      const was = m.role
      Object.assign(m, patch)
      if (patch.role === 'admin' && was !== 'admin') {
        m.delegatedBy = me(d).name
        log(d, { wsId, object: `Delegated admin on ${w.name} to ${principalName(d, p)} (${p.kind})` })
      } else if (patch.role === 'member' && was === 'admin') {
        m.delegatedBy = undefined
        log(d, { wsId, object: `Removed admin on ${w.name} from ${principalName(d, p)}` })
      } else {
        const n = p.kind === 'agent' ? recheckReceipts(d, { wsId, agentId: p.id }) : 0
        log(d, { wsId, object: `Changed ${principalName(d, p)}'s access in ${w.name} → ${m.read ? 'read' : ''}${m.read && m.write ? ' + ' : ''}${m.write ? 'write' : ''}${!m.read && !m.write ? 'none' : ''}`, result: `Done${filteredNote(n)}` })
      }
    })
  },
  rotateMemberToken(wsId: string, agentId: string) {
    const token = newWsToken()
    sessionSecrets.set(`ws:${wsId}:${agentId}`, token)
    update((d) => {
      const m = wsById(d, wsId)?.members.find((x) => x.kind === 'agent' && x.id === agentId)
      if (!m) return
      m.tokenLast4 = token.slice(-4)
      m.tokenRevoked = false
      log(d, { wsId, object: `Rotated ${agentById(d, agentId)?.label}'s workspace token → ••••${m.tokenLast4}` })
    })
    return token
  },
  removeMember(wsId: string, p: Principal) {
    update((d) => {
      const w = wsById(d, wsId)
      if (!w) return
      w.members = w.members.filter((m) => !(m.kind === p.kind && m.id === p.id))
      const n = p.kind === 'agent' ? recheckReceipts(d, { wsId, agentId: p.id }) : 0
      log(d, { wsId, object: `Removed ${principalName(d, p)} from ${w.name}${p.kind === 'agent' ? ' — its workspace token stops working now' : ''}`, result: `Done${filteredNote(n)}` })
    })
  },
  setWsBlocklist(wsId: string, ids: string[]) {
    update((d) => {
      const w = wsById(d, wsId)
      if (!w) return
      const added = ids.filter((x) => !w.agentBlocklist.includes(x))
      const removed = w.agentBlocklist.filter((x) => !ids.includes(x))
      w.agentBlocklist = ids
      for (const id of added) log(d, { wsId, object: `Added ${agentById(d, id)?.label} to ${w.name} blocklist`, result: `Done${filteredNote(recheckReceipts(d, { wsId, agentId: id }))}` })
      for (const id of removed) log(d, { wsId, object: `Removed ${agentById(d, id)?.label} from ${w.name} blocklist` })
    })
  },

  /* Agents */
  createAgent(a: { label: string; harness: Harness; description: string }) {
    const token = newAgentToken()
    const id = shortId('agt')
    sessionSecrets.set(`agent:${id}`, token)
    update((d) => {
      d.agents.push({ id, orgId: d.currentOrgId, label: a.label, harness: a.harness, description: a.description, tokenLast4: token.slice(-4), status: 'active', createdAt: Date.now(), createdBy: me(d).name, lastSeen: null, connected: false, filters: { read: true, write: true, workspaceBlocklist: [], agentBlocklist: [] } })
      log(d, { object: `Registered agent ${a.label} (${a.harness}) · ${id}` })
    })
    return { id, token }
  },
  rotateAgentToken(id: string) {
    const token = newAgentToken()
    sessionSecrets.set(`agent:${id}`, token)
    update((d) => {
      const a = agentById(d, id)
      if (!a) return
      a.tokenLast4 = token.slice(-4)
      log(d, { object: `Rotated agent token for ${a.label}` })
    })
    return token
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
  setAgentFilters(id: string, f: AgentFilters) {
    update((d) => {
      const a = agentById(d, id)
      if (!a) return
      a.filters = f
      const n = recheckReceipts(d, { agentId: id })
      log(d, { object: `Updated ${a.label}'s own filters · read ${f.read ? 'on' : 'off'} · write ${f.write ? 'on' : 'off'} · ${f.workspaceBlocklist.length} blocked workspaces · ${f.agentBlocklist.length} blocked agents`, result: `Done${filteredNote(n)}` })
    })
  },
  renameAgent(id: string, label: string) {
    update((d) => {
      const a = agentById(d, id)
      if (a && label.trim()) a.label = label.trim()
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
      d.humans.push({ id: uid('u'), name: email.split('@')[0].replace(/^./, (c) => c.toUpperCase()), email, roles: { [d.currentOrgId]: role }, status: 'invited', lastActive: null, sessions: [] })
      log(d, { object: `Invited ${email} as ${role}` })
    })
  },

  /* Messages */
  postMessage(m: { wsId: string; body: string; payload?: string; tags: string[]; audience: Audience; expiresInHours: number | null; parentId?: string; webhook?: { mode: 'fire'; url: string; trigger: FireTrigger; authUser: string; authSet: boolean } | { mode: 'listen'; authUser: string } }, as?: Principal) {
    const id = shortId('msg')
    let hookPassword: string | null = null
    let listenUrl: string | null = null
    update((d) => {
      const w = wsById(d, m.wsId)
      if (!w) return
      const author = as ?? { kind: 'human' as const, id: d.currentUserId }
      let webhook: Webhook | undefined
      if (m.webhook?.mode === 'fire') webhook = { ...m.webhook, attempts: [] }
      if (m.webhook?.mode === 'listen') {
        hookPassword = newHookPassword()
        sessionSecrets.set(`hook:${id}`, hookPassword)
        listenUrl = `https://hooks.dispatch.dev/l/lsn_${shortId('lsn').slice(4)}`
        webhook = { mode: 'listen', url: listenUrl, authUser: m.webhook.authUser, passwordLast4: hookPassword.slice(-4), calls: [] }
      }
      const msg: Message = { id, wsId: m.wsId, author, body: m.body, payload: m.payload || undefined, tags: m.tags, audience: m.audience, createdAt: Date.now(), expiresAt: m.expiresInHours ? Date.now() + m.expiresInHours * HOUR : null, parentId: m.parentId, receipts: {}, webhook, trk: trackingCode() }
      initReceipts(d, w, msg)
      d.messages.push(msg)
      const rs = Object.values(msg.receipts)
      const queued = rs.filter((r) => !r.filtered).length
      const filtered = rs.length - queued
      log(d, {
        wsId: w.id,
        type: 'message',
        severity: 'ok',
        actor: principalName(d, author),
        actorKind: author.kind,
        actorId: author.id,
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
  expireNow(msgId: string) {
    update((d) => {
      const m = d.messages.find((x) => x.id === msgId)
      if (!m) return
      m.expiresAt = Date.now()
      log(d, { wsId: m.wsId, type: 'message', object: `Expired ${m.id} early`, result: m.webhook?.mode === 'listen' ? 'Listener closed' : 'Done' })
    })
  },
  /** Issues a new basic-auth password for a message's listener. The old one stops working now. */
  rotateListenerPassword(msgId: string): string | null {
    const password = newHookPassword()
    let ok = false
    update((d) => {
      const m = d.messages.find((x) => x.id === msgId)
      if (!m || m.webhook?.mode !== 'listen' || isExpired(m)) return
      const old = m.webhook.passwordLast4
      m.webhook.passwordLast4 = password.slice(-4)
      sessionSecrets.set(`hook:${m.id}`, password)
      ok = true
      log(d, { wsId: m.wsId, type: 'webhook', severity: 'info', object: `Rotated listener password ${m.webhook.url.split('/').pop()} · message ${m.id}`, result: `••••${old} → ••••${m.webhook.passwordLast4}`, reason: 'The old password stops working now; calls using it get 401.', link: { label: 'Open the message', to: `/workspaces/${m.wsId}/messages?m=${m.id}` } })
    })
    return ok ? password : null
  },
  retryWebhook(msgId: string) {
    update((d) => {
      const m = d.messages.find((x) => x.id === msgId)
      if (!m || m.webhook?.mode !== 'fire') return
      const trk = trackingCode()
      const ms = 140 + Math.floor(Math.random() * 120)
      m.webhook.attempts.push({ id: uid('wa'), at: Date.now(), status: 200, ms, trk, note: 'Manual retry' })
      log(d, { wsId: m.wsId, type: 'webhook', severity: 'ok', actor: me(d).name, actorKind: 'human', object: `Retried ${m.webhook.url.replace(/^https?:\/\//, '')} · ${m.id}`, result: `200 · ${ms} ms`, trk })
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
  /** Records an API call in the audit log, allowed or refused. */
  logApiCall(e: { agentId: string; wsId?: string; line: string; allowed: boolean; reason?: string | null; status: number }) {
    update((d) => {
      const a = agentById(d, e.agentId)
      log(d, {
        wsId: e.wsId,
        type: e.allowed ? 'access' : 'blocked',
        severity: e.allowed ? 'ok' : 'blocked',
        actor: a?.label ?? e.agentId,
        actorKind: 'agent',
        actorId: e.agentId,
        object: e.line,
        result: e.allowed ? `${e.status}` : `${e.status} · refused`,
        reason: e.allowed ? undefined : `Blocked: ${e.reason}`,
        detail: [['Agent ID', e.agentId], ...(e.wsId ? ([['Workspace ID', e.wsId]] as [string, string][]) : []), ['Source', 'API console (prototype)']],
      })
    })
  },

  /* Context */
  saveNote(n: { id?: string; wsId: string; title: string; body: string; tags: string[] }) {
    update((d) => {
      const by = me(d).name
      if (n.id) {
        const ex = d.notes.find((x) => x.id === n.id)
        if (!ex) return
        Object.assign(ex, { title: n.title, body: n.body, tags: n.tags, version: ex.version + 1, updatedBy: by, updatedAt: Date.now() })
        ex.history.push({ version: ex.version, by, at: Date.now() })
        log(d, { wsId: n.wsId, type: 'context', object: `Updated context “${n.title}” → v${ex.version}` })
      } else {
        const note: ContextNote = { id: uid('nt'), wsId: n.wsId, title: n.title, body: n.body, tags: n.tags, version: 1, updatedBy: by, updatedAt: Date.now(), history: [{ version: 1, by, at: Date.now() }] }
        d.notes.push(note)
        log(d, { wsId: n.wsId, type: 'context', object: `Added context “${n.title}”` })
      }
    })
  },

  /* Settings */
  toggleNotification(k: string) {
    update((d) => void (d.notifications[k] = !d.notifications[k]))
  },
  renameMe(name: string) {
    update((d) => void (me(d).name = name))
  },
  renameOrg(name: string) {
    update((d) => {
      const o = org(d)
      if (o && name.trim()) o.name = name.trim()
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
