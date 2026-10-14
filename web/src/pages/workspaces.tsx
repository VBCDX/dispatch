// The Workspaces screen, ported from the mock (mocks/v1/src/pages/workspaces.tsx):
// the list with "New workspace", and the detail page's header (edit and
// delete) and tabs.
import { useEffect, useRef, useState } from 'react'
import { Link, Outlet, useNavigate, useOutletContext, useParams } from 'react-router-dom'
import { ApiError, manage, v1, type Org, type Workspace } from '../api'
import { trackEvent } from '../analytics'
import { Callout, Footer, FormField, ImpactDialog, Modal, Select, TextInput, Textarea, errorText } from '../kit'
import { useLoad, useSession } from '../session'
import { Breadcrumb, Button, ErrorBox, NoAccess, PageTitle, Pill, Row, SkeletonRows, Table, Tabs, plural } from '../ui'

const COLS = '1.5fr 1.4fr 1fr 1fr 0.9fr 0.8fr'

export const isOrgAdmin = (org: Org | null) => org?.status === 'active' && (org.role === 'Owner' || org.role === 'userAdmin')

export function WorkspacesList() {
  const { org, workspaces, reloadWorkspaces } = useSession()
  const nav = useNavigate()
  const [creating, setCreating] = useState(false)
  return (
    <div>
      <PageTitle
        actions={
          isOrgAdmin(org) && (
            <Button variant="primary" onClick={() => setCreating(true)}>
              New workspace
            </Button>
          )
        }
      >
        Workspaces
      </PageTitle>
      <div className="mt-1 max-w-[760px] text-sm2 text-zinc-500">A workspace is a permission space: who may read and write, which agents are blocked, and a full audit of what happened. Messages are addressed to the workspace, not to a running process.</div>
      <Table cols={COLS} head={['Name', 'Members', 'Messages · 24 h', 'Waiting on agents', 'Webhooks', 'Your role']} className="mt-5 max-w-[1080px]">
        {workspaces.state === 'loading' ? (
          <SkeletonRows cols={COLS} />
        ) : workspaces.state === 'error' ? (
          <div className="p-3">
            <ErrorBox what="workspaces" onRetry={reloadWorkspaces} />
          </div>
        ) : workspaces.data.length === 0 ? (
          <div className="p-10 text-center text-[13px] text-zinc-400">No workspaces yet. Create one to give agents a place to leave each other messages.</div>
        ) : (
          workspaces.data.map((w) => (
            <Row key={w.id} cols={COLS} onClick={() => nav(`/workspaces/${w.id}/messages`)}>
              <div>
                <Link to={`/workspaces/${w.id}/messages`} onClick={(e) => e.stopPropagation()} className="font-medium text-zinc-100 hover:text-zinc-100">
                  {w.name}
                </Link>
                <div className="font-mono text-2xs text-zinc-600">{w.id}</div>
              </div>
              <div className="text-zinc-400">
                {plural(w.humans, 'human')} · {plural(w.agents, 'agent')}
                {w.blocked_agents > 0 && <span className="ml-1.5 text-2xs text-red-400">{w.blocked_agents} blocked</span>}
              </div>
              <div className="text-zinc-400">{w.messages_24h}</div>
              <div className={w.waiting ? 'text-amber-400' : 'text-zinc-500'}>{w.waiting ? plural(w.waiting, 'message') : 'None'}</div>
              <div className="text-zinc-400">{w.webhooks || '—'}</div>
              <div>{w.my_role ? <Pill tone={w.my_role === 'workspace_admin' ? 'green' : 'neutral'}>{w.my_role === 'workspace_admin' ? 'admin' : 'member'}</Pill> : <span className="text-xs text-zinc-500">org admin</span>}</div>
            </Row>
          ))
        )}
      </Table>
      <WorkspaceForm
        open={creating}
        onClose={() => setCreating(false)}
        onSaved={(w) => {
          reloadWorkspaces()
          nav(`/workspaces/${w.id}/members`)
        }}
      />
    </div>
  )
}

const EXPIRY = [
  ['6', '6 hours'],
  ['24', '24 hours'],
  ['72', '3 days'],
  ['168', '7 days'],
  ['none', 'No expiry'],
] as const

/** Creates a workspace (no `editing`) or edits one's name and settings. */
function WorkspaceForm({ open, onClose, onSaved, editing }: { open: boolean; onClose: () => void; onSaved: (w: Workspace) => void; editing?: Workspace }) {
  const { me, org } = useSession()
  const [name, setName] = useState('')
  const [desc, setDesc] = useState('')
  const [expiry, setExpiry] = useState('24')
  const [retention, setRetention] = useState('90')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [clash, setClash] = useState(false)
  useEffect(() => {
    if (!open) return
    setName(editing?.name ?? '')
    setDesc(editing?.description ?? '')
    const h = editing ? editing.default_expiry_hours : 24
    setExpiry(h == null ? 'none' : String(h))
    setRetention(String(editing?.retention_days ?? 90))
    setError(null)
    setClash(false)
    setBusy(false)
  }, [open, editing])
  const days = Number(retention)
  const valid = name.trim() && Number.isInteger(days) && days >= 1 && days <= 3650
  async function save() {
    if (!org) return
    setBusy(true)
    setError(null)
    setClash(false)
    const body = { name: name.trim(), description: desc, default_expiry_hours: expiry === 'none' ? null : Number(expiry), retention_days: days }
    try {
      const w = editing ? await manage.updateWorkspace(me.csrf_token, org.id, editing.id, body) : await manage.createWorkspace(me.csrf_token, org.id, body)
      // Activation event: name/description are user content and are
      // never sent. First-occurrence maths lives in GA4, not here.
      if (!editing) trackEvent('workspace_created')
      onClose()
      onSaved(w)
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) setClash(true)
      else setError(errorText(err))
      setBusy(false)
    }
  }
  // Keep a non-preset expiry (set elsewhere) selectable.
  const options: (readonly [string, string])[] = EXPIRY.some(([v]) => v === expiry) ? [...EXPIRY] : [...EXPIRY, [expiry, `${expiry} hours`]]
  return (
    <Modal open={open} onClose={onClose} width={500} title={editing ? `Edit ${editing.name}` : 'New workspace'}>
      <FormField label="Name" error={clash ? 'A workspace with that name exists.' : null}>
        <TextInput value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
      </FormField>
      <FormField label="What it’s for" optional hint="Agents read this when they list their workspaces — write it for them.">
        <Textarea rows={2} maxLength={500} value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="Everything that gets a release out the door." />
      </FormField>
      <div className="grid grid-cols-2 gap-4">
        <FormField label="Default message expiry">
          <Select value={expiry} onChange={(e) => setExpiry(e.target.value)}>
            {options.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </Select>
        </FormField>
        <FormField label="Keep messages for (days)">
          <TextInput type="number" min={1} max={3650} value={retention} onChange={(e) => setRetention(e.target.value)} />
        </FormField>
      </div>
      {!editing && <div className="text-xs text-zinc-500">You’ll be its first admin. Add agents and people next — each agent gets its own workspace token on the Connect tab.</div>}
      {error && <Callout tone="red">{error}</Callout>}
      <Footer>
        <Button size="lg" onClick={onClose}>
          Cancel
        </Button>
        <Button size="lg" variant="primary" disabled={!valid || busy} onClick={save}>
          {busy ? 'Saving…' : editing ? 'Save changes' : 'Create workspace'}
        </Button>
      </Footer>
    </Modal>
  )
}

/**
 * Finds a workspace opened by ID: in the organization on screen first, then
 * in your other active ones, so a link into another of your organizations
 * opens there (as in the mock). Null when none of them has it.
 */
async function findWorkspace(orgs: Org[], current: Org | null, wsId: string): Promise<{ org: Org; ws: Workspace } | null> {
  const order = [current, ...orgs.filter((o) => o.id !== current?.id)].filter((o): o is Org => o?.status === 'active')
  for (const org of order) {
    try {
      return { org, ws: await v1.workspace(org.id, wsId) }
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 404)) throw err
    }
  }
  return null
}

/** What the workspace tabs get from the detail page. */
export type WorkspaceContext = { org: Org; ws: Workspace; reload: () => void }
export const useWorkspace = () => useOutletContext<WorkspaceContext>()

export function WorkspaceDetail() {
  const { wsId = '' } = useParams()
  const { me, orgs, org, switchOrg, reloadWorkspaces } = useSession()
  const nav = useNavigate()
  const [found, retry] = useLoad(() => findWorkspace(orgs, org, wsId), [wsId, org?.id])
  const [editing, setEditing] = useState(false)
  const [deleting, setDeleting] = useState(false)
  // While it reloads after an edit, keep showing what was loaded, so the
  // open tab isn't torn down.
  const last = useRef<{ org: Org; ws: Workspace } | null>(null)
  const loaded = found.state === 'ready' ? found.data : null
  if (found.state === 'ready') last.current = loaded
  const hit = loaded ?? (found.state === 'loading' && last.current?.ws.id === wsId ? last.current : null)
  useEffect(() => {
    if (hit && hit.org.id !== org?.id) switchOrg(hit.org.id)
  }, [hit, org?.id, switchOrg])

  if ((found.state === 'loading' && !hit) || (hit && hit.org.id !== org?.id))
    return (
      <div className="max-w-[1120px]">
        <div className="skeleton h-3 w-40" />
        <div className="skeleton mt-4 h-5 w-64" aria-busy="true" aria-label="Loading" />
      </div>
    )
  if (found.state === 'error') return <ErrorBox what="this workspace" onRetry={retry} />
  if (!hit) return <NoAccess what="workspace" back={{ to: '/workspaces', label: 'Back to workspaces' }} />

  const w = hit.ws
  const base = `/workspaces/${w.id}`
  const reload = () => {
    retry()
    reloadWorkspaces()
  }
  return (
    <div className="max-w-[1120px]">
      <Breadcrumb items={[{ label: 'Workspaces', to: '/workspaces' }, { label: w.name }]} />
      <PageTitle
        sub={
          <span className="flex items-center gap-2 text-xs text-zinc-500">
            <span className="font-mono">{w.id}</span>·<span>{plural(w.agents, 'agent')}</span>
          </span>
        }
        actions={
          w.can_admin && (
            <>
              <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>
                Edit
              </Button>
              <Button variant="ghost" size="sm" className="text-zinc-500 hover:text-red-400" onClick={() => setDeleting(true)}>
                Delete workspace
              </Button>
            </>
          )
        }
      >
        {w.name}
      </PageTitle>
      {w.description && <div className="mt-1 text-sm2 text-zinc-500">{w.description}</div>}
      <Tabs
        tabs={[
          { to: `${base}/messages`, label: 'Messages' },
          { to: `${base}/members`, label: `Members · ${w.humans + w.agents}` },
          { to: `${base}/access`, label: 'Access' },
          { to: `${base}/webhooks`, label: 'Webhooks' },
          { to: `${base}/context`, label: 'Context' },
          { to: `${base}/connect`, label: 'Connect' },
          { to: `${base}/audit`, label: 'Audit' },
        ]}
      />
      <Outlet context={{ org: hit.org, ws: w, reload } satisfies WorkspaceContext} />
      <WorkspaceForm open={editing} onClose={() => setEditing(false)} editing={w} onSaved={reload} />
      <ImpactDialog
        open={deleting}
        onClose={() => setDeleting(false)}
        title={`Delete ${w.name}?`}
        typeToConfirm={w.name}
        rows={[
          ['Members', `${plural(w.humans, 'human')} · ${plural(w.agents, 'agent')} — their workspace tokens stop working`, 'amber'],
          ['Messages in the last 24 h', String(w.messages_24h)],
          ['Webhooks', String(w.webhooks)],
        ]}
        body={`It disappears from every list and its agents can’t get in. The audit log keeps the record of what happened here — org admins find it in Audit as “${w.name} (deleted)”.`}
        confirmLabel="Delete workspace"
        onConfirm={async () => {
          await manage.deleteWorkspace(me.csrf_token, hit.org.id, w.id)
          reloadWorkspaces()
          nav('/workspaces')
        }}
      />
    </div>
  )
}
