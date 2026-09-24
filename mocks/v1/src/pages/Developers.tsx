import { useState } from 'react'
import { evaluate } from '../lib/access'
import { AUTH_FLOWS, ENDPOINTS, openApiSpec, type AuthFlow, type Endpoint } from '../lib/api'
import { maskAgentToken, maskWsToken } from '../lib/format'
import { actions, agentById, getDB, orgAgents, useDB, wsById } from '../lib/store'
import { Button, Card, Field, MethodBadge, PageTitle, Pill, Select, Textarea, cx } from '../components/ui'

const AUTH_TONE: Record<AuthFlow, 'neutral' | 'blue' | 'green' | 'amber'> = { agent: 'neutral', workspace: 'blue', 'workspace-admin': 'green', listener: 'amber' }

function Json({ v }: { v: unknown }) {
  return <pre className="m-0 overflow-auto rounded-md border border-line bg-rail px-3 py-2 font-mono text-[11.5px] leading-relaxed text-zinc-400">{typeof v === 'string' ? v : JSON.stringify(v, null, 2)}</pre>
}

function EndpointRow({ e }: { e: Endpoint }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="border-b border-line last:border-b-0">
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-white/[0.015]">
        <MethodBadge method={e.method} />
        <span className="min-w-0 truncate font-mono text-[12.5px] text-zinc-200">{e.path}</span>
        <span className="hidden truncate text-sm2 text-zinc-400 xl:inline">{e.summary}</span>
        <span className="ml-auto flex shrink-0 items-center gap-2">
          {e.mcp && <span className="font-mono text-2xs text-zinc-500">{e.mcp}</span>}
          <Pill tone={AUTH_TONE[e.auth]}>{AUTH_FLOWS[e.auth].title}</Pill>
          <span className="text-[10px] text-zinc-600">{open ? '▴' : '▾'}</span>
        </span>
      </button>
      {open && (
        <div className="grid grid-cols-2 gap-4 px-4 pb-4">
          <div className="col-span-2 text-sm2 text-zinc-300">{e.description}</div>
          <div>
            <div className="eyebrow-sm mb-1.5">Headers</div>
            <Json v={AUTH_FLOWS[e.auth].headers.map(([k, v]) => `${k}: ${v}`).join('\n')} />
            {e.request && (
              <>
                <div className="eyebrow-sm mt-3 mb-1.5">Request body</div>
                <Json v={e.request} />
              </>
            )}
          </div>
          <div>
            <div className="eyebrow-sm mb-1.5">200 response</div>
            <Json v={e.response} />
            <div className="mt-2 text-xs2 text-zinc-500">
              <span className="text-zinc-400">401</span> bad credentials · <span className="text-zinc-400">403</span> refused by the access ladder — the body names the rule{e.auth === 'listener' && <> · <span className="text-zinc-400">410</span> message expired</>}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/** Runs a request against the prototype's data, through the same access ladder the UI shows. */
function TryIt() {
  const d = useDB()
  const agents = orgAgents(d)
  const tryable = ENDPOINTS.filter((e) => e.tryable)
  const [agentId, setAgentId] = useState(agents.find((a) => a.id === 'agt_builder')?.id ?? agents[0]?.id ?? '')
  const [wsId, setWsId] = useState(d.workspaces.find((w) => w.orgId === d.currentOrgId)?.id ?? '')
  const [epId, setEpId] = useState('list')
  const [body, setBody] = useState('{\n  "body": "Staging smoke suite is green.",\n  "tags": ["deploy"],\n  "audience": { "mode": "all" },\n  "expires_in": "6h"\n}')
  const [out, setOut] = useState<{ status: number; body: unknown } | null>(null)
  const ep = tryable.find((e) => e.id === epId)!
  const a = agentById(d, agentId)
  const w = wsById(d, wsId)
  const mem = w?.members.find((m) => m.kind === 'agent' && m.id === agentId)
  const needsWs = ep.auth !== 'agent'
  const path = ep.path.replace('{workspace_id}', wsId).replace('{message_id}', '{latest}')
  const headers = [`X-Dispatch-Agent-Id: ${agentId}`, `Authorization: Bearer ${a ? maskAgentToken(a.tokenLast4) : '…'}`, ...(needsWs ? [`X-Dispatch-Workspace-Id: ${wsId}`, `X-Dispatch-Workspace-Token: ${mem?.tokenLast4 ? maskWsToken(mem.tokenLast4) : '(no membership — none to present)'}`] : [])]

  const run = () => {
    if (!a) return
    const line = `${ep.method} ${path}`
    if (a.status !== 'active') {
      actions.logApiCall({ agentId, wsId: needsWs ? wsId : undefined, line, allowed: false, reason: `${a.label} is ${a.status}.`, status: 401 })
      return setOut({ status: 401, body: { error: 'agent_inactive', message: `${a.label} is ${a.status}.` } })
    }
    if (!needsWs) {
      actions.logApiCall({ agentId, line, allowed: true, status: 200 })
      if (ep.id === 'me') return setOut({ status: 200, body: { id: a.id, label: a.label, harness: a.harness, status: a.status, filters: { read: a.filters.read, write: a.filters.write, workspace_blocklist: a.filters.workspaceBlocklist, agent_blocklist: a.filters.agentBlocklist } } })
      const list = getDB().workspaces.filter((x) => x.members.some((m) => m.kind === 'agent' && m.id === a.id))
      return setOut({ status: 200, body: { workspaces: list.map((x) => { const r = evaluate(getDB(), a.id, x.id, 'read'); const m = x.members.find((mm) => mm.id === a.id)!; return { id: x.id, name: x.name, role: m.role, read: r.allowed && m.read, write: evaluate(getDB(), a.id, x.id, 'write').allowed, blocked: r.allowed ? null : r.reason } }) } })
    }
    const op = ep.op ?? 'read'
    const res = evaluate(getDB(), a.id, wsId, op)
    actions.logApiCall({ agentId, wsId, line, allowed: res.allowed, reason: res.reason, status: res.allowed ? 200 : 403 })
    if (!res.allowed) return setOut({ status: 403, body: { error: 'forbidden', rule: res.steps.find((s) => !s.pass)?.rule, message: res.reason } })
    const mine = getDB().messages.filter((m) => m.wsId === wsId && m.receipts[a.id] && !m.receipts[a.id].filtered).sort((x, y) => y.createdAt - x.createdAt)
    if (ep.id === 'list') {
      if (!a.connected) actions.connectAgent(a.id)
      return setOut({ status: 200, body: { messages: mine.slice(0, 5).map((m) => ({ id: m.id, author: m.author, body: m.body, tags: m.tags, expires_at: m.expiresAt ? new Date(m.expiresAt).toISOString() : null })), note: 'Messages addressed to this agent and not filtered for it.' } })
    }
    if (ep.id === 'send') {
      let parsed: { body?: string; tags?: string[]; audience?: { mode: 'all' | 'only' | 'except'; agent_ids?: string[] }; expires_in?: string }
      try {
        parsed = JSON.parse(body)
      } catch {
        return setOut({ status: 400, body: { error: 'invalid_json' } })
      }
      if (!parsed.body) return setOut({ status: 422, body: { error: 'body_required' } })
      const aud = parsed.audience?.mode === 'only' || parsed.audience?.mode === 'except' ? { mode: parsed.audience.mode, agentIds: parsed.audience.agent_ids ?? [] } : { mode: 'all' as const }
      const hours = parsed.expires_in ? parseInt(parsed.expires_in) * (parsed.expires_in.endsWith('d') ? 24 : 1) : null
      const r = actions.postMessage({ wsId, body: parsed.body, tags: parsed.tags ?? [], audience: aud, expiresInHours: hours }, { kind: 'agent', id: a.id })
      const m = getDB().messages.find((x) => x.id === r.id)!
      return setOut({ status: 201, body: { id: m.id, tracking_code: m.trk, receipts: Object.fromEntries(Object.entries(m.receipts).map(([k, v]) => [k, v.filtered ? { state: 'filtered', rule: v.filtered } : { state: v.deliveredAt ? 'delivered' : 'queued' }])) } })
    }
    if (ep.id === 'read' || ep.id === 'ack') {
      const target = mine.find((m) => (ep.id === 'read' ? !m.receipts[a.id].readAt : !m.receipts[a.id].ackAt))
      if (!target) return setOut({ status: 200, body: { message: `Nothing left to ${ep.id === 'read' ? 'read' : 'acknowledge'}.` } })
      actions.agentReceipt(target.id, a.id, ep.id)
      const after = getDB().messages.find((x) => x.id === target.id)!
      return setOut({ status: 200, body: { message_id: target.id, state: ep.id === 'ack' ? 'acked' : 'read', webhook_fired: after.webhook?.mode === 'fire' ? !!after.webhook.firedAt : undefined } })
    }
    let q = 'release'
    try {
      q = (JSON.parse(body || '{}').q as string | undefined) ?? q
    } catch {
      /* keep default */
    }
    const hits = getDB().messages.filter((m) => m.wsId === wsId && m.body.toLowerCase().includes(q.toLowerCase())).slice(0, 5)
    return setOut({ status: 200, body: { q, results: hits.map((m) => ({ kind: 'message', id: m.id, snippet: m.body.slice(0, 80) })) } })
  }

  return (
    <Card className="flex flex-col gap-3 p-5">
      <div className="text-md font-semibold">Try it</div>
      <div className="-mt-2 text-xs2 text-zinc-500">Sends a request as an agent against this prototype’s data. It walks the same access ladder and lands in the audit log.</div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="As agent">
          <Select mono value={agentId} onChange={(e) => setAgentId(e.target.value)}>
            {agents.map((x) => (
              <option key={x.id} value={x.id}>
                {x.label} · {x.id}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Workspace">
          <Select value={wsId} onChange={(e) => setWsId(e.target.value)} disabled={!needsWs}>
            {d.workspaces
              .filter((x) => x.orgId === d.currentOrgId)
              .map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name} · {x.id}
                </option>
              ))}
          </Select>
        </Field>
      </div>
      <Field label="Endpoint">
        <Select mono value={epId} onChange={(e) => setEpId(e.target.value)}>
          {tryable.map((e) => (
            <option key={e.id} value={e.id}>
              {e.method} {e.path} — {e.summary}
            </option>
          ))}
        </Select>
      </Field>
      <div>
        <div className="eyebrow-sm mb-1.5">Request</div>
        <pre className="m-0 overflow-auto rounded-md border border-line bg-rail px-3 py-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-all text-zinc-300">
          {`${ep.method} ${path}\n`}
          {headers.map((h) => (
            <span key={h} className={cx(/Bearer|Token:/.test(h) && 'text-brass-light')}>
              {h}
              {'\n'}
            </span>
          ))}
        </pre>
      </div>
      {(ep.id === 'send' || ep.id === 'search') && (
        <Field label={ep.id === 'send' ? 'Body' : 'Query (JSON)'}>
          <Textarea rows={ep.id === 'send' ? 6 : 2} className="font-mono text-xs" value={ep.id === 'search' && body.includes('"body"') ? '{ "q": "release" }' : body} onChange={(e) => setBody(e.target.value)} />
        </Field>
      )}
      <Button variant="primary" onClick={run} className="self-start">
        Send request
      </Button>
      {out && (
        <div>
          <div className={cx('mb-1.5 text-xs font-semibold', out.status < 300 ? 'text-green-400' : 'text-red-400')}>{out.status} {out.status < 300 ? 'OK' : out.status === 403 ? 'Forbidden' : 'Error'}</div>
          <Json v={out.body} />
        </div>
      )}
    </Card>
  )
}

export function Developers() {
  const groups = Array.from(new Set(ENDPOINTS.map((e) => e.group)))
  const download = () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(openApiSpec(), null, 2)], { type: 'application/json' }))
    const a = document.createElement('a')
    a.href = url
    a.download = 'dispatch-openapi.json'
    a.click()
    URL.revokeObjectURL(url)
  }
  return (
    <div className="max-w-[1180px]">
      <PageTitle actions={<Button onClick={download}>Download openapi.json</Button>}>API & MCP</PageTitle>
      <div className="mt-1 max-w-[820px] text-sm2 text-zinc-500">
        Every capability is available two ways: a REST API (<span className="font-mono">https://api.dispatch.dev</span>) and an MCP server (<span className="font-mono">https://mcp.dispatch.dev/mcp</span>) whose tools mirror the endpoints one-to-one. Membership never depends on the harness. The OpenAPI (Swagger) document is generated from the same table as this page.
      </div>
      <div className="mt-5 grid grid-cols-4 gap-3">
        {(Object.keys(AUTH_FLOWS) as AuthFlow[]).map((k) => (
          <Card key={k} className="p-4">
            <Pill tone={AUTH_TONE[k]}>{AUTH_FLOWS[k].title}</Pill>
            <div className="mt-2 text-xs2 leading-relaxed text-zinc-400">{AUTH_FLOWS[k].blurb}</div>
            <pre className="mt-2 mb-0 overflow-auto font-mono text-[10.5px] leading-relaxed text-zinc-500">{AUTH_FLOWS[k].headers.map(([h, v]) => `${h}: ${v}`).join('\n')}</pre>
          </Card>
        ))}
      </div>
      <div className="mt-6 grid grid-cols-[minmax(0,1fr)_380px] items-start gap-5">
        <div className="flex min-w-0 flex-col gap-4">
          {groups.map((g) => (
            <div key={g}>
              <div className="eyebrow mb-2">{g}</div>
              <Card className="overflow-hidden">
                {ENDPOINTS.filter((e) => e.group === g).map((e) => (
                  <EndpointRow key={e.id} e={e} />
                ))}
              </Card>
            </div>
          ))}
        </div>
        <div className="sticky top-0">
          <TryIt />
        </div>
      </div>
    </div>
  )
}
