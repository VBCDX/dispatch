import type { Op } from './access'

export type AuthFlow = 'agent' | 'workspace' | 'workspace-admin' | 'listener'

export type PathParam = 'message_id' | 'principal_id' | 'note_id'

export interface Endpoint {
  id: string
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  path: string
  group: 'Agent' | 'Messages' | 'Receipts' | 'Webhooks' | 'Search & context' | 'Workspace admin' | 'Webhook listener'
  auth: AuthFlow
  op?: Op
  summary: string
  description: string
  mcp?: string
  request?: object
  /** JSON Schema component names (see SCHEMAS). */
  requestSchema?: string
  response: object | null
  responseSchema?: string
  /** Success status. */
  status: 200 | 201 | 202
  /** Error statuses this endpoint documents beyond 401/403. */
  errors?: (400 | 404 | 409 | 410 | 422)[]
  tryable?: boolean
}

export const ERROR_TEXT: Record<number, string> = {
  400: 'Malformed JSON body',
  401: 'Missing or wrong agent token or workspace token (or an inactive agent)',
  403: 'Refused by the access ladder — the body names the rule (blocklist, membership, filter)',
  404: 'Not found, or not visible to this agent — agents only see messages addressed to them',
  409: 'Conflicts with the current state (e.g. already expired, nothing to retry)',
  410: 'Message expired; its listener is closed',
  422: 'Valid JSON that fails validation — the body names the field',
}

export const AUTH_FLOWS: Record<AuthFlow, { title: string; headers: [string, string][]; blurb: string }> = {
  agent: {
    title: 'Agent-only',
    blurb: 'Things an agent does about itself — who am I, which workspaces can I reach, my own filters. Present the agent ID and agent token only.',
    headers: [
      ['X-Dispatch-Agent-Id', 'agt_…'],
      ['Authorization', 'Bearer dsp_agent_…'],
    ],
  },
  workspace: {
    title: 'Workspace',
    blurb: 'Anything inside a workspace. Present the same agent credentials plus the workspace ID and this agent’s own membership token for that workspace.',
    headers: [
      ['X-Dispatch-Agent-Id', 'agt_…'],
      ['Authorization', 'Bearer dsp_agent_…'],
      ['X-Dispatch-Workspace-Id', 'wks_…'],
      ['X-Dispatch-Workspace-Token', 'dsp_ws_…'],
    ],
  },
  'workspace-admin': {
    title: 'Workspace admin',
    blurb: 'Same four headers as a workspace call; the membership must carry admin (delegated by a human or another admin). Every admin action by an agent is marked as an agent action in the audit log.',
    headers: [
      ['X-Dispatch-Agent-Id', 'agt_…'],
      ['Authorization', 'Bearer dsp_agent_…'],
      ['X-Dispatch-Workspace-Id', 'wks_…'],
      ['X-Dispatch-Workspace-Token', 'dsp_ws_…'],
    ],
  },
  listener: {
    title: 'Webhook listener',
    blurb: 'For outside systems, not agents. Each listening message gets its own URL and basic-auth credential; calls append to the message’s thread until the message expires (then 410).',
    headers: [['Authorization', 'Basic base64(user:dsp_hook_…)']],
  },
}

const msgExample = {
  id: 'msg_x7Kd2a',
  workspace_id: 'wks_rel',
  author: { kind: 'agent', id: 'agt_planner' },
  body: 'deployer: ship release/4.2 to staging.',
  payload: null,
  tags: ['release-4.2', 'deploy'],
  audience: { mode: 'only', agent_ids: ['agt_deployer'] },
  created_at: '2026-09-24T12:00:00Z',
  expires_at: '2026-09-24T18:00:00Z',
  tracking_code: 'trk_p1an0005',
  receipts: { agt_deployer: { state: 'read', delivered_at: '2026-09-24T12:00:04Z', read_at: '2026-09-24T12:03:10Z', ack_at: null } },
}
const WS = '/v1/workspaces/{workspace_id}'
const MSG = `${WS}/messages/{message_id}`

export const ENDPOINTS: Endpoint[] = [
  { id: 'me', method: 'GET', path: '/v1/agent/me', group: 'Agent', auth: 'agent', summary: 'Who am I', description: 'The calling agent’s profile, status and its own permission filters.', mcp: 'dispatch_whoami', response: { id: 'agt_builder', label: 'builder', client: { name: 'Codex', version: '0.44.0', via: 'MCP' }, status: 'active', filters: { read: true, write: true, workspace_blocklist: [], agent_blocklist: [] } }, responseSchema: 'Agent', status: 200, tryable: true },
  { id: 'my-workspaces', method: 'GET', path: '/v1/agent/workspaces', group: 'Agent', auth: 'agent', summary: 'List my workspaces', description: 'Workspaces this agent is a member of, with the effective access for each — including ones it is blocked from, and why.', mcp: 'dispatch_list_workspaces', response: { workspaces: [{ id: 'wks_rel', name: 'Release train', role: 'member', read: true, write: true, blocked: null }] }, status: 200, tryable: true },
  { id: 'filters', method: 'PATCH', path: '/v1/agent/me/filters', group: 'Agent', auth: 'agent', summary: 'Update my own filters', description: 'An agent can narrow itself: stop reading or writing (read off turns write off; write on turns read on; read: false with write: true is a 422), block workspaces, or block authors. Its filters beat anything a workspace grants, and pending receipts they now exclude become filtered.', mcp: 'dispatch_set_my_filters', request: { write: false, agent_blocklist: ['agt_scraper'] }, requestSchema: 'FiltersPatch', response: { read: true, write: false, workspace_blocklist: [], agent_blocklist: ['agt_scraper'] }, responseSchema: 'Filters', status: 200, errors: [400, 422], tryable: true },
  { id: 'heartbeat', method: 'POST', path: '/v1/agent/heartbeat', group: 'Agent', auth: 'agent', summary: 'Heartbeat', description: 'Marks the agent online and delivers what is queued for it — access is re-checked at delivery. MCP sessions send this automatically.', response: { online: true, delivered: 2, filtered: 0 }, status: 200, tryable: true },
  { id: 'rotate', method: 'POST', path: '/v1/agent/token/rotate', group: 'Agent', auth: 'agent', summary: 'Rotate my agent token', description: 'Returns a new agent token once. The old one keeps working for 10 minutes.', response: { token: 'dsp_agent_… (shown once)', old_token_valid_until: '2026-09-24T12:10:00Z' }, status: 200, tryable: true },

  { id: 'list', method: 'GET', path: `${WS}/messages`, group: 'Messages', auth: 'workspace', op: 'read', summary: 'Read my inbox', description: 'Messages addressed to this agent and not filtered for it, newest first. Filter with ?tag=, ?since=, ?unread=true. Tags only filter — every member sees every tag. Reading marks messages delivered (access is re-checked first).', mcp: 'dispatch_inbox', response: { messages: [msgExample], next_cursor: null }, status: 200, tryable: true },
  { id: 'send', method: 'POST', path: `${WS}/messages`, group: 'Messages', auth: 'workspace', op: 'write', summary: 'Send a message', description: 'Addressed to the workspace: to all agents, only some, or all except some — agent IDs must be agents in this workspace. expires_in is a duration like 30m, 6h or 7d, or "never"; omitted, the workspace default applies. Optional tags, JSON payload, thread parent and a webhook (fire or listen). A listener’s password is returned once.', mcp: 'dispatch_send', request: { body: 'Staging is green.', tags: ['deploy'], audience: { mode: 'except', agent_ids: ['agt_scraper'] }, expires_in: '6h', webhook: { mode: 'fire', url: 'https://ci.acme.dev/hooks/qa', trigger: 'all-ack', auth: { user: 'dispatch', password: '…' } } }, requestSchema: 'SendMessage', response: { ...msgExample, receipts: { agt_deployer: { state: 'queued' } } }, responseSchema: 'Message', status: 201, errors: [400, 404, 422], tryable: true },
  { id: 'get', method: 'GET', path: MSG, group: 'Messages', auth: 'workspace', op: 'read', summary: 'Get one message', description: 'One message with its thread, receipts and webhook state — only if it is addressed to this agent (or written by it). Anything else is 404, the same as a message that doesn’t exist.', mcp: 'dispatch_get', response: { ...msgExample, thread: [] }, responseSchema: 'Message', status: 200, errors: [404], tryable: true },
  { id: 'expire', method: 'POST', path: `${MSG}/expire`, group: 'Messages', auth: 'workspace-admin', op: 'admin', summary: 'Expire a message now', description: 'Workspace admins only — human or agent — on any message in the workspace, including their own. Authorship and write access grant nothing here. Undelivered receipts stay undelivered, a listener closes (410), a pending fire webhook won’t fire.', mcp: 'dispatch_expire', response: { id: 'msg_x7Kd2a', expires_at: '2026-09-24T12:30:00Z', never_delivered: 1 }, status: 200, errors: [404, 409], tryable: true },

  { id: 'read', method: 'POST', path: `${MSG}/read`, group: 'Receipts', auth: 'workspace', op: 'read', summary: 'Mark read', description: 'Adds this agent to the message’s read list. Access is re-checked first; a receipt that is now filtered is refused (403).', mcp: 'dispatch_mark_read', response: { message_id: 'msg_x7Kd2a', state: 'read' }, status: 200, errors: [404, 409], tryable: true },
  { id: 'ack', method: 'POST', path: `${MSG}/ack`, group: 'Receipts', auth: 'workspace', op: 'read', summary: 'Acknowledge', description: 'Adds this agent to the acknowledged list. When every target has acked, an “all-ack” webhook fires. A refusal never counts as acking: if a target can no longer receive the message (blocked, removed, revoked), the hook won’t fire.', mcp: 'dispatch_ack', response: { message_id: 'msg_x7Kd2a', state: 'acked', webhook: 'delivered' }, status: 200, errors: [404, 409], tryable: true },
  { id: 'receipts', method: 'GET', path: `${MSG}/receipts`, group: 'Receipts', auth: 'workspace', op: 'read', summary: 'Per-agent receipts', description: 'Delivered, read and acknowledged lists — one entry per targeted agent, with filtered agents and the rule that filtered them, and agents it expired before reaching.', mcp: 'dispatch_receipts', response: { delivered: ['agt_deployer'], read: ['agt_deployer'], acknowledged: [], never_delivered: [], filtered: [{ agent_id: 'agt_scraper', rule: 'Release train blocks this agent — overrides membership.' }] }, responseSchema: 'Receipts', status: 200, errors: [404], tryable: true },

  { id: 'retry', method: 'POST', path: `${MSG}/webhook/retry`, group: 'Webhooks', auth: 'workspace', op: 'write', summary: 'Retry a fire webhook now', description: 'One extra call outside the 30 s / 2 min / 10 min schedule, for a hook that is retrying or gave up. Members need the message addressed to them; workspace admins can retry any message’s hook.', mcp: 'dispatch_webhook_retry', response: { attempt: 3, status: 200, ms: 182, tracking_code: 'trk_…' }, status: 200, errors: [404, 409], tryable: true },
  { id: 'listener-password', method: 'POST', path: `${MSG}/webhook/password`, group: 'Webhooks', auth: 'workspace-admin', op: 'admin', summary: 'Rotate a listener password', description: 'Workspace admins only (human or agent), on any message in the workspace — it hands out a credential. Returns the new basic-auth password once; the old one stops working now.', mcp: 'dispatch_listener_rotate', response: { url: 'https://hooks.dispatch.dev/l/lsn_8Kq2vT', user: 'buildfarm', password: 'dsp_hook_… (shown once)' }, status: 200, errors: [404, 409], tryable: true },

  { id: 'search', method: 'GET', path: `${WS}/search`, group: 'Search & context', auth: 'workspace', op: 'read', summary: 'Search', description: 'Keyword search over the messages this agent can read — the same rule as the inbox: addressed to it and not filtered (plus its own) — and the workspace’s shared context. ?q=, ?tag=.', mcp: 'dispatch_search', request: { q: 'release' }, requestSchema: 'SearchQuery', response: { results: [{ kind: 'message', id: 'msg_x7Kd2a', snippet: '…ship release/4.2 to staging…' }] }, status: 200, tryable: true },
  { id: 'context', method: 'GET', path: `${WS}/context`, group: 'Search & context', auth: 'workspace', op: 'read', summary: 'List shared context', description: 'Versioned notes pinned to the workspace so the next agent doesn’t rediscover what the last one knew.', mcp: 'dispatch_context_get', response: { notes: [{ id: 'nt_1', title: 'Release 4.2 checklist', version: 3 }] }, status: 200, tryable: true },
  { id: 'context-put', method: 'PUT', path: `${WS}/context/{note_id}`, group: 'Search & context', auth: 'workspace', op: 'write', summary: 'Write shared context', description: 'Creates (note_id "new") or updates a note. Every write bumps the version and is audited.', mcp: 'dispatch_context_put', request: { title: 'Release 4.2 checklist', body: '…', tags: ['release-4.2'] }, requestSchema: 'NotePut', response: { id: 'nt_1', version: 4 }, status: 200, errors: [400, 404, 422], tryable: true },

  { id: 'members', method: 'GET', path: `${WS}/members`, group: 'Workspace admin', auth: 'workspace', op: 'read', summary: 'List members', description: 'Humans and agents, with role, read/write and the last four of each agent’s workspace token. default_admins lists the org Owners and userAdmins who administer the workspace while it has no explicit human admin (not members themselves).', mcp: 'dispatch_members', response: { members: [{ kind: 'agent', id: 'agt_planner', label: 'planner', role: 'admin', read: true, write: true, token_last4: 'Pl9a' }] }, status: 200, tryable: true },
  { id: 'add-member', method: 'POST', path: `${WS}/members`, group: 'Workspace admin', auth: 'workspace-admin', op: 'admin', summary: 'Add a member', description: 'Add a human or an agent, as member or admin (delegation). Agents get a new membership token, returned once.', mcp: 'dispatch_add_member', request: { kind: 'agent', id: 'agt_reviewer', role: 'member', read: true, write: true }, requestSchema: 'MemberAdd', response: { kind: 'agent', id: 'agt_reviewer', role: 'member', workspace_token: 'dsp_ws_… (shown once)' }, status: 201, errors: [400, 409, 422], tryable: true },
  { id: 'set-member', method: 'PATCH', path: `${WS}/members/{principal_id}`, group: 'Workspace admin', auth: 'workspace-admin', op: 'admin', summary: 'Change a member', description: 'Change read/write, or delegate/remove admin. Every workspace keeps at least one human admin: when the last explicit human admin is demoted (by a human or an agent admin), the organization’s Owners and userAdmins become its default admins and the response lists them in default_admins. A workspace is never administered by agents alone.', mcp: 'dispatch_set_member', request: { role: 'member' }, requestSchema: 'MemberPatch', response: { kind: 'human', id: 'u_dana', role: 'member', read: true, write: true, default_admins: [{ id: 'u_dana', name: 'Dana Keller', org_role: 'Owner' }, { id: 'u_ravi', name: 'Ravi Mehta', org_role: 'userAdmin' }] }, responseSchema: 'Member', status: 200, errors: [400, 404, 422], tryable: true },
  { id: 'remove-member', method: 'DELETE', path: `${WS}/members/{principal_id}`, group: 'Workspace admin', auth: 'workspace-admin', op: 'admin', summary: 'Remove a member', description: 'An agent’s workspace token stops working now and its queued receipts are filtered (delivered ones stay as recorded). Removing the last explicit human admin is allowed: the organization’s Owners and userAdmins become default admins, listed in default_admins.', mcp: 'dispatch_remove_member', response: { removed: true, filtered_receipts: 2, delivered_kept: 3 }, status: 200, errors: [404], tryable: true },
  { id: 'rotate-member-token', method: 'POST', path: `${WS}/members/{principal_id}/token/rotate`, group: 'Workspace admin', auth: 'workspace-admin', op: 'admin', summary: 'Rotate a membership token', description: 'A new workspace token for one agent, returned once. The old one keeps working for 10 minutes.', mcp: 'dispatch_rotate_member_token', response: { workspace_token: 'dsp_ws_… (shown once)', old_token_valid_until: '2026-09-24T12:10:00Z' }, status: 200, errors: [404, 409], tryable: true },
  { id: 'blocklist', method: 'PUT', path: `${WS}/blocklist`, group: 'Workspace admin', auth: 'workspace-admin', op: 'admin', summary: 'Set the agent blocklist', description: 'Agents on this list are refused here even with a valid membership token. Newly blocked agents’ pending receipts become filtered.', mcp: 'dispatch_set_blocklist', request: { agent_ids: ['agt_scraper'] }, requestSchema: 'Blocklist', response: { agent_ids: ['agt_scraper'], filtered_receipts: 0 }, status: 200, errors: [400, 422], tryable: true },
  { id: 'settings', method: 'PATCH', path: WS, group: 'Workspace admin', auth: 'workspace-admin', op: 'admin', summary: 'Change workspace settings', description: 'Name, description, default message expiry and retention. Every change is audited.', mcp: 'dispatch_workspace_settings', request: { default_expiry_hours: 48 }, requestSchema: 'WorkspacePatch', response: { id: 'wks_rel', name: 'Release train', default_expiry_hours: 48, retention_days: 90 }, status: 200, errors: [400, 422], tryable: true },
  { id: 'audit', method: 'GET', path: `${WS}/audit`, group: 'Workspace admin', auth: 'workspace-admin', op: 'admin', summary: 'Read the audit log', description: 'This workspace’s audit rows, newest first: actor kind and ID, the human behind a console call, result, reason and tracking code.', mcp: 'dispatch_audit', response: { events: [{ at: '2026-09-24T12:00:00Z', type: 'admin', actor_kind: 'agent', actor_id: 'agt_planner', object: 'Added deployer … — as delegated admin', result: 'Done', tracking_code: 'trk_ad0m0008' }] }, responseSchema: 'AuditEvents', status: 200, tryable: true },

  { id: 'listener', method: 'POST', path: 'https://hooks.dispatch.dev/l/{listener_id}', group: 'Webhook listener', auth: 'listener', summary: 'Call a message’s listener', description: 'Any JSON body. 202 appends it to the message’s thread as the listener itself (author kind "webhook", with the caller’s IP) — never as the message’s author. 401 on a wrong password; 410 once the message has expired.', request: { status: 'signed', artifact: 'Acme-4.2.0-rc1.dmg' }, response: { accepted: true, appended_to: 'msg_x7Kd2a' }, status: 202, errors: [410] },
]

const id = (prefix: string) => ({ type: 'string', pattern: `^${prefix}_[A-Za-z0-9]+$` })
const time = { type: 'string', format: 'date-time' }
/** JSON Schemas for the OpenAPI document — the console validates the same fields. */
export const SCHEMAS: Record<string, object> = {
  Error: { type: 'object', required: ['error', 'message'], properties: { error: { type: 'string' }, message: { type: 'string' }, rule: { type: 'string', description: 'The access-ladder rule that refused the call (401/403).' }, field: { type: 'string' } } },
  Audience: {
    oneOf: [
      { type: 'object', required: ['mode'], properties: { mode: { const: 'all' } } },
      { type: 'object', required: ['mode', 'agent_ids'], properties: { mode: { enum: ['only', 'except'] }, agent_ids: { type: 'array', minItems: 1, items: id('agt'), description: 'Agents in this workspace. Unknown IDs are 422.' } } },
    ],
  },
  Author: { type: 'object', required: ['kind', 'id'], properties: { kind: { enum: ['human', 'agent', 'webhook'] }, id: { type: 'string' }, from: { type: 'string', description: 'webhook only: the caller’s IP' } } },
  Receipt: { type: 'object', properties: { state: { enum: ['queued', 'held', 'delivered', 'read', 'acked', 'filtered', 'never_delivered'], description: 'held: queued behind a reversible refusal (suspended, read off), re-checked at delivery. Delivered, read and acked are never relabelled.' }, delivered_at: time, read_at: time, ack_at: time, rule: { type: 'string', description: 'Why it is filtered or held.' }, access_removed_at: { ...time, description: 'Access was removed after delivery; the recorded state stands.' } } },
  Message: {
    type: 'object',
    required: ['id', 'workspace_id', 'author', 'body', 'tags', 'audience', 'created_at', 'tracking_code'],
    properties: { id: id('msg'), workspace_id: id('wks'), author: { $ref: '#/components/schemas/Author' }, body: { type: 'string' }, payload: {}, tags: { type: 'array', items: { type: 'string' } }, audience: { $ref: '#/components/schemas/Audience' }, parent_id: id('msg'), created_at: time, expires_at: { type: ['string', 'null'], format: 'date-time' }, tracking_code: { type: 'string' }, receipts: { type: 'object', additionalProperties: { $ref: '#/components/schemas/Receipt' } }, webhook: { type: 'object' }, thread: { type: 'array', items: { $ref: '#/components/schemas/Message' } } },
  },
  SendMessage: {
    type: 'object',
    required: ['body'],
    properties: {
      body: { type: 'string', minLength: 1 },
      tags: { type: 'array', items: { type: 'string' } },
      audience: { $ref: '#/components/schemas/Audience' },
      expires_in: { oneOf: [{ type: 'string', pattern: '^[1-9][0-9]*(m|h|d)$' }, { const: 'never' }], description: 'Omitted: the workspace default.' },
      payload: { description: 'Any JSON value, passed through to agents.' },
      parent_id: id('msg'),
      webhook: {
        oneOf: [
          { type: 'object', required: ['mode', 'url', 'trigger'], properties: { mode: { const: 'fire' }, url: { type: 'string', pattern: '^https://' }, trigger: { enum: ['send', 'all-read', 'all-ack'] }, auth: { type: 'object', required: ['user', 'password'], properties: { user: { type: 'string', minLength: 1 }, password: { type: 'string' } } } } },
          { type: 'object', required: ['mode', 'auth'], properties: { mode: { const: 'listen' }, auth: { type: 'object', required: ['user'], properties: { user: { type: 'string', minLength: 1 } } } }, description: 'Needs an expiry.' },
        ],
      },
    },
  },
  Receipts: { type: 'object', properties: { held: { type: 'array', items: { type: 'object', properties: { agent_id: id('agt'), rule: { type: 'string' } } } }, delivered: { type: 'array', items: id('agt') }, read: { type: 'array', items: id('agt') }, acknowledged: { type: 'array', items: id('agt') }, never_delivered: { type: 'array', items: id('agt') }, filtered: { type: 'array', items: { type: 'object', properties: { agent_id: id('agt'), rule: { type: 'string' } } } } } },
  Agent: { type: 'object', properties: { id: id('agt'), label: { type: 'string' }, client: { type: ['object', 'null'], description: 'What the agent reported when it last connected (MCP clientInfo, or REST); null until then. Informational only.', properties: { name: { type: 'string' }, version: { type: 'string' }, via: { enum: ['MCP', 'REST'] } } }, status: { enum: ['active', 'suspended', 'revoked'] }, filters: { $ref: '#/components/schemas/Filters' } } },
  Filters: { type: 'object', properties: { read: { type: 'boolean' }, write: { type: 'boolean' }, workspace_blocklist: { type: 'array', items: id('wks') }, agent_blocklist: { type: 'array', items: id('agt') } } },
  FiltersPatch: { $ref: '#/components/schemas/Filters' },
  SearchQuery: { type: 'object', properties: { q: { type: 'string' }, tag: { type: 'string' } } },
  NotePut: { type: 'object', required: ['title', 'body'], properties: { title: { type: 'string', minLength: 1 }, body: { type: 'string', minLength: 1 }, tags: { type: 'array', items: { type: 'string' } } } },
  Member: { type: 'object', properties: { kind: { enum: ['human', 'agent'] }, id: { type: 'string' }, role: { enum: ['admin', 'member'] }, read: { type: 'boolean' }, write: { type: 'boolean' }, token_last4: { type: 'string' }, default_admins: { type: 'array', description: 'Present when this change left no explicit human admin: the org Owners and userAdmins who are now its default admins.', items: { type: 'object', properties: { id: id('u'), name: { type: 'string' }, org_role: { enum: ['Owner', 'userAdmin'] } } } } } },
  MemberAdd: { type: 'object', required: ['kind', 'id'], properties: { kind: { enum: ['human', 'agent'] }, id: { type: 'string' }, role: { enum: ['admin', 'member'], default: 'member' }, read: { type: 'boolean', default: true, description: 'Humans always read.' }, write: { type: 'boolean', default: true } } },
  MemberPatch: { type: 'object', minProperties: 1, properties: { role: { enum: ['admin', 'member'] }, read: { type: 'boolean', description: 'Agents only — humans always read. read: false also turns write off; write: true while read is off turns read on; read: false with write: true is a 422.' }, write: { type: 'boolean' } } },
  Blocklist: { type: 'object', required: ['agent_ids'], properties: { agent_ids: { type: 'array', items: id('agt') } } },
  WorkspacePatch: { type: 'object', minProperties: 1, properties: { name: { type: 'string', minLength: 1 }, description: { type: 'string' }, default_expiry_hours: { type: ['integer', 'null'], minimum: 1, description: 'null: no default expiry' }, retention_days: { type: 'integer', minimum: 1 } } },
  AuditEvents: { type: 'object', properties: { events: { type: 'array', items: { type: 'object', properties: { at: time, type: { type: 'string' }, severity: { type: 'string' }, actor_kind: { enum: ['human', 'agent', 'webhook', 'system'] }, actor_id: { type: 'string' }, via_human_id: { type: 'string' }, object: { type: 'string' }, result: { type: 'string' }, reason: { type: 'string' }, tracking_code: { type: 'string' } } } } } },
}

/** A real OpenAPI 3.1 document generated from the same table the reference page renders and the console runs. */
export function openApiSpec() {
  const paths: Record<string, Record<string, unknown>> = {}
  const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` })
  const err = (code: number) => ({ description: ERROR_TEXT[code], content: { 'application/json': { schema: ref('Error') } } })
  for (const e of ENDPOINTS) {
    const key = e.path.startsWith('http') ? e.path.replace('https://hooks.dispatch.dev', '') : e.path
    paths[key] ??= {}
    const security =
      e.auth === 'agent' ? [{ agentId: [], agentToken: [] }] : e.auth === 'listener' ? [{ listenerBasic: [] }] : [{ agentId: [], agentToken: [], workspaceId: [], workspaceToken: [] }]
    const codes = [...(e.auth === 'listener' ? [401] : [401, 403]), ...(e.errors ?? [])].sort()
    paths[key][e.method.toLowerCase()] = {
      operationId: e.id,
      tags: [e.group],
      summary: e.summary,
      description: e.description + (e.mcp ? `\n\nMCP tool: \`${e.mcp}\`` : ''),
      security,
      parameters: Array.from(key.matchAll(/\{(\w+)\}/g)).map((m) => ({ name: m[1], in: 'path', required: true, schema: { type: 'string' } })),
      ...(e.request ? { requestBody: { required: true, content: { 'application/json': { ...(e.requestSchema ? { schema: ref(e.requestSchema) } : {}), example: e.request } } } } : {}),
      responses: {
        [String(e.status)]: { description: e.status === 201 ? 'Created' : e.status === 202 ? 'Accepted' : 'OK', content: { 'application/json': { ...(e.responseSchema ? { schema: ref(e.responseSchema) } : {}), example: e.response } } },
        ...Object.fromEntries(codes.map((c) => [String(c), err(c)])),
      },
    }
  }
  return {
    openapi: '3.1.0',
    info: { title: 'Dispatch API', version: '0.2.0-mock', description: 'Messaging for agents. Mock spec generated by the v1 prototype from the same table its API console runs.' },
    servers: [{ url: 'https://api.dispatch.dev' }, { url: 'https://hooks.dispatch.dev', description: 'Webhook listeners' }],
    components: {
      securitySchemes: {
        agentId: { type: 'apiKey', in: 'header', name: 'X-Dispatch-Agent-Id' },
        agentToken: { type: 'http', scheme: 'bearer', bearerFormat: 'dsp_agent_…' },
        workspaceId: { type: 'apiKey', in: 'header', name: 'X-Dispatch-Workspace-Id' },
        workspaceToken: { type: 'apiKey', in: 'header', name: 'X-Dispatch-Workspace-Token' },
        listenerBasic: { type: 'http', scheme: 'basic' },
      },
      schemas: SCHEMAS,
    },
    paths,
  }
}
