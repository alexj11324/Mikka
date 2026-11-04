'use client'

import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react'
import { useSWRConfig } from 'swr'
import { withBasePath } from '@/lib/base-path'
import { LiveChannel, type LiveRuntime, type LiveTicket } from '@/lib/live/channel'
import type { LiveKind } from '@/lib/live/events'

const LiveContext = createContext<LiveChannel | null>(null)

function browserRuntime(workspaceId: string): LiveRuntime {
  return {
    async ticket(signal) {
      const response = await fetch(withBasePath(`/api/live/ticket?workspace=${encodeURIComponent(workspaceId)}`), {
        cache: 'no-store', signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
      })
      if (!response.ok) return null
      const value = await response.json() as Partial<LiveTicket>
      return typeof value.url === 'string' && /^wss?:\/\//.test(value.url) && typeof value.protocol === 'string' && typeof value.expiresAt === 'number' ? value as LiveTicket : null
    },
    socket: ticket => new WebSocket(ticket.url, ticket.protocol),
    visible: () => document.visibilityState === 'visible',
    watchVisibility(changed) {
      document.addEventListener('visibilitychange', changed)
      window.addEventListener('online', changed)
      return () => { document.removeEventListener('visibilitychange', changed); window.removeEventListener('online', changed) }
    },
    now: Date.now,
    later: (callback, milliseconds) => setTimeout(callback, milliseconds),
    cancel: timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
  }
}

export function LiveProvider({ ownerId, workspaceId, children }: { ownerId: string; workspaceId?: string; children: ReactNode }) {
  const channel = useMemo(() => workspaceId ? new LiveChannel(browserRuntime(workspaceId)) : null, [ownerId, workspaceId])
  useEffect(() => () => channel?.dispose(), [channel])
  return <LiveContext value={channel}>{children}</LiveContext>
}

/** Register the SWR keys invalidated by a committed entity change. */
export function useLiveKey(kind: LiveKind, id: string | null | undefined, keys: readonly string[]) {
  const channel = useContext(LiveContext)
  const { mutate } = useSWRConfig()
  const serialized = JSON.stringify(keys)
  useEffect(() => {
    if (!channel || !id) return
    return channel.subscribe(kind, id, JSON.parse(serialized) as string[], key => mutate(key))
  }, [channel, kind, id, serialized, mutate])
}
