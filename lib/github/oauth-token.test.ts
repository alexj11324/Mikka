import assert from 'node:assert/strict'
import { inspect } from 'node:util'
import test from 'node:test'
import { exchangeGitHubOAuthToken, refreshGitHubOAuthToken } from './oauth-token'

const client = { clientId: 'Iv23.fixture-client', clientSecret: 'fixture-client-secret +&=?/本' }
const oldRefresh = 'fixture-previous-refresh-token+/_='
const accessToken = 'fixture.access-token_0123456789', refreshToken = 'fixture.refresh-token_0123456789'
const failureMessage = 'GitHub token exchange failed'
const privateValues = [client.clientSecret, oldRefresh, accessToken, refreshToken]
const encode = (text: string) => new TextEncoder().encode(text)

function safeFailure(error: unknown) {
  assert.ok(error instanceof Error)
  assert.equal(error.message, failureMessage)
  assert.equal(Object.hasOwn(error, 'cause'), false, 'a safe wrapper must not retain the provider or transport error as its cause')
  const rendered = `${String(error)}\n${inspect(error, { depth: 10 })}\n${JSON.stringify(error)}`
  for (const value of privateValues) assert.equal(rendered.includes(value), false, 'returned errors must not retain synthetic credentials')
  return true
}

test('refresh posts encoded credentials only to the fixed GitHub endpoint with no redirects, cookies or cache', async t => {
  const original = { ...client }, controller = new AbortController(), timeouts: number[] = []
  t.mock.method(AbortSignal, 'timeout', (milliseconds: number) => { timeouts.push(milliseconds); return controller.signal })
  const fetch = t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
    assert.ok(init)
    assert.equal(url, 'https://github.com/login/oauth/access_token')
    assert.equal(init?.method, 'POST'); assert.equal(init?.redirect, 'error')
    assert.equal(init?.credentials, 'omit'); assert.equal(init?.cache, 'no-store')
    assert.equal(init?.signal, controller.signal)
    const headers = new Headers(init?.headers)
    assert.equal(headers.get('accept'), 'application/json')
    assert.equal(headers.get('content-type'), 'application/x-www-form-urlencoded')
    assert.equal(headers.get('user-agent'), 'Mikka')
    assert.equal(headers.has('authorization'), false); assert.equal(headers.has('cookie'), false)
    assert.ok(init?.body instanceof URLSearchParams)
    assert.deepEqual(Object.fromEntries(init.body), { client_id: client.clientId, client_secret: client.clientSecret,
      grant_type: 'refresh_token', refresh_token: oldRefresh })
    for (const value of privateValues) assert.equal(String(url).includes(value), false)
    return Response.json({ access_token: accessToken, refresh_token: refreshToken })
  })
  const refreshed = await refreshGitHubOAuthToken(client, oldRefresh)
  assert.equal(refreshed.accessToken, accessToken); assert.equal(refreshed.refreshToken, refreshToken)
  assert.equal(fetch.mock.callCount(), 1); assert.deepEqual(timeouts, [10_000]); assert.deepEqual(client, original)
})

test('a browser abort cannot abandon rotation and each exchange owns a fresh bounded deadline', async t => {
  const ui = new AbortController(), deadlines: AbortController[] = [], intervals: number[] = []
  t.mock.method(AbortSignal, 'timeout', (milliseconds: number) => {
    const controller = new AbortController(); intervals.push(milliseconds); deadlines.push(controller); return controller.signal
  })
  const started = Promise.withResolvers<AbortSignal>(), response = Promise.withResolvers<Response>()
  let calls = 0
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    calls++
    assert.ok(init); assert.ok(init.signal instanceof AbortSignal)
    assert.notEqual(init.signal, ui.signal)
    if (calls === 1) { started.resolve(init.signal); return response.promise }
    assert.equal(init.signal, deadlines[1]!.signal)
    return Response.json({ access_token: accessToken })
  })
  const rotating = refreshGitHubOAuthToken(client, oldRefresh), firstSignal = await started.promise
  ui.abort(new Error('synthetic browser navigation'))
  assert.equal(firstSignal.aborted, false)
  response.resolve(Response.json({ access_token: accessToken, refresh_token: refreshToken }))
  assert.equal((await rotating).refreshToken, refreshToken)
  await refreshGitHubOAuthToken(client, oldRefresh)
  assert.deepEqual(intervals, [10_000, 10_000]); assert.notEqual(deadlines[0]!.signal, deadlines[1]!.signal)
})

test('the owned deadline bounds a stalled transport and exposes only a credential-free error', async t => {
  const deadline = new AbortController(), started = Promise.withResolvers<void>()
  t.mock.method(AbortSignal, 'timeout', (milliseconds: number) => { assert.equal(milliseconds, 10_000); return deadline.signal })
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    assert.equal(init?.signal, deadline.signal)
    init!.signal!.addEventListener('abort', () => reject(new Error(`provider timeout ${oldRefresh}`)), { once: true })
    started.resolve()
  }))
  const pending = assert.rejects(refreshGitHubOAuthToken(client, oldRefresh), safeFailure)
  await started.promise; deadline.abort()
  await pending
})

test('the same owned deadline remains effective while reading a stalled response body', async t => {
  const deadline = new AbortController(), reading = Promise.withResolvers<void>()
  let stream: ReadableStream<Uint8Array> | undefined
  t.mock.method(AbortSignal, 'timeout', () => deadline.signal)
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    stream = new ReadableStream<Uint8Array>({
      start(controller) { init!.signal!.addEventListener('abort', () => controller.error(new Error(`private stream ${refreshToken}`)), { once: true }) },
      pull() { reading.resolve() },
    }, { highWaterMark: 0 })
    return new Response(stream)
  })
  const pending = assert.rejects(refreshGitHubOAuthToken(client, oldRefresh), safeFailure)
  await reading.promise; deadline.abort()
  await pending
  assert.ok(stream); assert.equal(stream.locked, false)
})

test('exactly 32 KiB is accepted while a streamed byte beyond the cap is cancelled before the remainder is read', async t => {
  const body = JSON.stringify({ access_token: accessToken }), atLimit = body + ' '.repeat(32 * 1024 - Buffer.byteLength(body))
  assert.equal(Buffer.byteLength(atLimit), 32 * 1024)
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response(atLimit))
  assert.equal((await exchangeGitHubOAuthToken(client, { code: 'synthetic-code' })).access_token, accessToken)
  let pulls = 0, cancelled = 0
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls++
      if (pulls === 1) controller.enqueue(encode(atLimit))
      else if (pulls === 2) controller.enqueue(encode(' '))
      else { controller.enqueue(encode(refreshToken)); controller.close() }
    },
    cancel() { cancelled++ },
  }, { highWaterMark: 0 })
  fetch.mock.mockImplementation(async () => new Response(stream, { headers: { 'content-length': '1' } }))
  await assert.rejects(exchangeGitHubOAuthToken(client, { code: 'synthetic-code' }), safeFailure)
  assert.equal(pulls, 2); assert.equal(cancelled, 1); assert.equal(stream.locked, false)
})

test('response limits count bytes across chunks, including multibyte JSON, without trusting Content-Length', async t => {
  const body = JSON.stringify({ access_token: accessToken, provider_detail: '界'.repeat(11_000) })
  assert.ok(body.length < 32 * 1024); assert.ok(Buffer.byteLength(body) > 32 * 1024)
  const bytes = encode(body), stream = new ReadableStream<Uint8Array>({ start(controller) {
    for (let start = 0; start < bytes.length; start += 4096) controller.enqueue(bytes.slice(start, start + 4096))
    controller.close()
  } })
  t.mock.method(globalThis, 'fetch', async () => new Response(stream, { headers: { 'content-length': '1' } }))
  await assert.rejects(refreshGitHubOAuthToken(client, oldRefresh), safeFailure)
  assert.equal(stream.locked, false)
})

test('redirects and unsuccessful provider responses never expose their body or retry the rotating token', async t => {
  const fetch = t.mock.method(globalThis, 'fetch')
  for (const status of [301, 302, 307, 400, 401, 403, 429, 500]) {
    fetch.mock.mockImplementation(async () => Response.json({ access_token: accessToken, refresh_token: refreshToken,
      error_description: `${client.clientSecret} ${oldRefresh}` }, { status, headers: { location: `https://attacker.invalid/${refreshToken}` } }))
    await assert.rejects(refreshGitHubOAuthToken(client, oldRefresh), safeFailure)
  }
  assert.equal(fetch.mock.callCount(), 8, 'a failed rotation must not be blindly retried')
})

test('missing bodies, malformed JSON and provider error objects all return the same safe failure', async t => {
  const fetch = t.mock.method(globalThis, 'fetch')
  const responses = [
    new Response(null), new Response(`not JSON ${accessToken} ${client.clientSecret}`),
    Response.json(null), Response.json([]), Response.json('provider string'),
    Response.json({ error: 'bad_verification_code', error_description: `${refreshToken} ${oldRefresh}` }),
  ]
  for (const response of responses) {
    fetch.mock.mockImplementation(async () => response)
    await assert.rejects(exchangeGitHubOAuthToken(client, { code: 'synthetic-code' }), safeFailure)
    if (response.body) assert.equal(response.body.locked, false)
  }
})

test('invalid token fields, lifetimes and bounded metadata never escape in errors', async t => {
  const fetch = t.mock.method(globalThis, 'fetch')
  const cases: Record<string, unknown>[] = [
    ...['', 'with space', 'with\nnewline', 'private\\path', '非ASCII', 'a=b', 'x'.repeat(8193)]
      .map(access_token => ({ access_token })),
    { refresh_token: '' }, { refresh_token: 'with space' }, { refresh_token: 'x'.repeat(8193) },
    ...[0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '3600', null]
      .flatMap(value => [{ expires_in: value }, { refresh_token_expires_in: value }]),
    { token_type: {} }, { token_type: 'x'.repeat(65) }, { scope: [] }, { scope: 'x'.repeat(4097) },
  ]
  for (const change of cases) {
    fetch.mock.mockImplementation(async () => Response.json({ access_token: accessToken, refresh_token: refreshToken,
      provider_detail: client.clientSecret, ...change }))
    await assert.rejects(refreshGitHubOAuthToken(client, oldRefresh), safeFailure)
  }
})

test('transport and response stream failures discard credential-bearing messages and causes without logging them', async t => {
  const logs: unknown[][] = []
  for (const method of ['log', 'warn', 'error'] as const) t.mock.method(console, method, (...args: unknown[]) => { logs.push(args) })
  const unsafe = new Error(`request included ${client.clientSecret} ${oldRefresh}`, { cause: { accessToken, refreshToken } })
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw unsafe })
  await assert.rejects(refreshGitHubOAuthToken(client, oldRefresh), safeFailure)
  const stream = new ReadableStream<Uint8Array>({ pull(controller) { controller.error(unsafe) } }, { highWaterMark: 0 })
  fetch.mock.mockImplementation(async () => new Response(stream))
  await assert.rejects(refreshGitHubOAuthToken(client, oldRefresh), safeFailure)
  assert.equal(stream.locked, false)
  const rendered = inspect(logs, { depth: 10 })
  for (const value of privateValues) assert.equal(rendered.includes(value), false)
})

test('a failed body cancellation cannot replace the safe size-limit error or retain a stream lock', async t => {
  let cancelled = 0
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) { controller.enqueue(new Uint8Array(32 * 1024 + 1)) },
    cancel() { cancelled++; throw new Error(`cancel included ${refreshToken}`) },
  }, { highWaterMark: 0 })
  t.mock.method(globalThis, 'fetch', async () => new Response(stream))
  await assert.rejects(refreshGitHubOAuthToken(client, oldRefresh), safeFailure)
  assert.equal(cancelled, 1); assert.equal(stream.locked, false)
})

test('valid rotation preserves both provider lifetimes, token type and comma/space-delimited scopes', async t => {
  let now = Date.parse('2026-11-08T12:00:00.000Z')
  t.mock.method(Date, 'now', () => now)
  t.mock.method(globalThis, 'fetch', async () => {
    now += 250
    return Response.json({ access_token: accessToken, refresh_token: refreshToken, token_type: 'bearer',
      expires_in: 3600, refresh_token_expires_in: 2_592_000, scope: ' read:user,user:email  repo,read:org ' })
  })
  const value = await refreshGitHubOAuthToken(client, oldRefresh)
  assert.equal(value.accessToken, accessToken); assert.equal(value.refreshToken, refreshToken); assert.equal(value.tokenType, 'bearer')
  assert.deepEqual(value.scopes, ['read:user', 'user:email', 'repo', 'read:org'])
  assert.equal(value.accessTokenExpiresAt?.getTime(), now + 3600 * 1000)
  assert.equal(value.refreshTokenExpiresAt?.getTime(), now + 2_592_000 * 1000)
})

test('omitted expiry and refresh fields stay omitted instead of gaining an invented default lifetime', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json({ access_token: accessToken }))
  const value = await refreshGitHubOAuthToken(client, oldRefresh)
  assert.equal(value.refreshToken, undefined); assert.equal(value.tokenType, undefined); assert.equal(value.scopes, undefined)
  assert.equal(Object.hasOwn(value, 'accessTokenExpiresAt'), false); assert.equal(Object.hasOwn(value, 'refreshTokenExpiresAt'), false)
  fetch.mock.mockImplementation(async () => Response.json({ access_token: accessToken, scope: '', expires_in: 1 }))
  const minimum = await refreshGitHubOAuthToken(client, oldRefresh)
  assert.deepEqual(minimum.scopes, []); assert.ok(minimum.accessTokenExpiresAt instanceof Date)
  assert.equal(Object.hasOwn(minimum, 'refreshTokenExpiresAt'), false)
})

test('valid credential punctuation and exact field-size limits remain accepted', async t => {
  const token = 'A0._~+/-=', longestToken = 'x'.repeat(8192), scope = 's'.repeat(4096), tokenType = 't'.repeat(64)
  t.mock.method(globalThis, 'fetch', async () => Response.json({ access_token: token,
    refresh_token: longestToken, scope, token_type: tokenType }))
  const result = await refreshGitHubOAuthToken(client, oldRefresh)
  assert.equal(result.accessToken, token); assert.equal(result.refreshToken, longestToken)
  assert.deepEqual(result.scopes, [scope]); assert.equal(result.tokenType, tokenType)
})

test('positive lifetimes that cannot become valid expiration dates are rejected before persistence', async t => {
  const fetch = t.mock.method(globalThis, 'fetch')
  for (const field of ['expires_in', 'refresh_token_expires_in']) {
    fetch.mock.mockImplementation(async () => Response.json({ access_token: accessToken, refresh_token: refreshToken,
      [field]: Number.MAX_SAFE_INTEGER }))
    await assert.rejects(refreshGitHubOAuthToken(client, oldRefresh), safeFailure)
  }
})
