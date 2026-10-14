// Accepting an invitation. The inviter gets a link, /invite#dsp_inv_…, shown
// once. The token sits in the fragment, so it never reaches the server's
// logs; the app keeps it in sessionStorage across the sign-in redirect,
// then asks the signed-in person whether to join.
import { useEffect, useState } from 'react'
import { ApiError, manage, type InvitationOffer } from '../api'
import { Button, Card, DispatchMark } from '../ui'

const INVITE_KEY = 'dispatch.invite'

/** Takes an invite token from the address bar into sessionStorage and clears it from the address bar. */
export function captureInvite() {
  if (location.pathname === '/invite' && location.hash.startsWith('#dsp_inv_')) {
    sessionStorage.setItem(INVITE_KEY, decodeURIComponent(location.hash.slice(1)))
    history.replaceState(null, '', '/')
  }
}

export function pendingInvite() {
  return sessionStorage.getItem(INVITE_KEY)
}

const CLOSED: Record<string, string> = {
  invitation_accepted: 'This invite link has already been used.',
  invitation_revoked: 'This invitation was revoked.',
  invitation_expired: 'This invitation has expired.',
  already_member: 'You’re already in this organization.',
  suspended: 'This invitation is on hold. Ask the organization’s admins.',
  not_found: 'This invite link isn’t valid.',
}

function problem(err: unknown) {
  if (err instanceof ApiError) return CLOSED[err.code] ?? err.message
  return 'Something went wrong. Please try again.'
}

/** Asks whether to join the organization a pending invite link offers. onDone gets the org joined, if any. */
export function AcceptInvite({ csrf, onDone }: { csrf: string; onDone: (orgId: string | null) => void }) {
  const token = pendingInvite() ?? ''
  const [offer, setOffer] = useState<InvitationOffer | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    manage.previewInvitation(csrf, token).then(setOffer, (err) => setError(problem(err)))
  }, [csrf, token])

  function finish(orgId: string | null) {
    sessionStorage.removeItem(INVITE_KEY)
    onDone(orgId)
  }

  async function accept() {
    setBusy(true)
    try {
      finish((await manage.acceptInvitation(csrf, token)).org.id)
    } catch (err) {
      setError(problem(err))
      setBusy(false)
    }
  }

  return (
    <Card>
      <div className="flex items-center gap-2.5">
        <DispatchMark size={20} />
        <h1 className="text-[15px] font-semibold">{offer && !error ? `Join ${offer.org.name}?` : 'Invitation'}</h1>
      </div>
      {!offer && !error && <div className="mt-4 h-16 skeleton" aria-busy="true" aria-label="Loading" />}
      {offer && !error && (
        <p className="mt-4 text-sm2 text-zinc-300">
          {offer.invited_by} invited {offer.email} to {offer.org.name} as {offer.role}. Accepting joins you, as the account you’re signed in with, with that role. The invitation expires{' '}
          {new Date(offer.expires_at).toLocaleDateString()}.
        </p>
      )}
      {error && (
        <p role="alert" className="mt-4 text-sm2 text-red-400">
          {error}
        </p>
      )}
      <div className="mt-5 flex gap-2">
        {offer && !error && (
          <Button variant="primary" disabled={busy} onClick={accept}>
            {busy ? 'Joining…' : `Join ${offer.org.name}`}
          </Button>
        )}
        <Button onClick={() => finish(null)}>{error ? 'Continue' : 'Not now'}</Button>
      </div>
    </Card>
  )
}
