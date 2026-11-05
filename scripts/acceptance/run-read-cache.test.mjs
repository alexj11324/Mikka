import assert from 'node:assert/strict'
import { test } from 'node:test'
import { prepareAttestationRoute } from './run-read-cache.mjs'

const environment = { origin: 'http://127.0.0.1:3137', basePath: '/mikka' }

test('route compilation is one anonymous request with no attestation challenge or credentials', async () => {
  let calls = 0
  await prepareAttestationRoute(environment, async (url, options) => {
    calls++
    assert.equal(url, 'http://127.0.0.1:3137/mikka/api/test-environment')
    assert.equal(options.method, 'GET')
    assert.equal(options.redirect, 'error')
    assert.equal(options.credentials, 'omit')
    assert.equal(options.headers, undefined)
    assert.equal(options.body, undefined)
    assert.ok(options.signal instanceof AbortSignal)
    return new Response(null, { status: 404 })
  })
  assert.equal(calls, 1)
})

test('an unexpected response cannot stand in for the later HMAC attestation', async () => {
  for (const response of [new Response('{}'), new Response(null, { status: 500 }), new Response(null, { status: 404, headers: { 'set-cookie': 'unexpected=value' } })]) {
    await assert.rejects(prepareAttestationRoute(environment, async () => response), { code: 'owned_attestation_prepare_refused' })
  }
})

test('preparation preserves the cause without exposing a response or credential', async () => {
  const cause = new Error('private transport detail')
  await assert.rejects(prepareAttestationRoute(environment, async () => { throw cause }), error => {
    assert.equal(error.code, 'owned_attestation_prepare_unavailable')
    assert.equal(error.cause, cause)
    assert.equal(error.message, 'owned_attestation_prepare_unavailable')
    return true
  })
})
