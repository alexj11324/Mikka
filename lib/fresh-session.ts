import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * The session is cached in a signed cookie for 5 minutes (lib/auth.ts
 * session.cookieCache, Alex 2026-11-02), so a revoked session or a password
 * change reaches an ordinary read up to 5 minutes late. Writes about money,
 * permissions, credentials and deletion run inside withFreshSession: every
 * session read there goes to the database (`disableCookieCache`).
 */
const fresh = new AsyncLocalStorage<true>()

export function withFreshSession<T>(work: () => T): T {
  return fresh.run(true, work)
}

/** For a route handler: each request reads its session from the database. */
export function freshSessionRoute<Args extends unknown[], R>(handler: (...args: Args) => Promise<R>): (...args: Args) => Promise<R> {
  return (...args: Args) => fresh.run(true, () => handler(...args))
}

export function sessionMustBeFresh(): boolean {
  return fresh.getStore() === true
}

/** The session settings lib/auth.ts uses; a cached read is at most this old. */
export const SESSION_COOKIE_CACHE_SECONDS = 5 * 60
export const SESSION_OPTIONS = {
  expiresIn: 60 * 60 * 24 * 7, updateAge: 60 * 60 * 24,
  cookieCache: { enabled: true, maxAge: SESSION_COOKIE_CACHE_SECONDS },
}

/** Makes `auth.api.getSession` skip the cookie cache inside withFreshSession. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- better-auth's getSession is overloaded; the wrapper only adds a query flag.
export function readFreshSessionsInScope(api: { getSession: (context: any) => Promise<unknown> }) {
  const read = api.getSession
  api.getSession = (context: { query?: Record<string, unknown> } | undefined) => read(sessionMustBeFresh() ? { ...context, query: { ...context?.query, disableCookieCache: true } } : context)
}
