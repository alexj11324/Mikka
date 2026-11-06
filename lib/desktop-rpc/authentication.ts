import { DESKTOP_SESSION_CACHE_HEADER, desktopSessionCacheFromHeaders, validDesktopSessionCache } from './session-cache'
import { desktopRotatedToken, desktopUpdatedSessionCache, withDesktopReadSession, withoutDesktopSession } from './session'

type AuthResult<Session> = { response: Session | null; headers: Headers }
type Reader<Session> = (input: { headers: Headers; query?: { disableCookieCache: boolean }; returnHeaders: true }) => Promise<AuthResult<Session>>
type Authenticated<Session> = { session: Session; headers: Headers; cache?: string; fresh: boolean; cookieName: string }

/** Preserve Better Auth's existing signed, token-bound five-minute read cache.
 * No independent TTL, session lookup cache, or client-declared identity exists. */
export function desktopAuthentication<Session>(read: Reader<Session>, cookieName: () => Promise<string>) {
  return {
    async authenticate(headers: Headers): Promise<Authenticated<Session> | null> {
      const name = await cookieName()
      const result = await read({ headers, returnHeaders: true })
      if (!result.response) return null
      const cache = desktopSessionCacheFromHeaders(result.headers, name)
      // With a durable DB, Better Auth disables cookieRefreshCache. A successful
      // /get-session issues session_data only after its DB lookup/refresh; a
      // valid cache hit does not issue or extend it (1.7.12 session.mjs).
      const fresh = !validDesktopSessionCache(headers.get(DESKTOP_SESSION_CACHE_HEADER)) || Boolean(cache)
      return { session: result.response, headers, cache, fresh, cookieName: name }
    },
    async scope(authenticated: Authenticated<Session>, work: () => Promise<Response>): Promise<Response> {
      let cache = authenticated.cache
      return withDesktopReadSession(authenticated.session, {
        fresh: authenticated.fresh,
        refresh: async () => {
          const result = await withoutDesktopSession(() => read({ headers: authenticated.headers, query: { disableCookieCache: true }, returnHeaders: true }))
          cache = desktopSessionCacheFromHeaders(result.headers, authenticated.cookieName)
          return result.response
        },
      }, async () => {
        const response = await work()
        cache = desktopUpdatedSessionCache() ?? cache
        if (desktopRotatedToken()) response.headers.set(DESKTOP_SESSION_CACHE_HEADER, '')
        else if (cache !== undefined) response.headers.set(DESKTOP_SESSION_CACHE_HEADER, cache)
        return response
      })
    },
  }
}
