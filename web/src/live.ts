// The browser WebSocket's live view of a workspace: new messages as they
// are sent, and agents' acknowledgements and presence. Reconnects with a
// growing delay; onReconnect lets the screen reload what it missed. When
// the server stops the watch because access was removed, it stays stopped.
import { useEffect, useRef, useState } from 'react'
import type { Message } from './api'

export type LiveEvent = { kind: 'ack'; agent_id: string; seq: number } | { kind: 'presence'; agent_id: string; online: boolean }

export type LiveStatus = 'connecting' | 'live' | 'offline' | 'removed'

type Handlers = {
  onMessage: (m: Message, seq: number) => void
  onEvent: (e: LiveEvent) => void
  onReconnect: () => void
}

export function useWorkspaceLive(org: string | undefined, ws: string, handlers: Handlers): LiveStatus {
  const [status, setStatus] = useState<LiveStatus>('connecting')
  const h = useRef(handlers)
  h.current = handlers

  useEffect(() => {
    if (!org) return
    let sock: WebSocket | null = null
    let timer: number | undefined
    let delay = 1000
    let closed = false
    let connectedBefore = false

    const open = () => {
      setStatus('connecting')
      sock = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/ws`)
      sock.onopen = () => sock?.send(JSON.stringify({ op: 'watch', org, workspace: ws }))
      sock.onmessage = (e) => {
        let f: { op: string; workspace?: string; seq?: number; data?: unknown; error?: string }
        try {
          f = JSON.parse(e.data)
        } catch {
          return
        }
        if (f.op === 'watching') {
          setStatus('live')
          delay = 1000
          if (connectedBefore) h.current.onReconnect()
          connectedBefore = true
        } else if (f.op === 'message' && f.workspace === ws && f.seq) {
          h.current.onMessage({ ...(f.data as Message), seq: f.seq }, f.seq)
        } else if (f.op === 'event' && f.workspace === ws) {
          h.current.onEvent(f.data as LiveEvent)
        } else if (f.op === 'unwatched' && f.workspace === ws && f.error) {
          closed = true
          setStatus('removed')
          sock?.close()
        }
      }
      sock.onclose = () => {
        if (closed) return
        setStatus('offline')
        timer = window.setTimeout(open, delay)
        delay = Math.min(delay * 2, 30_000)
      }
    }
    open()
    return () => {
      closed = true
      window.clearTimeout(timer)
      sock?.close()
    }
  }, [org, ws])

  return status
}
