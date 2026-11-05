import { unstable_serialize, type Cache, type Key, type useSWRConfig } from 'swr'
import { PersistentReadCache, readAccessFailure, waitForCacheHydration } from './persistent-cache'

type ScopedMutate = ReturnType<typeof useSWRConfig>['mutate']
const inFlight = new WeakMap<Cache, Map<string, Promise<void>>>()

/** Intent reads belong to the current provider. A mounted/server read or an
 * optimistic write that starts meanwhile always wins over this prefetch. */
export async function prefetchScopedRead(cache: Cache, mutate: ScopedMutate, key: Key, read: () => Promise<unknown>): Promise<void> {
  await waitForCacheHydration(cache)
  if (cache instanceof PersistentReadCache && !cache.isEnabled) return
  const id = unstable_serialize(key)
  if (!id || cache.get(id) !== undefined) return
  let pending = inFlight.get(cache)
  if (!pending) { pending = new Map(); inFlight.set(cache, pending) }
  const existing = pending.get(id)
  if (existing) return existing
  const requests = pending
  const request = Promise.resolve().then(read).then(async value => {
    if (cache instanceof PersistentReadCache && !cache.isEnabled) return
    if (cache.get(id) === undefined) {
      cache.set(id, { _k: key })
      await mutate(key, value, { revalidate: false })
    }
  }).catch(error => {
      // A denied speculative read also retires private persisted data. Other
      // failures are retried only when the user opens or points to the section.
      if (readAccessFailure(error)) cache.set(id, { ...cache.get(id), error })
  }).finally(() => { requests.delete(id) })
  requests.set(id, request)
  return request
}
