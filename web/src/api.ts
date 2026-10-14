// Thin client for the Dispatch JSON API. Requests are same-origin and carry
// the session cookie; state-changing calls send the session's CSRF token.

/** One VBCDX app in the suite switcher (SUITE_APPS); current is this app. */
export type SuiteApp = { name: string; url: string; current: boolean }

export type AuthConfig = {
  local: boolean
  zitadel: boolean
  /** Try a silent single sign-on (prompt=none) before showing the sign-in page. */
  silent_sign_in: boolean
  suite_apps: SuiteApp[]
  /** GA4 measurement id; empty means analytics is off. Public config. */
  ga_measurement_id: string
}

export type Me = {
  user: { id: string; email: string; name: string }
  method: 'local' | 'zitadel'
  session_started_at: string
  session_expires_at: string
  csrf_token: string
}

export class ApiError extends Error {
  status: number
  code: string
  retryAfter: number | null

  constructor(status: number, code: string, message: string, retryAfter: number | null) {
    super(message)
    this.status = status
    this.code = code
    this.retryAfter = retryAfter
  }
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, { credentials: 'same-origin', ...init })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    const retry = res.headers.get('Retry-After')
    throw new ApiError(res.status, body.error ?? 'error', body.message ?? res.statusText, retry ? Number(retry) : null)
  }
  if (res.status === 204) return undefined as T
  return res.json() as Promise<T>
}

export const api = {
  authConfig: () => call<AuthConfig>('/api/auth/config'),

  me: async (): Promise<Me | null> => {
    try {
      return await call<Me>('/api/me')
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return null
      throw e
    }
  },

  login: (email: string, password: string) =>
    call<Me>('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    }),

  logout: (csrfToken: string) =>
    call<{ redirect_url: string }>('/api/auth/logout', {
      method: 'POST',
      headers: { 'X-CSRF-Token': csrfToken },
    }),
}

// The read API under /api/v1/. Anything outside the signed-in user's
// organizations comes back 404.

export type OrgRole = 'Owner' | 'userAdmin' | 'user'
export type MemberStatus = 'active' | 'invited' | 'suspended'

export type Org = { id: string; name: string; role: OrgRole; status: MemberStatus }

export type Workspace = {
  id: string
  name: string
  description: string
  default_expiry_hours: number | null
  retention_days: number
  blocked_agents: number
  created_at: string
  humans: number
  agents: number
  messages_24h: number
  waiting: number
  webhooks: number
  /** The user's own membership role; null when they see it as an org Owner or userAdmin. */
  my_role: 'member' | 'workspace_admin' | null
  can_admin: boolean
}

const seg = encodeURIComponent

export const v1 = {
  orgs: () => call<{ orgs: Org[] }>('/api/v1/orgs').then((r) => r.orgs),
  workspaces: (org: string) => call<{ workspaces: Workspace[] }>(`/api/v1/orgs/${seg(org)}/workspaces`).then((r) => r.workspaces),
  workspace: (org: string, ws: string) => call<{ workspace: Workspace }>(`/api/v1/orgs/${seg(org)}/workspaces/${seg(ws)}`).then((r) => r.workspace),
}

// Workspace and people management. Writes carry the session's CSRF token;
// the server checks the caller's role on every one (403 when you can see
// the thing but may not change it, 404 when you can't see it).

export type WorkspaceRole = 'member' | 'workspace_admin'
export type PrincipalRef = { kind: string; id: string; label: string }
export type TokenInfo = { prefix: string; last4: string; issued_at: string }
export type Credential = { current: TokenInfo; previous: TokenInfo | null; previous_until: string | null }
export type Client = { name: string; version?: string; via: 'MCP' | 'REST' }

export type Member = {
  id: string
  kind: 'user' | 'agent'
  member_id: string
  name: string
  email?: string
  org_role?: OrgRole
  org_status?: MemberStatus
  role: WorkspaceRole
  read: boolean
  write: boolean
  added_at: string
  added_by: PrincipalRef | null
  delegated_by: PrincipalRef | null
  agent_status?: 'active' | 'suspended' | 'revoked'
  last_seen_at?: string | null
  client?: Client | null
  token?: Credential | null
  token_revoked?: boolean
}
export type DefaultAdmin = { user_id: string; name: string; email: string; org_role: OrgRole }
export type Members = { members: Member[]; default_admins: DefaultAdmin[]; can_admin: boolean }

export type AgentRef = { id: string; label: string }
export type AgentFilterNote = { id: string; label: string; member: boolean; blocks_workspace: boolean; read: boolean; write: boolean; blocks_authors: string[] }
export type Access = { blocklist: AgentRef[]; agent_filters: AgentFilterNote[]; agents: AgentRef[]; can_admin: boolean }
export type LadderOp = 'read' | 'write' | 'admin'
export type Ladder = { allowed: boolean; reason: string; steps: { rule: string; pass: boolean; detail: string }[] }

export type AuditEvent = {
  id: string
  at: string
  workspace: { id: string; name: string; deleted: boolean } | null
  shared: boolean
  type: string
  severity: 'ok' | 'blocked' | 'warn' | 'info'
  actor: { kind: string; id?: string; label: string; via: PrincipalRef | null }
  subject: PrincipalRef | null
  object: string
  result: string
  reason?: string
  trk: string
  changes?: { field: string; before: unknown; after: unknown }[]
  detail?: Record<string, unknown>
  link: { label: string; to: string } | null
}

export type Person = {
  user_id: string
  membership_id: string
  name: string
  email: string
  role: OrgRole
  status: MemberStatus
  suspended_from?: MemberStatus
  joined_at: string | null
  last_active_at: string | null
  workspaces: number
  invitation: { id: string; invited_at: string; invited_by: PrincipalRef | null; expires_at: string } | null
  can_manage: boolean
  is_me: boolean
}
/** What an invite link offers the signed-in person. */
export type InvitationOffer = { org: { id: string; name: string }; email: string; role: OrgRole; invited_by: string; expires_at: string }
export type People = { people: Person[]; can_invite: boolean; my_role: OrgRole }

export type AgentWorkspace = { id: string; name: string; role: WorkspaceRole; read: boolean; write: boolean; blocked: boolean }
export type Agent = {
  id: string
  label: string
  status: 'active' | 'suspended' | 'revoked'
  description: string
  client: Client | null
  last_transport?: string
  last_seen_at: string | null
  created_at: string
  created_by_label: string
  token: Credential | null
  filters: { read: boolean; write: boolean; workspace_blocklist: AgentRef[]; agent_blocklist: AgentRef[] }
  workspaces: AgentWorkspace[]
}
export type Sidecar = { id: string; name: string; status: string; health: string; last_seen_at: string | null; version?: string; created_at: string }

export type WorkspaceSettings = { name?: string; description?: string; default_expiry_hours?: number | null; retention_days?: number }

const json = (csrf: string, method: string, body?: unknown): RequestInit => ({
  method,
  headers: body === undefined ? { 'X-CSRF-Token': csrf } : { 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
})

export const manage = {
  createWorkspace: (csrf: string, org: string, w: WorkspaceSettings) =>
    call<{ workspace: Workspace }>(`/api/v1/orgs/${seg(org)}/workspaces`, json(csrf, 'POST', w)).then((r) => r.workspace),
  updateWorkspace: (csrf: string, org: string, ws: string, w: WorkspaceSettings) =>
    call<{ workspace: Workspace }>(`/api/v1/orgs/${seg(org)}/workspaces/${seg(ws)}`, json(csrf, 'PATCH', w)).then((r) => r.workspace),
  deleteWorkspace: (csrf: string, org: string, ws: string) => call<void>(`/api/v1/orgs/${seg(org)}/workspaces/${seg(ws)}`, json(csrf, 'DELETE')),

  members: (org: string, ws: string) => call<Members>(`/api/v1/orgs/${seg(org)}/workspaces/${seg(ws)}/members`),
  addMember: (csrf: string, org: string, ws: string, m: { kind: 'user' | 'agent'; id: string; role: WorkspaceRole; read: boolean; write: boolean }) =>
    call<{ member: Member }>(`/api/v1/orgs/${seg(org)}/workspaces/${seg(ws)}/members`, json(csrf, 'POST', m)).then((r) => r.member),
  updateMember: (csrf: string, org: string, ws: string, id: string, p: { role?: WorkspaceRole; read?: boolean; write?: boolean }) =>
    call<{ member: Member }>(`/api/v1/orgs/${seg(org)}/workspaces/${seg(ws)}/members/${seg(id)}`, json(csrf, 'PATCH', p)).then((r) => r.member),
  removeMember: (csrf: string, org: string, ws: string, id: string) => call<void>(`/api/v1/orgs/${seg(org)}/workspaces/${seg(ws)}/members/${seg(id)}`, json(csrf, 'DELETE')),

  access: (org: string, ws: string) => call<Access>(`/api/v1/orgs/${seg(org)}/workspaces/${seg(ws)}/access`),
  checkAccess: (org: string, ws: string, agent: string, op: LadderOp) =>
    call<Ladder>(`/api/v1/orgs/${seg(org)}/workspaces/${seg(ws)}/access/check?agent=${seg(agent)}&op=${op}`),
  setBlocked: (csrf: string, org: string, ws: string, agent: string, blocked: boolean) =>
    call<{ changed: boolean }>(`/api/v1/orgs/${seg(org)}/workspaces/${seg(ws)}/access/blocklist/${seg(agent)}`, json(csrf, blocked ? 'PUT' : 'DELETE')),

  orgAudit: (org: string) => call<{ events: AuditEvent[] }>(`/api/v1/orgs/${seg(org)}/audit?limit=500`).then((r) => r.events),
  workspaceAudit: (org: string, ws: string) => call<{ events: AuditEvent[] }>(`/api/v1/orgs/${seg(org)}/workspaces/${seg(ws)}/audit?limit=500`).then((r) => r.events),
  agentAudit: (org: string, agent: string) => call<{ events: AuditEvent[] }>(`/api/v1/orgs/${seg(org)}/audit?limit=200&actor=${seg(agent)}`).then((r) => r.events),

  people: (org: string) => call<People>(`/api/v1/orgs/${seg(org)}/people`),
  /** invite_url is shown once: single use, it expires with the invitation (7 days). */
  invite: (csrf: string, org: string, email: string, role: OrgRole) =>
    call<{ person: Person; invite_url: string }>(`/api/v1/orgs/${seg(org)}/invitations`, json(csrf, 'POST', { email, role })),
  previewInvitation: (csrf: string, token: string) => call<{ invitation: InvitationOffer }>('/api/v1/invitations/preview', json(csrf, 'POST', { token })).then((r) => r.invitation),
  acceptInvitation: (csrf: string, token: string) => call<{ invitation: InvitationOffer }>('/api/v1/invitations/accept', json(csrf, 'POST', { token })).then((r) => r.invitation),
  setOrgRole: (csrf: string, org: string, user: string, role: OrgRole) => call<void>(`/api/v1/orgs/${seg(org)}/people/${seg(user)}`, json(csrf, 'PATCH', { role })),
  suspend: (csrf: string, org: string, user: string) => call<void>(`/api/v1/orgs/${seg(org)}/people/${seg(user)}/suspend`, json(csrf, 'POST', {})),
  resume: (csrf: string, org: string, user: string) => call<void>(`/api/v1/orgs/${seg(org)}/people/${seg(user)}/resume`, json(csrf, 'POST', {})),
  removePerson: (csrf: string, org: string, user: string) => call<void>(`/api/v1/orgs/${seg(org)}/people/${seg(user)}`, json(csrf, 'DELETE')),

  agents: (org: string) => call<{ agents: Agent[] }>(`/api/v1/orgs/${seg(org)}/agents`).then((r) => r.agents),
  agent: (org: string, id: string) => call<{ agent: Agent; sidecars: Sidecar[] }>(`/api/v1/orgs/${seg(org)}/agents/${seg(id)}`),
}

// Messaging and agent connections.

export type Author = { kind: 'agent' | 'user' | 'listener'; id: string; label: string }

export type Message = {
  id: string
  author: Author
  body: string
  payload?: unknown
  /** The thread's first message, on replies. */
  thread_id?: string
  created_at: string
  /** Position in the message stream; absent for messages that never went through it (demo data). */
  seq?: number
}

export type AgentMember = {
  agent_id: string
  label: string
  status: 'active' | 'suspended' | 'revoked'
  read: boolean
  write: boolean
  token_prefix: string
  token_last4: string
  token_issued_at: string
  token_revoked_at: string | null
  added_at: string
  online: boolean
  /** Every message with seq <= acked_seq is acknowledged by this agent. */
  acked_seq: number
}

export type MessagesPage = { messages: Message[]; agents: AgentMember[]; can_post: boolean; can_admin: boolean }

/** A one-time answer carrying plaintext tokens. */
export type Connection = {
  agent: { id: string; name: string }
  workspace: { id: string; name: string }
  agent_token?: string
  workspace_token?: string
  server_url: string
  /** Set on a rotation: the old token keeps working until then. */
  old_token_valid_until?: string
}

function post<T>(path: string, csrf: string, body: unknown = {}) {
  return call<T>(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
    body: JSON.stringify(body),
  })
}

const wsPath = (org: string, ws: string) => `/api/v1/orgs/${seg(org)}/workspaces/${seg(ws)}`

export const messaging = {
  messages: (org: string, ws: string) => call<MessagesPage>(`${wsPath(org, ws)}/messages?limit=200`),
  post: (org: string, ws: string, csrf: string, body: string, threadId?: string) =>
    post<{ message: Message; seq: number }>(`${wsPath(org, ws)}/messages`, csrf, threadId ? { body, thread_id: threadId } : { body }),
  agents: (org: string, ws: string) => call<{ agents: AgentMember[]; can_admin: boolean; server_url: string }>(`${wsPath(org, ws)}/agents`),
  connectNew: (org: string, ws: string, csrf: string, label: string) => post<Connection>(`${wsPath(org, ws)}/agents`, csrf, { label }),
  rotateWorkspaceToken: (org: string, ws: string, csrf: string, agent: string) => post<Connection>(`${wsPath(org, ws)}/agents/${seg(agent)}/token/rotate`, csrf),
  revokeWorkspaceToken: (org: string, ws: string, csrf: string, agent: string) => post<{ revoked: boolean }>(`${wsPath(org, ws)}/agents/${seg(agent)}/token/revoke`, csrf),
  rotateAgentToken: (org: string, csrf: string, agent: string) => post<{ agent_token: string; old_token_valid_until: string | null }>(`/api/v1/orgs/${seg(org)}/agents/${seg(agent)}/token/rotate`, csrf),
  revokeAgent: (org: string, csrf: string, agent: string) => post<{ revoked: boolean }>(`/api/v1/orgs/${seg(org)}/agents/${seg(agent)}/revoke`, csrf),
}

// Webhooks: outgoing webhooks and incoming listeners (docs/webhooks.md).

export type WebhookFilter = { author_kinds: ('agent' | 'user' | 'listener')[]; author_ids: string[]; threads: 'all' | 'roots' | 'replies'; contains: string }
export type Webhook = {
  id: string
  name: string
  url: string
  filter: WebhookFilter
  paused: boolean
  secret_last4: string
  secret_rotated_at: string
  created_at: string
  created_by: string
}
export type WebhookAttempt = { at: string; status: number; ms: number; note?: string }
export type WebhookDelivery = {
  id: string
  webhook_id: string
  message_id: string
  seq: number
  state: 'retrying' | 'delivered' | 'dead' | 'dropped'
  attempt_count: number
  attempts: WebhookAttempt[]
  next_attempt_at: string | null
  updated_at: string
}
export type DeadLetter = { id: string; webhook_id: string; delivery_id: string; message_id: string; url: string; attempts: WebhookAttempt[]; dead_at: string }
export type Listener = {
  id: string
  name: string
  url: string
  paused: boolean
  secret_last4: string
  secret_rotated_at: string
  call_count: number
  last_call_at: string | null
  created_at: string
  created_by: string
}
export type ListenerCall = { id: string; listener_id: string; at: string; status: number; from_ip?: string; bytes: number; message_id?: string; summary?: string }
export type WebhooksTab = {
  webhooks: Webhook[]
  listeners: Listener[]
  deliveries: WebhookDelivery[]
  dead_letters: DeadLetter[]
  listener_calls: ListenerCall[]
  can_admin: boolean
  allow_private: boolean
  available: boolean
}
export type WebhookInput = { name?: string; url?: string; filter?: Partial<WebhookFilter>; paused?: boolean }

export const hooks = {
  tab: (org: string, ws: string) => call<WebhooksTab>(`${wsPath(org, ws)}/webhooks`),
  create: (csrf: string, org: string, ws: string, w: WebhookInput) => call<{ webhook: Webhook; secret: string }>(`${wsPath(org, ws)}/webhooks`, json(csrf, 'POST', w)),
  update: (csrf: string, org: string, ws: string, id: string, w: WebhookInput) => call<{ webhook: Webhook }>(`${wsPath(org, ws)}/webhooks/${seg(id)}`, json(csrf, 'PATCH', w)),
  rotate: (csrf: string, org: string, ws: string, id: string) => call<{ webhook: Webhook; secret: string }>(`${wsPath(org, ws)}/webhooks/${seg(id)}/secret/rotate`, json(csrf, 'POST', {})),
  remove: (csrf: string, org: string, ws: string, id: string) => call<void>(`${wsPath(org, ws)}/webhooks/${seg(id)}`, json(csrf, 'DELETE')),
  redeliver: (csrf: string, org: string, ws: string, id: string) => call<{ delivery_id: string }>(`${wsPath(org, ws)}/webhook-dead-letters/${seg(id)}/redeliver`, json(csrf, 'POST', {})),
  createListener: (csrf: string, org: string, ws: string, name: string) => call<{ listener: Listener; secret: string }>(`${wsPath(org, ws)}/listeners`, json(csrf, 'POST', { name })),
  updateListener: (csrf: string, org: string, ws: string, id: string, p: { name?: string; paused?: boolean }) =>
    call<{ listener: Listener }>(`${wsPath(org, ws)}/listeners/${seg(id)}`, json(csrf, 'PATCH', p)),
  rotateListener: (csrf: string, org: string, ws: string, id: string) => call<{ listener: Listener; secret: string }>(`${wsPath(org, ws)}/listeners/${seg(id)}/secret/rotate`, json(csrf, 'POST', {})),
  removeListener: (csrf: string, org: string, ws: string, id: string) => call<void>(`${wsPath(org, ws)}/listeners/${seg(id)}`, json(csrf, 'DELETE')),
}
