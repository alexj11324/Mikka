import { withBasePath } from '@/lib/base-path'

/** The nonce the desktop stores before sending the person to the browser. */
export const DESKTOP_AUTH_STATE_PATTERN = /^[A-Za-z0-9_-]{16,128}$/

export function desktopAuthState(value: unknown): string | null {
  return typeof value === 'string' && DESKTOP_AUTH_STATE_PATTERN.test(value) ? value : null
}

/** A loopback callback the Electron main process is listening on. */
export function desktopLoopbackCallback(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 512) return null
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port) return null
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/auth/callback') return null
    return `${url.origin}${url.pathname}`
  } catch {
    return null
  }
}

/** The API path Better Auth redirects to after OAuth; it adds the app base path itself. */
export function desktopAuthCallbackPath(state: string, next: string, callback?: string | null): string {
  const query = new URLSearchParams({ state, next })
  if (callback) query.set('callback', callback)
  return `/api/desktop/return?${query}`
}

/** Where the system browser returns after OAuth, with the desktop nonce and page. */
export function desktopAuthReturnPath(state: string, next: string, callback?: string | null): string {
  return withBasePath(desktopAuthCallbackPath(state, next, callback))
}
