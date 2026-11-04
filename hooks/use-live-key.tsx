'use client'

import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react'
import { useSWRConfig } from 'swr'
import { withBasePath } from '@/lib/base-path'
import { type LiveRuntime, type LiveTicket } from '@/lib/live/channel'
import { LiveChannels } from '@/lib/live/channels'
import type { LiveKind } from '@/lib/live/events'

const LiveContext = createContext<{ channels: LiveChannels; workspaceId?: string } | null>(null)

function browserRuntime(workspaceId: string | null): LiveRuntime {
  return {
    async ticket(signal) {
      // An unresolved/inaccessible entity has slow fallback reads, never a guessed channel.
      if (!workspaceId) return null
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
  const channels = useMemo(() => new LiveChannels(browserRuntime), [ownerId])
  const value = useMemo(() => ({ channels, workspaceId }), [channels, workspaceId])
  useEffect(() => () => channels.dispose(), [channels])
  return <LiveContext value={value}>{children}</LiveContext>
}

export function useLiveScope() { return useContext(LiveContext) }

/** Register the SWR keys invalidated by a committed entity change. */
export function useLiveKey(kind: LiveKind, id: string | null | undefined, keys: readonly string[], workspaceId?: string | null) {
  const context = useContext(LiveContext)
  const channels = context?.channels
  const scope = workspaceId === undefined ? context?.workspaceId ?? null : workspaceId
  const { mutate } = useSWRConfig()
  const serialized = JSON.stringify(keys)
  useEffect(() => {
    if (!channels || !id) return
    return channels.subscribe(scope, kind, id, JSON.parse(serialized) as string[], key => mutate(key))
  }, [channels, scope, kind, id, serialized, mutate])
}
