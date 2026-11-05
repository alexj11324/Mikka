import assert from 'node:assert/strict'
import { channel } from 'node:diagnostics_channel'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { NextRequest } from 'next/server.js'
import { TestAccountError } from '../test-accounts/pool.mjs'
import { ReadCacheDiagnosticError } from './read-cache.mjs'
import { observeOwnedRequests, prepareAttestationRoute, publicOwnedFailure } from './run-read-cache.mjs'

const environment = { origin: 'http://localhost:3137', basePath: '/mikka' }

test('the Node Undici envelopes expose a closed timeout record and child state before cleanup', () => {
  let time = 0
  const observed = observeOwnedRequests(environment, () => time)
  const publish = (name, value) => channel(`undici:request:${name}`).publish(value)
  const forbidden = () => assert.fail('observer must not inspect headers, bodies, query values or error messages')
  const privateText = 'private cookie, password, account and response'
  const workspace = { origin: environment.origin, path: '/mikka/api/workspace', method: 'GET', get headers() { return forbidden() }, get body() { return forbidden() }, get query() { return forbidden() } }
  const signup = Object.create(workspace, { path: { value: '/mikka/api/auth/sign-up/email' }, method: { value: 'POST' } })
  try {
    publish('create', { request: workspace })
    time = 12
    publish('headers', { request: workspace, response: { statusCode: 200, get headers() { return forbidden() }, get statusText() { return forbidden() } } })
    publish('trailers', { request: workspace, get trailers() { return forbidden() } })
    publish('create', { request: signup })
    time = 30_012
    publish('error', { request: signup, error: { name: 'TimeoutError', get message() { return forbidden() }, privateText } })
    const cause = new TestAccountError('TEST_ACCOUNT_HTTP_FAILED')
    cause.message = privateText
    const failure = new ReadCacheDiagnosticError(cause, { stage: 'accounts', completedReads: 0, fixtureCleanup: 'not-started' })
    const child = { pid: 123, exitCode: null, signalCode: null }
    observed.recordFailure(failure, child)
    // The runner's subsequent shutdown is unrelated to the request failure.
    child.signalCode = 'SIGTERM'
    const evidence = publicOwnedFailure(failure)
    assert.equal(failure.cause, cause)
    assert.equal(evidence.stage, 'accounts')
    assert.equal(evidence.code, 'TEST_ACCOUNT_HTTP_FAILED')
    assert.equal(evidence.leaseCleanup, 'unobserved')
    assert.deepEqual(evidence.ownedServerAtFailure, { state: 'running', exitCode: null, signal: null })
    assert.deepEqual(evidence.httpRequests, [
      { route: 'account-workspace', method: 'GET', state: 'completed', httpStatus: 200, networkError: null, elapsedMs: 12 },
      { route: 'account-sign-up', method: 'POST', state: 'failed', httpStatus: null, networkError: 'TimeoutError', elapsedMs: 30_000 },
    ])
    assert.equal(JSON.stringify(evidence).includes(privateText), false)
  } finally { observed.close() }
})

test('request observations are bounded, ignore foreign and query paths, retain standard causes, and unsubscribe', () => {
  let time = 0
  const observed = observeOwnedRequests(environment, () => time)
  const publish = (name, value) => channel(`undici:request:${name}`).publish(value)
  const privateText = 'private-route-or-error'
  const request = overrides => ({ origin: environment.origin, path: '/mikka/api/auth/get-session', method: 'GET', ...overrides })
  const failure = new Error(privateText)
  try {
    for (let index = 0; index < 36; index++) publish('create', { request: request({}) })
    for (const ignored of [request({ origin: 'https://foreign.example' }), request({ path: `/mikka/api/auth/get-session?${privateText}` }), request({ path: `/mikka/${privateText}` }), request({ method: 'DELETE' })]) {
      publish('create', { request: ignored })
      publish('error', { request: ignored, error: { code: privateText, message: privateText } })
    }
    const refused = request({})
    publish('create', { request: refused })
    time = 42
    publish('error', { request: refused, error: { name: 'TypeError', cause: { code: 'ECONNREFUSED', message: privateText } } })
    const unknown = request({})
    publish('create', { request: unknown })
    publish('error', { request: unknown, error: { code: privateText, name: privateText } })
    observed.close()
    publish('create', { request: request({}) })
    observed.recordFailure(failure, { pid: 123, exitCode: null, signalCode: 'SIGKILL' })
    const evidence = publicOwnedFailure(failure)
    assert.equal(evidence.httpRequests.length, 32)
    assert.equal(evidence.httpRequests.at(-2).networkError, 'ECONNREFUSED')
    assert.equal(evidence.httpRequests.at(-1).networkError, 'unknown')
    assert.deepEqual(evidence.ownedServerAtFailure, { state: 'exited', exitCode: null, signal: 'SIGKILL' })
    assert.equal(JSON.stringify(evidence).includes(privateText), false)
    observed.recordFailure(failure, { pid: 123, exitCode: 7, signalCode: null })
    assert.deepEqual(publicOwnedFailure(failure).ownedServerAtFailure, { state: 'exited', exitCode: 7, signal: null })
    observed.recordFailure(failure, { pid: 123, exitCode: 999, signalCode: privateText })
    assert.deepEqual(publicOwnedFailure(failure).ownedServerAtFailure, { state: 'exited', exitCode: null, signal: 'other' })
  } finally { observed.close() }
})

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
