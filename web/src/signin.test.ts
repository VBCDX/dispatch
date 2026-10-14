// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

beforeEach(() => {
  sessionStorage.clear()
  vi.resetModules()
})

// Regression: a marker left by a *failed* silent-SSO
// attempt must never be redeemed later as a second `login`.
describe('sign-in marker accounting', () => {
  it('reports a completed sign-in exactly once', async () => {
    const { markSignIn, settleSignIn, consumeSignIn } = await import('./signin')
    markSignIn()
    expect(settleSignIn(true)).toBe(true)
    expect(settleSignIn(true)).toBe(false)
    expect(consumeSignIn()).toBe(false)
  })

  it('discards the marker when a load resolves signed-out', async () => {
    const { markSignIn, settleSignIn } = await import('./signin')
    markSignIn()
    expect(settleSignIn(false)).toBe(false) // failed silent SSO: no event, marker gone
    expect(settleSignIn(true)).toBe(false) // a later reload cannot double-count
  })

  it('retires an orphaned marker on the local sign-in path', async () => {
    const { markSignIn, settleSignIn, consumeSignIn } = await import('./signin')
    markSignIn()
    expect(consumeSignIn()).toBe(true) // local sign-in completes and consumes it
    expect(settleSignIn(true)).toBe(false) // reload still reports nothing
  })

  it('a plain load with no marker never reports a login', async () => {
    const { settleSignIn } = await import('./signin')
    expect(settleSignIn(true)).toBe(false)
    expect(settleSignIn(false)).toBe(false)
  })
})
