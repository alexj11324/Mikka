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

const DESKTOP_AUTH_PROTOCOL = 'mikka-desktop'
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,512}$/
const STATE_PATTERN = /^[A-Za-z0-9_-]{16,128}$/

/**
 * Turns a `mikka-desktop://auth` callback from the system browser into the
 * in-app page that exchanges its one-time token for the web session. Only the
 * exact scheme/host, a bounded token/state and an in-app `next` path are
 * accepted; everything else returns null and is ignored.
 */
export function desktopAuthFinishUrl(candidate: string, appUrl: string): string | null {
  if (!candidate || candidate.length > 4_096) return null
  let url: URL
  let app: URL
  try {
    url = new URL(candidate)
    app = new URL(appUrl)
  } catch {
    return null
  }
  if (url.protocol !== `${DESKTOP_AUTH_PROTOCOL}:` || url.hostname !== 'auth') return null
  const token = url.searchParams.get('token')
  const state = url.searchParams.get('state')
  const next = url.searchParams.get('next') ?? '/'
  if (!token || !TOKEN_PATTERN.test(token)) return null
  if (!state || !STATE_PATTERN.test(state)) return null
  if (next.length > 2_048 || !next.startsWith('/') || next.startsWith('//') || next.includes('\\') || next.includes('#')) return null
  let target: URL
  try {
    target = new URL(next, app)
  } catch {
    return null
  }
  if (target.origin !== app.origin) return null
  const finish = new URL(`${appUrl.replace(/\/$/, '')}/api/desktop/finish`)
  finish.hash = new URLSearchParams({ token, state, next }).toString()
  return finish.href
}
