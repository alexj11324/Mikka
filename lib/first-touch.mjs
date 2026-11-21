/** Non-identifying first-touch attribution shared by marketing and App subdomains.
 * Cookie values are untrusted analytics hints, never authorization inputs.
 * Keep this contract identical in both repositories.
 */
export const FIRST_TOUCH_COOKIE = 'mikka_first_touch_v1'
export const FIRST_TOUCH_MAX_AGE_SECONDS = 30 * 24 * 60 * 60

const safeLabel = value => typeof value === 'string' && value.length > 0 && value.length <= 80 && /^[a-z0-9][a-z0-9._-]*$/i.test(value)
  ? value.toLowerCase() : null

const safeDomain = value => typeof value === 'string' && value.length <= 253 && /^(?:[a-z0-9-]+\.)+[a-z]{2,}$/i.test(value)
  ? value.toLowerCase() : null

function safeLanding(pathname) {
  if (pathname === '/') return '/'
  const segments = pathname.split('/').filter(Boolean)
  if (segments.length > 4 || segments.some(part => !/^[a-z][a-z0-9-]{0,32}$/i.test(part))) return '/'
  if (segments.some(part => ['invite', 'token', 'oauth', 'callback', 'reset-password', 'settings', 'w', 'a'].includes(part.toLowerCase()))) return '/'
  return '/' + segments.join('/')
}

function externalReferrer(referrer) {
  try {
    const parsed = new URL(referrer)
    if (!['http:', 'https:'].includes(parsed.protocol)) return null
    const domain = safeDomain(parsed.hostname)
    if (!domain || domain === 'aspectlylabs.com' || domain.endsWith('.aspectlylabs.com')) return null
    return domain
  } catch { return null }
}

/** Accepts only known, bounded, non-sensitive fields, also on server reads. */
export function parseFirstTouch(cookieHeader, now = Date.now()) {
  if (typeof cookieHeader !== 'string') return null
  const segment = cookieHeader.split(';').map(part => part.trim()).find(part => part.startsWith(FIRST_TOUCH_COOKIE + '='))
  if (!segment) return null
  try {
    const value = JSON.parse(decodeURIComponent(segment.slice(FIRST_TOUCH_COOKIE.length + 1)))
    if (value.v !== 1 || typeof value.acquired_at !== 'number' || !Number.isFinite(value.acquired_at)
      || value.acquired_at > now || now - value.acquired_at > FIRST_TOUCH_MAX_AGE_SECONDS * 1000) return null
    const source = safeLabel(value.source)
    const landing_path = typeof value.landing_path === 'string' ? safeLanding(value.landing_path) : '/'
    if (!source) return null
    return {
      v: 1, source, acquired_at: value.acquired_at, landing_path,
      ...(safeDomain(value.referrer_domain) ? { referrer_domain: safeDomain(value.referrer_domain) } : {}),
      ...Object.fromEntries(['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term']
        .filter(key => safeLabel(value[key])).map(key => [key, safeLabel(value[key])])),
    }
  } catch { return null }
}

export function firstTouchFromPage(currentUrl, referrer, now = Date.now()) {
  let url
  try { url = new URL(currentUrl) } catch { return null }
  if (!['http:', 'https:'].includes(url.protocol)) return null
  const referrerDomain = externalReferrer(referrer)
  const utm = Object.fromEntries(['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term']
    .map(key => [key, safeLabel(url.searchParams.get(key))]).filter(([, value]) => value))
  return {
    v: 1, acquired_at: now, landing_path: safeLanding(url.pathname),
    source: utm.utm_source ?? referrerDomain ?? 'direct_or_unknown',
    ...(referrerDomain ? { referrer_domain: referrerDomain } : {}),
    ...utm,
  }
}

/** Only the marketing/root App subdomains can share a first-touch cookie. */
export function firstTouchCookieHeader(touch, hostname, protocol) {
  const domain = hostname === 'aspectlylabs.com' || hostname.endsWith('.aspectlylabs.com')
    ? '; Domain=aspectlylabs.com' : ''
  const secure = protocol === 'https:' ? '; Secure' : ''
  return `${FIRST_TOUCH_COOKIE}=${encodeURIComponent(JSON.stringify(touch))}; Path=/; Max-Age=${FIRST_TOUCH_MAX_AGE_SECONDS}; SameSite=Lax${domain}${secure}`
}

export function rememberFirstTouch(currentUrl, referrer, cookieHeader, setCookie, now = Date.now()) {
  const existing = parseFirstTouch(cookieHeader, now)
  if (existing) return existing
  const touch = firstTouchFromPage(currentUrl, referrer, now)
  if (!touch) return null
  const url = new URL(currentUrl)
  setCookie(firstTouchCookieHeader(touch, url.hostname, url.protocol))
  return touch
}
