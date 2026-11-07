import { withBasePath } from '@/lib/base-path'

/** The nonce the desktop stores before sending the person to the browser. */
export const DESKTOP_AUTH_STATE_PATTERN = /^[A-Za-z0-9_-]{16,128}$/

/** Native clients can omit browser headers. If supplied, both headers must
 * describe this deployment; a configured hostname never broadens this check. */
export function desktopSameOriginRequest(request: Request): boolean {
  const origin = request.headers.get('origin')
  if (origin !== null && origin !== new URL(request.url).origin) return false
  const site = request.headers.get('sec-fetch-site')
  return site === null || site === 'same-origin' || site === 'none'
}

export function desktopAuthState(value: unknown): string | null {
  return typeof value === 'string' && DESKTOP_AUTH_STATE_PATTERN.test(value) ? value : null
}

/** A loopback callback the Electron main process is listening on. */
export function desktopLoopbackCallback(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 512) return null
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' || (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') || !url.port) return null
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/auth/callback') return null
    // NextURL normalizes 127.0.0.1 to localhost inside query values too.
    url.hostname = '127.0.0.1'
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

export type DesktopBrowserStep =
  | { kind: 'form' }
  /** The browser already has a web session: ask before handing it to the app. */
  | { kind: 'choose-account' }
  /** The app asked for this provider: start it without another click. */
  | { kind: 'oauth'; provider: 'google' | 'github'; selectAccount: boolean }

/**
 * What the browser's sign-in page does for a desktop handoff. A web session is
 * never handed over without the person seeing which account it is; choosing
 * another account asks the provider to show its account picker.
 */
export function desktopBrowserStep(input: {
  desktop: boolean
  signedIn: boolean
  addAccount: boolean
  switchAccount: boolean
  refused: boolean
  provider: 'google' | 'github' | null
}): DesktopBrowserStep {
  if (!input.desktop || input.refused) return { kind: 'form' }
  if (input.signedIn && !input.addAccount && !input.switchAccount) return { kind: 'choose-account' }
  if (input.provider) return { kind: 'oauth', provider: input.provider, selectAccount: input.signedIn }
  return { kind: 'form' }
}

/** Provider parameters that make Google and GitHub show their account picker. */
export const SELECT_ACCOUNT_PARAMS = { prompt: 'select_account' } as const

/** A PKCE-style S256 challenge: base64url(sha256(verifier)), 43 characters. */
export const DESKTOP_AUTH_CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/
/** The verifier the desktop keeps; RFC 7636 allows 43-128 unreserved characters. */
export const DESKTOP_AUTH_VERIFIER_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/
/** The one-time code the loopback receives instead of a sign-in token. */
export const DESKTOP_AUTH_CODE_PATTERN = /^[A-Za-z0-9_-]{32,128}$/

/** How long a signed-out desktop has to finish OAuth in the browser. */
export const DESKTOP_AUTH_PENDING_TTL_MS = 10 * 60_000
/** How long the desktop has to trade the code once the browser binds the row. */
export const DESKTOP_AUTH_EXCHANGE_TTL_MS = 60_000

export function desktopAuthChallenge(value: unknown): string | null {
  return typeof value === 'string' && DESKTOP_AUTH_CHALLENGE_PATTERN.test(value) ? value : null
}

export function desktopAuthVerifier(value: unknown): string | null {
  return typeof value === 'string' && DESKTOP_AUTH_VERIFIER_PATTERN.test(value) ? value : null
}

export function desktopAuthCode(value: unknown): string | null {
  return typeof value === 'string' && DESKTOP_AUTH_CODE_PATTERN.test(value) ? value : null
}

/** An absolute OAuth callback; Better Auth would otherwise drop the app base path. */
export function desktopAuthCallbackURL(origin: string, state: string, next: string, callback?: string | null): string {
  return new URL(desktopAuthReturnPath(state, next, callback), origin).href
}
