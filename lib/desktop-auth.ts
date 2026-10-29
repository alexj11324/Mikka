import { withBasePath } from '@/lib/base-path'

/** The nonce the desktop stores before sending the person to the browser. */
export const DESKTOP_AUTH_STATE_PATTERN = /^[A-Za-z0-9_-]{16,128}$/

export function desktopAuthState(value: unknown): string | null {
  return typeof value === 'string' && DESKTOP_AUTH_STATE_PATTERN.test(value) ? value : null
}

/** Where the system browser returns after OAuth, with the desktop nonce and page. */
export function desktopAuthReturnPath(state: string, next: string): string {
  return withBasePath(`/api/desktop/return?${new URLSearchParams({ state, next })}`)
}
