import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test, { after } from 'node:test'
import { configuration, ORIGIN, REF, WORKFLOW, readMcpReply, runMcpReplyProof } from './mcp-reply-production.mjs'

const APP = 'a'.repeat(40), DRIVER = 'b'.repeat(40), OTHER = 'c'.repeat(40)
const OWNER = 'synthetic-smoke-owner', EMAIL = 'synthetic+mikka-smoke@example.invalid', PASSWORD = 'SYNTHETIC_PASSWORD_NOT_A_CREDENTIAL'
const COOKIE = 'SYNTHETIC_PRIVATE_SESSION', CLIENT = 'synthetic_this_run_client', BEFORE = 'synthetic_existing_client'
const TOKEN = 'mka_SYNTHETIC_PRIVATE_ACCESS', HISTORY = 'PRIVATE_HISTORY_SHOULD_NEVER_REACH_A_REPORT_中文'
const nativeFetch = globalThis.fetch
globalThis.fetch = () => { throw new Error('offline_network_forbidden') }
after(() => { globalThis.fetch = nativeFetch })
const env = () => ({ GITHUB_REPOSITORY: 'alexj11324/Mikka', GITHUB_EVENT_NAME: 'push', GITHUB_REF: REF,
  GITHUB_WORKFLOW_REF: `alexj11324/Mikka/${WORKFLOW}@${REF}`, GITHUB_SHA: DRIVER, GITHUB_RUN_ID: '987654321',
  GITHUB_RUN_ATTEMPT: '1', MIKKA_ACCEPTANCE_SHA: APP, SMOKE_OWNER_EMAIL: EMAIL, SMOKE_OWNER_PASSWORD: PASSWORD })
const event = { ref: REF, after: DRIVER, repository: { full_name: 'alexj11324/Mikka' } }
const json = (value, status = 200, headers = {}) => Response.json(value, { status, headers })
const result = (id, value) => ({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(value) }] } })
const reading = (messages = [], last = 27, extra = {}) => ({ messages, last, replied: messages.some(row => row.role === 'assistant'),
  working: false, lastError: null, coordinatorRunning: true, ...extra })
const latest = () => reading([{ position: 27, role: 'assistant', text: HISTORY, toolCalls: ['private_tool_name'], createdAt: '2026-11-06T12:00:00Z' }])

function fixture(options = {}) {
  let signedIn = false, client, registration = 0, deleted = false, revoked = false, authorization
  let wall = Date.parse('2026-11-06T12:00:00Z'), mono = 0, versionReads = 0, calls = 0
  let scheduler, responseCancelled = 0, transportAborted = 0
  const timers = new Map(), requests = [], privateValues = [EMAIL, PASSWORD, COOKIE, CLIENT, BEFORE, TOKEN, HISTORY, 'private_tool_name']
  const advance = milliseconds => { wall += milliseconds; mono += milliseconds }
  const later = (callback, milliseconds) => {
    assert.equal(milliseconds, 5_000)
    const id = Symbol('fixture-timer')
    timers.set(id, callback)
    scheduler = id
    if (!options.earlyCancelReply) queueMicrotask(() => {
      if (timers.has(id)) { advance(milliseconds); timers.delete(id); callback() }
    })
    return id
  }
  const cancelTimer = id => { timers.delete(id) }
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(input), method = init.method ?? 'GET', headers = new Headers(init.headers)
    requests.push({ path: url.pathname, search: url.search, method, body: init.body, signal: init.signal, headers })
    assert.equal(url.origin, ORIGIN)
    assert.equal(init.redirect, 'manual')
    assert.equal(headers.has('host'), false)
    if (url.pathname === '/mikka/api/version') {
      versionReads++
      return json({ build: options.wrongVersion || options.versionDrift && versionReads > 1 ? OTHER : APP })
    }
    if (url.pathname === '/mikka/api/auth/sign-in/email') {
      assert.deepEqual(JSON.parse(init.body), { email: EMAIL, password: PASSWORD })
      assert.equal(headers.get('origin'), ORIGIN)
      signedIn = true
      if (options.lostSignIn) throw new Error('SYNTHETIC_PRIVATE_AUTH_FAILURE')
      return json({ user: { id: OWNER, email: EMAIL }, token: COOKIE }, 200,
        { 'set-cookie': `better-auth.session_token=${COOKIE}; Path=/; Secure; HttpOnly` })
    }
    if (url.pathname === '/mikka/api/auth/get-session') return json(signedIn ? {
      user: { id: options.wrongOwner ? 'another-person' : OWNER, email: EMAIL }, session: {} } : null)
    if (url.pathname === '/mikka/api/auth/sign-out') {
      assert.equal(method, 'POST')
      signedIn = false
      return json({ success: true }, 200, { 'set-cookie': 'better-auth.session_token=; Path=/; Max-Age=0; Secure; HttpOnly' })
    }
    if (url.pathname.startsWith('/mikka/api/auth/oauth2/') && !['token', 'revoke'].includes(url.pathname.split('/').at(-1))) {
      assert.ok(signedIn)
      assert.ok(headers.get('cookie')?.includes('better-auth.session_token=' + COOKIE))
      assert.equal(headers.get('origin'), ORIGIN)
    }
    if (url.pathname.endsWith('/oauth2/get-clients')) {
      const rows = [{ client_id: BEFORE, client_name: 'Existing unrelated client' }, ...(client && !deleted ? [client] : [])]
      if (client && options.ambiguousRegistration) rows.push({ ...client, client_id: 'synthetic_second_matching_client' })
      return json(rows)
    }
    if (url.pathname.endsWith('/oauth2/create-client')) {
      assert.equal(++registration, 1)
      const metadata = JSON.parse(init.body)
      assert.equal(metadata.scope, 'mikka'); assert.deepEqual(metadata.grant_types, ['authorization_code'])
      client = { ...metadata, client_id: CLIENT, user_id: options.foreignClient ? 'another-person' : OWNER }
      privateValues.push(client.client_name)
      if (options.lostRegistration || options.ambiguousRegistration) throw new Error('SYNTHETIC_PRIVATE_REGISTRATION_FAILURE')
      if (options.registration500) return json({ error: 'unavailable' }, 500)
      return json(client, 201)
    }
    if (url.pathname.endsWith('/oauth2/get-client')) {
      assert.equal(url.searchParams.get('client_id'), CLIENT)
      return client && !deleted ? json(client) : json({ error: 'not_found' }, 404)
    }
    if (url.pathname.endsWith('/oauth2/authorize')) {
      authorization = url.searchParams
      assert.equal(authorization.get('client_id'), CLIENT)
      assert.equal(authorization.get('scope'), 'mikka')
      assert.equal(authorization.get('code_challenge_method'), 'S256')
      assert.equal(authorization.get('resource'), ORIGIN + '/mikka/api/mcp')
      privateValues.push(authorization.get('state'), authorization.get('code_challenge'))
      const consent = new URL(ORIGIN + '/mikka/oauth/consent')
      consent.search = authorization.toString()
      return new Response(null, { status: 302, headers: { location: consent.href,
        'set-cookie': 'oauth_state=synthetic_signed_oauth_state; Path=/mikka/api/auth; Secure; HttpOnly' } })
    }
    if (url.pathname.endsWith('/oauth2/consent')) {
      assert.ok(headers.get('cookie')?.includes('oauth_state=synthetic_signed_oauth_state'))
      const body = JSON.parse(init.body), query = new URLSearchParams(body.oauth_query)
      assert.equal(body.accept, true); assert.equal(query.get('state'), authorization.get('state'))
      const callback = new URL(authorization.get('redirect_uri'))
      callback.searchParams.set('state', options.wrongState ? 'wrong-state' : authorization.get('state'))
      callback.searchParams.set('code', 'synthetic-private-code')
      return json({ url: callback.href })
    }
    if (url.pathname.endsWith('/oauth2/token')) {
      assert.equal(headers.has('cookie'), false); assert.equal(headers.has('authorization'), false)
      const body = new URLSearchParams(init.body)
      assert.equal(body.get('client_id'), CLIENT)
      assert.equal(createHash('sha256').update(body.get('code_verifier')).digest('base64url'), authorization.get('code_challenge'))
      privateValues.push(body.get('code'), body.get('code_verifier'))
      return json({ access_token: TOKEN, token_type: 'Bearer', scope: 'mikka',
        ...(options.missingTTL ? {} : { expires_in: options.ttl ?? 3600 }),
        ...(options.refresh ? { refresh_token: 'mkr_SYNTHETIC_UNWANTED_REFRESH' } : {}) })
    }
    if (url.pathname.endsWith('/oauth2/revoke')) {
      assert.equal(headers.has('cookie'), false)
      assert.equal(new URLSearchParams(init.body).get('token'), TOKEN)
      assert.equal(new URLSearchParams(init.body).get('client_id'), CLIENT)
      if (options.revokeUnavailable) throw new Error('SYNTHETIC_PRIVATE_REVOKE_FAILURE')
      revoked = true
      return json({})
    }
    if (url.pathname.endsWith('/oauth2/delete-client')) {
      assert.deepEqual(JSON.parse(init.body), { client_id: CLIENT })
      if (options.deleteUnavailable) throw new Error('SYNTHETIC_PRIVATE_DELETE_FAILURE')
      deleted = true
      return json({})
    }
    assert.equal(url.pathname, '/mikka/api/mcp', 'there is no model, app RPC, Stop, registration fallback or arbitrary URL')
    assert.equal(headers.get('authorization'), 'Bearer ' + TOKEN)
    assert.equal(headers.has('cookie'), false)
    const body = JSON.parse(init.body)
    if (revoked) { assert.equal(body.method, 'tools/list'); return json({ error: 'unauthorized' }, 401) }
    if (body.method === 'initialize') return json({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'mikka', version: '1.0.0' } } })
    if (body.method === 'notifications/initialized') return new Response(null, { status: 202 })
    assert.equal(body.method, 'tools/call')
    assert.equal(body.params.name, 'read_coordinator_messages')
    assert.ok(++calls <= 3)
    if (calls === 1) {
      assert.deepEqual(body.params.arguments, { limit: 1, waitSeconds: 0 })
      return json(result(body.id, options.latest ?? latest()))
    }
    assert.deepEqual(body.params.arguments, { after: 27, limit: 1, waitSeconds: 90 })
    if (calls === 2) {
      advance(options.shortWait ? 20_000 : options.naturalReply ? 700 : 90_000)
      const value = options.naturalReply ? reading([{ position: 28, role: 'assistant', text: HISTORY }], 28) : reading()
      const bytes = new TextEncoder().encode(': keepalive\r\n\r\ndata: ' + JSON.stringify(result(body.id, value)) + '\r\n\r\n')
      const stream = new ReadableStream({ start(controller) {
        for (let at = 0; at < bytes.length; at += 13) controller.enqueue(bytes.slice(at, at + 13))
        controller.close()
      } })
      return new Response(stream, { headers: { 'content-type': 'text/event-stream', 'x-vercel-id': 'iad1::sample-1793966400000-abcdef' } })
    }
    if (options.earlyCancelReply) return json(result(body.id, reading([{ position: 28, role: 'assistant', text: HISTORY }], 28)))
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode(': actual response headers are open\n\n'))
      init.signal.addEventListener('abort', () => {
        transportAborted++
        if (!options.ignoreTransportAbort) controller.error(new DOMException('Synthetic transport cancelled', 'AbortError'))
      }, { once: true })
    }, cancel() { responseCancelled++ } }), { headers: { 'content-type': 'text/event-stream' } })
  }
  return { fetchImpl, requests, now: () => wall, monotonic: () => mono, later, cancelTimer,
    state: () => ({ registration, deleted, revoked, signedIn, calls, timers: timers.size, responseCancelled, transportAborted, scheduler }),
    assertPrivate(report) {
      const text = JSON.stringify(report)
      for (const value of privateValues) assert.equal(text.includes(value), false, 'private source must not be reported')
      assert.equal(text.includes('mkr_SYNTHETIC_UNWANTED_REFRESH'), false)
      assert.equal(report.modelCalls, 0); assert.equal(report.coordinatorWriteCalls, 0)
      assert.equal(report.runtimeEvidence.controlledPersonalReply, 'not_covered')
      assert.equal(report.runtimeEvidence.serverCancelObserved, null)
      assert.equal(report.runtimeEvidence.subscriberCloseObserved, null)
      assert.equal(report.runtimeEvidence.healthyPeriodicReadCount, null)
      assert.equal(report.acceptancePassed, false)
    } }
}
async function run(options = {}, environment = env()) {
  const f = fixture(options)
  const report = await runMcpReplyProof({ env: environment, event, ...f })
  f.assertPrivate(report)
  return { f, report }
}
const used = (f, ending) => f.requests.filter(row => row.path.endsWith(ending))

test('exact workflow/build guard rejects before credentials or network, and wrong deployed version never reads credentials', async () => {
  for (const changes of [{ GITHUB_REF: 'refs/heads/main' }, { MIKKA_ACCEPTANCE_SHA: '' }, { GITHUB_WORKFLOW_REF: 'other' }]) {
    const e = { ...env(), ...changes }
    Object.defineProperty(e, 'SMOKE_OWNER_PASSWORD', { get() { assert.fail('credentials were read') } })
    const { f, report } = await run({}, e)
    assert.equal(report.error, 'configuration_invalid'); assert.equal(f.requests.length, 0)
  }
  const e = env(); Object.defineProperty(e, 'SMOKE_OWNER_EMAIL', { get() { assert.fail('credentials were read') } })
  const { f, report } = await run({ wrongVersion: true }, e)
  assert.equal(report.error, 'version_mismatch'); assert.equal(f.requests.length, 1)
  assert.throws(() => configuration(env(), { ...event, after: OTHER }))
})

test('actual copied PKCE helper, one managed client, three genuine-shaped readonly calls, complete cleanup and pending runtime evidence', async () => {
  const { f, report } = await run()
  assert.equal(report.status, 'observed'); assert.equal(report.error, null)
  assert.equal(report.toolsCalls, 3); assert.equal(report.oauth.observedTokenTTLSeconds, 3600)
  assert.equal(report.oauth.refreshTokenIssued, false); assert.equal(report.oauth.pkceS256, true)
  assert.equal(report.observations.boundedWait.durationMs, 90_000)
  assert.equal(report.observations.boundedWait.transportTimeoutMs, 110_000)
  assert.equal(report.observations.cancel.clientAbortObserved, true)
  assert.equal(report.observations.cancel.boundary, 'http_headers_only_server_readiness_unproven')
  assert.equal(report.cleanup.tokenRevoked, true); assert.equal(report.cleanup.tokenRejected, true)
  assert.equal(report.cleanup.clientAbsent, true); assert.equal(report.cleanup.sessionAbsent, true)
  assert.equal(report.cleanup.originalClientsPreserved, true)
  assert.deepEqual(report.cleanup.failures, []); assert.equal(report.cleanup.unresolvedResources, false)
  assert.equal(f.state().registration, 1); assert.equal(f.state().calls, 3); assert.equal(f.state().timers, 0)
  assert.equal(f.state().transportAborted, 1)
  assert.equal(used(f, '/oauth2/register').length, 0)
})

test('empty/filtered-tail, mismatched last and active personal chat stop after one read without invented cursors', async () => {
  for (const [value, reason] of [[reading([], 0), 'cursor_unavailable'], [latest(), 'cursor_unavailable'],
    [reading([{ position: 27, role: 'user', text: HISTORY }], 27, { working: true }), 'personal_chat_active']]) {
    if (reason === 'cursor_unavailable' && value.messages.length) value.last = 99
    const { f, report } = await run({ latest: value })
    assert.equal(report.status, 'not_covered'); assert.equal(report.error, reason)
    assert.equal(f.state().calls, 1); assert.equal(report.cleanup.clientAbsent, true)
    assert.equal(report.cleanup.sessionAbsent, true); assert.equal(f.state().timers, 0)
  }
})

test('natural activity and an early empty result cannot masquerade as a 90-second healthy idle observation', async () => {
  for (const [options, reason] of [[{ naturalReply: true }, 'natural_activity_observed'], [{ shortWait: true }, 'bounded_wait_unobserved']]) {
    const { f, report } = await run(options)
    assert.equal(report.status, 'not_covered'); assert.equal(report.error, reason)
    assert.equal(f.state().calls, 2); assert.equal(report.observations.cancel, null)
    assert.equal(report.cleanup.clientAbsent, true)
  }
})

test('a reply before the planned HTTP cancel is not a successful cancellation', async () => {
  const { f, report } = await run({ earlyCancelReply: true })
  assert.equal(report.status, 'not_covered'); assert.equal(report.error, 'client_cancel_unobserved')
  assert.equal(report.observations.cancel.abortRequested, false)
  assert.equal(report.observations.cancel.clientAbortObserved, false)
  assert.equal(f.state().timers, 0); assert.equal(report.cleanup.clientAbsent, true)
})

test('client body cancellation is bounded even when the offline transport ignores abort; server cleanup remains unproven', async () => {
  const { f, report } = await run({ ignoreTransportAbort: true })
  assert.equal(report.status, 'observed'); assert.equal(report.observations.cancel.clientAbortObserved, true)
  assert.equal(f.state().responseCancelled, 1); assert.equal(f.state().transportAborted, 1)
  assert.equal(report.runtimeEvidence.status, 'pending_root_correlation')
})

test('lost/500 registration response reconciles only the single owned intent, never repeats registration or sends a token request', async () => {
  for (const options of [{ lostRegistration: true }, { registration500: true }]) {
    const { f, report } = await run(options)
    assert.equal(report.status, 'failed'); assert.equal(report.oauth.registrationAttempts, 1)
    assert.equal(used(f, '/oauth2/create-client').length, 1); assert.equal(used(f, '/oauth2/token').length, 0)
    assert.equal(report.cleanup.clientAbsent, true); assert.equal(report.cleanup.sessionAbsent, true)
    assert.equal(report.toolsCalls, 0)
  }
})

test('ambiguous new intent or foreign ownership refuses authorization and cannot delete an unproven client', async () => {
  for (const options of [{ ambiguousRegistration: true }, { foreignClient: true }]) {
    const { f, report } = await run(options)
    assert.equal(report.status, 'failed'); assert.equal(report.cleanup.unresolvedResources, true)
    assert.equal(used(f, '/oauth2/delete-client').length, 0); assert.equal(used(f, '/oauth2/authorize').length, 0)
    assert.equal(report.cleanup.sessionAbsent, true)
  }
})

test('wrong account/state, refresh grant and excessive or missing TTL all fail closed with the permitted exact cleanup', async () => {
  for (const options of [{ wrongOwner: true }, { wrongState: true }, { refresh: true }, { ttl: 7200 }, { ttl: 0 }, { missingTTL: true }]) {
    const { f, report } = await run(options)
    assert.equal(report.status, 'failed'); assert.equal(report.toolsCalls, 0)
    assert.equal(report.cleanup.sessionAbsent, true)
    if (options.wrongOwner) assert.equal(used(f, '/oauth2/create-client').length, 0)
    else assert.equal(report.cleanup.clientAbsent, true)
    if (options.refresh || options.ttl !== undefined || options.missingTTL) {
      assert.equal(report.cleanup.tokenRevoked, true); assert.equal(report.cleanup.tokenRejected, true)
    }
  }
})

test('revoke failure cannot prevent owned client deletion or sign-out; delete uncertainty and version drift stay failed', async () => {
  for (const options of [{ revokeUnavailable: true }, { deleteUnavailable: true }, { versionDrift: true }]) {
    const { f, report } = await run(options)
    assert.equal(report.status, 'failed'); assert.equal(report.cleanup.sessionAbsent, true)
    assert.equal(used(f, '/oauth2/delete-client').length, 1)
    if (options.deleteUnavailable) assert.equal(report.cleanup.unresolvedResources, true)
    else assert.equal(report.cleanup.clientAbsent, true)
    if (options.versionDrift) assert.equal(report.version.afterMatches, false)
  }
})

test('fragmented multiline SSE decodes only a matching result and drops user history; protocol errors and overlarge payloads reject', async () => {
  const id = 41, frame = result(id, latest())
  const formatted = JSON.stringify(frame, null, 2).split('\n').map(line => 'data: ' + line).join('\n') + '\n\n'
  const bytes = new TextEncoder().encode(': heartbeat\n\n' + formatted)
  const stream = new ReadableStream({ start(controller) {
    for (let at = 0; at < bytes.length; at += 5) controller.enqueue(bytes.slice(at, at + 5))
    controller.close()
  } })
  const value = await readMcpReply(new Response(stream, { headers: { 'content-type': 'text/event-stream' } }), id)
  assert.equal(value.last, 27); assert.equal(JSON.stringify(value).includes(HISTORY), false)
  await assert.rejects(readMcpReply(json({ jsonrpc: '2.0', id, error: { code: -32000, message: HISTORY } }), id))
  await assert.rejects(readMcpReply(json(result(id + 1, latest())), id))
  await assert.rejects(readMcpReply(new Response('x'.repeat(65_537)), id))
})
