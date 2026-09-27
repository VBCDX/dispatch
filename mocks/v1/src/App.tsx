import { useEffect } from 'react'
import { HashRouter, Navigate, Route, Routes, useParams } from 'react-router-dom'
import { liveTick, useDB } from './lib/store'
import { AppShell } from './components/AppShell'
import { DemoPanel } from './components/DemoPanel'
import { SecretHost } from './components/credential'
import { Developers } from './pages/Developers'
import { AccountSettings, AuditPage, Home, MySettings, SearchPage } from './pages/misc'
import { AgentDetail, AgentsPage, UserDetail, UsersPage } from './pages/players'
import { OrgAgents, OrgAudit, OrgDetail, OrgMembers, OrgOverview, OrgsList, OrgWorkspaces } from './pages/orgs'
import { WorkspaceDetail, WorkspacesList, WsAudit, WsContext, WsMessages, WsWebhooks } from './pages/workspaces'
import { WsAccess, WsConnect, WsMembers } from './pages/wsAccess'

/** Drives the simulated agents while the prototype's simulation is running. */
function Simulation() {
  const live = useDB().live
  useEffect(() => {
    if (!live) return
    const t = setInterval(liveTick, 3000)
    return () => clearInterval(t)
  }, [live])
  return null
}

function OldAgentLink() {
  const { agentId } = useParams()
  return <Navigate to={`/players/agents/${agentId}`} replace />
}

export default function App() {
  return (
    <HashRouter>
      <Simulation />
      <Routes>
        <Route element={<AppShell />}>
          <Route index element={<Home />} />
          <Route path="orgs" element={<OrgsList />} />
          <Route path="orgs/:orgId" element={<OrgDetail />}>
            <Route index element={<Navigate to="overview" replace />} />
            <Route path="overview" element={<OrgOverview />} />
            <Route path="members" element={<OrgMembers />} />
            <Route path="agents" element={<OrgAgents />} />
            <Route path="workspaces" element={<OrgWorkspaces />} />
            <Route path="audit" element={<OrgAudit />} />
          </Route>
          <Route path="workspaces" element={<WorkspacesList />} />
          <Route path="workspaces/:wsId" element={<WorkspaceDetail />}>
            <Route index element={<Navigate to="messages" replace />} />
            <Route path="messages" element={<WsMessages />} />
            <Route path="members" element={<WsMembers />} />
            <Route path="access" element={<WsAccess />} />
            <Route path="webhooks" element={<WsWebhooks />} />
            <Route path="context" element={<WsContext />} />
            <Route path="connect" element={<WsConnect />} />
            <Route path="audit" element={<WsAudit />} />
          </Route>
          <Route path="search" element={<SearchPage />} />
          <Route path="players/users" element={<UsersPage />} />
          <Route path="players/users/:userId" element={<UserDetail />} />
          <Route path="players/agents" element={<AgentsPage />} />
          <Route path="players/agents/:agentId" element={<AgentDetail />} />
          {/* Old addresses keep working. */}
          <Route path="agents" element={<Navigate to="/players/agents" replace />} />
          <Route path="agents/:agentId" element={<OldAgentLink />} />
          <Route path="people" element={<Navigate to="/players/users" replace />} />
          <Route path="audit" element={<AuditPage />} />
          <Route path="developers" element={<Developers />} />
          <Route path="settings/me" element={<MySettings />} />
          <Route path="settings/account" element={<AccountSettings />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
      <DemoPanel />
      <SecretHost />
    </HashRouter>
  )
}
