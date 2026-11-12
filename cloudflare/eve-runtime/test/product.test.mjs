import assert from 'node:assert/strict'
import test from 'node:test'
import { productRequest } from '../runtime/product.mjs'

const endpoint = 'https://product.internal/mikka/api/internal/eve/tools'
const origin = 'https://app.example.test'
const request = (url = endpoint, method = 'POST', extra = {}) => new Request(url, { method,
  headers: { authorization: 'Bearer mev_fixture', 'x-mikka-product-capability': 'private-local', cookie: 'ignored', ...extra },
  ...(method === 'POST' ? { body: '{"operation":"prepare"}' } : {}) })

test('the shared host sends only the scoped product authorization to its selected API', async () => {
  let forwarded
  const result = await productRequest(request(), { fetch(r) { forwarded = r; return new Response(null, { status: 204 }) } }, origin, 'private-local')
  assert.equal(result.status, 204)
  assert.equal(forwarded.url, origin + '/mikka/api/internal/eve/tools')
  assert.equal(forwarded.redirect, 'manual')
  assert.deepEqual(Object.fromEntries(forwarded.headers), { authorization: 'Bearer mev_fixture', 'content-type': 'application/json' })
  assert.deepEqual(await forwarded.json(), { operation: 'prepare' })
})

test('a missing immutable binding, wrong principal, wrong capability, or unrelated route stays closed', () => {
  assert.equal(productRequest(request(), undefined, origin, 'private-local').status, 503)
  for (const r of [request(endpoint, 'POST', { authorization: 'Bearer user' }), request(endpoint, 'POST', { 'x-mikka-product-capability': 'other' })]) {
    assert.equal(productRequest(r, undefined, origin, 'private-local').status, 403)
  }
  for (const r of [request(endpoint, 'GET'), request(endpoint + '?scope=other'), request(origin + '/mikka/api/internal/eve/tools'), request(endpoint + '/more')]) {
    assert.equal(productRequest(r, undefined, origin, 'private-local').status, 404)
  }
})

test('an upstream redirect is cancelled and returned as an empty gateway failure', async () => {
  for (const status of [300, 301, 302, 303, 304, 307, 308, 399]) {
    let calls = 0, cancelled = false
    const result = await productRequest(request(), { fetch(r) {
      calls++
      assert.equal(r.redirect, 'manual')
      const body = status === 304 ? null : new ReadableStream({ cancel() { cancelled = true } })
      return new Response(body, { status, headers: { location: 'https://elsewhere.example/receipt' } })
    } }, origin, 'private-local')
    assert.equal(calls, 1)
    assert.equal(result.status, 502)
    assert.equal(result.headers.get('location'), null)
    assert.equal(await result.text(), '')
    assert.equal(cancelled, status !== 304)
  }
})
