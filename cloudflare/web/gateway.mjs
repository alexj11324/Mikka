// Only the deployment-owned binding map selects origins. Each retained entry
// names a private, immutable Worker with its own API, cloud and static assets.
import { releaseRoutePath, versionPath } from './route-path.mjs'

const versionHeader = 'x-mikka-gateway-version-sha256'
const nativeVersion = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    const params = url.searchParams.getAll('dpl')
    const header = request.headers.get('x-deployment-id')
    const path = releaseRoutePath(url.pathname)
    const api = path.startsWith('/mikka/api/')
    const pinnedAsset = url.pathname.startsWith('/mikka/') && /\/[^/]+\.[^/]+$/.test(path) && !api
    let id = env.CURRENT_RELEASE
    if (path !== versionPath && (api || pinnedAsset)) {
      if (params.length > 1 || (header !== null && params.length && header !== params[0])) {
        return Response.json({ error: 'deploymentPinConflict' }, { status: 400, headers: { 'cache-control': 'no-store' } })
      }
      id = header ?? params[0] ?? id
    }
    const binding = env.RELEASES && Object.hasOwn(env.RELEASES, id) ? env.RELEASES[id] : null
    if (!binding || !Object.hasOwn(env, binding) || typeof env[binding]?.fetch !== 'function') {
      const current = id === env.CURRENT_RELEASE
      return Response.json({ error: current ? 'deploymentUnavailable' : 'deploymentExpired' }, {
        status: current ? 503 : 409, headers: { 'cache-control': 'no-store' },
      })
    }
    // Only server-selected pins cross the private service boundary. Keep the
    // original body, signal, cookies, streaming and WebSocket upgrade intact.
    const outbound = new Request(request)
    outbound.headers.delete('cloudflare-workers-version-overrides')
    const versionRead = path === versionPath && (request.method === 'GET' || request.method === 'HEAD')
    if (!versionRead) return env[binding].fetch(outbound)
    outbound.headers.delete(versionHeader)
    const upstream = await env[binding].fetch(outbound)
    if (upstream.status === 101) return upstream
    const version = env.CF_VERSION_METADATA?.id
    const attest = upstream.ok && typeof version === 'string' && nativeVersion.test(version)
    if (!attest && !upstream.headers.has(versionHeader)) return upstream

    const response = new Response(upstream.body, upstream)
    response.headers.delete(versionHeader)
    if (attest) {
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(version))
      response.headers.set(versionHeader, Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join(''))
    }
    return response
  },
}
