'use client'

import { createContext, useContext, useEffect, useMemo, useRef, type ReactNode } from 'react'
import { useSWRConfig } from 'swr'
import { withBasePath } from '@/lib/base-path'
import { type LiveRuntime, type LiveTicket, type LiveSubscriptionOptions, type LiveSubscription } from '@/lib/live/channel'
import { LiveChannels } from '@/lib/live/channels'
import { TabShare } from '@/lib/live/tab-share'
import type { LiveKind } from '@/lib/live/events'

const LiveContext = createContext<{ channels: LiveChannels; workspaceId?: string; share: (scope: string | null) => TabShare } | null>(null)

/** Live reads opt in to taking another tab's result (lib/live/tab-share.ts). */
export type LiveKeyOptions = LiveSubscriptionOptions & { shareAcrossTabs?: boolean }

/** One tab-share channel per signed-in person and workspace scope; all closed on sign-out or a user switch. */
function tabShares(ownerId: string) {
  const shares = new Map<string, TabShare>()
  return {
    share(scope: string | null) {
      const name = `mikka-live-read:${ownerId}:${scope ?? 'none'}`
      let share = shares.get(name)
      if (!share) shares.set(name, share = new TabShare(name))
      return share
    },
    close() { for (const share of shares.values()) share.close(); shares.clear() },
  }
}

/** Shared visibility subscription for live transport and local display clocks.
 * Subscribers decide their own catch-up; this helper never reads application data. */
export function watchPageVisibility(changed: () => void) {
  document.addEventListener('visibilitychange', changed)
  return () => document.removeEventListener('visibilitychange', changed)
}

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
      const unwatch = watchPageVisibility(changed)
      window.addEventListener('online', changed)
      return () => { unwatch(); window.removeEventListener('online', changed) }
    },
    now: Date.now,
    monotonicNow: () => performance.now(),
    later: (callback, milliseconds) => setTimeout(callback, milliseconds),
    cancel: timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
  }
}

export function LiveProvider({ ownerId, workspaceId, children }: { ownerId: string; workspaceId?: string; children: ReactNode }) {
  const channels = useMemo(() => new LiveChannels(browserRuntime), [ownerId])
  const shares = useMemo(() => tabShares(ownerId), [ownerId])
  const value = useMemo(() => ({ channels, workspaceId, share: shares.share }), [channels, workspaceId, shares])
  useEffect(() => () => channels.dispose(), [channels])
  useEffect(() => () => shares.close(), [shares])
  return <LiveContext value={value}>{children}</LiveContext>
}

export function useLiveScope() { return useContext(LiveContext) }

/** Register the SWR keys invalidated by a committed entity change. */
export function useLiveKey(kind: LiveKind, id: string | null | undefined, keys: readonly string[], workspaceId?: string | null, options?: LiveKeyOptions) {
  useLiveKeys(id ? [{ kind, id }] : [], keys, workspaceId, options)
}

type LiveEntity = { kind: LiveKind; id: string; workspaceId?: string | null; /** This entity's held revision per key; see LiveSubscriptionOptions. */ revisions?: LiveSubscriptionOptions['revisions'] }

/** A thread's attempts share one read and one owner/workspace connection. */
export function useLiveKeys(entities: readonly LiveEntity[], keys: readonly string[], workspaceId?: string | null, options?: LiveKeyOptions) {
  const context = useContext(LiveContext)
  const channels = context?.channels
  const scope = workspaceId === undefined ? context?.workspaceId ?? null : workspaceId
  const { mutate } = useSWRConfig()
  const share = options?.shareAcrossTabs ? context?.share : undefined
  const serialized = JSON.stringify(keys)
  // A new revision updates the existing handle; it is not a new subscription or initial read.
  const references = JSON.stringify(entities.map(({ kind, id, workspaceId: entityScope }) => ({ kind, id, workspaceId: entityScope })))
  const revisions = useRef(entities)
  revisions.current = entities
  const revisionKey = JSON.stringify([options?.revisions ?? null, entities.map(entity => entity.revisions ?? null)])
  const minIntervalMs = options?.minIntervalMs ?? 0
  const timing = useRef<LiveSubscriptionOptions>({ minIntervalMs, deadline: options?.deadline, revisions: options?.revisions })
  timing.current = { minIntervalMs, deadline: options?.deadline, revisions: options?.revisions }
  const optionsFor = (index: number): LiveSubscriptionOptions => ({ ...timing.current, revisions: { ...timing.current.revisions, ...revisions.current[index]?.revisions } })
  // Renders do not reanchor an expiry. A newer HTTP observation can arrange a
  // final check if the conservative timer fired before the server's deadline.
  const deadlineKey = options?.deadline?.at ?? null
  const deadlineObservation = options?.deadline?.observation
  const active = useRef<LiveSubscription[]>([])
  useEffect(() => {
    if (!channels) return
    const subscriptions = (JSON.parse(references) as LiveEntity[]).map(({ kind, id, workspaceId: entityScope }, index) => {
      const channelScope = entityScope === undefined ? scope : entityScope
      // Another tab of this person reading the same key in the same scope serves this one too.
      const refresh = share ? (key: string) => share(channelScope).run(key, () => mutate(key), data => mutate(key, data, { revalidate: false })) : (key: string) => mutate(key)
      return channels.subscribe(channelScope, kind, id, JSON.parse(serialized) as string[], refresh, optionsFor(index))
    })
    active.current = subscriptions
    return () => {
      for (const stop of subscriptions) stop()
      if (active.current === subscriptions) active.current = []
    }
    // Timing options update the existing handles below. Only an actual scope,
    // entity, cache key or refresh owner change needs a new initial read.
  }, [channels, scope, references, serialized, mutate, share])
  useEffect(() => {
    active.current.forEach((subscription, index) => subscription.update(optionsFor(index)))
    // optionsFor reads the refs set above.
  }, [minIntervalMs, deadlineKey, deadlineObservation, revisionKey])
}
