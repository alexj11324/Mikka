import assert from 'node:assert/strict'
import { channel } from 'node:diagnostics_channel'
import { readFile } from 'node:fs/promises'
import { mock, test } from 'node:test'
import { NextRequest } from 'next/server.js'
import { TestAccountError } from '../test-accounts/pool.mjs'
import { ReadCacheDiagnosticError } from './read-cache.mjs'
import { createOwnedRuntimeObserver, observeOwnedRequests, prepareAttestationRoute, prepareLandingRoute, publicOwnedFailure } from './run-read-cache.mjs'

const environment = { origin: 'http://localhost:3137', basePath: '/mikka' }

test('owned output observations retain only closed counters across split and oversized log lines', async () => {
  const privateText = 'private-account-cookie-command-and-sql'
  const observer = createOwnedRuntimeObserver({ readFileImpl: async () => null, hardware: () => ({ cpuCount: 4, availableCpuCount: 4, systemMemoryBytes: 16 * 1024 ** 3 }) })
  const compiling = Buffer.from('\u001b[37m○ Compiling /[locale] ...\u001b[0m\n')
  observer.output('stdout', compiling.subarray(0, 7))
  observer.output('stdout', compiling.subarray(7))
  observer.output('stdout', ` ✓ Ready in 1s\n GET /private-resource 200 in 12ms\n${privateText.repeat(1000)}`)
  observer.output('stdout', `\n${privateText}\n`)
  observer.output('stderr', ` ⨯ ${privateText}\nFATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory ${privateText}\n`)
  observer.output('stderr', 'fatal error: all goroutines are asleep - deadlock!')
  const result = await observer.finish()
  assert.deepEqual(result.output, { ready: 1, compiling: 1, compiled: 0, httpCompleted: 1, nextError: 1, fatalError: 1, heapOutOfMemory: 1, esbuildDeadlock: 1 })
  assert.equal(JSON.stringify(result).includes(privateText), false)
  assert.equal(JSON.stringify(result).includes('/private-resource'), false)
  observer.output('stderr', '\nFATAL ERROR: ignored after the outcome snapshot\n')
  assert.equal(await observer.finish(), result)
})

test('two resource samples detect lost direct children and OOM increments while the owned CLI remains alive', async () => {
  let ended = false
  const accesses = [], child = { pid: 413, exitCode: null, signalCode: null }
  const files = () => ({
    '/proc/meminfo': `MemTotal: 16000000 kB\nMemAvailable: ${ended ? 3000000 : 14000000} kB\n`,
    '/proc/self/cgroup': '0::/private-cgroup\n',
    '/sys/fs/cgroup/private-cgroup/memory.current': ended ? '9000\n' : '1000\n',
    '/sys/fs/cgroup/private-cgroup/memory.max': 'max\n',
    '/sys/fs/cgroup/private-cgroup/memory.peak': ended ? '10000\n' : '1100\n',
    '/sys/fs/cgroup/private-cgroup/memory.events': ended ? 'oom 3\noom_kill 2\n' : 'oom 2\noom_kill 1\n',
    '/proc/413/task/413/children': ended ? '' : '514\n',
    ...ended ? {} : { '/proc/514/status': 'Name: private-process\nPid: 514\nPPid: 413\nState: S (sleeping)\nVmRSS: 50 kB\nVmHWM: 100 kB\n' },
  })
  const observer = createOwnedRuntimeObserver({
    readFileImpl: async (path, encoding) => { accesses.push(path); assert.equal(encoding, 'utf8'); return files()[path] ?? null },
    hardware: () => ({ cpuCount: 4, availableCpuCount: 4, systemMemoryBytes: 16 * 1024 ** 3, privateValue: 'never included' }),
  })
  await observer.ready(child)
  ended = true
  const result = await observer.finish(child)
  assert.equal(child.exitCode, null)
  assert.equal(result.start.ownedDirectChildCount, 1)
  assert.deepEqual(result.start.workers, [{ stillDirectChild: true, state: 'S', rssBytes: 51200, peakRssBytes: 102400 }])
  assert.equal(result.end.ownedDirectChildCount, 0)
  assert.deepEqual(result.end.workers, [])
  assert.equal(result.retainedDirectChildren, 0)
  assert.equal(result.cgroupCurrentBytesDelta, 8000)
  assert.equal(result.cgroupOomDelta, 1)
  assert.equal(result.cgroupOomKillDelta, 1)
  assert.equal(result.start.cgroupMaxBytes, null)
  assert.equal(result.start.cgroupMaxUnlimited, true)
  assert.equal(result.cpuCount, 4)
  assert.equal(result.systemMemoryBytes, 16 * 1024 ** 3)
  assert.equal(accesses.filter(path => path === '/proc/413/task/413/children').length, 2)
  assert.equal(accesses.filter(path => path === '/proc/514/status').length, 1, 'do not inspect a disappeared or reparented PID')
  assert.ok(accesses.every(path => Object.hasOwn({ ...files(), '/proc/514/status': true }, path)))
  assert.doesNotMatch(JSON.stringify(result), /private-cgroup|private-process|never included|"pid"/iu)
  const before = accesses.length
  assert.equal(await observer.finish(child), result)
  assert.equal(accesses.length, before, 'success and failure reporting cannot trigger a third sample')
})

test('unavailable resource files stay null and cannot replace the original failure or cause', async () => {
  const cause = new Error('private original transport detail')
  const failure = new ReadCacheDiagnosticError(new TestAccountError('TEST_ACCOUNT_HTTP_FAILED'), { stage: 'accounts', completedReads: 0, fixtureCleanup: 'not-started' })
  failure.cause.cause = cause
  const child = { pid: 413, exitCode: null, signalCode: null }
  const observer = createOwnedRuntimeObserver({ readFileImpl: async () => { throw cause }, hardware: () => { throw cause } })
  await observer.ready(child)
  const evidence = await observer.finish(child)
  assert.equal(evidence.cpuCount, null)
  assert.equal(evidence.systemMemoryBytes, null)
  assert.equal(evidence.start.cgroupOom, null)
  assert.equal(evidence.end.cgroupMaxBytes, null)
  assert.equal(evidence.end.cgroupMaxUnlimited, null)
  assert.equal(evidence.end.ownedDirectChildCount, null)
  assert.equal(evidence.end.workers, null)
  assert.equal(evidence.retainedDirectChildren, null)
  assert.equal(evidence.cgroupOomKillDelta, null)
  const observedRequests = observeOwnedRequests(environment)
  try {
    observedRequests.recordFailure(failure, child)
    assert.equal(failure.cause.cause, cause)
    assert.equal(publicOwnedFailure(failure).code, 'TEST_ACCOUNT_HTTP_FAILED')
    assert.equal(publicOwnedFailure(failure).ownedServerAtFailure.state, 'running')
    assert.equal(JSON.stringify({ ...publicOwnedFailure(failure), ownedRuntime: evidence }).includes(cause.message), false)
  } finally { observedRequests.close() }
})

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

test('landing compilation makes one bounded anonymous request and never follows the guest redirect', async () => {
  const abort = new AbortController()
  const timeout = mock.method(AbortSignal, 'timeout', duration => { assert.equal(duration, 120_000); return abort.signal })
  try {
    for (const response of [new Response('<html>streamed redirect</html>'), new Response(null, { status: 307, headers: { location: '/api/acceptance' } }), new Response(null, { status: 307, headers: { location: `${environment.origin}/mikka/api/acceptance`, 'set-cookie': 'NEXT_LOCALE=zh-CN; Path=/mikka; SameSite=Lax' } })]) {
      let calls = 0
      await prepareLandingRoute(environment, async (url, options) => {
        calls++
        assert.equal(url, 'http://localhost:3137/mikka')
        assert.equal(options.method, 'GET')
        assert.equal(options.redirect, 'manual')
        assert.equal(options.credentials, 'omit')
        assert.equal(options.cache, 'no-store')
        assert.equal(options.headers, undefined)
        assert.equal(options.body, undefined)
        assert.equal(options.signal, abort.signal)
        return response
      })
      assert.equal(calls, 1)
    }
  } finally { timeout.mock.restore() }
})

test('landing preparation refuses unexpected status, redirect and auth cookies without a second request', async () => {
  for (const response of [new Response(null, { status: 500 }), new Response(null, { status: 404 }), new Response(null, { status: 307 }),
    ...['https://foreign.example/api/acceptance', '//foreign.example/api/acceptance', '/api/acceptance?next=private', '/mikka/api/auth/sign-up/email'].map(location => new Response(null, { status: 307, headers: { location } })),
    ...['better-auth.session_token=private; HttpOnly', 'NEXT_LOCALE=private', 'NEXT_LOCALE=en, better-auth.session_token=private'].map(cookie => new Response(null, { headers: { 'set-cookie': cookie } })),
  ]) {
    let calls = 0
    await assert.rejects(prepareLandingRoute(environment, async () => { calls++; return response }), { code: 'owned_landing_prepare_refused' })
    assert.equal(calls, 1)
  }
})

test('a landing preparation transport failure retains its cause and reports no original error text', async () => {
  const cause = new DOMException('private transport context', 'TimeoutError')
  await assert.rejects(prepareLandingRoute(environment, async () => { throw cause }), error => {
    assert.equal(error.code, 'owned_landing_prepare_unavailable')
    assert.equal(error.cause, cause)
    assert.deepEqual(publicOwnedFailure(error), { status: 'fail', code: 'owned_landing_prepare_unavailable' })
    return true
  })
})
