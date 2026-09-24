import { useEffect } from 'react'
import { HashRouter, Navigate, Route, Routes } from 'react-router-dom'
import { liveTick, useDB } from './lib/store'
import { AppShell } from './components/AppShell'
import { DemoPanel } from './components/DemoPanel'
import { Developers } from './pages/Developers'
import { AccountSettings, AuditPage, Home, MySettings, SearchPage } from './pages/misc'
import { AgentDetail, AgentsPage, PeoplePage } from './pages/players'
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

export default function App() {
  return (
    <HashRouter>
      <Simulation />
      <Routes>
        <Route element={<AppShell />}>
          <Route index element={<Home />} />
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
          <Route path="agents" element={<AgentsPage />} />
          <Route path="agents/:agentId" element={<AgentDetail />} />
          <Route path="people" element={<PeoplePage />} />
          <Route path="audit" element={<AuditPage />} />
          <Route path="developers" element={<Developers />} />
          <Route path="settings/me" element={<MySettings />} />
          <Route path="settings/account" element={<AccountSettings />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
      <DemoPanel />
    </HashRouter>
  )
}
