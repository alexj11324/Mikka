import Negotiator from 'negotiator'
import { match } from '@formatjs/intl-localematcher'
import { parseRequestCookies } from '../src/request-cookies.mjs'

export const baseSecurityHeaders = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'strict-transport-security': 'max-age=63072000',
  'x-frame-options': 'SAMEORIGIN',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
}

function decodedPath(pathname) { try { return decodeURIComponent(pathname) } catch { return null } }
export function isMachinePath(pathname) {
  const path = decodedPath(pathname)
  // Invalid encoding and encoded machine names must never receive a SPA 200.
  return path === null || /^\/(?:mikka\/)?(?:api|v1|trpc|_next|_vercel|__nextjs|\.well-known|w)(?:\/|$)/.test(path)
}
export function prefersServerHtml(request) {
  return new Negotiator({ headers: { accept: request.headers.get('accept') ?? '*/*' } })
    .mediaType(['application/json', 'text/html']) === 'text/html'
}

export function isPagePath(pathname) {
  const path = decodedPath(pathname)
  return path !== null && (path === '/mikka' || path.startsWith('/mikka/'))
    && !isMachinePath(path) && !path.includes('.') && !/^\/mikka\/(?:assets|@vite|@react-refresh|src|node_modules)(?:\/|$)/.test(path)
}
export function securityHeaders(pathname, current = undefined) {
  const headers = new Headers(current)
  for (const [name, value] of Object.entries(baseSecurityHeaders)) if (!headers.has(name)) headers.set(name, value)
  const path = (decodedPath(pathname) ?? pathname).replace(/^\/mikka(?=\/|$)/, '').replace(/^\/(?:en|zh-CN)(?=\/|$)/, '')
  if (/^\/(?:api\/auth\/)?(?:verify-email|reset-password|device)(?:\/|$)/.test(path) || /^\/a(?:\/|$)/.test(path)) {
    headers.set('referrer-policy', 'no-referrer'); headers.set('cache-control', 'no-store')
  }
  return headers
}
export function applySecurityHeaders(request, response) {
  const secured = new Response(response.body, { status: response.status, statusText: response.statusText, headers: securityHeaders(new URL(request.url).pathname, response.headers) })
  // Nitro's upgrade adapter resolves these hooks after the HTTP fetch chain.
  // Preserve route hooks and authority-rejection hooks across header wrapping.
  if (response.crossws) secured.crossws = response.crossws
  return secured
}

/** Next's default trailingSlash:false redirect runs before every route. Work
 * on the literal URL path: an encoded slash must never become a separator. */
export function trailingSlashRedirect(request) {
  const url = new URL(request.url)
  if (url.pathname.length <= 1 || !url.pathname.endsWith('/')) return undefined
  url.pathname = url.pathname.slice(0, -1)
  return new Response(null, { status: 308, headers: { location: url.href } })
}

export function pageRedirect(request, { production = process.env.NODE_ENV === 'production', legacyHost = process.env.MIKKA_LEGACY_APP_HOST, origin = process.env.BETTER_AUTH_URL, edition = process.env.MIKKA_EDITION } = {}) {
  const canonical = trailingSlashRedirect(request)
  if (canonical) return canonical
  const url = new URL(request.url), path = url.pathname
  const redirect = (pathname, status = 307, reset = false) => {
    const target = new URL(url); target.pathname = pathname; if (reset) target.search = ''
    return new Response(null, { status, headers: { location: target.href } })
  }
  if (legacyHost && origin && url.host === legacyHost) {
    const target = new URL(origin); target.pathname = `/mikka${path === '/' ? '' : path}`; target.search = url.search
    return new Response(null, { status: 308, headers: { location: target.href } })
  }
  if (path === '/') return redirect('/mikka')
  // The official App keeps /mikka as its Setup URL. Only the cloud broker's
  // namespaced state continues into its authenticated one-use callback.
  const state = url.searchParams.get('state'), installationId = url.searchParams.get('installation_id')
  if (edition === 'cloud' && request.method === 'GET' && /^\/mikka(?:\/(?:en|zh-CN))?$/.test(path)
    && /^mikka-gh\.[a-f0-9-]{36}\.[A-Za-z0-9_-]{43}$/.test(state ?? '') && /^\d{1,20}$/.test(installationId ?? '')
    && url.searchParams.getAll('state').length === 1 && url.searchParams.getAll('installation_id').length === 1) {
    const target = new URL('/mikka/cloud/v1/github/setup', url.origin)
    target.searchParams.set('state', state); target.searchParams.set('installation_id', installationId)
    return new Response(null, { status: 302, headers: { location: target.href, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } })
  }
  if (path === '/.well-known/oauth-authorization-server' || path === '/.well-known/oauth-authorization-server/mikka/api/auth') return redirect('/mikka/.well-known/oauth-authorization-server')
  if (path === '/.well-known/oauth-protected-resource/mikka/api/mcp') return redirect('/mikka/.well-known/oauth-protected-resource')
  const device = /^\/mikka(\/(?:en|zh-CN))?\/devices$/.exec(path)
  if (device) { const target = new URL(url); target.pathname = `/mikka${device[1] ?? ''}/settings`; target.searchParams.set('section', 'devices'); return new Response(null, { status: 307, headers: { location: target.href } }) }
  if (!isPagePath(path)) return undefined
  const alias = /^\/mikka\/(zh|zh-cn)(?=\/|$)/i.exec(path)
  if (alias && !path.startsWith('/mikka/zh-CN')) return redirect(`/mikka/zh-CN${path.slice(alias[0].length)}`)
  const preview = /^\/mikka(\/(?:en|zh-CN))?\/preview(\/settings)?$/.exec(path)
  if (production && preview) {
    const target = new URL(url); target.pathname = `/mikka${preview[1] ?? ''}${preview[2] ? '/settings/members' : ''}`; target.search = ''
    if (preview[2]) { if (url.searchParams.has('workspace')) target.searchParams.set('workspace', url.searchParams.get('workspace')); if (url.searchParams.get('invite') === '1') target.searchParams.set('invite', '1') }
    return new Response(null, { status: 307, headers: { location: target.href } })
  }
}

/** @returns {{locale:'en'|'zh-CN', redirect?:Response, cookie?:string}} */
export function localizePage(request) {
  const url = new URL(request.url), explicit = /^\/mikka\/(en|zh-CN)(?=\/|$)/.exec(url.pathname)?.[1]
  const cookie = parseRequestCookies(request.headers.get('cookie')).get('NEXT_LOCALE')
  let locale = explicit ?? (cookie === 'en' || cookie === 'zh-CN' ? cookie : undefined)
  if (!locale) {
    try { locale = match(new Negotiator({ headers: { 'accept-language': request.headers.get('accept-language') ?? '' } }).languages().filter(value => value !== '*'), ['zh-CN', 'en'], 'zh-CN') }
    catch { locale = 'zh-CN' }
  }
  if (locale !== 'en') locale = 'zh-CN'
  let destination
  if (explicit === 'zh-CN') destination = url.pathname.replace(/^\/mikka\/zh-CN/, '/mikka')
  else if (!explicit && locale === 'en') destination = url.pathname.replace(/^\/mikka/, '/mikka/en')
  const document = request.headers.get('sec-fetch-dest')
  const result = { locale, ...(document === 'document' && cookie !== locale ? { cookie: `NEXT_LOCALE=${locale}; Max-Age=31536000; Path=/mikka; SameSite=Lax` } : {}) }
  if (destination) { url.pathname = destination; return { ...result, redirect: new Response(null, { status: 307, headers: { location: url.href } }) } }
  return result
}

export async function pageResponse(request, render, options = {}) {
  const redirect = pageRedirect(request, options)
  if (redirect) return applySecurityHeaders(request, redirect)
  const path = new URL(request.url).pathname
  if (!isPagePath(path)) return applySecurityHeaders(request, new Response(null, { status: 404 }))
  if (!['GET', 'HEAD'].includes(request.method)) return applySecurityHeaders(request, new Response(null, { status: 405, headers: { allow: 'GET, HEAD' } }))
  const localized = localizePage(request)
  const headers = { 'cache-control': 'no-store', vary: 'Accept-Language, Cookie', ...(localized.cookie ? { 'set-cookie': localized.cookie } : {}) }
  if (localized.redirect) {
    for (const [key, value] of Object.entries(headers)) localized.redirect.headers.set(key, value)
    return applySecurityHeaders(request, localized.redirect)
  }
  const html = request.method === 'HEAD' ? null : (await render()).replace(/<html\b[^>]*\blang="[^"]*"/, `<html lang="${localized.locale}"`)
  return applySecurityHeaders(request, new Response(html, { headers: { ...headers, 'content-type': 'text/html; charset=utf-8' } }))
}
