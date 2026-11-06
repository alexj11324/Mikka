#!/usr/bin/env node
// Normal ACME OAuth plus at most three read-only MCP calls. No Coordinator
// writes, models, Stop, notification cancellation, fake cursors, or retries.
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { authorizeMcpSession } from './pkce-session.mjs'

export const ORIGIN = 'https://app.aspectlylabs.com'
export const OWNER = 'OFtPbAHifGBAOYiek9hd3w'
export const REF = 'refs/heads/acceptance/issues-1504-1506'
export const WORKFLOW = '.github/workflows/issue-1212-mcp-reply.yml'
const BASE = '/mikka', AUTH = BASE + '/api/auth', MCP = BASE + '/api/mcp'
const CALLBACK = 'http://127.0.0.1:45123/callback', REPOSITORY = 'alexj11324/Mikka'
const SHA = /^[0-9a-f]{40}$/, CLIENT = /^[A-Za-z0-9_-]{1,200}$/
const METHODS = new Set(['initialize', 'notifications/initialized'])
const CODES = new Set(['configuration_invalid', 'version_mismatch', 'credentials_missing', 'identity_mismatch',
  'request_denied', 'request_failed', 'response_invalid', 'oauth_protocol_failed', 'client_ownership',
  'registration_ambiguous', 'intent_collision', 'token_policy', 'mcp_protocol_failed', 'mcp_read_limit',
  'mcp_response_invalid', 'cursor_unavailable', 'personal_chat_active', 'natural_activity_observed',
  'bounded_wait_unobserved', 'client_cancel_unobserved', 'cleanup_failed', 'report_rejected'])
const NOT_COVERED = new Set(['cursor_unavailable', 'personal_chat_active', 'natural_activity_observed',
  'bounded_wait_unobserved', 'client_cancel_unobserved'])
class ProofError extends Error {
  constructor(code) { super(CODES.has(code) ? code : 'oauth_protocol_failed'); this.code = this.message }
}
const need = (condition, code) => { if (!condition) throw new ProofError(code) }
const errorCode = error => error instanceof ProofError ? error.code : 'oauth_protocol_failed'
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const integer = value => Number.isSafeInteger(value) && value >= 0
const positive = value => Number.isSafeInteger(value) && value > 0
const ms = value => Math.max(0, Math.round(value))
const requestId = value => typeof value === 'string' && /^[a-z0-9]+(?:::[a-z0-9]+){1,3}-[0-9]+-[a-z0-9]+$/i.test(value) && value.length <= 180 ? value : null

export function configuration(env, event) {
  need(env.GITHUB_REPOSITORY === REPOSITORY && env.GITHUB_EVENT_NAME === 'push'
    && env.GITHUB_REF === REF && env.GITHUB_WORKFLOW_REF === `${REPOSITORY}/${WORKFLOW}@${REF}`
    && SHA.test(env.GITHUB_SHA ?? '') && SHA.test(env.MIKKA_ACCEPTANCE_SHA ?? '')
    && /^[1-9][0-9]*$/.test(env.GITHUB_RUN_ID ?? '') && /^[1-9][0-9]*$/.test(env.GITHUB_RUN_ATTEMPT ?? '')
    && event?.ref === REF && event?.after === env.GITHUB_SHA
    && event?.repository?.full_name === REPOSITORY, 'configuration_invalid')
  return { applicationSha: env.MIKKA_ACCEPTANCE_SHA, driverRevision: env.GITHUB_SHA,
    runId: env.GITHUB_RUN_ID, runAttempt: env.GITHUB_RUN_ATTEMPT }
}

function ownedClient(row, { clientId, name, before }) {
  need(row && CLIENT.test(row.client_id ?? '') && row.client_id === clientId && !before.has(clientId)
    && row.user_id === OWNER && row.client_name === name && row.token_endpoint_auth_method === 'none'
    && row.application_type === 'native' && same(row.redirect_uris, [CALLBACK])
    && same(row.grant_types, ['authorization_code']) && same(row.response_types, ['code'])
    && row.scope === 'mikka' && row.client_secret === undefined, 'client_ownership')
  return row
}

async function boundedText(response, { signal, limit = 65_536 } = {}) {
  const reader = response.body?.getReader()
  need(reader, 'response_invalid')
  let rejectAbort = () => {}, size = 0
  const chunks = [], aborted = new Promise((_, reject) => { rejectAbort = reject })
  const onAbort = () => {
    rejectAbort(new ProofError('request_failed'))
    void reader.cancel().catch(() => {})
  }
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    if (signal?.aborted) onAbort()
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), aborted])
      if (done) break
      size += value.byteLength
      need(size <= limit, 'response_invalid')
      chunks.push(value)
    }
    if (signal?.aborted) throw new ProofError('request_failed')
    return Buffer.concat(chunks).toString('utf8')
  } catch (error) {
    await reader.cancel().catch(() => {})
    throw error
  } finally {
    signal?.removeEventListener('abort', onAbort)
    reader.releaseLock()
  }
}
async function json(response, options) {
  try { return JSON.parse(await boundedText(response, options)) }
  catch (error) { if (error instanceof ProofError) throw error; throw new ProofError('response_invalid') }
}

export async function readMcpReply(response, id, signal) {
  need(response.ok, 'mcp_protocol_failed')
  const text = await boundedText(response, { signal })
  let messages
  try {
    const type = response.headers.get('content-type')?.split(';')[0]
    if (type === 'application/json') messages = [JSON.parse(text)]
    else {
      need(type === 'text/event-stream', 'mcp_response_invalid')
      messages = text.split(/\r?\n\r?\n/).flatMap(event => {
        const data = event.split(/\r?\n/).filter(line => line.startsWith('data:'))
          .map(line => line.slice(5).replace(/^ /, '')).join('\n')
        return data ? [JSON.parse(data)] : []
      })
    }
  } catch { throw new ProofError('mcp_response_invalid') }
  const matches = messages.filter(value => value?.id === id)
  need(matches.length === 1 && matches[0].jsonrpc === '2.0' && !matches[0].error
    && matches[0].result?.isError !== true, 'mcp_protocol_failed')
  const content = matches[0].result?.content
  need(Array.isArray(content) && content.length === 1 && content[0]?.type === 'text'
    && typeof content[0].text === 'string', 'mcp_response_invalid')
  let value
  try { value = JSON.parse(content[0].text) } catch { throw new ProofError('mcp_response_invalid') }
  need(value && Array.isArray(value.messages) && value.messages.length <= 1 && integer(value.last)
    && typeof value.replied === 'boolean' && typeof value.working === 'boolean'
    && typeof value.coordinatorRunning === 'boolean' && (value.lastError === null || typeof value.lastError === 'string')
    && value.messages.every(row => positive(row?.position) && ['user', 'assistant'].includes(row.role)
      && typeof row.text === 'string'), 'mcp_response_invalid')
  // Drop all history text, tool names and timestamps at the parser boundary.
  return { last: value.last, positions: value.messages.map(row => row.position), count: value.messages.length,
    replied: value.replied, working: value.working, hasLastError: value.lastError !== null,
    coordinatorRunning: value.coordinatorRunning }
}

export async function runMcpReplyProof({ env = process.env, event, fetchImpl = globalThis.fetch,
  now = Date.now, monotonic = () => performance.now(), later = setTimeout, cancelTimer = clearTimeout } = {}) {
  const report = { schemaVersion: 1, issues: [1212, 1506], case: 'acme-mcp-bounded-read', status: 'failed',
    startedAt: new Date(now()).toISOString(), binding: null, phase: 'configuration', error: null,
    version: { beforeMatches: false, afterMatches: false }, identityMatched: false,
    oauth: { registrationMode: 'owner-managed', registrationAttempts: 0, clientOwned: false,
      requestedScope: 'mikka', refreshRequested: false, refreshTokenIssued: null,
      serverDefaultTTLSeconds: 3600, observedTokenTTLSeconds: null, pkceS256: false, browserConsentUI: false },
    toolsCalls: 0, modelCalls: 0, coordinatorWriteCalls: 0, explicitBusinessWrites: 0,
    backendMaintenanceWritesMeasured: false, observations: { latest: null, boundedWait: null, cancel: null },
    runtimeEvidence: { status: 'pending_root_correlation', serverCancelObserved: null,
      subscriberCloseObserved: null, healthyPeriodicReadCount: null, controlledPersonalReply: 'not_covered' },
    acceptancePassed: false, requests: [], cleanup: { tokenRevoked: false, tokenRejected: false,
      clientDeleted: false, clientAbsent: false, originalClientsPreserved: false,
      sessionClosed: false, sessionAbsent: false, unresolvedResources: false, failures: [] } }
  const cookies = responseCookieJar(now), privateValues = new Set(), remember = values => {
    for (const value of values) if (typeof value === 'string' && value.length) privateValues.add(value)
  }
  const close = async response => { await response.body?.cancel().catch(() => {}) }
  const deadline = now() + 240_000
  let binding, clientId, name, token, protocol, before = new Set(), registrationStarted = false
  let registrationSettled = false, signInStarted = false, sessionObserved = false, complete = false
  let versionVerified = false, activeController, timer, serial = 30, evidenceRejected = false
  const oauthCalls = new Set(), helperCalls = new Set()

  async function raw(path, init = {}, { cookie = false, cleanup = false, redirects = false, timeoutMs = 20_000 } = {}) {
    const url = new URL(path, ORIGIN), headers = new Headers(init.headers)
    need(url.origin === ORIGIN && !url.username && !url.password && !url.hash && url.pathname.startsWith(BASE + '/')
      && !headers.has('cookie') && !headers.has('host') && (cleanup || now() < deadline), 'request_denied')
    if (cookie) {
      need(!headers.has('authorization'), 'request_denied')
      const value = cookies.header(url)
      if (value) { headers.set('cookie', value); remember([value]) }
      headers.set('origin', ORIGIN)
    }
    headers.set('cache-control', 'no-store')
    const timeout = AbortSignal.timeout(Math.max(1, Math.min(timeoutMs, cleanup ? 20_000 : deadline - now())))
    const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout
    const began = monotonic()
    let response
    try { response = await fetchImpl(url.href, { ...init, headers, redirect: 'manual', cache: 'no-store', signal }) }
    catch { throw new ProofError('request_failed') }
    need(!response.redirected && (!response.url || response.url === url.href), 'response_invalid')
    if (cookie) { cookies.receive(url, response.headers); remember(response.headers.getSetCookie()) }
    report.requests.push({ phase: report.phase, path: url.pathname, method: init.method ?? 'GET',
      status: response.status, headersMs: ms(monotonic() - began), requestId: requestId(response.headers.get('x-vercel-id')) })
    if (!redirects) need(response.status < 300 || response.status >= 400, 'response_invalid')
    return response
  }
  const ownPost = (path, body, cleanup = false) => raw(path, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, { cookie: true, cleanup })
  async function ownRead(path, cleanup = false) {
    const response = await raw(path, {}, { cookie: true, cleanup })
    return { status: response.status, value: await json(response) }
  }
  async function clients(cleanup = false) {
    const { status, value } = await ownRead(AUTH + '/oauth2/get-clients', cleanup)
    need(status === 200 && (value === null || Array.isArray(value))
      && (value ?? []).every(row => CLIENT.test(row?.client_id ?? '')), 'response_invalid')
    return value ?? []
  }
  async function owned(cleanup = false) {
    const { status, value } = await ownRead(AUTH + '/oauth2/get-client?client_id=' + encodeURIComponent(clientId), cleanup)
    need(status === 200, 'client_ownership')
    return ownedClient(value, { clientId, name, before })
  }
  async function version(cleanup = false) {
    const response = await raw(BASE + '/api/version', {}, { cleanup })
    const value = await json(response)
    need(response.status === 200 && value?.build === binding.applicationSha, 'version_mismatch')
  }
  async function read(args, phase, controller) {
    need(report.toolsCalls < 3 && Object.keys(args).every(key => ['after', 'limit', 'waitSeconds'].includes(key))
      && args.limit === 1 && [0, 90].includes(args.waitSeconds)
      && (args.after === undefined || integer(args.after)), 'mcp_read_limit')
    report.toolsCalls++
    const id = ++serial, began = monotonic()
    const response = await raw(MCP, { method: 'POST', signal: controller?.signal,
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json',
        accept: 'application/json, text/event-stream', 'mcp-protocol-version': protocol },
      body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call',
        params: { name: 'read_coordinator_messages', arguments: args } }) }, { timeoutMs: args.waitSeconds ? 110_000 : 20_000 })
    const observed = { requestedWaitSeconds: args.waitSeconds, transportTimeoutMs: args.waitSeconds ? 110_000 : 20_000,
      headersMs: ms(monotonic() - began), requestId: requestId(response.headers.get('x-vercel-id')) }
    report.observations[phase] = observed
    if (phase === 'cancel') {
      Object.assign(observed, { plannedAbortAfterHeadersMs: 5_000, abortRequested: false,
        clientAbortObserved: false, boundary: 'http_headers_only_server_readiness_unproven' })
      timer = later(() => {
        observed.abortRequested = true; observed.abortRequestedMs = ms(monotonic() - began)
        controller.abort()
      }, 5_000)
    }
    try {
      const value = await readMcpReply(response, id, controller?.signal)
      Object.assign(observed, { durationMs: ms(monotonic() - began), ...value })
      return value
    } catch (error) {
      observed.durationMs = ms(monotonic() - began)
      if (phase === 'cancel' && controller.signal.aborted) {
        observed.clientAbortObserved = true
        observed.abortToClientSettledMs = ms(observed.durationMs - observed.abortRequestedMs)
        return null
      }
      throw error
    } finally { if (timer !== undefined) { cancelTimer(timer); timer = undefined } }
  }

  try {
    binding = configuration(env, event); report.binding = binding
    report.phase = 'version-before'; await version(); versionVerified = true; report.version.beforeMatches = true
    const email = env.ACME_DEMO_EMAIL, password = env.ACME_DEMO_PASSWORD
    need(/^[^@\s]+@[^@\s]+$/.test(email ?? '') && typeof password === 'string' && password.length > 0, 'credentials_missing')
    remember([email, password]); name = 'Mikka issue1212 MCP readonly ' + randomUUID(); remember([name])
    report.phase = 'sign-in'; signInStarted = true
    const response = await ownPost(AUTH + '/sign-in/email', { email, password })
    const signed = await json(response); remember([signed?.token])
    need(response.status === 200, 'identity_mismatch')
    const session = await ownRead(AUTH + '/get-session')
    need(session.status === 200 && session.value?.user?.id === OWNER
      && session.value.user.email?.toLowerCase() === email.toLowerCase(), 'identity_mismatch')
    sessionObserved = true; report.identityMatched = true
    report.phase = 'oauth-register'
    const original = await clients()
    before = new Set(original.map(row => row.client_id)); remember([...before])
    need(!original.some(row => row.client_name === name), 'intent_collision')
    const owner = { userId: OWNER, async request(path, init = {}) {
      need(typeof path === 'string' && path.startsWith('/api/auth/oauth2/'), 'request_denied')
      const url = new URL(BASE + path, ORIGIN), method = init.method ?? 'GET'
      if (url.pathname === AUTH + '/oauth2/create-client') {
        need(!url.search && method === 'POST' && !registrationStarted, 'request_denied')
        const body = JSON.parse(init.body)
        need(body.token_endpoint_auth_method === 'none' && body.application_type === 'native' && body.scope === 'mikka'
          && same(body.grant_types, ['authorization_code']) && same(body.response_types, ['code'])
          && same(body.redirect_uris, [CALLBACK]), 'request_denied')
        registrationStarted = true; report.oauth.registrationAttempts++
        const result = await ownPost(url.pathname, { ...body, client_name: name })
        const value = await json(result.clone())
        if (result.status !== 201) return result
        need(CLIENT.test(value?.client_id ?? ''), 'registration_ambiguous')
        clientId = value.client_id; remember([clientId])
        ownedClient(value, { clientId, name, before }); await owned()
        registrationSettled = true; report.oauth.clientOwned = true
        return result
      }
      if (url.pathname === AUTH + '/oauth2/authorize') {
        report.phase = 'oauth-authorize'
        need(method === 'GET' && !init.body && clientId && url.searchParams.get('client_id') === clientId
          && url.searchParams.get('scope') === 'mikka' && url.searchParams.get('response_type') === 'code'
          && url.searchParams.get('redirect_uri') === CALLBACK && url.searchParams.get('code_challenge_method') === 'S256'
          && url.searchParams.get('resource') === ORIGIN + MCP && !oauthCalls.has('authorize'), 'request_denied')
        oauthCalls.add('authorize'); remember([url.searchParams.get('state'), url.searchParams.get('code_challenge')])
        return raw(url.href, init, { cookie: true, redirects: true })
      }
      if (url.pathname === AUTH + '/oauth2/consent') {
        report.phase = 'oauth-consent'
        const body = JSON.parse(init.body), query = new URLSearchParams(body.oauth_query)
        need(!url.search && method === 'POST' && body.accept === true && typeof body.oauth_query === 'string'
          && !oauthCalls.has('consent') && query.get('client_id') === clientId && query.get('scope') === 'mikka'
          && query.get('redirect_uri') === CALLBACK, 'request_denied')
        oauthCalls.add('consent'); remember([body.oauth_query])
        return raw(url.href, init, { cookie: true })
      }
      throw new ProofError('request_denied')
    } }
    const helperFetch = async (input, init = {}) => {
      const url = new URL(input), headers = new Headers(init.headers)
      need(url.origin === ORIGIN && !url.search && !url.hash && !headers.has('cookie')
        && !headers.has('host') && init.method === 'POST', 'request_denied')
      if (url.pathname === AUTH + '/oauth2/token') {
        report.phase = 'oauth-token'
        const body = new URLSearchParams(init.body)
        need(!oauthCalls.has('token') && !headers.has('authorization') && body.get('grant_type') === 'authorization_code'
          && body.get('client_id') === clientId && body.get('redirect_uri') === CALLBACK
          && body.get('resource') === ORIGIN + MCP && body.get('code_verifier') && body.get('code'), 'request_denied')
        oauthCalls.add('token'); remember([body.get('code_verifier'), body.get('code')])
        const result = await raw(url.href, init), value = await json(result.clone())
        if (typeof value?.access_token === 'string') { token = value.access_token; remember([token]) }
        remember([value?.refresh_token])
        report.oauth.refreshTokenIssued = typeof value?.refresh_token === 'string'
        report.oauth.observedTokenTTLSeconds = positive(value?.expires_in) ? value.expires_in : null
        need(result.status === 200 && token?.startsWith('mka_') && value.scope === 'mikka'
          && value.refresh_token === undefined && String(value.token_type).toLowerCase() === 'bearer'
          && positive(value.expires_in) && value.expires_in <= 3600, 'token_policy')
        return result
      }
      report.phase = 'mcp-initialize'
      need(url.pathname === MCP && token && headers.get('authorization') === 'Bearer ' + token, 'request_denied')
      const body = JSON.parse(init.body)
      need(METHODS.has(body.method) && !helperCalls.has(body.method) && body.jsonrpc === '2.0', 'request_denied')
      helperCalls.add(body.method)
      if (body.method === 'notifications/initialized') {
        protocol = headers.get('mcp-protocol-version')
        need(protocol === '2025-06-18' && !headers.has('mcp-session-id'), 'mcp_protocol_failed')
      }
      return raw(url.href, init)
    }
    const mcp = await authorizeMcpSession(owner, { origin: ORIGIN, basePath: BASE }, async values => remember(values),
      { fetchImpl: helperFetch, registrationPath: '/api/auth/oauth2/create-client' })
    need(mcp.clientId === clientId && protocol && oauthCalls.has('consent'), 'oauth_protocol_failed')
    report.oauth.pkceS256 = true
    report.phase = 'latest'
    const latest = await read({ limit: 1, waitSeconds: 0 }, 'latest')
    need(!latest.working, 'personal_chat_active')
    need(latest.count === 1 && positive(latest.last) && latest.last === latest.positions[0], 'cursor_unavailable')
    const cursor = latest.last
    report.phase = 'bounded-wait'
    const waited = await read({ after: cursor, limit: 1, waitSeconds: 90 }, 'boundedWait')
    need(waited.count === 0 && waited.last === cursor && !waited.replied && !waited.working, 'natural_activity_observed')
    need(report.observations.boundedWait.durationMs >= 89_000 && report.observations.boundedWait.durationMs <= 110_000, 'bounded_wait_unobserved')
    report.phase = 'cancel-own-http'
    activeController = new AbortController()
    const cancelled = await read({ after: cursor, limit: 1, waitSeconds: 90 }, 'cancel', activeController)
    need(cancelled === null && report.observations.cancel.clientAbortObserved === true, 'client_cancel_unobserved')
    complete = true
  } catch (error) {
    report.error = errorCode(error)
    report.status = NOT_COVERED.has(report.error) ? 'not_covered' : 'failed'
  } finally {
    activeController?.abort(); if (timer !== undefined) cancelTimer(timer)
    const failed = code => { report.cleanup.failures.push(code) }
    if (sessionObserved && registrationStarted) {
      report.phase = 'oauth-cleanup'
      try {
        if (!clientId && !registrationSettled) {
          const matches = (await clients(true)).filter(row => row.client_name === name && !before.has(row.client_id))
          need(matches.length <= 1, 'registration_ambiguous')
          if (matches.length === 1) { clientId = matches[0].client_id; remember([clientId]); ownedClient(matches[0], { clientId, name, before }) }
          else registrationSettled = true
        }
        if (clientId) {
          await owned(true)
          if (token) {
            try {
              const revoked = await raw(AUTH + '/oauth2/revoke', { method: 'POST',
                headers: { 'content-type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({ token, client_id: clientId, token_type_hint: 'access_token' }) }, { cleanup: true })
              report.cleanup.tokenRevoked = revoked.status === 200; await close(revoked)
              if (!report.cleanup.tokenRevoked) failed('token_revoke')
              const rejected = await raw(MCP, { method: 'POST', headers: { authorization: 'Bearer ' + token,
                'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' },
                body: JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'tools/list', params: {} }) }, { cleanup: true })
              report.cleanup.tokenRejected = rejected.status === 401; await close(rejected)
              if (!report.cleanup.tokenRejected) failed('token_still_accepted')
            } catch { failed('token_cleanup_unproven') }
          }
          try {
            const deleted = await ownPost(AUTH + '/oauth2/delete-client', { client_id: clientId }, true)
            report.cleanup.clientDeleted = [200, 204].includes(deleted.status); await close(deleted)
            if (!report.cleanup.clientDeleted) failed('client_delete')
          } catch { failed('client_delete_response') }
          const absent = await ownRead(AUTH + '/oauth2/get-client?client_id=' + encodeURIComponent(clientId), true)
          report.cleanup.clientAbsent = absent.status === 404 && absent.value?.error === 'not_found'
          if (!report.cleanup.clientAbsent) failed('client_remains')
          const remaining = await clients(true)
          report.cleanup.originalClientsPreserved = remaining.length === before.size && remaining.every(row => before.has(row.client_id))
          if (!report.cleanup.originalClientsPreserved) failed('original_clients_changed')
        }
      } catch { failed('oauth_cleanup_unproven') }
    }
    if (signInStarted) {
      report.phase = 'session-cleanup'
      try {
        const signedOut = await ownPost(AUTH + '/sign-out', {}, true)
        report.cleanup.sessionClosed = signedOut.status === 200; await close(signedOut)
        const absent = await ownRead(AUTH + '/get-session', true)
        report.cleanup.sessionAbsent = absent.status === 200 && absent.value === null
        if (!report.cleanup.sessionClosed || !report.cleanup.sessionAbsent || !sessionObserved) failed('session_cleanup_unproven')
      } catch { failed('session_cleanup_unproven') }
    }
    report.cleanup.unresolvedResources = Boolean(registrationStarted && (clientId ? !report.cleanup.clientAbsent : !registrationSettled)
      || signInStarted && (!report.cleanup.sessionClosed || !report.cleanup.sessionAbsent || !sessionObserved))
    if (versionVerified) {
      report.phase = 'version-after'
      try { await version(true); report.version.afterMatches = true }
      catch { report.error ??= 'version_mismatch'; report.status = 'failed' }
    }
    if (report.cleanup.failures.length || report.cleanup.unresolvedResources) { report.error ??= 'cleanup_failed'; report.status = 'failed' }
    if (complete && !report.error && report.version.afterMatches && !report.cleanup.failures.length && !report.cleanup.unresolvedResources) report.status = 'observed'
    report.phase = 'complete'; report.finishedAt = new Date(now()).toISOString()
    // Every report value is fixed metadata, a number or a closed-set status.
    const serialized = JSON.stringify(report)
    evidenceRejected = [...privateValues].some(value => value.length >= 8 && serialized.includes(value))
    token = clientId = name = undefined; cookies.clear(); privateValues.clear()
  }
  if (evidenceRejected) return { schemaVersion: 1, case: 'acme-mcp-bounded-read', status: 'failed', error: 'report_rejected',
    toolsCalls: report.toolsCalls, modelCalls: 0, coordinatorWriteCalls: 0, acceptancePassed: false,
    runtimeEvidence: report.runtimeEvidence, cleanup: report.cleanup }
  return report
}

// Exact cookie-jar logic reused from scripts/acceptance/read-cache-production.mjs.
export function responseCookieJar(now) {
  const cookies = new Map()
  const domainMatches = (host, domain) => host === domain || host.endsWith(`.${domain}`)
  return {
    receive(url, headers) {
      for (const header of headers.getSetCookie()) {
        const parts = header.split(';').map(value => value.trim()), separator = parts[0].indexOf('=')
        if (separator < 1) continue
        const name = parts[0].slice(0, separator), value = parts[0].slice(separator + 1)
        if (!/^[!#$%&'*+\-.^_\x60|~0-9A-Za-z]+$/.test(name)) continue
        const attributes = Object.fromEntries(parts.slice(1).map(part => {
          const at = part.indexOf('=')
          return at < 0 ? [part.toLowerCase(), true] : [part.slice(0, at).toLowerCase(), part.slice(at + 1)]
        }))
        const domain = typeof attributes.domain === 'string' ? attributes.domain.replace(/^\./, '').toLowerCase() : url.hostname
        if (!domain || !domainMatches(url.hostname, domain)) continue
        const defaultPath = url.pathname.slice(0, url.pathname.lastIndexOf('/')) || '/'
        const path = typeof attributes.path === 'string' && attributes.path.startsWith('/') ? attributes.path : defaultPath
        const maxAge = /^-?\d+$/.test(attributes['max-age'] ?? '') ? Number(attributes['max-age']) : NaN
        const expires = Number.isFinite(maxAge) ? now() + maxAge * 1000 : Date.parse(attributes.expires)
        const key = JSON.stringify([name, domain, path])
        if (expires <= now()) cookies.delete(key)
        else cookies.set(key, { name, value, domain, path, expires, secure: Boolean(attributes.secure) })
      }
    },
    header(url) {
      for (const [key, cookie] of cookies) if (cookie.expires <= now()) cookies.delete(key)
      return [...cookies.values()].filter(cookie => domainMatches(url.hostname, cookie.domain)
        && (!cookie.secure || url.protocol === 'https:')
        && (url.pathname === cookie.path || url.pathname.startsWith(cookie.path.endsWith('/') ? cookie.path : `${cookie.path}/`)))
        .sort((a, b) => b.path.length - a.path.length).map(cookie => `${cookie.name}=${cookie.value}`).join('; ')
    },
    clear() { cookies.clear() },
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let report
  try {
    const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'))
    if (process.argv[2] === '--check-config') {
      configuration(process.env, event)
      console.log(JSON.stringify({ configurationValid: true, productionRequests: 0 }))
    } else {
      need(process.argv[2] === 'observe', 'configuration_invalid')
      report = await runMcpReplyProof({ event })
      await mkdir('issue-1212-mcp-report', { recursive: true, mode: 0o700 })
      await writeFile('issue-1212-mcp-report/mcp-reply.json', JSON.stringify(report, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
      console.log(JSON.stringify(report))
      if (report.status !== 'observed') process.exitCode = report.status === 'not_covered' ? 2 : 1
    }
  } catch {
    console.log(JSON.stringify({ schemaVersion: 1, case: 'acme-mcp-bounded-read', status: 'failed', error: 'configuration_invalid' }))
    process.exitCode = 1
  }
}
