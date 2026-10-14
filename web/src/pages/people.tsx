// The People screen, ported from the mock (mocks/v1/src/pages/players.tsx
// PeoplePage): the organization's members, invitations (pending, with an
// invite link shown once; no email is sent yet), role changes, suspend and
// remove.
import { useEffect, useState } from 'react'
import { ApiError, manage, type OrgRole, type Person } from '../api'
import { Callout, Footer, FormField, ImpactDialog, Menu, Modal, PrincipalChip, Segmented, StatusInline, TextInput, ago, errorText, type ImpactRow } from '../kit'
import { SecretLine, SecretPanel } from '../secret'
import { useLoad, useSession } from '../session'
import { Button, ErrorBox, PageTitle, Row, SkeletonRows, Table } from '../ui'

const P_COLS = '1.4fr 1.6fr 0.9fr 1fr 0.8fr 1fr 36px'
type Action = { kind: 'role' | 'suspend' | 'resume' | 'remove'; p: Person; role?: OrgRole }

export function PeoplePage() {
  const { org } = useSession()
  const [list, retry] = useLoad(() => manage.people(org!.id), [org?.id])
  const [inviting, setInviting] = useState(false)
  const [acting, setActing] = useState<Action | null>(null)
  const data = list.state === 'ready' ? list.data : null
  const activeOwners = data?.people.filter((p) => p.role === 'Owner' && p.status === 'active').length ?? 0
  const lastOwner = (p: Person) => p.role === 'Owner' && p.status === 'active' && activeOwners <= 1
  return (
    <div>
      <PageTitle
        actions={
          data?.can_invite && (
            <Button variant="primary" onClick={() => setInviting(true)}>
              Invite person
            </Button>
          )
        }
      >
        People
      </PageTitle>
      <div className="mt-1 max-w-[760px] text-sm2 text-zinc-500">Humans sign in to the web app. Like agents, they see a workspace only once an admin adds them — and inside it they can read, search and post to every message.</div>
      <Table cols={P_COLS} head={['Name', 'Email', 'Org role', 'Status', 'Workspaces', 'Last active', '']} className="mt-5 max-w-[1120px]">
        {list.state === 'loading' ? (
          <SkeletonRows cols={P_COLS} />
        ) : list.state === 'error' || !data ? (
          <div className="p-3">
            <ErrorBox what="people" onRetry={retry} />
          </div>
        ) : (
          data.people.map((p) => (
            <Row key={p.user_id} cols={P_COLS}>
              <div className="min-w-0">
                <PrincipalChip kind="user" name={p.name || p.email} />
                {p.is_me && <span className="ml-[30px] text-2xs text-zinc-600">you</span>}
              </div>
              <div className="truncate text-zinc-400">{p.email}</div>
              <div className="text-zinc-400">
                {p.role}
                {lastOwner(p) && <div className="text-2xs text-zinc-600">last active Owner</div>}
              </div>
              <div>
                {p.status === 'active' ? (
                  <StatusInline tone="green">Active</StatusInline>
                ) : p.status === 'invited' ? (
                  <span>
                    <StatusInline tone="gray">Invited</StatusInline>
                    {p.invitation && <div className="text-2xs text-zinc-600">pending · expires {new Date(p.invitation.expires_at).toLocaleDateString()}</div>}
                  </span>
                ) : (
                  <span>
                    <StatusInline tone="amber">Suspended</StatusInline>
                    {p.suspended_from === 'invited' && <div className="text-2xs text-zinc-600">was invited</div>}
                  </span>
                )}
              </div>
              <div className="text-zinc-400">{p.workspaces || '—'}</div>
              <div className="text-zinc-500">{p.is_me ? 'Now' : ago(p.last_active_at)}</div>
              <div className="text-right">
                {p.can_manage && (
                  <Menu
                    label={`Actions for ${p.name || p.email}`}
                    items={[
                      p.role !== 'user' && { label: 'Make user', disabled: lastOwner(p), hint: lastOwner(p) ? 'The last active Owner — make someone else Owner first' : undefined, onClick: () => setActing({ kind: 'role', p, role: 'user' }) },
                      p.role !== 'userAdmin' && { label: 'Make userAdmin', disabled: lastOwner(p), hint: lastOwner(p) ? 'The last active Owner — make someone else Owner first' : undefined, onClick: () => setActing({ kind: 'role', p, role: 'userAdmin' }) },
                      data.my_role === 'Owner' && p.role !== 'Owner' && { label: 'Make Owner', onClick: () => setActing({ kind: 'role', p, role: 'Owner' }) },
                      p.status === 'suspended'
                        ? { label: 'Resume', onClick: () => setActing({ kind: 'resume', p }) }
                        : { label: 'Suspend…', disabled: lastOwner(p), hint: lastOwner(p) ? 'The last active Owner' : undefined, onClick: () => setActing({ kind: 'suspend', p }) },
                      { label: p.status === 'invited' ? 'Revoke invitation…' : 'Remove from organization…', danger: true, disabled: lastOwner(p), hint: lastOwner(p) ? 'The last active Owner' : undefined, onClick: () => setActing({ kind: 'remove', p }) },
                    ]}
                  />
                )}
              </div>
            </Row>
          ))
        )}
      </Table>
      {data && !data.can_invite && <div className="mt-3 text-xs2 text-zinc-600">Only the organization’s Owners and userAdmins can invite people or change their access.</div>}
      <InviteModal open={inviting} onClose={() => setInviting(false)} owner={data?.my_role === 'Owner'} onDone={retry} />
      <PersonConfirm acting={acting} onClose={() => setActing(null)} onDone={retry} />
    </div>
  )
}

function InviteModal({ open, onClose, owner, onDone }: { open: boolean; onClose: () => void; owner: boolean; onDone: () => void }) {
  const { me, org } = useSession()
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<OrgRole>('user')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [taken, setTaken] = useState(false)
  const [link, setLink] = useState<string | null>(null)
  useEffect(() => {
    if (open) {
      setEmail('')
      setRole('user')
      setError(null)
      setTaken(false)
      setBusy(false)
      setLink(null)
    }
  }, [open])
  async function invite() {
    setBusy(true)
    setError(null)
    setTaken(false)
    try {
      setLink((await manage.invite(me.csrf_token, org!.id, email.trim(), role)).invite_url)
      setBusy(false)
      onDone()
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) setTaken(true)
      else setError(errorText(err))
      setBusy(false)
    }
  }
  const roles: { value: OrgRole; label: string }[] = [
    { value: 'user', label: 'user' },
    { value: 'userAdmin', label: 'userAdmin' },
  ]
  if (owner) roles.push({ value: 'Owner', label: 'Owner' })
  if (link)
    return (
      <Modal open={open} onClose={onClose} width={520} title="Invite person">
        <SecretPanel title={`Invite link for ${email.trim()}`} onDone={onClose}>
          <SecretLine label="Invite link" value={link} />
          <div className="text-xs text-zinc-400">
            Send it to {email.trim()} yourself: Dispatch doesn’t send invitation email yet. Whoever opens it while signed in, with any sign-in method, joins {org?.name} as {role}. It works once and
            expires in 7 days. Revoking the invitation on People stops it.
          </div>
        </SecretPanel>
      </Modal>
    )
  return (
    <Modal open={open} onClose={onClose} width={440} title="Invite person">
      <FormField label="Email" error={taken ? `${email.trim()} is already in ${org?.name}.` : null}>
        <TextInput type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
      </FormField>
      <FormField label="Org role" hint="Owners and userAdmins administer every workspace. Users see only the workspaces they’ve been added to.">
        <Segmented label="Org role" value={role} onChange={setRole} options={roles} />
      </FormField>
      <Callout tone="neutral">The invitation shows as pending, and you get an invite link to send them. Dispatch doesn’t send invitation email yet.</Callout>
      {error && <Callout tone="red">{error}</Callout>}
      <Footer>
        <Button size="lg" onClick={onClose}>
          Cancel
        </Button>
        <Button size="lg" variant="primary" disabled={busy || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())} onClick={invite}>
          {busy ? 'Inviting…' : 'Invite'}
        </Button>
      </Footer>
    </Modal>
  )
}

/** Confirm dialogs for People: role changes, suspend, resume and remove. Nothing a person did is undone. */
function PersonConfirm({ acting, onClose, onDone }: { acting: Action | null; onClose: () => void; onDone: () => void }) {
  const { me, org } = useSession()
  const p = acting?.p
  const name = p ? p.name || p.email : ''
  const csrf = me.csrf_token
  const orgId = org?.id ?? ''
  const done = <T,>(f: () => Promise<T>) => async () => {
    await f()
    onDone()
  }
  const standing: ImpactRow[] = [
    ['Agents they registered', 'Unaffected — agents belong to the organization'],
    ['Admin rights they delegated', 'Stand'],
    ['Messages they sent', 'Stay, under their name'],
  ]
  let spec: { title: string; rows: ImpactRow[]; body?: string; confirm: string; danger: boolean; run: () => Promise<unknown> } | null = null
  if (acting && p) {
    if (acting.kind === 'role') {
      const role = acting.role!
      spec = {
        title: `Make ${name} ${role === 'Owner' ? 'an Owner' : `a ${role}`}?`,
        rows: [
          ['Org role', `${p.role} → ${role}`, 'amber'],
          ['Workspaces', role === 'user' ? 'Sees only the workspaces they’ve been added to' : 'Administers every workspace in the organization'],
          ...(role === 'Owner' ? ([['Can then', 'Manage Owners, and make others Owner']] as ImpactRow[]) : []),
        ],
        body: 'Permission is checked when an action happens; what they already did stays in place.',
        confirm: role === 'user' ? 'Make user' : role === 'userAdmin' ? 'Make userAdmin' : 'Make Owner',
        danger: role === 'user',
        run: done(() => manage.setOrgRole(csrf, orgId, p.user_id, role)),
      }
    } else if (acting.kind === 'resume') {
      spec = {
        title: `Resume ${name}?`,
        rows: [['Status', `suspended → ${p.suspended_from ?? 'active'}`, 'amber']],
        body: p.suspended_from === 'invited' ? 'They go back to invited and still have to accept.' : 'They can open the organization again with the access they had.',
        confirm: 'Resume',
        danger: false,
        run: done(() => manage.resume(csrf, orgId, p.user_id)),
      }
    } else if (acting.kind === 'suspend') {
      spec = {
        title: `Suspend ${name}?`,
        rows: [['Org role', p.role, 'amber'], ['Workspaces', `${p.workspaces} — memberships kept`], ...standing],
        body: `Blocks them from ${org?.name} entirely until resumed — they can’t open anything here (their other organizations aren’t affected). Resume restores the status they had before.`,
        confirm: 'Suspend',
        danger: true,
        run: done(() => manage.suspend(csrf, orgId, p.user_id)),
      }
    } else {
      spec = {
        title: p.status === 'invited' ? `Revoke ${name}’s invitation?` : `Remove ${name} from ${org?.name}?`,
        rows: [['Org role', `${p.role} → none`, 'amber'], ['Their workspace memberships', `${p.workspaces} — removed`, p.workspaces ? 'amber' : undefined], ...standing],
        body: 'Losing permission doesn’t undo what was already done, and the audit log keeps their name on all of it.',
        confirm: p.status === 'invited' ? 'Revoke invitation' : 'Remove from organization',
        danger: true,
        run: done(() => manage.removePerson(csrf, orgId, p.user_id)),
      }
    }
  }
  return <ImpactDialog open={!!spec} onClose={onClose} title={spec?.title ?? ''} rows={spec?.rows ?? []} body={spec?.body} confirmLabel={spec?.confirm ?? ''} danger={spec?.danger} onConfirm={spec?.run ?? (async () => undefined)} />
}
