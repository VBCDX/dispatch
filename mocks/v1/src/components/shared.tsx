import { Fragment, useEffect, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { clock, initials } from '../lib/format'
import { accessImpact, ALREADY_DELIVERED, actions, actorKey, actorLabel, humanById, me, useDB, wsLabel } from '../lib/store'
import type { DB } from '../lib/types'
import type { AuditEvent, Author, Harness } from '../lib/types'
import { CopyChip } from './credential'
import { Avatar, Button, ErrorBox, Field, Footer, Input, Modal, SkeletonRows, cx, useFakeLoad } from './ui'

/* ------------------------------------------------------------------ */
/* List state: loading → populated, honouring the demo override.       */
/* ------------------------------------------------------------------ */
export function useListState() {
  const d = useDB()
  const ready = useFakeLoad()
  const [retried, setRetried] = useState(0)
  const state: 'loading' | 'error' | 'ready' = d.listState === 'loading' || !ready ? 'loading' : d.listState === 'error' && retried === 0 ? 'error' : 'ready'
  return { state, retry: () => setRetried((n) => n + 1) }
}

export function ListBody({ cols, what, children, empty, rows = 3 }: { cols: string; what: string; children: ReactNode; empty?: ReactNode; rows?: number }) {
  const { state, retry } = useListState()
  if (state === 'loading') return <SkeletonRows cols={cols} n={rows} />
  if (state === 'error')
    return (
      <div className="p-3">
        <ErrorBox what={what} onRetry={retry} />
      </div>
    )
  return <>{empty ?? children}</>
}

/* ------------------------------------------------------------------ */
/* Records loaded by ID belong to an organization.                     */
/* ------------------------------------------------------------------ */
/**
 * Resolves a record's own organization. A viewer who belongs to it is moved
 * into it, so that org's suspended gate and roles apply; anyone else gets a
 * no-access state. Returns 'ok' once the record's org is the current one.
 */
export function useRecordOrg(orgId: string | undefined): 'ok' | 'switching' | 'denied' {
  const d = useDB()
  const member = !!orgId && !!me(d)?.roles[orgId]
  const elsewhere = !!orgId && orgId !== d.currentOrgId
  useEffect(() => {
    if (elsewhere && member) actions.switchOrg(orgId!)
  }, [elsewhere, member, orgId])
  if (!elsewhere) return 'ok'
  return member ? 'switching' : 'denied'
}

export function NoAccess({ what, back }: { what: string; back: { to: string; label: string } }) {
  return (
    <div role="alert" className="max-w-[560px] rounded-[10px] border border-edge bg-panel p-6 text-sm2 text-zinc-400">
      <div className="text-[13px] font-semibold text-zinc-200">You don’t have access to this {what}.</div>
      <div className="mt-1">It belongs to an organization or workspace you’re not part of. Nothing about it is shown.</div>
      <Link to={back.to} className="mt-3 inline-block">
        {back.label} →
      </Link>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Impact preview                                                      */
/* ------------------------------------------------------------------ */
export function ImpactDialog({ open, onClose, title, rows, body, confirmLabel, onConfirm, typeToConfirm, confirmVariant = 'danger' }: { open: boolean; onClose: () => void; title: ReactNode; rows: [string, ReactNode, ('amber' | 'red')?][]; body?: ReactNode; confirmLabel: string; onConfirm: () => void; typeToConfirm?: string; confirmVariant?: 'danger' | 'primary' }) {
  const [typed, setTyped] = useState('')
  useEffect(() => {
    if (open) setTyped('')
  }, [open])
  return (
    <Modal open={open} onClose={onClose} width={500} title={title}>
      <div className="flex flex-col gap-2.5 rounded-[10px] border border-edge bg-rail p-4 text-sm2">
        {rows.map(([k, v, tone]) => (
          <div key={k} className="flex justify-between gap-6">
            <span className="text-zinc-500">{k}</span>
            <span className={cx('text-right', tone === 'amber' && 'font-semibold text-amber-400', tone === 'red' && 'font-semibold text-red-400')}>{v}</span>
          </div>
        ))}
      </div>
      {body && <div className="text-sm2 leading-relaxed text-zinc-400">{body}</div>}
      {typeToConfirm && (
        <Field label={<>Type “{typeToConfirm}” to confirm</>}>
          <Input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={typeToConfirm} autoFocus />
        </Field>
      )}
      <Footer>
        <Button size="lg" onClick={onClose}>
          Cancel
        </Button>
        <Button
          size="lg"
          variant={confirmVariant}
          disabled={!!typeToConfirm && typed !== typeToConfirm}
          onClick={() => {
            onConfirm()
            onClose()
          }}
        >
          {confirmLabel}
        </Button>
      </Footer>
    </Modal>
  )
}

/**
 * Impact-preview rows for taking an agent's access away. `final` for a block,
 * removal or revocation (queued messages are filtered, waiting webhooks won't
 * fire); otherwise a reversible hold (suspension, read turned off).
 */
export function accessImpactRows(d: DB, agentId: string, wsId: string | undefined, final: boolean): [string, ReactNode, ('amber' | 'red')?][] {
  const i = accessImpact(d, agentId, wsId)
  const kept = i.delivered + i.read + i.acked
  return [
    ['Queued for it, never delivered', i.queued ? `${i.queued} — ${final ? 'filtered now, never delivered' : 'held; delivered if access returns'}` : 'None', i.queued ? 'amber' : undefined],
    ['Already delivered', kept ? `${kept} ${ALREADY_DELIVERED} (${i.delivered} delivered · ${i.read} read · ${i.acked} acknowledged)` : 'None'],
    [
      'Fire webhooks waiting on it',
      i.hooks.length ? `${final ? 'Won’t fire' : 'Stay pending while it’s held'}: ${i.hooks.map((h) => `${h.id} (${h.url})`).join(', ')}` : 'None',
      i.hooks.length ? (final ? 'red' : 'amber') : undefined,
    ],
  ]
}

/* ------------------------------------------------------------------ */
/* Principals: humans are round, agents are square with their harness. */
/* ------------------------------------------------------------------ */
const HARNESS_MARK: Record<Harness, string> = { 'Claude Code': 'CC', Codex: 'CX', OpenCode: 'OC', Other: '··' }
export function AgentGlyph({ harness, size = 22, dim }: { harness: Harness; size?: number; dim?: boolean }) {
  return (
    <span title={harness} style={{ width: size, height: size, minWidth: size, fontSize: size > 26 ? 11 : 9 }} className={cx('inline-flex items-center justify-center rounded-md border font-mono font-semibold', dim ? 'border-edge bg-line text-zinc-500' : 'border-signal/30 bg-signal/10 text-signal-light')}>
      {HARNESS_MARK[harness]}
    </span>
  )
}

export function PrincipalChip({ p, size = 22, withKind, className }: { p: Author; size?: number; withKind?: boolean; className?: string }) {
  const d = useDB()
  if (p.kind === 'webhook')
    return (
      <span className={cx('inline-flex min-w-0 items-center gap-2', className)} title={`Outside system calling listener ${p.id} from ${p.from}`}>
        <span style={{ width: size, height: size, minWidth: size, fontSize: size > 26 ? 12 : 10 }} className="inline-flex items-center justify-center rounded-md border border-sky-500/30 bg-sky-500/10 font-mono text-sky-400">
          ⇠
        </span>
        <span className="truncate font-mono text-[12.5px] text-sky-300">{p.id}</span>
        <span className="font-mono text-2xs text-zinc-500">{p.from}</span>
        {withKind && <span className="text-2xs text-zinc-600">webhook listener</span>}
      </span>
    )
  if (p.kind === 'agent') {
    const a = d.agents.find((x) => x.id === p.id)
    return (
      <span className={cx('inline-flex min-w-0 items-center gap-2', className)}>
        <AgentGlyph harness={a?.harness ?? 'Other'} size={size} dim={a?.status !== 'active'} />
        <span className={cx('truncate font-mono text-[12.5px]', a?.status !== 'active' ? 'text-zinc-500' : 'text-zinc-200')}>{a?.label ?? p.id}</span>
        {withKind && <span className="text-2xs text-zinc-600">agent</span>}
      </span>
    )
  }
  const h = d.humans.find((x) => x.id === p.id)
  return (
    <span className={cx('inline-flex min-w-0 items-center gap-2', className)}>
      <Avatar initials={initials(h?.name ?? '?')} size={size} />
      <span className="truncate text-[13px] text-zinc-200">{h?.name ?? p.id}</span>
      {withKind && <span className="text-2xs text-zinc-600">human</span>}
    </span>
  )
}

export function Tag({ t, on, onClick }: { t: string; on?: boolean; onClick?: () => void }) {
  const cls = cx('inline-flex items-center rounded-md border px-1.5 py-px font-mono text-2xs', on ? 'border-signal/50 bg-signal/15 text-signal-light' : 'border-chip bg-line text-zinc-400', onClick && 'cursor-pointer hover:text-zinc-200')
  return onClick ? (
    <button type="button" className={cls} onClick={onClick} aria-pressed={on}>
      #{t}
    </button>
  ) : (
    <span className={cls}>#{t}</span>
  )
}

/* ------------------------------------------------------------------ */
/* Activity log — one design, filtered everywhere.                     */
/* ------------------------------------------------------------------ */
const TYPE_TONE: Record<AuditEvent['type'], string> = {
  message: 'text-signal-light bg-signal/10 border-signal/30',
  receipt: 'text-zinc-400 bg-line border-chip',
  webhook: 'text-sky-400 bg-sky-500/10 border-sky-500/30',
  access: 'text-zinc-400 bg-line border-chip',
  blocked: 'text-red-400 bg-red-500/10 border-red-500/30',
  admin: 'text-zinc-400 bg-line border-chip',
  context: 'text-zinc-400 bg-line border-chip',
}
const DOT: Record<AuditEvent['severity'], string> = { ok: 'bg-green-500', blocked: 'bg-red-500', warn: 'bg-amber-500', info: 'bg-zinc-400' }
const resultTone = (e: AuditEvent) => (e.severity === 'blocked' ? 'text-red-400' : e.severity === 'warn' ? 'text-amber-400' : e.severity === 'ok' ? 'text-green-400' : 'text-zinc-400')

export function LogRow({ e, compact, expanded, onToggle, fresh }: { e: AuditEvent; compact?: boolean; expanded?: boolean; onToggle?: () => void; fresh?: boolean }) {
  const d = useDB()
  const blocked = e.severity === 'blocked'
  const expandable = !compact && !!(e.reason || e.detail || e.link)
  return (
    <div className={cx('border-b border-line', blocked && 'border-l-[3px] border-l-red-600 bg-red-500/[0.04]', fresh && 'animate-row-in')}>
      <div className={cx('flex items-center gap-3.5 px-4 text-sm2', compact ? 'py-2.5' : 'py-[11px]', expandable && 'cursor-pointer hover:bg-white/[0.015]')} onClick={expandable ? onToggle : undefined} role={expandable ? 'button' : undefined} aria-expanded={expandable ? expanded : undefined}>
        <span className={cx('shrink-0 font-mono text-xs2 text-zinc-500', blocked ? 'w-[61px]' : 'w-16')}>{clock(e.at)}</span>
        <span className={cx('size-[7px] min-w-[7px] rounded-full', DOT[e.severity])} />
        {!compact && <span className={cx('rounded-full border px-2 py-0.5 text-2xs font-semibold', TYPE_TONE[e.type])}>{e.type}</span>}
        <span className="flex min-w-0 items-center gap-2">
          <span className={cx('shrink-0', e.actorKind === 'agent' ? 'font-mono text-[12.5px] text-zinc-300' : 'text-zinc-300')} title={e.actorId ? `${e.actorKind} · ${e.actorId}` : e.actorKind}>
            {actorLabel(d, e)}
          </span>
          {(e.actorKind === 'agent' || e.actorKind === 'webhook') && !compact && <span className="text-2xs text-zinc-600">{e.actorKind}</span>}
          {e.viaHumanId && <span className="shrink-0 rounded border border-brass/30 px-1.5 text-2xs text-brass-light" title="A human sent this from the API console with the agent’s credentials">via {humanById(d, e.viaHumanId)?.name ?? e.viaHumanId} · console</span>}
          <span className="text-zinc-600">→</span>
          <span className="truncate text-zinc-400">{e.object}</span>
          {!compact && e.wsId && <span className="shrink-0 text-xs text-zinc-600">· {wsLabel(d, e.wsId)}</span>}
        </span>
        <span className={cx('ml-auto shrink-0 whitespace-nowrap', resultTone(e))}>{e.result}</span>
        <CopyChip value={e.trk} variant="inline" />
        {!compact && <span className={cx('w-2.5 text-[10px] text-zinc-600', !expandable && 'invisible')}>{expanded ? '▴' : '▾'}</span>}
      </div>
      {expanded && expandable && (
        <div className="flex flex-col gap-2 pr-4 pb-3.5 pl-[94px]">
          {e.reason && <div className="text-sm2 text-zinc-100">{e.reason}</div>}
          {e.detail && (
            <div className="grid max-w-[560px] grid-cols-[120px_1fr] gap-x-3 gap-y-1 text-xs text-zinc-400">
              {e.detail.map(([k, v]) => (
                <Fragment key={k}>
                  <span className="text-zinc-500">{k}</span>
                  <span className={cx(/^(agt_|wks_|dsp_)/.test(v) && 'font-mono text-xs2')}>{v}</span>
                </Fragment>
              ))}
            </div>
          )}
          {e.link && (
            <Link to={e.link.to} className="self-start text-sm2">
              {e.link.label} →
            </Link>
          )}
        </div>
      )}
    </div>
  )
}

export function LogFeed({ events }: { events: AuditEvent[] }) {
  return (
    <div className="overflow-hidden rounded-[10px] border border-edge bg-panel [&>*:last-child]:border-b-0">
      {events.map((e) => (
        <LogRow key={e.id} e={e} compact />
      ))}
    </div>
  )
}

const FILTER_SEL = 'appearance-none rounded-lg border border-edge bg-panel py-2 pr-7 pl-3 text-sm2 text-zinc-400 outline-none hover:border-zinc-700 focus:border-zinc-500'
function Filter({ value, onChange, label, children }: { value: string; onChange: (v: string) => void; label: string; children: ReactNode }) {
  return (
    <div className="relative">
      <select aria-label={label} className={cx(FILTER_SEL, value && 'text-zinc-200')} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{label}</option>
        {children}
      </select>
      <span className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-[9px] text-zinc-500">▾</span>
    </div>
  )
}

export function AuditLog({ events, hideWorkspaceFilter, initialQuery }: { events: AuditEvent[]; hideWorkspaceFilter?: boolean; initialQuery?: string }) {
  const d = useDB()
  const [q, setQ] = useState(initialQuery ?? '')
  const [type, setType] = useState('')
  const [actor, setActor] = useState('')
  const [ws, setWs] = useState('')
  const [result, setResult] = useState('')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [seen] = useState(() => new Set(events.map((e) => e.id)))
  const { state, retry } = useListState()
  // Listener rows are keyed by listener ID (callers' IPs vary), so one listener is one actor.
  const actors = Array.from(new Map(events.map((e) => [actorKey(e), e.actorKind === 'webhook' && e.actorId ? `listener ${e.actorId} · webhook` : `${actorLabel(d, e)}${e.actorKind === 'human' || e.actorKind === 'system' ? '' : ` · ${e.actorKind}`}`])).entries()).sort((a, b) => a[1].localeCompare(b[1]))
  const wsOptions = Array.from(new Set(events.map((e) => e.wsId).filter((x): x is string => !!x))).map((id) => [id, wsLabel(d, id)!] as const).sort((a, b) => a[1].localeCompare(b[1]))
  const filtered = events.filter((e) => {
    if (q) {
      const s = q.toLowerCase()
      if (![e.trk, e.actor, actorLabel(d, e), e.viaHumanId ? `via ${humanById(d, e.viaHumanId)?.name}` : '', e.object, e.type, e.result, e.reason ?? '', e.actorId ?? '', e.wsId ?? ''].some((x) => x.toLowerCase().includes(s))) return false
    }
    if (type && e.type !== type) return false
    if (actor && actorKey(e) !== actor) return false
    if (ws && e.wsId !== ws) return false
    if (result === 'ok' && e.severity !== 'ok') return false
    if (result === 'blocked' && e.severity !== 'blocked') return false
    if (result === 'other' && (e.severity === 'ok' || e.severity === 'blocked')) return false
    return true
  })
  const exportCsv = () => {
    const cols = ['time', 'workspace_id', 'workspace', 'type', 'severity', 'actor_kind', 'actor_id', 'actor', 'via_human_id', 'object', 'result', 'reason', 'tracking_code', 'detail']
    const body = filtered
      .map((e) => [new Date(e.at).toISOString(), e.wsId ?? '', wsLabel(d, e.wsId) ?? '', e.type, e.severity, e.actorKind, e.actorId ?? '', actorLabel(d, e), e.viaHumanId ?? '', e.object, e.result, e.reason ?? '', e.trk, e.detail ? JSON.stringify(Object.fromEntries(e.detail)) : ''].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(','))
      .join('\n')
    const url = URL.createObjectURL(new Blob([cols.join(',') + '\n' + body], { type: 'text/csv' }))
    const a = document.createElement('a')
    a.href = url
    a.download = 'dispatch-audit.csv'
    a.click()
    URL.revokeObjectURL(url)
  }
  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search — actor, agent ID, message ID, tracking code…" aria-label="Search the log" className="min-w-[200px] flex-1 rounded-lg border border-zinc-700 bg-panel px-3 py-2 text-[13px] text-zinc-100 outline-none placeholder:text-zinc-500 focus:border-zinc-500" />
        <Filter value={type} onChange={setType} label="Event type">
          {(['message', 'receipt', 'webhook', 'access', 'blocked', 'admin', 'context'] as const).map((t) => (
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
        <button type="button" onClick={exportCsv} className="rounded-lg border border-edge bg-panel px-3 py-2 text-sm2 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200">
          Export
        </button>
      </div>
      <div className="mt-3.5 overflow-hidden rounded-[10px] border border-edge bg-panel [&>*:last-child]:border-b-0">
        {state === 'loading' ? (
          <SkeletonRows cols="64px 8px 70px 1fr 90px 100px" n={5} />
        ) : state === 'error' ? (
          <div className="p-3">
            <ErrorBox what="the activity log" onRetry={retry} />
          </div>
        ) : filtered.length === 0 ? (
          <div className="p-10 text-center text-[13px] text-zinc-400">{events.length ? 'Nothing matches these filters. Clear the search or pick another filter.' : 'No activity yet. Every message, receipt, webhook call and access decision shows up here.'}</div>
        ) : (
          filtered.slice(0, 250).map((e) => (
            <LogRow
              key={e.id}
              e={e}
              fresh={!seen.has(e.id)}
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
      <div className="mt-2.5 text-xs2 text-zinc-600">Every access decision is logged — allowed or refused — with the rule that decided it.</div>
    </div>
  )
}
