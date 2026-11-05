import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { NextRequest } from 'next/server.js'
import { prepareAttestationRoute } from './run-read-cache.mjs'

const environment = { origin: 'http://localhost:3137', basePath: '/mikka' }

test('the workflow binds the canonical NextRequest origin before signing the environment descriptor', async () => {
  const workflow = await readFile(new URL('../../.github/workflows/read-cache.yml', import.meta.url), 'utf8')
  const authOrigin = /^\s+BETTER_AUTH_URL: (\S+)$/m.exec(workflow)?.[1]
  const baseOrigin = /^\s+E2E_BASE_URL: (\S+)$/m.exec(workflow)?.[1]
  assert.ok(authOrigin); assert.equal(authOrigin, baseOrigin)
  const route = new NextRequest(`${authOrigin}/mikka/api/test-environment?challenge=${'a'.repeat(64)}`)
  assert.equal(new URL(route.url).origin, authOrigin, 'the route checks an exact origin before it reads the HMAC key')
  // NextRequest normalizes IPv4 loopback even when Next's listener was bound
  // to it explicitly. Keep database identity separate from the HTTP origin.
  assert.equal(new URL(new NextRequest('http://127.0.0.1:3137/mikka/api/test-environment').url).hostname, 'localhost')
  for (const name of ['E2E_DATABASE_URL', 'MIKKA_DATABASE_URL', 'DATABASE_URL']) {
    const value = new RegExp(`^\\s+${name}: (\\S+)$`, 'm').exec(workflow)?.[1]
    assert.ok(value); assert.equal(new URL(value).hostname, '127.0.0.1')
  }
})

test('route compilation is one anonymous request with no attestation challenge or credentials', async () => {
  let calls = 0
  await prepareAttestationRoute(environment, async (url, options) => {
    calls++
    assert.equal(url, 'http://localhost:3137/mikka/api/test-environment')
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
