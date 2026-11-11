// Only the deployment-owned binding map selects origins. Each retained entry
// names a private, immutable Worker with its own API, cloud and static assets.
import { releaseRoutePath, versionPath } from './route-path.mjs'

export default {
  fetch(request, env) {
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
    return env[binding].fetch(outbound)
  },
}
