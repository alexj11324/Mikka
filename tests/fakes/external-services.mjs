import { createServer } from 'node:http'
import { createE2BFake, LOCAL_E2B_KEY } from './e2b.mjs'
import { createSlackFake } from './slack.mjs'
import { assertLoopbackOrigin, json } from './http.mjs'

/** Shared by focused tests and the local-loop/MVP service's routes hook. */
export function externalServiceRoutes(options = {}) {
  const e2b = createE2BFake(options.e2b), slack = createSlackFake(options.slack)
  return { e2b, slack, async routes(request, response, url) {
    return await e2b.routes(request, response, url) || await slack.routes(request, response, url)
  } }
}

/** A fetch transport: ordinary provider clients still serialize and parse HTTP. */
export function externalServiceFetch(origin, upstream = fetch) {
  origin = assertLoopbackOrigin(origin)
  return async (input, init) => {
    const request = new Request(input, init), source = new URL(request.url)
    const path = source.origin === 'https://slack.com' && source.pathname.startsWith('/api/') ? `/slack${source.pathname}${source.search}`
      : source.origin === 'https://api.github.com' ? `/github${source.pathname}${source.search}` : null
    if (!path) throw new Error('Unexpected external request in HTTP fixture')
    return upstream(new Request(`${origin}${path}`, request), { redirect: 'error' })
  }
}

export async function startExternalServices(options = {}) {
  const services = externalServiceRoutes(options)
  const server = createServer(async (request, response) => {
    try {
      if (!await services.routes(request, response, new URL(request.url, 'http://127.0.0.1')))
        json(response, { error: 'unknown_fake_provider_route' }, 404)
    } catch {
      // Body/assertion errors can contain credentials. Do not echo them.
      json(response, { error: 'invalid_fake_provider_request' }, 400)
    }
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(options.port ?? 0, '127.0.0.1', resolve) })
  const origin = `http://127.0.0.1:${server.address().port}`
  return { ...services, origin, fetch: externalServiceFetch(origin),
    e2bOptions: { apiKey: LOCAL_E2B_KEY, apiUrl: `${origin}/e2b/api`, sandboxUrl: `${origin}/e2b/envd`, httpVersion: /** @type {const} */ ('1.1'), retries: 0 },
    async close() { await services.e2b.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) } }
}
