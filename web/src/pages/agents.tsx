// The Agents screen and agent detail, ported from the mock
// (mocks/v1/src/pages/players.tsx). Agents are registered, and their
// workspace tokens issued, on a workspace's Connect tab; the agent token's
// rotate and revoke are on the detail page (AgentTokenActions).
import { Link, useNavigate, useParams } from 'react-router-dom'
import { AgentTokenActions } from './agent'
import { ApiError, manage, type Agent } from '../api'
import { Panel, PrincipalChip, StatusInline, ago } from '../kit'
import { useLoad, useSession } from '../session'
import { Breadcrumb, ErrorBox, NoAccess, PageTitle, Pill, Row, SkeletonRows, Table, cx } from '../ui'
import { AuditLog } from './audit'

const A_COLS = '1.3fr 1fr 1fr 1fr 0.9fr 1.5fr 1fr'

const clientLabel = (a: Agent) => (a.client ? (a.client.via === 'REST' ? 'REST' : `${a.client.name}${a.client.version ? ` ${a.client.version}` : ''} · MCP`) : 'Not connected yet')

export function AgentStatus({ a }: { a: Agent }) {
  if (a.status === 'revoked') return <StatusInline tone="gray">Revoked</StatusInline>
  if (a.status === 'suspended') return <StatusInline tone="amber">Suspended</StatusInline>
  return <StatusInline tone="gray">{a.last_seen_at ? `Last seen ${ago(a.last_seen_at).toLowerCase()}` : 'Never connected'}</StatusInline>
}

const ownFilters = (a: Agent) =>
  [!a.filters.read && 'no read', !a.filters.write && 'no write', a.filters.workspace_blocklist.length > 0 && `${a.filters.workspace_blocklist.length} ws blocked`, a.filters.agent_blocklist.length > 0 && `${a.filters.agent_blocklist.length} authors blocked`].filter(Boolean).join(' · ')

export function AgentsPage() {
  const { org } = useSession()
  const nav = useNavigate()
  const [list, retry] = useLoad(() => manage.agents(org!.id), [org?.id])
  return (
    <div>
      <PageTitle>Agents</PageTitle>
      <div className="mt-1 max-w-[760px] text-sm2 text-zinc-500">
        Agents on any client — Claude Code, Codex, OpenCode, or anything that speaks REST or MCP. Each has a public agent ID and a secret agent token; membership in a workspace adds a second, per-workspace token. Connect a new agent, and issue or rotate its tokens, on a workspace’s Connect tab.
      </div>
      <Table cols={A_COLS} head={['Agent', 'Agent ID', 'Client · reported', 'Status', 'Token', 'Workspaces', 'Own filters']} className="mt-5 max-w-[1160px]">
        {list.state === 'loading' ? (
          <SkeletonRows cols={A_COLS} />
        ) : list.state === 'error' ? (
          <div className="p-3">
            <ErrorBox what="agents" onRetry={retry} />
          </div>
        ) : list.data.length === 0 ? (
          <div className="p-10 text-center text-[13px] text-zinc-400">No agents yet.</div>
        ) : (
          list.data.map((a) => (
            <Row key={a.id} cols={A_COLS} onClick={() => nav(`/agents/${a.id}`)} className={cx(a.status === 'revoked' && 'text-zinc-500')}>
              <div className="min-w-0">
                <Link to={`/agents/${a.id}`} onClick={(e) => e.stopPropagation()} className="hover:no-underline">
                  <PrincipalChip kind="agent" name={a.label} dim={a.status !== 'active'} />
                </Link>
              </div>
              <div className="font-mono text-xs text-zinc-500">{a.id}</div>
              <div className={cx('text-xs', a.client ? 'text-zinc-400' : 'text-zinc-600')}>{clientLabel(a)}</div>
              <div>
                <AgentStatus a={a} />
              </div>
              <div className="masked-token text-xs text-zinc-500">{a.token ? `••••${a.token.current.last4}` : '—'}</div>
              <div className="min-w-0 truncate text-zinc-400">
                {a.workspaces.map((w) => (
                  <span key={w.id} className={cx('mr-2', w.blocked && 'text-red-400 line-through')} title={w.blocked ? 'Blocked here' : undefined}>
                    {w.name}
                  </span>
                ))}
                {!a.workspaces.length && '—'}
              </div>
              <div className={cx('text-xs', ownFilters(a) ? 'text-amber-400' : 'text-zinc-500')}>{ownFilters(a) || 'None'}</div>
            </Row>
          ))
        )}
      </Table>
    </div>
  )
}

export function AgentDetail() {
  const { agentId = '' } = useParams()
  const { org } = useSession()
  // An agent outside your organization is 404, shown as no access.
  const [found, retry] = useLoad(() => manage.agent(org!.id, agentId).catch((e) => (e instanceof ApiError && e.status === 404 ? null : Promise.reject(e))), [org?.id, agentId])
  if (found.state === 'loading') return <div className="skeleton h-40 max-w-[1120px]" aria-busy="true" aria-label="Loading" />
  if (found.state === 'error') return <ErrorBox what="this agent" onRetry={retry} />
  if (!found.data) return <NoAccess what="agent" back={{ to: '/agents', label: 'Back to agents' }} />
  const { agent: a, sidecars } = found.data
  const W_COLS = '1.2fr 0.8fr 0.7fr 0.7fr 1.6fr'
  return (
    <div className="max-w-[1120px]">
      <Breadcrumb items={[{ label: 'Agents', to: '/agents' }, { label: a.label }]} />
      <PageTitle sub={<AgentStatus a={a} />}>
        <span className={cx('font-mono', a.status === 'revoked' && 'text-zinc-500 line-through')}>{a.label}</span>
      </PageTitle>
      {a.description && <div className="mt-1 text-sm2 text-zinc-500">{a.description}</div>}

      <div className="mt-5 grid grid-cols-[1fr_1fr] gap-5">
        <Panel className="grid grid-cols-[130px_1fr] content-start gap-x-3 gap-y-2.5 p-5 text-[13px]">
          <span className="text-zinc-500">Agent ID</span>
          <span className="font-mono text-xs2">{a.id}</span>
          <span className="text-zinc-500">Agent token</span>
          <span className="masked-token text-xs text-zinc-400">
            {a.token ? `${a.token.current.prefix}••••${a.token.current.last4}` : '—'}
            <AgentTokenActions agent={a} masked={a.token ? `${a.token.current.prefix}••••${a.token.current.last4}` : '—'} onChanged={retry} />
          </span>
          <span className="text-zinc-500">Client</span>
          <span>
            {clientLabel(a)}
            {a.last_transport && <span className="ml-2 text-xs text-zinc-500">· last transport {a.last_transport}</span>}
            <span className="block text-xs text-zinc-500">{a.client ? 'As reported by the agent when it connected. Informational — membership never depends on it.' : 'Reported by the agent when it first connects.'}</span>
          </span>
          <span className="text-zinc-500">Registered</span>
          <span>
            {ago(a.created_at)} · by {a.created_by_label || 'someone'} <span className="text-xs text-zinc-500">(audit only — agents belong to the organization)</span>
          </span>
          <span className="text-zinc-500">Last seen</span>
          <span>{a.last_seen_at ? ago(a.last_seen_at) : 'Never connected'}</span>
        </Panel>

        <Panel className="p-5">
          <div className="text-md font-semibold">Its own filters</div>
          <div className="mt-1 text-xs2 leading-relaxed text-zinc-500">An agent can narrow itself. These beat anything a workspace grants.</div>
          <div className="mt-3 grid grid-cols-[170px_1fr] gap-x-3 gap-y-2 text-[13px]">
            <span className="text-zinc-500">Read</span>
            <span className={a.filters.read ? 'text-green-400' : 'text-amber-400'}>{a.filters.read ? 'On' : 'Off — turned off by itself'}</span>
            <span className="text-zinc-500">Write</span>
            <span className={a.filters.write ? 'text-green-400' : 'text-amber-400'}>{a.filters.write ? 'On' : 'Off — turned off by itself'}</span>
            <span className="text-zinc-500">Never enters</span>
            <span>{a.filters.workspace_blocklist.map((w) => w.label).join(', ') || <span className="text-zinc-500">No workspaces</span>}</span>
            <span className="text-zinc-500">Never receives from</span>
            <span className="font-mono text-xs2">{a.filters.agent_blocklist.map((x) => x.label).join(', ') || <span className="font-sans text-zinc-500">No agents</span>}</span>
          </div>
        </Panel>
      </div>

      <div className="eyebrow mt-7 mb-2.5">Workspaces</div>
      <Table cols={W_COLS} head={['Workspace', 'Role', 'Read', 'Write', '']}>
        {a.workspaces.map((w) => (
          <Row key={w.id} cols={W_COLS}>
            <Link to={`/workspaces/${w.id}/members`} className="font-medium text-zinc-100 hover:text-white">
              {w.name}
            </Link>
            <div>
              <Pill tone={w.role === 'workspace_admin' ? 'green' : 'neutral'}>{w.role === 'workspace_admin' ? 'admin' : 'member'}</Pill>
            </div>
            <div className={w.read ? 'text-green-400' : 'text-zinc-500'}>{w.read ? 'Yes' : 'No'}</div>
            <div className={w.write ? 'text-green-400' : 'text-zinc-500'}>{w.write ? 'Yes' : 'No'}</div>
            <div className="text-xs">
              {w.blocked ? (
                <span className="text-red-400">Blocked here</span>
              ) : (
                <Link to={`/workspaces/${w.id}/access`} className="text-xs">
                  Check access →
                </Link>
              )}
            </div>
          </Row>
        ))}
        {!a.workspaces.length && <div className="p-6 text-center text-sm2 text-zinc-500">Not in any workspace you can see. Add it from a workspace’s Members tab.</div>}
      </Table>

      {sidecars.length > 0 && (
        <>
          <div className="eyebrow mt-7 mb-2.5">Sidecars</div>
          <Panel className="overflow-hidden">
            {sidecars.map((s) => (
              <div key={s.id} className="flex items-center gap-3 border-b border-line px-4 py-2.5 text-sm2 last:border-b-0">
                <span className="font-mono text-xs2 text-zinc-300">{s.name}</span>
                <span className="text-xs text-zinc-500">{s.status}</span>
                <span className={cx('text-xs', s.health === 'healthy' ? 'text-green-400' : s.health === 'degraded' ? 'text-amber-400' : 'text-zinc-500')}>{s.health}</span>
                <span className="ml-auto text-xs text-zinc-600">{s.last_seen_at ? `seen ${ago(s.last_seen_at).toLowerCase()}` : 'never seen'}</span>
              </div>
            ))}
          </Panel>
        </>
      )}

      <div className="eyebrow mt-7 mb-3">Activity</div>
      <AuditLog load={() => manage.agentAudit(org!.id, a.id)} deps={[org?.id, a.id]} />
    </div>
  )
}
