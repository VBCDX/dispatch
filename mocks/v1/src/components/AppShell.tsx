import { Outlet } from 'react-router-dom'
import { iAmActive, me, org, statusIn, useDB } from '../lib/store'
import { Sidebar } from './Sidebar'
import { Callout } from './ui'

export function AppShell() {
  const d = useDB()
  return (
    <div className="flex h-full bg-page text-zinc-100">
      <Sidebar />
      <main className="min-w-0 flex-1 overflow-y-auto px-10 py-8">
        {!iAmActive(d) && (
          <Callout tone="amber" className="mb-5">
            {me(d)?.name}’s account is {statusIn(me(d), d.currentOrgId) === 'suspended' ? 'suspended' : 'not active'} in {org(d)?.name}. Other organizations aren’t affected. Here you can look around, but you can’t change anything, post, or send API requests until an admin resumes you.
          </Callout>
        )}
        <Outlet />
      </main>
    </div>
  )
}
