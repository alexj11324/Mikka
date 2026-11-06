import { AsyncLocalStorage } from 'node:async_hooks'

export const DESKTOP_SESSION_CACHE_HEADER = 'x-mikka-session-cache'
type CacheResponse = { authorization: string; cache?: string }
const responseCache = new AsyncLocalStorage<CacheResponse>()

/** SDK output only, bound to this request's bearer. This is never a session
 * identity or an authorization cache, and is never part of request logs. */
export function recordNativeSessionCache(headers: Headers | undefined, cache: string): void {
  const scope = responseCache.getStore()
  if (scope && headers?.get('authorization') === scope.authorization) scope.cache = cache
}

/** REST readers also need the SDK's replacement proof when it expires; without
 * this transport every later REST read would repeat the same session lookup. */
export function withNativeSessionCache<T extends Response>(headers: Headers, work: () => T | Promise<T>): Promise<T> {
  const authorization = headers.get('authorization')
  if (headers.get('x-mikka-client') !== 'desktop' || !authorization) return Promise.resolve(work())
  const scope: CacheResponse = { authorization }
  return responseCache.run(scope, async () => {
    const response = await work()
    // Explicit RPC rotation/clearing takes precedence over an earlier SDK read.
    if (scope.cache !== undefined && !response.headers.has(DESKTOP_SESSION_CACHE_HEADER)) response.headers.set(DESKTOP_SESSION_CACHE_HEADER, scope.cache)
    return response
  })
}
