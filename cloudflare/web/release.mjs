// Each deployment binds this Worker to the Vite assets and private services
// built for the same release. The public gateway owns deployment pin selection.
import { applySecurityHeaders, isMachinePath, isPagePath, pageResponse, pageRedirect } from '../../apps/api/runtime/http-policy.mjs'

import { publicVersion } from './version.mjs'

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    let decoded
    try { decoded = decodeURIComponent(url.pathname) } catch { return env.API.fetch(request) }
    if (/^\/mikka\/cloud(?:\/|$)/.test(decoded)) return env.CLOUD.fetch(request)

    const options = {
      production: true, edition: 'cloud', legacyHost: env.MIKKA_LEGACY_APP_HOST ?? '',
      origin: env.BETTER_AUTH_URL ?? url.origin,
    }
    const assetsUrl = new URL(url.origin)
    if (isPagePath(url.pathname)) {
      return pageResponse(request, async () => {
        assetsUrl.pathname = '/index.html'
        const html = await env.ASSETS.fetch(new Request(assetsUrl))
        if (!html.ok) throw new Error('WEB_RELEASE_DOCUMENT_UNAVAILABLE')
        return html.text()
      }, options)
    }

    const redirect = pageRedirect(request, options)
    if (redirect) return applySecurityHeaders(request, redirect)
    // Workflow callbacks, SSE, WebSocket upgrades and API bodies reach their
    // service intact. Never convert them to a document or cache them.
    if (url.pathname === '/mikka/api/version' && (request.method === 'GET' || request.method === 'HEAD')) {
      return applySecurityHeaders(request, await publicVersion(request, env))
    }
    if (isMachinePath(url.pathname)) return env.API.fetch(request)

    // The binding is rooted at the release's static directory. Keep the raw
    // index, dotfiles, directory redirects and non-application paths private.
    if (!url.pathname.startsWith('/mikka/') || /%2f|%5c|\\/i.test(url.pathname)
        || decoded === '/mikka/index.html' || decoded.split('/').some(segment => segment.startsWith('.'))) {
      return applySecurityHeaders(request, new Response(null, { status: 404 }))
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return applySecurityHeaders(request, new Response(null, { status: 405, headers: { Allow: 'GET, HEAD' } }))
    }
    assetsUrl.pathname = url.pathname.slice('/mikka'.length)
    const headers = new Headers()
    for (const key of ['if-none-match', 'if-modified-since', 'range', 'if-range', 'accept-encoding']) {
      if (request.headers.has(key)) headers.set(key, request.headers.get(key))
    }
    const asset = await env.ASSETS.fetch(new Request(assetsUrl, { method: request.method, headers }))
    const response = applySecurityHeaders(request, asset)
    response.headers.set('cache-control', asset.ok || asset.status === 304
      ? (decoded.startsWith('/mikka/assets/') ? 'public, max-age=31536000, immutable' : 'public, max-age=0, must-revalidate')
      : 'no-store')
    return response
  },
}
