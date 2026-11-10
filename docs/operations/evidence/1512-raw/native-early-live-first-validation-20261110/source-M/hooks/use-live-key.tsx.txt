'use client'

import { createContext, useContext, useEffect, useMemo, useRef, type ReactNode } from 'react'
import { useSWRConfig } from 'swr'
import { browserRuntime } from '@/lib/live/browser-runtime'
import { type LiveRefresh, type LiveSubscriptionOptions, type LiveSubscription } from '@/lib/live/channel'
import { LiveChannels } from '@/lib/live/channels'
import { coversLiveRevisions } from '@/lib/live/revisions'
import { TabShare, tabShareChannelName } from '@/lib/live/tab-share'
import type { LiveKind } from '@/lib/live/events'
import { registerLiveKeyConnection } from '@/lib/swr/live-focus'
import { PersistentReadCache, readCacheShareNamespace } from '@/lib/swr/persistent-cache'
import { readBoundary, readFresh } from '@/lib/swr/read-observer'

const LiveContext = createContext<{ channels: LiveChannels; ownerId: string; workspaceId?: string; namespace: string | null; share?: (scope: string | null) => TabShare | null } | null>(null)

/** Live reads opt in to taking another tab's result (lib/live/tab-share.ts). */
export type LiveKeyOptions = LiveSubscriptionOptions & { shareAcrossTabs?: boolean }

/** The cache namespace includes the authorized owner, selected workspace,
 * build and role. The live transport's personal home alone is not a tenant:
 * default Coordinator aliases resolve to different bots in each workspace.
 * A key whose transport scope is unresolved still reads independently. */
function tabShares(namespace: string) {
  const shares = new Map<string, TabShare>()
  return {
    share(scope: string | null): TabShare | null {
      if (!scope) return null
      const name = tabShareChannelName(namespace, scope)
      let share = shares.get(name)
      if (!share) shares.set(name, share = new TabShare(name))
      return share
    },
    close() { for (const share of shares.values()) share.close(); shares.clear() },
  }
}

export { watchPageVisibility } from '@/lib/live/browser-runtime'

export function LiveProvider({ ownerId, workspaceId, children }: { ownerId: string; workspaceId?: string; children: ReactNode }) {
  const { cache } = useSWRConfig()
  const channels = useMemo(() => new LiveChannels(browserRuntime), [ownerId])
  const namespace = readCacheShareNamespace(cache, ownerId)
  const shares = useMemo(() => namespace ? tabShares(namespace) : null, [namespace])
  const value = useMemo(() => ({ channels, ownerId, workspaceId, namespace, share: shares?.share }), [channels, ownerId, workspaceId, namespace, shares])
  useEffect(() => () => channels.dispose(), [channels])
  useEffect(() => () => shares?.close(), [shares])
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
  const { cache, mutate } = useSWRConfig()
  const share = options?.shareAcrossTabs ? context?.share : undefined
  const ownerId = context?.ownerId
  const namespace = context?.namespace
  const serialized = JSON.stringify(keys)
  // A new revision updates the existing handle; it is not a new subscription or initial read.
  const references = JSON.stringify(entities.map(({ kind, id, workspaceId: entityScope }) => ({ kind, id, workspaceId: entityScope })))
  const revisions = useRef(entities)
  revisions.current = entities
  const revisionKey = JSON.stringify([options?.revisions ?? null, entities.map(entity => entity.revisions ?? null)])
  const minIntervalMs = options?.minIntervalMs ?? 0
  const timing = useRef<LiveSubscriptionOptions>({ minIntervalMs, deadline: options?.deadline, revisions: options?.revisions, presence: options?.presence })
  timing.current = { minIntervalMs, deadline: options?.deadline, revisions: options?.revisions, presence: options?.presence }
  const optionsFor = (index: number): LiveSubscriptionOptions => ({ ...timing.current, revisions: { ...timing.current.revisions, ...revisions.current[index]?.revisions } })
  // Renders do not reanchor an expiry. A newer HTTP observation can arrange a
  // final check if the conservative timer fired before the server's deadline.
  const deadlineKey = options?.deadline?.at ?? null
  const deadlineObservation = options?.deadline?.observation
  const presenceKey = JSON.stringify(options?.presence)
  const active = useRef<LiveSubscription[]>([])
  const lifetime = useMemo(() => ({}), [channels, scope, references, serialized, cache, mutate, share, ownerId, namespace])
  const currentLifetime = useRef(lifetime)
  currentLifetime.current = lifetime
  useEffect(() => {
    if (!channels) return
    let mounted = true
    const current = () => mounted && currentLifetime.current === lifetime && document.visibilityState === 'visible'
      && (!(cache instanceof PersistentReadCache) || cache.isEnabled)
    const subscriptions = (JSON.parse(references) as LiveEntity[]).map(({ kind, id, workspaceId: entityScope }, index) => {
      const channelScope = entityScope === undefined ? scope : entityScope
      const refresh: LiveRefresh = (key, requiredRevisions, reuseCompleted, after = readBoundary()) => {
        if (!current()) return
        const authorized = () => ownerId && namespace && readCacheShareNamespace(cache, ownerId) === namespace
        const heldAtStart = { ...cache.get(key)?.data?.live?.revisions }
        const accepts = (data: unknown) => coversLiveRevisions(data, requiredRevisions)
          && coversLiveRevisions(data, heldAtStart)
          && coversLiveRevisions(data, cache.get(key)?.data?.live?.revisions)
        const read = () => readFresh(cache, key, after, () => mutate(key), accepts, current)
        if (!share || !authorized()) return read()
        const tabs = share(channelScope)
        if (!tabs) return read()
        const previous = cache.get(key)?.data
        // Share normalized snapshots, never a delta against another tab's
        // cursor. A local write while waiting must not be overwritten either.
        return readFresh(cache, key, after, () => tabs.run(key, read, data => {
          if (!current() || !authorized()) return
          return cache.get(key)?.data === previous ? mutate(key, data, { revalidate: false }) : read()
        }, accepts, reuseCompleted), accepts, current)
      }
      return channels.subscribe(channelScope, kind, id, JSON.parse(serialized) as string[], refresh, optionsFor(index))
    })
    const connections = (JSON.parse(serialized) as string[]).map(key => registerLiveKeyConnection(cache, [key], () => channels.keyConnected(key)))
    active.current = subscriptions
    return () => {
      mounted = false
      for (const stop of subscriptions) stop()
      for (const stop of connections) stop()
      if (active.current === subscriptions) active.current = []
    }
    // Timing options update the existing handles below. Only an actual scope,
    // entity, cache key or refresh owner change needs a new initial read.
  }, [channels, scope, references, serialized, cache, mutate, share, ownerId, namespace, lifetime])
  useEffect(() => {
    active.current.forEach((subscription, index) => subscription.update(optionsFor(index)))
    // optionsFor reads the refs set above.
  }, [minIntervalMs, deadlineKey, deadlineObservation, revisionKey, presenceKey])
}
