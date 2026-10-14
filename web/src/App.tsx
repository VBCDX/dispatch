import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { api, ApiError, v1, type AuthConfig, type Me, type Org, type SuiteApp } from './api'
import { initAnalytics, trackEvent, trackPageView } from './analytics'
import { consumeSignIn, markSignIn, settleSignIn } from './signin'
import { AgentDetail, AgentsPage } from './pages/agents'
import { AuditPage, WsAudit } from './pages/audit'
import { WsConnect } from './pages/connect'
import { WsAccess, WsMembers } from './pages/members'
import { WsMessages } from './pages/messages'
import { AcceptInvite, captureInvite, pendingInvite } from './pages/invite'
import { WsWebhooks } from './pages/webhooks'
import { PeoplePage } from './pages/people'
import { WorkspaceDetail, WorkspacesList } from './pages/workspaces'
import { SessionProvider } from './session'
import { AppShell } from './shell'
import { Button, ButtonLink, Card, ComingSoon, DispatchMark, ErrorBox, Field, Input } from './ui'

// Messages for the ?error= codes the server redirects back with.
const REDIRECT_ERRORS: Record<string, string> = {
  signin_failed: 'Single sign-on did not complete. Please try again.',
  provider_unavailable: 'The single sign-on provider is not reachable right now. Please try again shortly.',
  zitadel_not_enabled: 'Single sign-on is not enabled on this server.',
}

type State =
  | { kind: 'loading' }
  | { kind: 'failed'; message: string }
  | { kind: 'signed-out'; config: AuthConfig }
  | { kind: 'signed-in'; me: Me; config: AuthConfig }

// Apps on the same OpenID Connect provider share its sign-in session. With
// no Dispatch session, try joining it silently (prompt=none) before showing the sign-in page; the
// server allows one attempt per few minutes and none after a sign-out, and
// says so in silent_sign_in, so this cannot loop.
const SILENT_SIGN_IN = '/auth/oidc/login?prompt=none'

function signedOutState(config: AuthConfig): State {
  if (config.zitadel && config.silent_sign_in) {
    markSignIn() // the silent SSO attempt is still a sign-in
    window.location.assign(SILENT_SIGN_IN)
    return { kind: 'loading' }
  }
  return { kind: 'signed-out', config }
}

export function App() {
  useState(captureInvite) // before any sign-in redirect can drop the link
  const [state, setState] = useState<State>({ kind: 'loading' })
  const [notice, setNotice] = useState<string | null>(null)

  // The session ended (an API call came back 401): back to sign-in.
  const signedOut = useCallback(() => {
    setNotice('Your session ended. Please sign in again.')
    api.authConfig().then(
      (config) => setState(signedOutState(config)),
      () => setState({ kind: 'failed', message: 'Dispatch is not responding. Reload to try again.' }),
    )
  }, [])

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const code = params.get('error')
    if (code) {
      setNotice(REDIRECT_ERRORS[code] ?? 'Sign-in failed. Please try again.')
      window.history.replaceState(null, '', window.location.pathname)
    }
    Promise.all([api.authConfig(), api.me()])
      .then(([config, me]) => {
        // Analytics is server-configured: load the tag as soon as the
        // config says so; with no id this is a no-op.
        initAnalytics(config.ga_measurement_id)
        trackPageView(window.location.pathname, document.title)
        // A sign-in this browser started (SSO redirect or silent SSO)
        // just completed: one aggregate event, method from the session. A
        // load that resolves signed-out discards any marker, so a failed
        // silent-SSO attempt cannot double-count a later local sign-in.
        if (settleSignIn(me !== null) && me) trackEvent('login', { method: me.method })
        setState(me ? { kind: 'signed-in', me, config } : signedOutState(config))
      })
      .catch(() => setState({ kind: 'failed', message: 'Dispatch is not responding. Reload to try again.' }))
  }, [])

  switch (state.kind) {
    case 'loading':
      return <Card><div className="h-24 skeleton" aria-busy="true" aria-label="Loading" /></Card>
    case 'failed':
      return <Card><p role="alert" className="text-sm2 text-red-400">{state.message}</p></Card>
    case 'signed-out':
      return <SignIn config={state.config} notice={notice} onSignedIn={(me) => setState({ kind: 'signed-in', me, config: state.config })} />
    case 'signed-in':
      return <SignedIn me={state.me} suite={state.config.suite_apps} onSignedOut={signedOut} />
  }
}

function SignIn({ config, notice, onSignedIn }: { config: AuthConfig; notice: string | null; onSignedIn: (me: Me) => void }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(notice)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const me = await api.login(email, password)
      consumeSignIn() // a completed local sign-in retires any orphaned marker
      trackEvent('login', { method: 'local' })
      onSignedIn(me)
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) setError('Wrong email or password.')
      else if (err instanceof ApiError && err.status === 429) {
        const minutes = Math.max(1, Math.ceil((err.retryAfter ?? 60) / 60))
        setError(`Too many failed sign-ins. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`)
      } else setError('Sign-in failed. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <div className="flex items-center gap-2.5">
        <DispatchMark size={20} />
        <h1 className="text-[15px] font-semibold">Sign in to Dispatch</h1>
      </div>
      {pendingInvite() && <p className="mt-3 text-sm2 text-zinc-400">Sign in to accept your invitation.</p>}

      {error && (
        <p role="alert" className="mt-4 rounded-lg border border-red-900/60 bg-red-950/40 px-3 py-2 text-sm2 text-red-300">
          {error}
        </p>
      )}

      {config.zitadel && (
        <ButtonLink variant="primary" href="/auth/oidc/login" className="mt-5 w-full" onClick={markSignIn}>
          Sign in with single sign-on
        </ButtonLink>
      )}

      {config.zitadel && config.local && (
        <div className="my-5 flex items-center gap-3 text-2xs uppercase tracking-[0.08em] text-zinc-600">
          <span className="h-px flex-1 bg-line" />
          or
          <span className="h-px flex-1 bg-line" />
        </div>
      )}

      {config.local && (
        <form onSubmit={submit} className={config.zitadel ? 'flex flex-col gap-4' : 'mt-5 flex flex-col gap-4'}>
          <Field label="Email" htmlFor="email">
            <Input id="email" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <Field label="Password" htmlFor="password">
            <Input id="password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
          <Button type="submit" variant={config.zitadel ? 'secondary' : 'primary'} disabled={busy}>
            {busy ? 'Signing in…' : 'Sign in'}
          </Button>
        </form>
      )}

      {!config.local && !config.zitadel && <p className="mt-4 text-sm2 text-zinc-400">No sign-in method is enabled.</p>}
    </Card>
  )
}

/** Loads your organizations, then runs the app inside the shell. */
function SignedIn({ me, suite, onSignedOut }: { me: Me; suite: SuiteApp[]; onSignedOut: () => void }) {
  const [orgs, setOrgs] = useState<Org[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [tick, setTick] = useState(0)
  const [invite, setInvite] = useState(pendingInvite() !== null)

  useEffect(() => {
    let live = true
    setFailed(false)
    v1.orgs().then(
      (o) => live && setOrgs(o),
      (err) => {
        if (!live) return
        if (err instanceof ApiError && err.status === 401) onSignedOut()
        else setFailed(true)
      },
    )
    return () => {
      live = false
    }
  }, [tick, onSignedOut])

  if (failed)
    return (
      <Card>
        <ErrorBox what="your organizations" onRetry={() => setTick((n) => n + 1)} />
      </Card>
    )
  if (invite)
    return (
      <AcceptInvite
        csrf={me.csrf_token}
        onDone={(orgId) => {
          if (orgId) {
            localStorage.setItem('dispatch.org', orgId) // open the organization just joined
            setOrgs(null)
            setTick((n) => n + 1)
          }
          setInvite(false)
        }}
      />
    )
  if (!orgs) return <Card><div className="h-24 skeleton" aria-busy="true" aria-label="Loading" /></Card>
  return (
    <SessionProvider me={me} orgs={orgs} suite={suite} onSignedOut={onSignedOut}>
      <BrowserRouter>
        <Routes>
          <Route element={<AppShell />}>
            <Route index element={<ComingSoon title="Home" />} />
            <Route path="workspaces" element={<WorkspacesList />} />
            <Route path="workspaces/:wsId" element={<WorkspaceDetail />}>
              <Route index element={<Navigate to="messages" replace />} />
              <Route path="messages" element={<WsMessages />} />
              <Route path="members" element={<WsMembers />} />
              <Route path="access" element={<WsAccess />} />
              <Route path="connect" element={<WsConnect />} />
              <Route path="audit" element={<WsAudit />} />
              <Route path="webhooks" element={<WsWebhooks />} />
              {['context'].map((tab) => (
                <Route key={tab} path={tab} element={<ComingSoon inline />} />
              ))}
            </Route>
            <Route path="search" element={<ComingSoon title="Search" />} />
            <Route path="agents" element={<AgentsPage />} />
            <Route path="agents/:agentId" element={<AgentDetail />} />
            <Route path="people" element={<PeoplePage />} />
            <Route path="audit" element={<AuditPage />} />
            <Route path="developers" element={<ComingSoon title="API & MCP" />} />
            <Route path="settings/me" element={<ComingSoon title="My Settings" />} />
            <Route path="settings/account" element={<ComingSoon title="Account" />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </SessionProvider>
  )
}
