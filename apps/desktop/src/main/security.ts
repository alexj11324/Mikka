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
 * `allow` keeps the navigation in the renderer: the app itself and the
 * sign-in providers. Everything else is opened in the system browser when it
 * is an HTTPS or mailto URL, and denied otherwise.
 */
export function navigationDecision(
  candidate: string,
  appUrl: string,
  authOrigins: readonly string[]
): NavigationDecision {
  const origin = originOf(candidate)
  if (!origin) return 'deny'
  if (origin === originOf(appUrl)) return 'allow'
  if (authOrigins.includes(origin)) return 'allow'
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
