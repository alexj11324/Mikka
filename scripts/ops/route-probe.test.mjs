import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { routeProbePlan, runRouteProbe } from './route-probe.mjs'

const manifest = routes => ({ version: 1, basePath: '/mikka', routes })
const route = (path = '/mikka/api/items/[id]', methods = ['GET', 'POST']) => ({ path, methods })
const healthy = probe => new Response(null, { status: probe.expectedStatus, headers: { allow: probe.allowed.join(', ') } })

test('all generated routes have a safe dispatch-only probe, including explicit OPTIONS and catch-all routes', async () => {
  const generated = JSON.parse(await readFile(new URL('../../apps/api/generated/routes.json', import.meta.url), 'utf8'))
  const plan = routeProbePlan(generated)
  assert.equal(plan.length, generated.routes.length)
  for (const [index, probe] of plan.entries()) {
    assert.equal(generated.routes[index].methods.includes(probe.method), false)
    assert.equal(/[[\]]/.test(probe.path), false)
    assert.equal(probe.allowed.includes('OPTIONS'), true)
  }
  assert.ok(plan.some(probe => probe.method === 'PUT' && probe.expectedStatus === 405))
})

test('anonymous requests carry no body or credentials and do not follow redirects', async () => {
  const input = manifest([route(), route('/mikka/api/agents/[...path]', ['GET', 'OPTIONS', 'POST'])])
  const plan = routeProbePlan(input)
  const calls = []
  const report = await runRouteProbe({ baseUrl: 'https://stage.example.test/mikka', manifest: input, fetchImpl: async (url, init) => {
    calls.push({ url, init })
    const probe = plan.find(item => url.endsWith(item.path))
    assert.equal(init.method, probe.method)
    assert.equal(init.body, undefined)
    assert.equal(init.credentials, 'omit')
    assert.equal(init.redirect, 'manual')
    assert.deepEqual(init.headers, { accept: 'application/json' })
    assert.ok(init.signal instanceof AbortSignal)
    return healthy(probe)
  } })
  assert.equal(calls.length, 2)
  assert.equal(report.status, 'pass')
  assert.equal(report.passed, 2)
})

test('404, 5xx, redirects and a generic OPTIONS response without the real Allow contract fail', async () => {
  for (const status of [404, 500, 503, 302, 204]) {
    const report = await runRouteProbe({ baseUrl: 'https://stage.example.test', manifest: manifest([route()]),
      fetchImpl: async () => new Response(null, { status }) })
    assert.equal(report.status, 'fail')
    assert.equal(report.failed, 1)
    assert.equal(report.results[0].status, status)
  }
})

test('a changed route method list fails the dispatch contract even when its path exists', async () => {
  const report = await runRouteProbe({ baseUrl: 'https://stage.example.test', manifest: manifest([route()]),
    fetchImpl: async () => new Response(null, { status: 204, headers: { allow: 'GET, HEAD, OPTIONS' } }) })
  assert.equal(report.status, 'fail')
  assert.equal(report.results[0].error, 'route_probe_allow')
})

test('network failures preserve a closed cause and never expose response bodies or origins', async () => {
  const report = await runRouteProbe({ baseUrl: 'https://private.example.test', manifest: manifest([route()]),
    fetchImpl: async () => { throw new Error('https://private.example.test/?token=secret') } })
  assert.equal(report.status, 'fail')
  assert.equal(report.results[0].error, 'route_probe_request_failed')
  assert.doesNotMatch(JSON.stringify(report), /private\.example|secret/)
})

test('malformed inventories, unsafe origins and handlers implementing every method fail before any request', async () => {
  let called = false
  const fetchImpl = async () => { called = true; throw new Error('unexpected') }
  for (const baseUrl of [undefined, 'http://remote.example', 'https://user:password@example.test', 'https://example.test/private', 'https://example.test/?token=secret']) {
    await assert.rejects(runRouteProbe({ baseUrl, manifest: manifest([route()]), fetchImpl }), /route_probe_origin_invalid/)
  }
  for (const input of [manifest([]), manifest([route('/mikka/../api/write')]), manifest([route(), route()]), manifest([route('/mikka/api/full', ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])])]) {
    await assert.rejects(runRouteProbe({ baseUrl: 'http://127.0.0.1', manifest: input, fetchImpl }), /route_probe_/)
  }
  assert.equal(called, false)
})
