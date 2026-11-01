'use client'

import { useRef, type ReactNode } from 'react'
import { SWRConfig, unstable_serialize, type Middleware, type SWRConfiguration } from 'swr'

/** Data younger than this is fresh: focus leaves it alone. A hook may set a longer `focusThrottleInterval`. */
export const FRESH_FOR_MS = 60_000

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
  const cache = (config as { cache?: object }).cache ?? fetchedAt
  const stamped = fetcher && id
    ? (...args: unknown[]) => {
      const result = (fetcher as (...input: unknown[]) => unknown)(...args)
      const stamp = () => { stamps(cache).set(id, Date.now()) }
      if (result instanceof Promise) return result.then(value => { stamp(); return value })
      stamp()
      return result
    }
    : fetcher
  const allowed = config.revalidateOnFocus
  const gated = Object.defineProperty({ ...config }, 'revalidateOnFocus', {
    enumerable: true,
    // SWR reads this when the focus event fires.
    get: () => Boolean(allowed) && Date.now() - (stamps(cache).get(id) ?? mountedAt.current) >= (config.focusThrottleInterval ?? FRESH_FOR_MS),
  })
  return useSWRNext(key, stamped as typeof fetcher, gated)
}

export const swrDefaults = {
  revalidateOnFocus: true,
  focusThrottleInterval: FRESH_FOR_MS,
  refreshWhenHidden: false,
  use: [staleOnFocus],
} satisfies SWRConfiguration

export function SWRDefaults({ children }: { children: ReactNode }) {
  return <SWRConfig value={swrDefaults}>{children}</SWRConfig>
}
