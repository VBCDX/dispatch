// The signed-in session: who you are, your organizations, which one is on
// screen, and its workspaces (the sidebar and the Workspaces screen share
// one load).
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import { api, ApiError, v1, type Me, type Org, type SuiteApp, type Workspace } from './api'

export type Load<T> = { state: 'loading' } | { state: 'error' } | { state: 'ready'; data: T }

type Session = {
  me: Me
  /** The VBCDX apps for the suite switcher; empty hides it. */
  suite: SuiteApp[]
  orgs: Org[]
  org: Org | null
  switchOrg: (id: string) => void
  signOut: () => Promise<void>
  /** Call with any error from the API: a 401 means the session ended, so go back to sign-in. */
  onError: (err: unknown) => void
  workspaces: Load<Workspace[]>
  reloadWorkspaces: () => void
}

const SessionContext = createContext<Session | null>(null)

export function useSession() {
  const s = useContext(SessionContext)
  if (!s) throw new Error('useSession outside SessionProvider')
  return s
}

const ORG_KEY = 'dispatch.org'

/** The org to open: the last one picked if you're still in it, else your first active one. */
function initialOrg(orgs: Org[]) {
  const saved = localStorage.getItem(ORG_KEY)
  return orgs.find((o) => o.id === saved) ?? orgs.find((o) => o.status === 'active') ?? orgs[0] ?? null
}

/**
 * Loads fn while the component is mounted, again whenever deps change or
 * retry is called. Results of superseded loads are dropped.
 */
export function useLoad<T>(fn: (() => Promise<T>) | null, deps: unknown[]): [Load<T>, () => void] {
  const { onError } = useSession()
  const [state, setState] = useState<Load<T>>({ state: 'loading' })
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (!fn) return
    let live = true
    setState({ state: 'loading' })
    fn().then(
      (data) => live && setState({ state: 'ready', data }),
      (err) => {
        if (!live) return
        onError(err)
        setState({ state: 'error' })
      },
    )
    return () => {
      live = false
    }
  }, [...deps, tick]) // eslint-disable-line react-hooks/exhaustive-deps
  return [state, () => setTick((n) => n + 1)]
}

export function SessionProvider({ me, orgs, suite, onSignedOut, children }: { me: Me; orgs: Org[]; suite: SuiteApp[]; onSignedOut: () => void; children: ReactNode }) {
  const [org, setOrg] = useState<Org | null>(() => initialOrg(orgs))
  const [workspaces, setWorkspaces] = useState<Load<Workspace[]>>({ state: 'loading' })
  const [tick, setTick] = useState(0)

  const onError = useCallback(
    (err: unknown) => {
      if (err instanceof ApiError && err.status === 401) onSignedOut()
    },
    [onSignedOut],
  )

  const active = org?.status === 'active' ? org.id : null
  useEffect(() => {
    if (!active) return
    let live = true
    setWorkspaces({ state: 'loading' })
    v1.workspaces(active).then(
      (data) => live && setWorkspaces({ state: 'ready', data }),
      (err) => {
        if (!live) return
        onError(err)
        setWorkspaces({ state: 'error' })
      },
    )
    return () => {
      live = false
    }
  }, [active, tick, onError])

  const value: Session = {
    me,
    suite,
    orgs,
    org,
    switchOrg: (id) => {
      const next = orgs.find((o) => o.id === id)
      if (!next) return
      localStorage.setItem(ORG_KEY, id)
      setOrg(next)
    },
    signOut: async () => {
      const { redirect_url } = await api.logout(me.csrf_token)
      window.location.assign(redirect_url)
    },
    onError,
    workspaces,
    reloadWorkspaces: () => setTick((n) => n + 1),
  }
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
}
