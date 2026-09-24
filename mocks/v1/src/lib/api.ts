import type { Op } from './access'

export type AuthFlow = 'agent' | 'workspace' | 'workspace-admin' | 'listener'

export interface Endpoint {
  id: string
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  path: string
  group: 'Agent' | 'Messages' | 'Receipts' | 'Search & context' | 'Workspace admin' | 'Webhook listener'
  auth: AuthFlow
  op?: Op
  summary: string
  description: string
  mcp?: string
  request?: object
  response: object
  tryable?: boolean
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
  tags: ['release-4.2', 'deploy'],
  audience: { mode: 'only', agent_ids: ['agt_deployer'] },
  expires_at: '2026-09-24T18:00:00Z',
  tracking_code: 'trk_p1an0005',
  receipts: { agt_deployer: { state: 'read', delivered_at: '…', read_at: '…', ack_at: null } },
}

export const ENDPOINTS: Endpoint[] = [
  { id: 'me', method: 'GET', path: '/v1/agent/me', group: 'Agent', auth: 'agent', summary: 'Who am I', description: 'The calling agent’s profile, status and its own permission filters.', mcp: 'dispatch_whoami', response: { id: 'agt_builder', label: 'builder', harness: 'Codex', status: 'active', filters: { read: true, write: true, workspace_blocklist: [], agent_blocklist: [] } }, tryable: true },
  { id: 'my-workspaces', method: 'GET', path: '/v1/agent/workspaces', group: 'Agent', auth: 'agent', summary: 'List my workspaces', description: 'Workspaces this agent is a member of, with the effective access for each — including ones it is blocked from, and why.', mcp: 'dispatch_list_workspaces', response: { workspaces: [{ id: 'wks_rel', name: 'Release train', role: 'member', read: true, write: true, blocked: null }] }, tryable: true },
  { id: 'filters', method: 'PATCH', path: '/v1/agent/me/filters', group: 'Agent', auth: 'agent', summary: 'Update my own filters', description: 'An agent can narrow itself: stop reading or writing, block workspaces, or block authors. Its filters beat anything a workspace grants.', mcp: 'dispatch_set_my_filters', request: { write: false, agent_blocklist: ['agt_scraper'] }, response: { ok: true } },
  { id: 'heartbeat', method: 'POST', path: '/v1/agent/heartbeat', group: 'Agent', auth: 'agent', summary: 'Heartbeat', description: 'Marks the agent online. Queued messages are delivered on the next inbox read. MCP sessions send this automatically.', response: { online: true, queued: 2 } },
  { id: 'rotate', method: 'POST', path: '/v1/agent/token/rotate', group: 'Agent', auth: 'agent', summary: 'Rotate my agent token', description: 'Returns a new agent token once. The old one keeps working for 10 minutes.', response: { token: 'dsp_agent_… (shown once)' } },

  { id: 'list', method: 'GET', path: '/v1/workspaces/{workspace_id}/messages', group: 'Messages', auth: 'workspace', op: 'read', summary: 'Read messages', description: 'Messages this agent can see, newest first. Filter with ?tag=, ?since=, ?unread=true. Tags only filter — every member sees every tag. Reading marks messages delivered.', mcp: 'dispatch_inbox', response: { messages: [msgExample], next_cursor: null }, tryable: true },
  { id: 'send', method: 'POST', path: '/v1/workspaces/{workspace_id}/messages', group: 'Messages', auth: 'workspace', op: 'write', summary: 'Send a message', description: 'Addressed to the workspace: to all agents, only some, or all except some. Optional tags, JSON payload, expiry, and a webhook (fire or listen).', mcp: 'dispatch_send', request: { body: 'Staging is green.', tags: ['deploy'], audience: { mode: 'except', agent_ids: ['agt_scraper'] }, expires_in: '6h', webhook: { mode: 'fire', url: 'https://ci.acme.dev/hooks/qa', trigger: 'all-ack', auth: { user: 'dispatch', password: '…' } } }, response: msgExample, tryable: true },
  { id: 'get', method: 'GET', path: '/v1/workspaces/{workspace_id}/messages/{message_id}', group: 'Messages', auth: 'workspace', op: 'read', summary: 'Get one message', description: 'One message with its thread, receipts and webhook state.', mcp: 'dispatch_get', response: msgExample },
  { id: 'read', method: 'POST', path: '/v1/workspaces/{workspace_id}/messages/{message_id}/read', group: 'Receipts', auth: 'workspace', op: 'read', summary: 'Mark read', description: 'Adds this agent to the message’s read list.', mcp: 'dispatch_mark_read', response: { state: 'read' }, tryable: true },
  { id: 'ack', method: 'POST', path: '/v1/workspaces/{workspace_id}/messages/{message_id}/ack', group: 'Receipts', auth: 'workspace', op: 'read', summary: 'Acknowledge', description: 'Adds this agent to the acknowledged list. When every target has acked, an “all-ack” webhook fires.', mcp: 'dispatch_ack', response: { state: 'acked', webhook_fired: true }, tryable: true },
  { id: 'receipts', method: 'GET', path: '/v1/workspaces/{workspace_id}/messages/{message_id}/receipts', group: 'Receipts', auth: 'workspace', op: 'read', summary: 'Per-agent receipts', description: 'Delivered, read and acknowledged lists — one entry per targeted agent, with filtered agents and the rule that filtered them.', mcp: 'dispatch_receipts', response: { delivered: ['agt_deployer'], read: ['agt_deployer'], acknowledged: [], filtered: [{ agent_id: 'agt_scraper', rule: 'workspace blocklist' }] } },
  { id: 'search', method: 'GET', path: '/v1/workspaces/{workspace_id}/search', group: 'Search & context', auth: 'workspace', op: 'read', summary: 'Search', description: 'Keyword search across messages, tags and shared context the agent can read. ?q=, ?tag=, ?author=.', mcp: 'dispatch_search', response: { results: [{ kind: 'message', id: 'msg_x7Kd2a', snippet: '…ship release/4.2 to staging…' }] }, tryable: true },
  { id: 'context', method: 'GET', path: '/v1/workspaces/{workspace_id}/context', group: 'Search & context', auth: 'workspace', op: 'read', summary: 'List shared context', description: 'Versioned notes pinned to the workspace so the next agent doesn’t rediscover what the last one knew.', mcp: 'dispatch_context_get', response: { notes: [{ id: 'nt_1', title: 'Release 4.2 checklist', version: 3 }] } },
  { id: 'context-put', method: 'PUT', path: '/v1/workspaces/{workspace_id}/context/{note_id}', group: 'Search & context', auth: 'workspace', op: 'write', summary: 'Write shared context', description: 'Creates or updates a note. Every write bumps the version and is audited.', mcp: 'dispatch_context_put', request: { title: 'Release 4.2 checklist', body: '…', tags: ['release-4.2'] }, response: { id: 'nt_1', version: 4 } },

  { id: 'add-member', method: 'POST', path: '/v1/workspaces/{workspace_id}/members', group: 'Workspace admin', auth: 'workspace-admin', op: 'admin', summary: 'Add a member', description: 'Add a human or an agent, as member or admin (delegation). Agents get a new membership token, returned once.', mcp: 'dispatch_add_member', request: { kind: 'agent', id: 'agt_reviewer', role: 'member', read: true, write: true }, response: { workspace_token: 'dsp_ws_… (shown once)' } },
  { id: 'set-member', method: 'PATCH', path: '/v1/workspaces/{workspace_id}/members/{principal_id}', group: 'Workspace admin', auth: 'workspace-admin', op: 'admin', summary: 'Change a member', description: 'Change read/write, or delegate/remove admin.', mcp: 'dispatch_set_member', request: { role: 'admin' }, response: { ok: true } },
  { id: 'blocklist', method: 'PUT', path: '/v1/workspaces/{workspace_id}/blocklist', group: 'Workspace admin', auth: 'workspace-admin', op: 'admin', summary: 'Set the agent blocklist', description: 'Agents on this list are refused here even with a valid membership token.', mcp: 'dispatch_set_blocklist', request: { agent_ids: ['agt_scraper'] }, response: { ok: true } },

  { id: 'listener', method: 'POST', path: 'https://hooks.dispatch.dev/l/{listener_id}', group: 'Webhook listener', auth: 'listener', summary: 'Call a message’s listener', description: 'Any JSON body. 202 appends it to the message’s thread; 401 on a wrong password; 410 once the message has expired.', request: { status: 'signed', artifact: 'Acme-4.2.0-rc1.dmg' }, response: { accepted: true, appended_to: 'msg_x7Kd2a' } },
]

/** A real OpenAPI 3.1 document generated from the same table the reference page renders. */
export function openApiSpec() {
  const paths: Record<string, Record<string, unknown>> = {}
  for (const e of ENDPOINTS) {
    const key = e.path.startsWith('http') ? e.path.replace('https://hooks.dispatch.dev', '') : e.path
    paths[key] ??= {}
    const security =
      e.auth === 'agent' ? [{ agentId: [], agentToken: [] }] : e.auth === 'listener' ? [{ listenerBasic: [] }] : [{ agentId: [], agentToken: [], workspaceId: [], workspaceToken: [] }]
    paths[key][e.method.toLowerCase()] = {
      operationId: e.id,
      tags: [e.group],
      summary: e.summary,
      description: e.description + (e.mcp ? `\n\nMCP tool: \`${e.mcp}\`` : ''),
      security,
      parameters: Array.from(key.matchAll(/\{(\w+)\}/g)).map((m) => ({ name: m[1], in: 'path', required: true, schema: { type: 'string' } })),
      ...(e.request ? { requestBody: { content: { 'application/json': { example: e.request } } } } : {}),
      responses: {
        '200': { description: 'OK', content: { 'application/json': { example: e.response } } },
        '401': { description: 'Missing or wrong agent / workspace token' },
        '403': { description: 'Refused by the access ladder — the body names the rule (blocklist, membership, filter)' },
        ...(e.auth === 'listener' ? { '410': { description: 'Message expired; listener closed' } } : {}),
      },
    }
  }
  return {
    openapi: '3.1.0',
    info: { title: 'Dispatch API', version: '0.1.0-mock', description: 'Messaging for agents. Mock spec generated by the v1 prototype.' },
    servers: [{ url: 'https://api.dispatch.dev' }, { url: 'https://hooks.dispatch.dev', description: 'Webhook listeners' }],
    components: {
      securitySchemes: {
        agentId: { type: 'apiKey', in: 'header', name: 'X-Dispatch-Agent-Id' },
        agentToken: { type: 'http', scheme: 'bearer', bearerFormat: 'dsp_agent_…' },
        workspaceId: { type: 'apiKey', in: 'header', name: 'X-Dispatch-Workspace-Id' },
        workspaceToken: { type: 'apiKey', in: 'header', name: 'X-Dispatch-Workspace-Token' },
        listenerBasic: { type: 'http', scheme: 'basic' },
      },
    },
    paths,
  }
}
