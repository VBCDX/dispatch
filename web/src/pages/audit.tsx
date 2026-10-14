// The audit log, ported from the mock (mocks/v1/src/components/shared.tsx
// AuditLog and pages/misc.tsx AuditPage): the org Audit screen and the
// workspace Audit tab.
import { Fragment, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { manage, type AuditEvent } from '../api'
import { isOrgAdmin, useWorkspace } from './workspaces'
import { useLoad, useSession } from '../session'
import { ErrorBox, PageTitle, SkeletonRows, cx } from '../ui'

const TYPE_TONE: Record<string, string> = {
  message: 'text-signal-light bg-signal/10 border-signal/30',
  webhook: 'text-sky-400 bg-sky-500/10 border-sky-500/30',
  blocked: 'text-red-400 bg-red-500/10 border-red-500/30',
}
const DOT: Record<AuditEvent['severity'], string> = { ok: 'bg-green-500', blocked: 'bg-red-500', warn: 'bg-amber-500', info: 'bg-zinc-400' }
const RESULT: Record<AuditEvent['severity'], string> = { ok: 'text-green-400', blocked: 'text-red-400', warn: 'text-amber-400', info: 'text-zinc-400' }

const clock = (iso: string) => {
  const d = new Date(iso)
  const today = new Date().toDateString() === d.toDateString()
  return today ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

const show = (v: unknown): string => {
  if (v == null) return '—'
  if (typeof v === 'string') return v || '—'
  if (typeof v === 'object') return Object.entries(v as Record<string, unknown>).map(([k, x]) => `${k} ${show(x)}`).join(', ')
  return String(v)
}

/** Label/value pairs for a row's details: shared changes, or Dispatch's own detail. */
function details(e: AuditEvent): [string, string][] {
  const out: [string, string][] = []
  const changes = e.changes ?? (Array.isArray(e.detail?.changes) ? (e.detail.changes as AuditEvent['changes']) : undefined)
  for (const c of changes ?? []) out.push([c.field, `${show(c.before)} → ${show(c.after)}`])
  if (e.detail && !Array.isArray(e.detail.changes)) {
    for (const [k, v] of Object.entries(e.detail)) if (k !== 'kind' && k !== 'steps') out.push([k, show(v)])
  }
  if (e.subject) out.push([e.subject.kind === 'agent' ? 'Agent ID' : e.subject.kind === 'workspace' ? 'Workspace ID' : 'ID', e.subject.id])
  return out
}

function LogRow({ e, expanded, onToggle }: { e: AuditEvent; expanded: boolean; onToggle: () => void }) {
  const blocked = e.severity === 'blocked'
  const rows = details(e)
  const expandable = !!(e.reason || rows.length || e.link)
  return (
    <div className={cx('border-b border-line', blocked && 'border-l-[3px] border-l-red-600 bg-red-500/[0.04]')}>
      <div className={cx('flex items-center gap-3.5 px-4 py-[11px] text-sm2', expandable && 'cursor-pointer hover:bg-white/[0.015]')} onClick={expandable ? onToggle : undefined} role={expandable ? 'button' : undefined} aria-expanded={expandable ? expanded : undefined}>
        <span className="w-16 shrink-0 font-mono text-xs2 text-zinc-500" title={new Date(e.at).toLocaleString()}>
          {clock(e.at)}
        </span>
        <span className={cx('size-[7px] min-w-[7px] rounded-full', DOT[e.severity])} />
        <span className={cx('rounded-full border px-2 py-0.5 text-2xs font-semibold', TYPE_TONE[e.type] ?? 'text-zinc-400 bg-line border-chip')}>{e.type}</span>
        <span className="flex min-w-0 items-center gap-2">
          <span className={cx('shrink-0', e.actor.kind === 'agent' ? 'font-mono text-[12.5px] text-zinc-300' : 'text-zinc-300')} title={e.actor.id ? `${e.actor.kind} · ${e.actor.id}` : e.actor.kind}>
            {e.actor.label}
          </span>
          {e.actor.kind !== 'user' && <span className="text-2xs text-zinc-600">{e.actor.kind}</span>}
          {e.actor.via && <span className="shrink-0 rounded border border-brass/30 px-1.5 text-2xs text-brass-light">via {e.actor.via.label}</span>}
          <span className="text-zinc-600">→</span>
          <span className="truncate text-zinc-400">{e.object}</span>
          {e.workspace && <span className="shrink-0 text-xs text-zinc-600">· {e.workspace.name}{e.workspace.deleted && ' (deleted)'}</span>}
          {e.shared && <span className="shrink-0 rounded border border-chip px-1 text-2xs text-zinc-500" title="A suite record: shows in every VBCDX app">shared</span>}
        </span>
        <span className={cx('ml-auto shrink-0 whitespace-nowrap', RESULT[e.severity])}>{e.result}</span>
        <span className="shrink-0 font-mono text-2xs text-zinc-600">{e.trk}</span>
        <span className={cx('w-2.5 text-[10px] text-zinc-600', !expandable && 'invisible')}>{expanded ? '▴' : '▾'}</span>
      </div>
      {expanded && expandable && (
        <div className="flex flex-col gap-2 pr-4 pb-3.5 pl-[94px]">
          {e.reason && <div className="text-sm2 text-zinc-100">{e.reason}</div>}
          {rows.length > 0 && (
            <div className="grid max-w-[640px] grid-cols-[140px_1fr] gap-x-3 gap-y-1 text-xs text-zinc-400">
              {rows.map(([k, v], i) => (
                <Fragment key={k + i}>
                  <span className="text-zinc-500">{k}</span>
                  <span className={cx(/^(ag_|ws_|u_|wm_)/.test(v) && 'font-mono text-xs2')}>{v}</span>
                </Fragment>
              ))}
            </div>
          )}
          {e.link && (
            <Link to={e.link.to.replace('/wks_', '/ws_')} className="self-start text-sm2">
              {e.link.label} →
            </Link>
          )}
        </div>
      )}
    </div>
  )
}

const FILTER = 'appearance-none rounded-lg border border-edge bg-panel py-2 pr-7 pl-3 text-sm2 text-zinc-400 outline-none hover:border-zinc-700 focus:border-zinc-500'
function Filter({ value, onChange, label, children }: { value: string; onChange: (v: string) => void; label: string; children: ReactNode }) {
  return (
    <div className="relative">
      <select aria-label={label} className={cx(FILTER, value && 'text-zinc-200')} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{label}</option>
        {children}
      </select>
      <span className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-[9px] text-zinc-500">▾</span>
    </div>
  )
}

/** The searchable, filterable log. Filtering happens on the rows already loaded (up to 500). */
export function AuditLog({ load, deps, hideWorkspaceFilter }: { load: () => Promise<AuditEvent[]>; deps: unknown[]; hideWorkspaceFilter?: boolean }) {
  const [events, retry] = useLoad(load, deps)
  const [q, setQ] = useState('')
  const [type, setType] = useState('')
  const [actor, setActor] = useState('')
  const [ws, setWs] = useState('')
  const [result, setResult] = useState('')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const all = events.state === 'ready' ? events.data : []
  const actors = Array.from(new Map(all.map((e) => [`${e.actor.kind}:${e.actor.id ?? e.actor.label}`, `${e.actor.label}${e.actor.kind === 'user' ? '' : ` · ${e.actor.kind}`}`])).entries()).sort((a, b) => a[1].localeCompare(b[1]))
  const wsOptions = Array.from(new Map(all.filter((e) => e.workspace).map((e) => [e.workspace!.id, e.workspace!.name + (e.workspace!.deleted ? ' (deleted)' : '')])).entries()).sort((a, b) => a[1].localeCompare(b[1]))
  const types = Array.from(new Set(all.map((e) => e.type))).sort()
  const filtered = all.filter((e) => {
    if (q) {
      const s = q.toLowerCase()
      if (![e.trk, e.actor.label, e.actor.id ?? '', e.object, e.type, e.result, e.reason ?? '', e.workspace?.id ?? '', e.workspace?.name ?? '', e.subject?.id ?? ''].some((x) => x.toLowerCase().includes(s))) return false
    }
    if (type && e.type !== type) return false
    if (actor && `${e.actor.kind}:${e.actor.id ?? e.actor.label}` !== actor) return false
    if (ws && e.workspace?.id !== ws) return false
    if (result === 'ok' && e.severity !== 'ok') return false
    if (result === 'blocked' && e.severity !== 'blocked') return false
    if (result === 'other' && (e.severity === 'ok' || e.severity === 'blocked')) return false
    return true
  })
  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search — actor, agent ID, workspace, tracking code…" aria-label="Search the log" className="min-w-[200px] flex-1 rounded-lg border border-zinc-700 bg-panel px-3 py-2 text-[13px] text-zinc-100 outline-none placeholder:text-zinc-500 focus:border-zinc-500" />
        <Filter value={type} onChange={setType} label="Event type">
          {types.map((t) => (
            <option key={t}>{t}</option>
          ))}
        </Filter>
        <Filter value={actor} onChange={setActor} label="Actor">
          {actors.map(([k, l]) => (
            <option key={k} value={k}>
              {l}
            </option>
          ))}
        </Filter>
        {!hideWorkspaceFilter && (
          <Filter value={ws} onChange={setWs} label="Workspace">
            {wsOptions.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </Filter>
        )}
        <Filter value={result} onChange={setResult} label="Result">
          <option value="ok">Succeeded</option>
          <option value="blocked">Blocked or rejected</option>
          <option value="other">Warnings and notices</option>
        </Filter>
      </div>
      <div className="mt-3.5 overflow-hidden rounded-[10px] border border-edge bg-panel [&>*:last-child]:border-b-0">
        {events.state === 'loading' ? (
          <SkeletonRows cols="64px 8px 70px 1fr 90px 100px" n={5} />
        ) : events.state === 'error' ? (
          <div className="p-3">
            <ErrorBox what="the activity log" onRetry={retry} />
          </div>
        ) : filtered.length === 0 ? (
          <div className="p-10 text-center text-[13px] text-zinc-400">{all.length ? 'Nothing matches these filters. Clear the search or pick another filter.' : 'No activity yet. Admin changes, messages and access decisions show up here.'}</div>
        ) : (
          filtered.map((e) => (
            <LogRow
              key={e.id}
              e={e}
              expanded={expanded.has(e.id)}
              onToggle={() => {
                const n = new Set(expanded)
                if (n.has(e.id)) n.delete(e.id)
                else n.add(e.id)
                setExpanded(n)
              }}
            />
          ))
        )}
      </div>
      <div className="mt-2.5 text-xs2 text-zinc-600">Every admin change is logged with who made it and what it changed. Rows marked shared are suite records that show in every VBCDX app.</div>
    </div>
  )
}

export function AuditPage() {
  const { org } = useSession()
  const all = isOrgAdmin(org)
  return (
    <div className="max-w-[1120px]">
      <PageTitle>Audit</PageTitle>
      <div className="mt-1 text-sm2 text-zinc-500">
        Messages, receipts, webhook calls, access decisions and admin changes.
        {all ? ' You see the whole organization, including workspaces that were deleted.' : ' You see the workspaces you belong to, and organization-wide changes.'}
      </div>
      <div className="mt-4">{org && <AuditLog load={() => manage.orgAudit(org.id)} deps={[org.id]} />}</div>
    </div>
  )
}

export function WsAudit() {
  const { org, ws } = useWorkspace()
  return (
    <div className="mt-5">
      <AuditLog load={() => manage.workspaceAudit(org.id, ws.id)} deps={[org.id, ws.id, ws]} hideWorkspaceFilter />
    </div>
  )
}
