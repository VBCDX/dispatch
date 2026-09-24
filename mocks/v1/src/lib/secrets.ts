import type { ReactNode } from 'react'

/*
 * One-time secrets are shown by a single host at the app root, not by the
 * page or drawer that created them. Closing a drawer, pressing Escape or
 * navigating can't unmount a secret before it's been acknowledged.
 */
export type SecretSpec = { title: string; subtitle?: ReactNode; note?: ReactNode; onDone?: () => void } & ({ kind: 'token'; token: string } | { kind: 'listener'; url: string; user: string; password: string })

let queue: SecretSpec[] = []
const subs = new Set<() => void>()
const emit = () => subs.forEach((f) => f())

export function showSecret(s: SecretSpec) {
  queue = [...queue, s]
  emit()
}
export function acknowledgeSecret() {
  const [cur, ...rest] = queue
  queue = rest
  emit()
  cur?.onDone?.()
}
export const subscribeSecrets = (f: () => void) => {
  subs.add(f)
  return () => void subs.delete(f)
}
export const pendingSecrets = () => queue
