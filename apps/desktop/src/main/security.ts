// Pure URL policy for the shell. Every navigation and external open goes
// through here, so a renderer bug cannot turn into a privileged navigation.

export type NavigationDecision = 'allow' | 'external' | 'deny'

export function originOf(candidate: string): string | null {
  try {
    const url = new URL(candidate)
    if (url.username || url.password) return null
    return url.origin
  } catch {
    return null
  }
}

/** True only for the app's own origin; a lookalike host never matches. */
export function isTrustedFrame(frameUrl: string | undefined, appUrl: string): boolean {
  if (!frameUrl) return false
  const app = originOf(appUrl)
  return app !== null && originOf(frameUrl) === app
}

/**
 * `allow` keeps the navigation in the renderer: only the app's own origin.
 * Everything else is opened in the system browser when it is an HTTPS or
 * mailto URL, and denied otherwise. Third-party sign-in (Google, GitHub) must
 * run in the system browser: embedded webviews are not an allowed OAuth
 * user-agent for those providers.
 */
export function navigationDecision(
  candidate: string,
  appUrl: string
): NavigationDecision {
  const origin = originOf(candidate)
  if (!origin) return 'deny'
  if (origin === originOf(appUrl)) return 'allow'
  return externalUrl(candidate) ? 'external' : 'deny'
}

/** The URL handed to `shell.openExternal`, or null when it is not safe to open. */
export function externalUrl(candidate: string): string | null {
  if (!candidate || candidate.length > 2_048) return null
  try {
    const url = new URL(candidate)
    if (url.username || url.password) return null
    if (url.protocol === 'https:' || url.protocol === 'mailto:') return url.href
    return null
  } catch {
    return null
  }
}

/** The app-origin URL handed to `shell.openExternal` for OAuth, or null. */
export function appExternalUrl(candidate: string, appUrl: string): string | null {
  try {
    const url = new URL(candidate)
    if (url.origin !== originOf(appUrl) || url.username || url.password) return null
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null
  } catch {
    return null
  }
}

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,512}$/
const STATE_PATTERN = /^[A-Za-z0-9_-]{16,128}$/

/** The nonce the renderer stored before asking for a loopback listener. */
export function desktopAuthState(value: unknown): string | null {
  return typeof value === 'string' && value.length <= 128 && STATE_PATTERN.test(value) ? value : null
}

/**
 * Builds the in-app page that exchanges a one-time token for the web session.
 * The token/state/next come from the loopback callback, never from a custom
 * URL scheme; only a bounded token/state and an in-app `next` path are
 * accepted.
 */
export function desktopAuthFinishUrl(token: unknown, state: unknown, next: unknown, appUrl: string): string | null {
  if (typeof token !== 'string' || token.length > 512 || !TOKEN_PATTERN.test(token)) return null
  if (typeof state !== 'string' || state.length > 128 || !STATE_PATTERN.test(state)) return null
  const target = typeof next === 'string' ? next : '/'
  if (target.length > 2_048 || !target.startsWith('/') || target.startsWith('//') || target.includes('\\') || target.includes('#')) return null
  let app: URL
  let resolved: URL
  try {
    app = new URL(appUrl)
    resolved = new URL(target, app)
  } catch {
    return null
  }
  if (resolved.origin !== app.origin) return null
  const finish = new URL(`${appUrl.replace(/\/$/, '')}/api/desktop/finish`)
  // The value is the one-time exchange code, not a sign-in token.
  finish.hash = new URLSearchParams({ code: token, state, next: target }).toString()
  return finish.href
}
