'use client'

import { createContext, useContext, useEffect, useMemo, useRef, type ReactNode } from 'react'
import { useSWRConfig } from 'swr'
import { browserRuntime } from '@/lib/live/browser-runtime'
import { type LiveSubscriptionOptions, type LiveSubscription } from '@/lib/live/channel'
import { LiveChannels } from '@/lib/live/channels'
import { TabShare } from '@/lib/live/tab-share'
import { APP_BUILD } from '@/lib/app-build'
import type { LiveKind } from '@/lib/live/events'

const LiveContext = createContext<{ channels: LiveChannels; workspaceId?: string; share: (scope: string | null) => TabShare | null } | null>(null)

/** Live reads opt in to taking another tab's result (lib/live/tab-share.ts). */
export type LiveKeyOptions = LiveSubscriptionOptions & { shareAcrossTabs?: boolean }

/** One tab-share channel per signed-in person, workspace scope and app build; all closed on
 * sign-out or a user switch. A tab left open across a deploy never adopts the other build's
 * data shape, and a key whose scope is not yet resolved reads on its own. */
function tabShares(ownerId: string) {
  const shares = new Map<string, TabShare>()
  return {
    share(scope: string | null): TabShare | null {
      if (!scope) return null
      const name = `mikka-live-read:${APP_BUILD || 'unbuilt'}:${ownerId}:${scope}`
      let share = shares.get(name)
      if (!share) shares.set(name, share = new TabShare(name))
      return share
    },
    close() { for (const share of shares.values()) share.close(); shares.clear() },
  }
}

export { watchPageVisibility } from '@/lib/live/browser-runtime'

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
      const tabs = share?.(channelScope ?? null)
      const refresh = tabs ? (key: string) => tabs.run(key, () => mutate(key), data => mutate(key, data, { revalidate: false })) : (key: string) => mutate(key)
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
