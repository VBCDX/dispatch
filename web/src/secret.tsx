// One-time secrets and confirmations for the agent screens. Brass means a
// credential is near (index.css).
import { useState, type ReactNode } from 'react'
import { Button, cx } from './ui'

export function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <Button
      size="sm"
      onClick={() =>
        navigator.clipboard.writeText(value).then(() => {
          setCopied(true)
          window.setTimeout(() => setCopied(false), 1200)
        })
      }
    >
      {copied ? 'Copied' : label}
    </Button>
  )
}

/** A secret shown once. It stays until the person confirms they stored it. */
export function SecretPanel({ title, children, onDone, note }: { title: ReactNode; children: ReactNode; onDone: () => void; note?: ReactNode }) {
  return (
    <section role="alert" className="rounded-[10px] border border-brass/50 bg-secret-bg p-4">
      <div className="text-[13px] font-semibold text-brass-light">{title}</div>
      <div className="mt-1 text-xs text-zinc-400">{note ?? 'Shown once. Dispatch keeps only a hash, so store it now: it can’t be shown again, only replaced.'}</div>
      <div className="mt-3 flex flex-col gap-2.5">{children}</div>
      <div className="mt-4">
        <Button variant="primary" size="sm" onClick={onDone}>
          I’ve stored it
        </Button>
      </div>
    </section>
  )
}

export function SecretLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[150px_1fr_auto] items-center gap-3">
      <span className="text-xs text-zinc-500">{label}</span>
      <code className="overflow-x-auto rounded-md border border-brass/30 bg-page px-2.5 py-1.5 font-mono text-xs text-brass-pale whitespace-nowrap">{value}</code>
      <CopyButton value={value} />
    </div>
  )
}

export function CodeBlock({ text }: { text: string }) {
  return (
    <div className="relative">
      <pre className="m-0 overflow-x-auto rounded-md border border-line bg-rail px-3 py-2.5 font-mono text-xs2 leading-relaxed text-zinc-300">{text}</pre>
      <div className="absolute top-1.5 right-1.5">
        <CopyButton value={text} />
      </div>
    </div>
  )
}

/** An inline confirmation for a consequential action. */
export function Confirm({
  title,
  body,
  confirmLabel,
  danger,
  busy,
  onConfirm,
  onCancel,
}: {
  title: ReactNode
  body: ReactNode
  confirmLabel: string
  danger?: boolean
  busy?: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <div role="dialog" aria-label={typeof title === 'string' ? title : undefined} className={cx('rounded-[10px] border p-4', danger ? 'border-red-500/35 bg-red-500/[0.05]' : 'border-edge bg-panel')}>
      <div className={cx('text-[13px] font-semibold', danger ? 'text-red-400' : 'text-zinc-100')}>{title}</div>
      <div className="mt-1 text-xs text-zinc-400">{body}</div>
      <div className="mt-3 flex gap-2">
        <Button variant="primary" size="sm" disabled={busy} onClick={onConfirm}>
          {busy ? 'Working…' : confirmLabel}
        </Button>
        <Button size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  )
}

export const maskToken = (prefix: string, last4: string) => `${prefix || 'dsp_'}••••${last4}`

/** The env and command for the example agent; tokens only when given. */
export function demoCommand(serverURL: string, agentToken?: string, wsToken?: string) {
  return [
    `export DISPATCH_URL=${serverURL}`,
    `export DISPATCH_AGENT_TOKEN=${agentToken ?? '<agent token>'}`,
    `export DISPATCH_WORKSPACE_TOKEN=${wsToken ?? '<workspace token>'}`,
    'dispatch agent demo --say "hello from my agent"',
  ].join('\n')
}

export function errorText(err: unknown) {
  return err instanceof Error && err.message ? err.message : 'Something went wrong. Nothing was changed.'
}
