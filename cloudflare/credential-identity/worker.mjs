import { WorkerEntrypoint } from 'cloudflare:workers'
import { issueRuntimeIdentity, runtimeIdentityMetadata } from './identity.mjs'

const noStore = { 'cache-control': 'no-store' }

async function issue(request, role, env) {
  if (request.method !== 'POST' || request.url !== 'https://identity.internal/token') {
    return new Response(null, { status: 404, headers: noStore })
  }
  try {
    if (request.body) {
      const reader = request.body.getReader()
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (value.byteLength) {
          await reader.cancel()
          return new Response(null, { status: 404, headers: noStore })
        }
      }
    }
    return Response.json({ token: await issueRuntimeIdentity(role, env) }, { headers: noStore })
  } catch {
    return new Response('Runtime identity unavailable', { status: 503, headers: noStore })
  }
}

export class AppIdentity extends WorkerEntrypoint {
  fetch(request) { return issue(request, 'app', this.env) }
}

export class BrokerIdentity extends WorkerEntrypoint {
  fetch(request) { return issue(request, 'broker', this.env) }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    if (request.method !== 'GET' || url.search ||
        !['/.well-known/openid-configuration', '/.well-known/jwks.json'].includes(url.pathname)) {
      return new Response(null, { status: 404, headers: noStore })
    }
    try {
      const metadata = await runtimeIdentityMetadata(env)
      const body = url.pathname === '/.well-known/jwks.json' ? metadata.jwks : metadata.configuration
      return Response.json(body, { headers: noStore })
    } catch {
      return new Response('Runtime identity unavailable', { status: 503, headers: noStore })
    }
  },
}
