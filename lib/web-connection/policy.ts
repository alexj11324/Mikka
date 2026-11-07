/** Public-web trust is separate from Better Auth's cookie/OAuth origin list.
 * An administrator can disable this public client without disabling desktop. */
export type WebConnectionEnvironment = Record<string, string | undefined>
export const WEB_CONNECTION_PROTOCOL = 1
export const OFFICIAL_WEB_URL = 'https://app.aspectlylabs.com/mikka'
const host = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$|^\[[0-9a-f:.]+\]$/
const path = /^(?:\/[A-Za-z0-9._~-]{1,100}){0,5}$/

/** Reject before URL parsing can erase dot segments, encoded separators or
 * user information. Web connections always require HTTPS, including loopback. */
export function canonicalWebServer(value: unknown): string | null {
  if (typeof value !== 'string' || !value || value.length > 2048 || /[\s\\%]/.test(value)) return null
  try {
    const url = new URL(value)
    const rawPath = value.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]+/i, '').replace(/\/+$/, '')
    if (url.protocol !== 'https:' || !host.test(url.hostname) || url.username || url.password || url.search || url.hash
      || !path.test(rawPath) || rawPath.split('/').some(part => part === '.' || part === '..')) return null
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`
  } catch { return null }
}

export function webConnectionURL(env: WebConnectionEnvironment = process.env): string | null {
  return canonicalWebServer(env.MIKKA_OFFICIAL_WEB_URL ?? OFFICIAL_WEB_URL)
}
export function webConnectionEnabled(env: WebConnectionEnvironment = process.env): boolean {
  return env.MIKKA_OFFICIAL_WEB_ENABLED !== '0' && env.MIKKA_OFFICIAL_WEB_ENABLED !== 'false' && webConnectionURL(env) !== null
}
export function officialWebOriginAllowed(origin: string | null | undefined, env: WebConnectionEnvironment = process.env): boolean {
  const app = webConnectionURL(env)
  return webConnectionEnabled(env) && !!app && origin === new URL(app).origin
}
export function officialWebCallback(value: unknown, env: WebConnectionEnvironment = process.env): string | null {
  const app = webConnectionURL(env)
  const callback = app && `${app}/api/web/complete`
  return webConnectionEnabled(env) && value === callback ? callback : null
}
