import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { createApiHandler } from './application'
import { runRouteProbe } from '../../../scripts/ops/route-probe.mjs'
import type { ApiRoute } from './routes'

test('real API dispatch serves the generated route inventory over HTTP without loading handlers; a removed route fails', async () => {
  const manifest = JSON.parse(await readFile(new URL('../generated/routes.json', import.meta.url), 'utf8'))
  let loaded = 0
  const routes: ApiRoute[] = manifest.routes.map((route: ApiRoute) => ({ ...route, load: async () => {
    loaded++
    throw new Error('route_probe_must_not_invoke_business_handlers')
  } }))
  let app = createApiHandler(routes)
  const server = createServer(async (request, response) => {
    try {
      const result = await app.fetch(new Request(`http://127.0.0.1${request.url}`, { method: request.method }))
      response.writeHead(result.status, Object.fromEntries(result.headers))
      response.end(Buffer.from(await result.arrayBuffer()))
    } catch { response.writeHead(500); response.end() }
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const baseUrl = `http://127.0.0.1:${address.port}`
  try {
    const positive = await runRouteProbe({ baseUrl, manifest })
    assert.equal(positive.total, routes.length)
    assert.deepEqual(positive.results.filter((result: { ok: boolean }) => !result.ok), [])
    assert.equal(positive.status, 'pass')
    const removed = '/mikka/api/version'
    assert.ok(routes.some(route => route.path === removed))
    app = createApiHandler(routes.filter(route => route.path !== removed))
    const negative = await runRouteProbe({ baseUrl, manifest })
    assert.equal(negative.status, 'fail')
    assert.equal(negative.failed, 1)
    assert.deepEqual(negative.results.filter((result: { ok: boolean }) => !result.ok), [
      { route: removed, method: 'OPTIONS', status: 404, ok: false, error: 'route_probe_status' },
    ])
    assert.equal(loaded, 0)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
})
