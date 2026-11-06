import { parseSetCookieHeader } from 'better-auth/cookies'
import { recordDesktopSessionCache } from './session'
import { DESKTOP_SESSION_CACHE_HEADER, recordNativeSessionCache } from './session-cache-context'

/** An existing Better Auth signed cache, carried only by the native main process. */
export { DESKTOP_SESSION_CACHE_HEADER }
export const DESKTOP_SESSION_CACHE_MAX = 16_384

export function validDesktopSessionCache(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= DESKTOP_SESSION_CACHE_MAX && /^[A-Za-z0-9_-]+$/.test(value)
}

/** No browser cookie can authenticate a bearer request. Better Auth alone
 * verifies the restored cache's signature, expiry, version and bearer binding. */
export function nativeSessionHeaders(input: Headers, cookieName?: string, allowCache = false): Headers {
  const headers = new Headers(input)
  headers.delete('cookie')
  const value = headers.get(DESKTOP_SESSION_CACHE_HEADER)
  headers.delete(DESKTOP_SESSION_CACHE_HEADER)
  if (allowCache && cookieName && validDesktopSessionCache(value)) headers.set('cookie', `${cookieName}=${value}`)
  return headers
}

/** Reassemble only the configured session_data cookie, never session_token or
 * a provider cookie. Empty means clear; absence leaves main's cache unchanged. */
export function desktopSessionCacheFromHeaders(headers: Headers, cookieName: string): string | undefined {
  const cookies = parseSetCookieHeader(headers.get('set-cookie') ?? '')
  const direct = cookies.get(cookieName)
  if (direct && direct['max-age'] !== 0 && validDesktopSessionCache(direct.value)) return direct.value
  const parts = [...cookies].flatMap(([name, cookie]) => {
    if (!name.startsWith(`${cookieName}.`) || !/^\d+$/.test(name.slice(cookieName.length + 1)) || cookie['max-age'] === 0 || !cookie.value) return []
    return [{ index: Number(name.slice(cookieName.length + 1)), value: cookie.value }]
  }).sort((a, b) => a.index - b.index)
  if (parts.length && parts.every((part, index) => part.index === index)) {
    const value = parts.map(part => part.value).join('')
    if (validDesktopSessionCache(value)) return value
  }
  return direct || [...cookies.keys()].some(name => name.startsWith(`${cookieName}.`)) ? '' : undefined
}

type CacheHookContext = {
  headers?: Headers
  path?: string
  context: { authCookies: { sessionData: { name: string } }; responseHeaders?: Headers }
}

/** Sanitize before entering Better Auth: its before hooks merge header values,
 * and the bearer plugin can read request.headers ahead of context.headers. */
export function withDesktopSessionCache(handler: (request: Request) => Promise<Response>, cookieName: () => Promise<string>) {
  return async (request: Request): Promise<Response> => {
    if (!request.headers.has('authorization')) return handler(request)
    const headers = nativeSessionHeaders(request.headers, await cookieName(), true)
    return handler(new Request(request, { headers }))
  }
}

export function desktopSessionCacheAfter(ctx: CacheHookContext & { setHeader: (name: string, value: string) => void }) {
  const cache = desktopSessionCacheFromHeaders(ctx.context.responseHeaders ?? new Headers(), ctx.context.authCookies.sessionData.name)
  // update-user already signs the new name/image into session_data. Transfer
  // that exact SDK output through this RPC so the existing bootstrap refresh
  // sees the changed profile without a second identity lookup.
  if (ctx.path === '/update-user' && cache !== undefined) recordDesktopSessionCache(cache)
  if (cache !== undefined) recordNativeSessionCache(ctx.headers, cache)
  if (ctx.headers?.get('x-mikka-client') !== 'desktop' || (ctx.path !== '/sign-in/email' && ctx.path !== '/get-session')) return
  if (cache !== undefined) {
    ctx.setHeader(DESKTOP_SESSION_CACHE_HEADER, cache)
    ctx.setHeader('cache-control', 'no-store')
  }
}
