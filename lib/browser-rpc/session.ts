import { AsyncLocalStorage } from 'node:async_hooks'
import { desktopSessionCacheFromHeaders } from '../desktop-rpc/session-cache'

type SessionContext = { headers?: Headers; query?: Record<string, unknown> }
type Scope = { cookie: string; session: unknown; fresh: boolean; refresh: () => Promise<unknown>; refreshing?: Promise<unknown> }
const storage = new AsyncLocalStorage<Scope>()

/** Only a successfully authenticated browser RPC installs this scope. It is
 * separate from desktop identity: browser billing and multiSession retain
 * their normal cookie behavior. */
export function withBrowserSession<T>(cookie: string, session: unknown, options: { fresh: boolean; refresh: () => Promise<unknown> }, work: () => T): T {
  return storage.run({ cookie, session, ...options }, work)
}
export function withoutBrowserSession<T>(work: () => T): T { return storage.exit(work) }

export function readBrowserSession(context: SessionContext | undefined, fresh: boolean): Promise<unknown> | undefined {
  const scope = storage.getStore()
  if (!scope || !context || !(context.headers instanceof Headers) || context.headers.has('authorization')
    || context.headers.get('cookie') !== scope.cookie) return undefined
  // Better Call has multiple result modes. Unknown current/future options must
  // execute in the SDK rather than accidentally receive a bare cached session.
  if (Object.keys(context).some(key => key !== 'headers' && key !== 'query')) return undefined
  if (context.query && (Object.keys(context.query).some(key => key !== 'disableCookieCache' && key !== 'disableRefresh')
    || Object.values(context.query).some(value => value !== undefined && typeof value !== 'boolean')
    || context.query.disableRefresh === true)) return undefined
  if (!fresh && !scope.refreshing) return Promise.resolve(scope.session)
  if (scope.fresh) return Promise.resolve(scope.session)
  // A null/rejected fresh read stays authoritative for this request. Concurrent
  // permission checks join one upgrade and never fall back to the old principal.
  return scope.refreshing ??= Promise.resolve().then(async () => {
    scope.session = await scope.refresh()
    scope.fresh = true
    return scope.session
  })
}

type AuthResult<Session> = { response: Session | null; headers: Headers }
type Reader<Session> = (input: { headers: Headers; query?: { disableCookieCache: boolean }; returnHeaders: true }) => Promise<AuthResult<Session>>
type Authenticated<Session> = { session: Session; headers: Headers; responseHeaders: Headers; fresh: boolean }

export function browserAuthentication<Session>(read: Reader<Session>, cookieName: () => Promise<string>) {
  return {
    async authenticate(headers: Headers): Promise<Authenticated<Session> | null> {
      if (headers.has('authorization') || !headers.get('cookie')) return null
      const result = await read({ headers, returnHeaders: true })
      if (!result.response) return null
      // The configured durable Better Auth session cache emits session_data
      // only on a DB read/refresh. A signed cache hit is never marked fresh.
      const issued = desktopSessionCacheFromHeaders(result.headers, await cookieName())
      return { session: result.response, headers, responseHeaders: result.headers, fresh: Boolean(issued) }
    },
    async scope(identity: Authenticated<Session>, work: () => Promise<Response>): Promise<Response> {
      const outputs: Headers[] = [identity.responseHeaders]
      return withBrowserSession(identity.headers.get('cookie')!, identity.session, {
        fresh: identity.fresh,
        refresh: async () => {
          const result = await withoutBrowserSession(() => read({ headers: identity.headers, query: { disableCookieCache: true }, returnHeaders: true }))
          outputs.push(result.headers)
          return result.response
        },
      }, async () => {
        const response = await work()
        for (const output of outputs) for (const value of output.getSetCookie()) {
          if (!response.headers.getSetCookie().includes(value)) response.headers.append('set-cookie', value)
        }
        // These credentials belong exclusively to the native main process.
        response.headers.delete('x-mikka-session-token')
        response.headers.delete('x-mikka-session-cache')
        return response
      })
    },
  }
}
