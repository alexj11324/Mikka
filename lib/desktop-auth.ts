import { withBasePath } from '@/lib/base-path'

/** The nonce the desktop stores before sending the person to the browser. */
export const DESKTOP_AUTH_STATE_PATTERN = /^[A-Za-z0-9_-]{16,128}$/

export function desktopAuthState(value: unknown): string | null {
  return typeof value === 'string' && DESKTOP_AUTH_STATE_PATTERN.test(value) ? value : null
}

/** The API path Better Auth redirects to after OAuth; it adds the app base path itself. */
export function desktopAuthCallbackPath(state: string, next: string): string {
  return `/api/desktop/return?${new URLSearchParams({ state, next })}`
}

/** Where the system browser returns after OAuth, with the desktop nonce and page. */
export function desktopAuthReturnPath(state: string, next: string): string {
  return withBasePath(desktopAuthCallbackPath(state, next))
}
