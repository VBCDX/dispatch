export type OrgRole = 'Owner' | 'orgAdmin' | 'member'

export interface Org {
  id: string
  name: string
  createdAt: number
}

export interface Human {
  id: string
  name: string
  email: string
  roles: Record<string, OrgRole>
  status: 'active' | 'invited' | 'suspended'
  lastActive: number | null
  sessions: { device: string; place: string; at: number }[]
}

export type Harness = 'Claude Code' | 'Codex' | 'OpenCode' | 'Other'

/** An agent's own permission filters. They apply everywhere and beat anything a workspace grants. */
export interface AgentFilters {
  read: boolean
  write: boolean
  /** Workspaces this agent must never enter, even when invited. */
  workspaceBlocklist: string[]
  /** Agents whose messages this agent never receives. */
  agentBlocklist: string[]
}

export interface Agent {
  id: string // public agent ID, e.g. agt_7Hq2
  orgId: string
  label: string
  harness: Harness
  description: string
  tokenLast4: string
  status: 'active' | 'suspended' | 'revoked'
  createdAt: number
  createdBy: string
  lastSeen: number | null
  /** Holding an open connection (MCP session or polling the REST API). Offline agents' messages wait, queued. */
  connected: boolean
  filters: AgentFilters
}

export type MemberRole = 'admin' | 'member'
export type PrincipalKind = 'human' | 'agent'
export type Principal = { kind: PrincipalKind; id: string }

export interface Membership {
  kind: PrincipalKind
  id: string
  role: MemberRole
  read: boolean
  write: boolean
  /** Per-membership workspace token (agents only) — last four only. */
  tokenLast4?: string
  tokenRevoked?: boolean
  addedBy: string
  addedAt: number
  /** Set when admin was delegated, names who delegated it. */
  delegatedBy?: string
}

export interface Workspace {
  id: string // public workspace ID, e.g. wks_4f1c
  orgId: string
  name: string
  description: string
  createdAt: number
  members: Membership[]
  /** Workspace-side blocklist: agents that may never act here, whatever their membership says. */
  agentBlocklist: string[]
  defaultExpiryHours: number | null
  retentionDays: number
}

export type Audience = { mode: 'all' } | { mode: 'only'; agentIds: string[] } | { mode: 'except'; agentIds: string[] }

export interface Receipt {
  deliveredAt?: number
  readAt?: number
  ackAt?: number
  /** Not delivered because of a filter — says which one. */
  filtered?: string
}

export type FireTrigger = 'send' | 'all-read' | 'all-ack'

export interface WebhookAttempt {
  id: string
  at: number
  status: number
  ms: number
  trk: string
  note?: string
}

export interface ListenerCall {
  id: string
  at: number
  status: 202 | 401 | 410
  from: string
  bytes: number
  trk: string
  summary?: string
}

export type Webhook =
  | {
      mode: 'fire'
      url: string
      trigger: FireTrigger
      authUser: string
      authSet: boolean
      firedAt?: number
      attempts: WebhookAttempt[]
    }
  | {
      mode: 'listen'
      url: string
      authUser: string
      passwordLast4: string
      calls: ListenerCall[]
    }

export interface Message {
  id: string
  wsId: string
  author: Principal
  body: string
  payload?: string
  tags: string[]
  audience: Audience
  createdAt: number
  expiresAt: number | null
  parentId?: string
  receipts: Record<string, Receipt>
  webhook?: Webhook
  trk: string
  /** Appended by a webhook listener call. */
  viaWebhook?: boolean
}

export interface ContextNote {
  id: string
  wsId: string
  title: string
  body: string
  tags: string[]
  version: number
  updatedBy: string
  updatedAt: number
  history: { version: number; by: string; at: number }[]
}

export type EventType = 'message' | 'receipt' | 'webhook' | 'access' | 'blocked' | 'admin' | 'context'

export interface AuditEvent {
  id: string
  at: number
  orgId: string
  wsId?: string
  type: EventType
  severity: 'ok' | 'blocked' | 'warn' | 'info'
  actor: string
  actorKind: 'human' | 'agent' | 'webhook' | 'system'
  actorId?: string
  object: string
  result: string
  trk: string
  reason?: string
  detail?: [string, string][]
  link?: { label: string; to: string }
}

export interface DB {
  scenario: 'fresh' | 'populated'
  currentUserId: string
  currentOrgId: string
  checklistDismissed: boolean
  orgs: Org[]
  humans: Human[]
  agents: Agent[]
  workspaces: Workspace[]
  messages: Message[]
  notes: ContextNote[]
  events: AuditEvent[]
  notifications: Record<string, boolean>
  listState: 'normal' | 'loading' | 'error'
  live: boolean
}
