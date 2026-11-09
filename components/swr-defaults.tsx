'use client'

import { useEffect, useRef, type ReactNode } from 'react'
import { SWRConfig, unstable_serialize, type Middleware, type SWRConfiguration } from 'swr'
import { pageNeedsRefresh } from '@/lib/app-build'
import { PersistentReadCache, waitForCacheHydration } from '@/lib/swr/persistent-cache'
import { isAutoRetryable, MAX_READ_RETRIES, retryRead } from '@/lib/swr/retry'
import { liveKeyConnection } from '@/lib/swr/live-focus'
import { acceptSWRRead, failSWRRead, isSnapshotReadFetcher, observeSWRRead } from '@/lib/swr/read-observer'

/** Data younger than this is fresh: focus leaves it alone. A hook may set a longer `focusThrottleInterval`. */
export const FRESH_FOR_MS = 5 * 60_000
const WITHOUT_PUSH_FRESH_FOR_MS = 60_000

const fetchedAt = new WeakMap<object, Map<string, number>>()
const stamps = (cache: object) => {
  let map = fetchedAt.get(cache)
  if (!map) { map = new Map(); fetchedAt.set(cache, map) }
  return map
}

/**
 * Stale-while-revalidate on focus (decision 2026-11-01-0400-no-refetch-on-focus):
 * a focus revalidates a key only when its data is older than the hook's
 * `focusThrottleInterval`, in the background, while what is on screen stays.
 * SWR alone throttles focus from mount, not from the last answer, so a poll or
 * a mutate would not count as fresh.
 */
export const staleOnFocus: Middleware = useSWRNext => (key, fetcher, config) => {
  const mountedAt = useRef(0)
  if (!mountedAt.current) mountedAt.current = Date.now()
  const id = key ? unstable_serialize(key) : ''
  // SWR passes the merged config, cache included, to every middleware.
  const cache = (config as { cache?: { get(key: string): { data?: unknown; error?: unknown } | undefined } }).cache
  const resumeAfterHydration = Boolean(fetcher) && config.revalidateOnMount !== false
  const stamped = fetcher && id && cache
    ? (...args: unknown[]) => observeSWRRead(cache, id, async withDispatch => {
      await waitForCacheHydration(cache)
      const run = () => (fetcher as (...input: unknown[]) => unknown)(...args)
      const result = await (isSnapshotReadFetcher(fetcher) ? withDispatch(run) : run())
      stamps(cache).set(id, Date.now())
      return result
    })
    : fetcher
  const allowed = config.revalidateOnFocus
  const focusAllowed = () => {
    if (!allowed) return false
    const connected = cache ? liveKeyConnection(cache, id) : undefined
    if (connected === false) return true
    const configured = config.focusThrottleInterval ?? FRESH_FOR_MS
    // Settings without a push subscription keep their previous freshness; a
    // hook's explicitly longer window (e.g. usage) remains its own policy.
    const freshFor = connected === undefined && configured === FRESH_FOR_MS ? WITHOUT_PUSH_FRESH_FOR_MS : configured
    return Date.now() - (cache ? stamps(cache).get(id) ?? mountedAt.current : mountedAt.current) >= freshFor
  }
  const onSuccess: NonNullable<SWRConfiguration['onSuccess']> = (data, key, configuration) => {
    try { config.onSuccess?.(data, key, configuration) }
    catch (error) {
      if (cache) failSWRRead(cache, key, data, error)
      throw error
    }
    if (cache) acceptSWRRead(cache, key, data)
  }
  // Hook-level pauses (for example Settings) must not override a required update.
  const gated = Object.defineProperty({
    ...config,
    // SWR's own throttle starts at mount and can hide a disconnected catch-up.
    // This middleware gates against the last successful answer instead.
    focusThrottleInterval: 0,
    isPaused: () => pageNeedsRefresh() || (cache instanceof PersistentReadCache && (!cache.isHydrated || !cache.isEnabled)) || Boolean(config.isPaused?.()),
    onSuccess,
  }, 'revalidateOnFocus', {
    enumerable: true,
    // SWR reads this when the focus event fires.
    get: focusAllowed,
  })
  const result = useSWRNext(key, stamped as typeof fetcher, gated)
  useEffect(() => {
    if (!key || !resumeAfterHydration || !(cache instanceof PersistentReadCache)) return
    return cache.trackHydrationRead(id, result.mutate)
  }, [cache, id, key, resumeAfterHydration, result.mutate])
  return result
}

export const swrDefaults = {
  isPaused: pageNeedsRefresh,
  revalidateOnFocus: true,
  focusThrottleInterval: FRESH_FOR_MS,
  refreshWhenHidden: false,
  shouldRetryOnError: isAutoRetryable,
  errorRetryCount: MAX_READ_RETRIES,
  onErrorRetry: retryRead,
  use: [staleOnFocus],
} satisfies SWRConfiguration

export function SWRDefaults({ children }: { children: ReactNode }) {
  return <SWRConfig value={swrDefaults}>{children}</SWRConfig>
}
