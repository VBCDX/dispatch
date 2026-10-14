/*
 * Remembers that this browser just started a sign-in (the SSO redirect or
 * the silent SSO attempt), so the first load that resolves to a session can
 * report login completion exactly once. Best-effort: without
 * sessionStorage the flow still works, only the completion event is lost.
 */
const KEY = 'dispatch.signin.pending'

export function markSignIn(): void {
  try {
    sessionStorage.setItem(KEY, '1')
  } catch {
    /* storage unavailable */
  }
}

/** True once per marked sign-in: consumes the marker. */
export function consumeSignIn(): boolean {
  try {
    const value = sessionStorage.getItem(KEY)
    if (value !== null) sessionStorage.removeItem(KEY)
    return value !== null
  } catch {
    return false
  }
}

/**
 * Settles the marker for a load that has resolved: consumes it when the load
 * has a session (reports completion exactly once) and discards it when the
 * load resolved signed-out. The discard is what stops a failed silent-SSO
 * attempt — whose marker otherwise survives — from being redeemed later as a
 * spurious second `login` after a local sign-in plus reload.
 */
export function settleSignIn(hasSession: boolean): boolean {
  const pending = consumeSignIn()
  return hasSession && pending
}
