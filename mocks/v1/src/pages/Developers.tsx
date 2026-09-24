import { useState } from 'react'
import { visibleToAgent } from '../lib/access'
import { AUTH_FLOWS, ENDPOINTS, ERROR_TEXT, openApiSpec, type AuthFlow, type Endpoint, type PathParam } from '../lib/api'
import { runConsole, type ConsoleResponse } from '../lib/console'
import { agentById, me, orgAgents, principalName, sessionSecret, useDB, wsById } from '../lib/store'
import { KeyholeIcon } from '../components/credential'
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
                <div className="eyebrow-sm mt-3 mb-1.5">Request body{e.requestSchema && <span className="font-normal normal-case"> · schema {e.requestSchema}</span>}</div>
                <Json v={e.request} />
              </>
            )}
          </div>
          <div>
            <div className="eyebrow-sm mb-1.5">
              {e.status} response{e.responseSchema && <span className="font-normal normal-case"> · schema {e.responseSchema}</span>}
            </div>
            <Json v={e.response} />
            <div className="mt-2 flex flex-col gap-0.5 text-xs2 text-zinc-500">
              {[...(e.auth === 'listener' ? [401] : [401, 403]), ...(e.errors ?? [])]
                .sort()
                .map((c) => (
                  <span key={c}>
                    <span className="font-mono text-zinc-400">{c}</span> {ERROR_TEXT[c]}
                  </span>
                ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

const STATUS_TEXT: Record<number, string> = { 200: 'OK', 201: 'Created', 202: 'Accepted', 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 409: 'Conflict', 410: 'Gone', 422: 'Unprocessable' }
const DEFAULT_BODY: Record<string, string> = {
  send: '{\n  "body": "Staging smoke suite is green.",\n  "tags": ["deploy"],\n  "audience": { "mode": "all" },\n  "expires_in": "6h"\n}',
  search: '{ "q": "deployer" }',
  filters: '{ "agent_blocklist": [] }',
}
const defaultBody = (e: Endpoint) => DEFAULT_BODY[e.id] ?? (e.request ? JSON.stringify(e.request, null, 2) : '')
const maskTyped = (t: string, prefix: string) => (!t.trim() ? '(missing)' : t.startsWith(prefix) ? `${prefix}••••${t.trim().slice(-4)}` : `••••${t.trim().slice(-4)}`)

/** A pasted token: masked, brass (a credential is near), never echoed back in full. */
function TokenInput({ label, value, onChange, issued, placeholder }: { label: string; value: string; onChange: (v: string) => void; issued: string | null; placeholder: string }) {
  return (
    <Field label={label} hint={issued ? undefined : 'Prototype: only a token issued in this browser tab can be verified. Rotate it (with the grace window) to get one.'}>
      <div className="flex items-center gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-brass/25 bg-secret-bg px-3 py-2 focus-within:border-brass/50">
          <input type="password" aria-label={label} autoComplete="off" spellCheck={false} data-1p-ignore data-lpignore="true" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className="masked min-w-0 flex-1 bg-transparent font-mono text-xs text-brass outline-none placeholder:font-sans placeholder:tracking-normal placeholder:text-zinc-600" />
          <KeyholeIcon state={value ? 'closed' : 'open'} size={13} />
        </div>
        {issued && value !== issued && (
          <Button size="sm" onClick={() => onChange(issued)} title="This tab still holds the token it issued">
            Use the one issued in this tab
          </Button>
        )}
      </div>
    </Field>
  )
}

/**
 * Sends a request as an agent against this prototype's data. It presents the
 * agent's real tokens, walks the same access ladder, and is audited as the
 * agent — with the human who sent it from the console.
 */
function TryIt() {
  const d = useDB()
  const agents = orgAgents(d)
  const tryable = ENDPOINTS.filter((e) => e.tryable)
  const groups = Array.from(new Set(tryable.map((e) => e.group)))
  const [agentId, setAgentId] = useState(agents.find((a) => a.id === 'agt_builder')?.id ?? agents[0]?.id ?? '')
  const [wsId, setWsId] = useState(d.workspaces.find((w) => w.orgId === d.currentOrgId)?.id ?? '')
  const [epId, setEpId] = useState('list')
  const [agentToken, setAgentToken] = useState('')
  const [wsToken, setWsToken] = useState('')
  const [bodies, setBodies] = useState<Record<string, string>>({})
  const [params, setParams] = useState<Partial<Record<PathParam, string>>>({})
  const [out, setOut] = useState<ConsoleResponse | null>(null)
  const ep = tryable.find((e) => e.id === epId)!
  const a = agentById(d, agentId)
  const w = wsById(d, wsId)
  const needsWs = ep.auth !== 'agent'
  const body = bodies[ep.id] ?? defaultBody(ep)
  const pathParams = (['message_id', 'principal_id', 'note_id'] as PathParam[]).filter((p) => ep.path.includes(`{${p}}`))
  const msgs = d.messages.filter((m) => m.wsId === wsId).sort((x, y) => y.createdAt - x.createdAt)
  const paramOptions: Record<PathParam, { value: string; label: string }[]> = {
    message_id: msgs.map((m) => ({ value: m.id, label: `${m.id} · ${m.body.slice(0, 38)}${m.body.length > 38 ? '…' : ''}${visibleToAgent(m, agentId) ? '' : ` — not addressed to ${a?.label}`}` })),
    principal_id: (w?.members ?? []).map((m) => ({ value: m.id, label: `${principalName(d, m)} · ${m.id} · ${m.role}` })),
    note_id: [{ value: 'new', label: 'new — create a note' }, ...d.notes.filter((n) => n.wsId === wsId).map((n) => ({ value: n.id, label: `${n.id} · ${n.title} · v${n.version}` }))],
  }
  const param = (p: PathParam) => params[p] ?? (p === 'message_id' ? (msgs.find((m) => visibleToAgent(m, agentId)) ?? msgs[0])?.id : paramOptions[p][0]?.value) ?? ''
  const path = pathParams.reduce((acc, p) => acc.replace(`{${p}}`, param(p) || `{${p}}`), ep.path.replace('{workspace_id}', wsId))
  const issuedAgent = sessionSecret(`agent:${agentId}`)
  const issuedWs = needsWs ? sessionSecret(`ws:${wsId}:${agentId}`) : null
  const headers = [`X-Dispatch-Agent-Id: ${agentId}`, `Authorization: Bearer ${maskTyped(agentToken, 'dsp_agent_')}`, ...(needsWs ? [`X-Dispatch-Workspace-Id: ${wsId}`, `X-Dispatch-Workspace-Token: ${maskTyped(wsToken, 'dsp_ws_')}`] : [])]

  const run = () =>
    setOut(runConsole({ ep, agentId, wsId, agentToken, wsToken, params: Object.fromEntries(pathParams.map((p) => [p, param(p)])), body, humanId: d.currentUserId }))

  return (
    <Card className="flex flex-col gap-3 p-5">
      <div className="text-md font-semibold">Try it</div>
      <div className="-mt-2 text-xs2 leading-relaxed text-zinc-500">
        Sends a request as an agent, with that agent’s real tokens, against this prototype’s data. It walks the same access ladder and is audited as <span className="font-mono text-zinc-400">{a?.label ?? 'the agent'}</span> sent by <span className="text-zinc-400">{me(d).name}</span> from the console.
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="As agent">
          <Select
            mono
            value={agentId}
            onChange={(e) => {
              setAgentId(e.target.value)
              setAgentToken('')
              setWsToken('')
              setParams({})
            }}
          >
            {agents.map((x) => (
              <option key={x.id} value={x.id}>
                {x.label} · {x.id}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Workspace">
          <Select
            value={wsId}
            onChange={(e) => {
              setWsId(e.target.value)
              setWsToken('')
              setParams({})
            }}
            disabled={!needsWs}
          >
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
      <TokenInput label="Agent token" value={agentToken} onChange={setAgentToken} issued={issuedAgent} placeholder="Paste dsp_agent_…" />
      {needsWs && <TokenInput label={`Workspace token · ${w?.name ?? wsId}`} value={wsToken} onChange={setWsToken} issued={issuedWs} placeholder="Paste dsp_ws_…" />}
      <Field label="Endpoint">
        <Select
          mono
          value={epId}
          onChange={(e) => {
            setEpId(e.target.value)
            setOut(null)
          }}
        >
          {groups.map((g) => (
            <optgroup key={g} label={g}>
              {tryable
                .filter((e) => e.group === g)
                .map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.method} {e.path.replace('/v1/workspaces/{workspace_id}', '…')} — {e.summary}
                  </option>
                ))}
            </optgroup>
          ))}
        </Select>
      </Field>
      {pathParams.map((p) => (
        <Field key={p} label={p}>
          <Select mono value={param(p)} onChange={(e) => setParams({ ...params, [p]: e.target.value })}>
            {paramOptions[p].map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        </Field>
      ))}
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
      {ep.request && (
        <Field label={`Body${ep.requestSchema ? ` · ${ep.requestSchema}` : ''}`}>
          <Textarea rows={Math.min(8, body.split('\n').length + 1)} className="font-mono text-xs" value={body} onChange={(e) => setBodies({ ...bodies, [ep.id]: e.target.value })} />
        </Field>
      )}
      <Button variant="primary" onClick={run} className="self-start" disabled={!a}>
        Send request
      </Button>
      {out && (
        <div role="status">
          <div className={cx('mb-1.5 text-xs font-semibold', out.status < 300 ? 'text-green-400' : 'text-red-400')}>
            {out.status} {STATUS_TEXT[out.status] ?? ''}
          </div>
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
        Every capability is available two ways: a REST API (<span className="font-mono">https://api.dispatch.dev</span>) and an MCP server (<span className="font-mono">https://mcp.dispatch.dev/mcp</span>) whose tools mirror the endpoints one-to-one. Membership never depends on the harness. The OpenAPI (Swagger) document — paths, status codes and JSON Schemas — is generated from the same table as this page and the Try it console. Agents read only messages addressed to them (or written by them): the inbox, search and GET all apply that one rule.
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
