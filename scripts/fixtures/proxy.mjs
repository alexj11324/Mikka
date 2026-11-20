import { createServer, request as httpRequest } from 'node:http'
import { fixtureOrigin } from './guard.mjs'

// A release-output scan uses this marker to prove the login helper is absent.
export const FIXTURE_LOGIN_PROXY_MARKER = 'mikka-local-fixture-login-proxy-v1'

/** Login through the ordinary password endpoint; only the loopback harness knows the ephemeral password. */
export async function startFixtureProxy({ origin, upstream, fixtures, defaultScene }) {
  origin = fixtureOrigin(origin); upstream = fixtureOrigin(upstream)
  const publicUrl = new URL(origin), target = new URL(upstream)
  const server = createServer(async (request, response) => {
    try {
      if (request.headers.host !== publicUrl.host || request.headers.origin && request.headers.origin !== origin
        || request.headers['sec-fetch-site'] === 'cross-site') { response.writeHead(403); response.end(); return }
      const url = new URL(request.url, origin)
      if (url.pathname === '/') { response.writeHead(302, { location: `/__fixture/${defaultScene}` }); response.end(); return }
      if (url.pathname.startsWith('/__fixture/')) {
        const scene = fixtures.get(url.pathname.slice('/__fixture/'.length))
        if (request.method !== 'GET' || !scene || url.search) { response.writeHead(404); response.end(); return }
        const login = await fetch(`${upstream}/mikka/api/auth/sign-in/email`, {
          method: 'POST', headers: { 'content-type': 'application/json', origin, host: publicUrl.host },
          body: JSON.stringify({ email: scene.email, password: scene.password }), redirect: 'error', signal: AbortSignal.timeout(15_000),
        })
        if (!login.ok) { await login.body?.cancel(); throw new Error('FIXTURE_PASSWORD_LOGIN_FAILED') }
        const identity = await login.json()
        if (identity?.user?.id !== scene.userId) throw new Error('FIXTURE_LOGIN_IDENTITY_MISMATCH')
        const cookies = login.headers.getSetCookie()
        if (!cookies.length) throw new Error('FIXTURE_SESSION_COOKIE_MISSING')
        response.writeHead(303, { location: scene.path, 'set-cookie': cookies, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' })
        response.end(); return
      }
      const headers = { ...request.headers, host: publicUrl.host }
      for (const name of Object.keys(headers)) if (name === 'forwarded' || name.startsWith('x-forwarded-')) delete headers[name]
      const proxy = httpRequest({ hostname: target.hostname, port: target.port, method: request.method, path: request.url, headers })
      proxy.once('response', incoming => { response.writeHead(incoming.statusCode ?? 502, incoming.headers); incoming.pipe(response); incoming.once('error', () => response.destroy()) })
      proxy.once('error', () => { if (!response.headersSent) response.writeHead(502); response.end() })
      request.once('aborted', () => proxy.destroy()); response.once('close', () => proxy.destroy()); request.pipe(proxy)
    } catch {
      // Auth/HTTP exceptions may contain passwords, response bodies or cookies.
      if (!response.headersSent) response.writeHead(502, { 'content-type': 'text/plain' })
      response.end('FIXTURE_LOGIN_OR_PROXY_FAILED')
    }
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(Number(publicUrl.port), publicUrl.hostname, resolve) })
  return { origin, async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fixtures.clear() } }
}
