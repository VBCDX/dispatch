// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// gtag() queues its arguments; one queued hit is [command, ...args].
type Hit = unknown[]

function setLocation(href: string): void {
  Object.defineProperty(window, 'location', { configurable: true, value: new URL(href) })
}

function setReferrer(value: string): void {
  Object.defineProperty(document, 'referrer', { configurable: true, value })
}

/** A fresh module (enabled/initialized are module-level state). */
async function load() {
  vi.resetModules()
  return await import('./analytics')
}

beforeEach(() => {
  delete (window as { dataLayer?: unknown[] }).dataLayer
  delete (window as { gtag?: unknown }).gtag
  document.head.innerHTML = ''
  setLocation('https://dispatch.example.com/')
  setReferrer('')
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('normalizePath', () => {
  it('normalizes app ids, uuids, hex and numbers to :id', async () => {
    const { normalizePath } = await load()
    const cases: Array<[string, string]> = [
      ['/workspaces/ws_3fK9qLm0ZtR8bW2x/messages', '/workspaces/:id/messages'],
      ['/agents/ag_0123456789ABCDEF', '/agents/:id'],
      ['/workspaces/wm_abcdefghijklmnop/members', '/workspaces/:id/members'],
      ['/events/trk_ZzYyXxWwVvUuTtSs', '/events/:id'],
      ['/u/3f2a1b9c-8d4e-4f6a-9b2c-1d3e5f7a9b0c', '/u/:id'],
      ['/t/0123456789abcdef', '/t/:id'],
      ['/events/12345', '/events/:id'],
      ['/workspaces', '/workspaces'],
      ['/auth/callback?code=secret&state=x#f', '/auth/callback'],
      ['/', '/'],
    ]
    for (const [input, want] of cases) {
      expect(normalizePath(input), input).toBe(want)
    }
  })
})

describe('privacy filter (allowlist + GA4 auto-parameter override)', () => {
  it('drops undocumented keys and never queues a code/state, referrer query or email', async () => {
    setLocation(
      'https://dispatch.example.com/workspaces/ws_3fK9qLm0ZtR8bW2x/messages?code=SUPERSECRET&state=STATEVAL',
    )
    setReferrer('https://idp.example.com/ui/v2/login/authorize?code_challenge=CHALLENGE&state=STATEVAL')
    const { initAnalytics, trackEvent, trackPageView } = await load()
    expect(initAnalytics('G-TEST12345')).toBe(true)

    trackPageView('/workspaces/ws_3fK9qLm0ZtR8bW2x/messages', 'Messages')
    trackEvent('login', { method: 'local', email: 'person@example.com', intent: 'signup' })

    const hits = (window.dataLayer ?? []).filter((hit) => (hit as Hit)[0] === 'event')
    expect(hits).toHaveLength(2)
    const queued = JSON.stringify(hits)
    expect(queued).not.toContain('SUPERSECRET')
    expect(queued).not.toContain('STATEVAL')
    expect(queued).not.toContain('CHALLENGE')
    expect(queued).not.toContain('person@example.com')
    expect(queued).not.toContain('signup')

    for (const hit of hits) {
      const params = (hit as Hit)[2] as Record<string, unknown>
      expect(params.page_location).toBe('https://dispatch.example.com/workspaces/:id/messages')
      expect(params.page_referrer).toBe('https://idp.example.com')
    }
    const pageView = (hits[0] as Hit)[2] as Record<string, unknown>
    expect(Object.keys(pageView).sort()).toEqual([
      'page_location',
      'page_path',
      'page_referrer',
      'page_title',
    ])
    expect(pageView.page_path).toBe('/workspaces/:id/messages')
  })

  it('is a no-op before init and refuses an invalid measurement id', async () => {
    const { initAnalytics, trackEvent } = await load()
    trackEvent('page_view', { page_path: '/' })
    expect(window.dataLayer).toBeUndefined()
    expect(initAnalytics('not-an-id')).toBe(false)
    expect(initAnalytics(undefined)).toBe(false)
    trackEvent('page_view', { page_path: '/' })
    expect(window.dataLayer).toBeUndefined()
    expect(document.head.querySelector('script')).toBeNull()
  })

  it('loads the tag once, keeps auto page views off, and configures sanitized defaults', async () => {
    setLocation('https://dispatch.example.com/workspaces/ws_0123456789ABCDEF')
    const { initAnalytics } = await load()
    expect(initAnalytics('G-ABCD1234')).toBe(true)
    expect(initAnalytics('G-OTHER1234')).toBe(true) // already on: true, and no second loader
    const scripts = document.head.querySelectorAll('script')
    expect(scripts).toHaveLength(1)
    expect(scripts[0]!.src).toContain('id=G-ABCD1234')
    const config = (window.dataLayer ?? []).find((hit) => (hit as Hit)[0] === 'config') as Hit
    const opts = config[2] as Record<string, unknown>
    expect(opts.send_page_view).toBe(false)
    expect(opts.allow_google_signals).toBe(false)
    expect(opts.page_location).toBe('https://dispatch.example.com/workspaces/:id')
    expect(opts.page_referrer).toBe('')
  })
})
