/** How long one person's repository list is reused before GitHub is asked again. */
export const REPOSITORY_CACHE_MS = 5 * 60_000
const cache = new Map<string, { at: number; listing: Promise<unknown> }>()

/**
 * One person's authorized repositories for the Coordinator's turn context, asked of GitHub at most once every few
 * minutes per person and instance. Only a successful listing is kept; a failure is asked again next time.
 * Dispatch never relies on it: it checks a repository against the live list (lib/coordinator/repository-resolution.ts).
 */
export function cachedRepositoriesForUser<T>(userId: string, list: (userId: string) => Promise<T>, now = Date.now()): Promise<T> {
  const hit = cache.get(userId)
  if (hit && now - hit.at < REPOSITORY_CACHE_MS) return hit.listing as Promise<T>
  const listing = list(userId)
  if (cache.size >= 1000) cache.delete(cache.keys().next().value!)
  cache.set(userId, { at: now, listing })
  listing.catch(() => { if (cache.get(userId)?.listing === listing) cache.delete(userId) })
  return listing
}

/** Tests only. */
export function clearRepositoryCache() { cache.clear() }
