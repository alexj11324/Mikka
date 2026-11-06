#!/usr/bin/env node
/** One normal-owner OAuth/MCP catalogue probe. No SQL, client credentials grant,
 * refresh grant, tools/call, model request, browser impersonation, or retries. */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { isSmokeAccountEmail } from '../../lib/smoke-account.ts'
import { responseCookieJar } from './read-cache-production.mjs'
import { assertCurrentMain, waitForWebDeployment } from '../release/web-deploy.mjs'
import { authorizeMcpSession } from '../../tests/support/mcp-closeout-session.mjs'
import { DeployedTargetError, deployedTargetGuard, assertDeployedTarget, publicTargetFailure } from './deployed-target.mjs'

export const ORIGIN = 'https://app.aspectlylabs.com'
export const OPS_REF = 'refs/heads/ops/issue1415-production-functional'
const BASE = '/mikka', AUTH = BASE + '/api/auth', MCP = BASE + '/api/mcp'
const CALLBACK = 'http://127.0.0.1:45123/callback'
const REPOSITORY = 'alexj11324/Mikka', SHA = /^[a-f0-9]{40}$/
const clientIdValid = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(value)
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const codes = new Set(['trigger_rejected', 'application_binding', 'account_required', 'request_denied',
  'request_failed', 'response_invalid', 'session_identity', 'client_intent_collision',
  'client_ownership', 'registration_ambiguous', 'token_policy', 'catalogue_invalid',
  'protocol_failed', 'cleanup_failed', 'evidence_rejected'])
class ProbeError extends Error {
  constructor(code) { super(codes.has(code) ? code : 'protocol_failed'); this.code = this.message }
}
const need = (condition, code) => { if (!condition) throw new ProbeError(code) }

export function productionMcpGuard(env, event) {
  if (env.MIKKA_ACCEPTANCE_TARGET_MODE === 'deployed-target') {
    const binding = deployedTargetGuard(env, event)
    return { ...binding, sourceRevision: binding.driverRevision }
  }
  const applicationSha = env.APPLICATION_SHA
  need(env.GITHUB_REPOSITORY === REPOSITORY && env.GITHUB_EVENT_NAME === 'push'
    && env.GITHUB_REF === OPS_REF && event?.ref === OPS_REF
    && event?.repository?.full_name === REPOSITORY && event?.after === env.GITHUB_SHA
    && SHA.test(env.GITHUB_SHA ?? '') && SHA.test(applicationSha ?? ''), 'trigger_rejected')
  return { applicationSha, sourceRevision: env.GITHUB_SHA }
}

export function assertOwnedClient(row, { clientId, ownerId, name, baselineIds }) {
  need(row && clientIdValid(row.client_id) && row.client_id === clientId
    && !baselineIds.has(clientId) && row.user_id === ownerId && row.client_name === name
    && row.token_endpoint_auth_method === 'none' && row.application_type === 'native'
    && same(row.redirect_uris, [CALLBACK]) && same(row.grant_types, ['authorization_code'])
    && same(row.response_types, ['code']) && row.client_secret === undefined, 'client_ownership')
  need(row.scope === 'mikka', 'client_ownership')
  return row
}

async function json(response, limit = 65_536) {
  const reader = response.body?.getReader()
  if (!reader) throw new ProbeError('response_invalid')
  let size = 0
  const chunks = []
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      need(size <= limit, 'response_invalid')
      chunks.push(value)
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    await reader.cancel().catch(() => {})
    throw new ProbeError('response_invalid')
  } finally { reader.releaseLock() }
}

export async function runProductionMcpProof({
  env = process.env, event, attestation, fetchImpl = fetch, now = Date.now,
} = {}) {
  const report = { version: 1, purpose: 'production-oauth-mcp', status: 'failed',
    startedAt: new Date(now()).toISOString(), checks: [], cleanup: {
      tokenRevoked: false, tokenRejected: false, clientDeleted: false, clientAbsent: false,
      normalSessionClosed: false, sessionAbsent: false, unresolvedResources: false,
    }, registrationAttempts: 0, toolsInvoked: 0, modelCalls: 0, sqlUsed: false,
    registrationMode: 'owner-managed', requestedScopes: ['mikka'], refreshRequested: false, browserConsentUI: false,
    loopbackCallbackObserved: false }
  const secretValues = new Set(), remember = values => {
    for (const value of values) if (typeof value === 'string' && value.length > 0) secretValues.add(value)
  }
  const cookies = responseCookieJar(now)
  const deadline = now() + 180_000
  const cleanupErrors = []
  let ownerId, clientId, token, registrationStarted = false, registrationSettled = false
  let signInStarted = false, sessionObserved = false, completed = false
  let baselineIds = new Set(), name, binding, targetProof = attestation, initialTargetVerified = false
  const clientRequest = new Set()
  const methods = new Set()
  const record = (name, details = {}) => report.checks.push({ name, passed: true, ...details })
  const close = async response => { await response.body?.cancel() }
  const raw = async (path, init = {}, { cookie = false, cleanup = false, redirect = false } = {}) => {
    const url = new URL(path, ORIGIN), headers = new Headers(init.headers)
    need(url.origin === ORIGIN && !url.username && !url.password && !url.hash
      && !headers.has('cookie') && !headers.has('host'), 'request_denied')
    need(cleanup || now() < deadline, 'request_failed')
    if (cookie) {
      need(!headers.has('authorization'), 'request_denied')
      const value = cookies.header(url)
      if (value) { headers.set('cookie', value); remember([value]) }
      headers.set('origin', ORIGIN)
    }
    headers.set('cache-control', 'no-store')
    let response
    try {
      response = await fetchImpl(url, { ...init, headers, redirect: 'manual', cache: 'no-store',
        signal: AbortSignal.timeout(cleanup ? 20_000 : Math.max(1, Math.min(20_000, deadline - now()))) })
    } catch { throw new ProbeError('request_failed') }
    need(!response.redirected && (!response.url || response.url === url.href), 'response_invalid')
    if (cookie) { cookies.receive(url, response.headers); remember(response.headers.getSetCookie()) }
    if (!redirect) need(response.status < 300 || response.status >= 400, 'response_invalid')
    return response
  }
  const ownerRead = async (path, cleanup = false) => {
    const response = await raw(path, {}, { cookie: true, cleanup })
    const value = await json(response)
    return { status: response.status, value }
  }
  const ownPost = (path, body, cleanup = false) => raw(path, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }, { cookie: true, cleanup })
  const readClients = async cleanup => {
    const { status, value } = await ownerRead(AUTH + '/oauth2/get-clients', cleanup)
    need(status === 200 && (value === null || Array.isArray(value)), 'response_invalid')
    const rows = value ?? []
    need(rows.every(row => row && typeof row.client_id === 'string'), 'response_invalid')
    return rows
  }
  const readOwned = async (id, cleanup = false) => {
    const { status, value } = await ownerRead(AUTH + '/oauth2/get-client?client_id=' + encodeURIComponent(id), cleanup)
    need(status === 200, 'client_ownership')
    return assertOwnedClient(value, { clientId: id, ownerId, name, baselineIds })
  }
  const assertBinding = async () => {
    if (binding.targetMode === 'deployed-target') {
      const proof = await assertDeployedTarget({ env, event, attestation: targetProof, fetchImpl, now })
      targetProof = proof
      Object.assign(report, { targetMode: proof.targetMode, applicationSha: proof.applicationSha,
        driverRevision: proof.driverRevision, driverRunId: proof.driverRunId, driverRunAttempt: proof.driverRunAttempt,
        webDeployRunId: proof.webDeployRunId, webAttempt: proof.webAttempt, webDeployJobId: proof.webDeployJobId,
        deploymentId: proof.deploymentId })
      return
    }
    try {
      await assertCurrentMain({ expectedBuild: binding.applicationSha, token: env.GH_TOKEN,
        fetchImpl, timeoutMs: 20_000 })
      const response = await raw(BASE + '/api/version')
      const value = await json(response)
      need(response.status === 200 && value?.build === binding.applicationSha, 'application_binding')
    } catch { throw new ProbeError('application_binding') }
  }
  try {
    binding = productionMcpGuard(env, event)
    Object.assign(report, { applicationSha: binding.applicationSha, sourceRevision: binding.sourceRevision })
    need(typeof env.GH_TOKEN === 'string' && env.GH_TOKEN.length > 0, 'application_binding')
    remember([env.GH_TOKEN])
    if (binding.targetMode === 'deployed-target') {
      remember([env.VERCEL_TEAM_TOKEN])
      await assertBinding()
      initialTargetVerified = true
      report.deployment = { webRunId: targetProof.webDeployRunId, webAttempt: targetProof.webAttempt,
        exactApplication: targetProof.applicationSha === binding.applicationSha, deploymentId: targetProof.deploymentId }
    } else {
      let deployment
      try {
        deployment = await waitForWebDeployment({ expectedBuild: binding.applicationSha, token: env.GH_TOKEN,
          fetchImpl, maxWaitMs: 30_000, intervalMs: 1000 })
      } catch { throw new ProbeError('application_binding') }
      report.deployment = { webRunId: deployment.webRunId, webAttempt: deployment.webAttempt,
        exactApplication: deployment.sourceCommit === binding.applicationSha && deployment.publicBuild === binding.applicationSha }
    }
    need(report.deployment.exactApplication, 'application_binding')
    const email = env.SMOKE_OWNER_EMAIL, password = env.SMOKE_OWNER_PASSWORD
    need(isSmokeAccountEmail(email) && typeof password === 'string' && password.length > 0, 'account_required')
    remember([email, password])
    name = 'Mikka issue1415 MCP proof ' + randomUUID()
    remember([name])
    signInStarted = true
    const signedIn = await ownPost(AUTH + '/sign-in/email', { email, password })
    const signed = await json(signedIn)
    remember([signed?.token, signed?.user?.id, signed?.user?.email])
    need(signedIn.status === 200, 'session_identity')
    const session = await ownerRead(AUTH + '/get-session')
    ownerId = session.value?.user?.id
    need(session.status === 200 && typeof ownerId === 'string' && ownerId.length > 0
      && session.value.user.email?.toLowerCase() === email.toLowerCase(), 'session_identity')
    remember([ownerId])
    sessionObserved = true
    record('normal-owner-session')
    baselineIds = new Set((await readClients(false)).map(row => row.client_id))
    remember([...baselineIds])
    await assertBinding()

    const owner = { userId: ownerId, async request(path, init = {}) {
      need(typeof path === 'string' && path.startsWith('/api/auth/oauth2/'), 'request_denied')
      const url = new URL(BASE + path, ORIGIN), method = init.method ?? 'GET'
      if (url.pathname === AUTH + '/oauth2/create-client') {
        need(!url.search && method === 'POST' && !registrationStarted, 'request_denied')
        const metadata = JSON.parse(init.body)
        need(metadata.token_endpoint_auth_method === 'none' && metadata.application_type === 'native'
          && metadata.scope === 'mikka' && same(metadata.grant_types, ['authorization_code'])
          && same(metadata.response_types, ['code']) && same(metadata.redirect_uris, [CALLBACK]), 'request_denied')
        registrationStarted = true; report.registrationAttempts++
        const response = await ownPost(url.pathname, { ...metadata, client_name: name })
        const value = await json(response.clone())
        if (response.status !== 201) return response
        need(clientIdValid(value?.client_id), 'registration_ambiguous')
        clientId = value.client_id; remember([clientId])
        assertOwnedClient(value, { clientId, ownerId, name, baselineIds })
        await readOwned(clientId)
        registrationSettled = true
        report.registrationStatus = response.status
        record('owned-public-client')
        return response
      }
      if (url.pathname === AUTH + '/oauth2/authorize') {
        need(method === 'GET' && !init.body && clientId && url.searchParams.get('client_id') === clientId
          && url.searchParams.get('response_type') === 'code' && url.searchParams.get('scope') === 'mikka'
          && url.searchParams.get('redirect_uri') === CALLBACK && url.searchParams.get('code_challenge_method') === 'S256'
          && url.searchParams.get('resource') === ORIGIN + MCP, 'request_denied')
        remember([url.searchParams.get('state'), url.searchParams.get('code_challenge')])
        need(!clientRequest.has('authorize'), 'request_denied'); clientRequest.add('authorize')
        return raw(url.href, init, { cookie: true, redirect: true })
      }
      if (url.pathname === AUTH + '/oauth2/consent') {
        const body = JSON.parse(init.body)
        need(!url.search && method === 'POST' && body.accept === true
          && typeof body.oauth_query === 'string' && !clientRequest.has('consent'), 'request_denied')
        const query = new URLSearchParams(body.oauth_query)
        need(query.get('client_id') === clientId && query.get('scope') === 'mikka'
          && query.get('redirect_uri') === CALLBACK, 'request_denied')
        remember([body.oauth_query]); clientRequest.add('consent')
        return raw(url.href, init, { cookie: true })
      }
      throw new ProbeError('request_denied')
    } }
    const helperFetch = async (input, init = {}) => {
      const url = new URL(input), headers = new Headers(init.headers)
      need(url.origin === ORIGIN && !url.search && !url.hash && !headers.has('cookie')
        && !headers.has('host') && init.method === 'POST', 'request_denied')
      if (url.pathname === AUTH + '/oauth2/token') {
        const body = new URLSearchParams(init.body)
        need(!clientRequest.has('token') && !headers.has('authorization') && body.get('grant_type') === 'authorization_code'
          && body.get('client_id') === clientId && body.get('redirect_uri') === CALLBACK
          && body.get('resource') === ORIGIN + MCP && body.get('code_verifier') && body.get('code'), 'request_denied')
        clientRequest.add('token'); remember([body.get('code_verifier'), body.get('code')])
        const response = await raw(url.href, init)
        const value = await json(response.clone())
        if (typeof value?.access_token === 'string') { token = value.access_token; remember([token]) }
        need(response.status === 200 && token?.startsWith('mka_') && value.scope === 'mikka'
          && value.refresh_token === undefined && String(value.token_type).toLowerCase() === 'bearer', 'token_policy')
        report.accessScope = 'mikka'; report.refreshTokenIssued = false
        return response
      }
      need(url.pathname === MCP && token && headers.get('authorization') === 'Bearer ' + token, 'request_denied')
      const body = JSON.parse(init.body)
      need(['initialize', 'notifications/initialized', 'tools/list'].includes(body.method)
        && !methods.has(body.method) && body.jsonrpc === '2.0', 'request_denied')
      methods.add(body.method)
      return raw(url.href, init)
    }
    const mcp = await authorizeMcpSession(owner, { origin: ORIGIN, basePath: BASE }, async values => remember(values),
      { fetchImpl: helperFetch, registrationPath: '/api/auth/oauth2/create-client' })
    need(mcp.clientId === clientId && token && clientRequest.has('consent'), 'protocol_failed')
    report.loopbackCallbackObserved = true
    record('normal-pkce-s256-consent')
    record('mcp-initialize')
    const catalogue = await mcp.rpc('tools/list')
    need(Array.isArray(catalogue?.tools) && catalogue.tools.length > 0
      && catalogue.tools.some(tool => tool.name === 'list_issues')
      && catalogue.tools.every(tool => typeof tool.name === 'string' && tool.inputSchema?.type === 'object'), 'catalogue_invalid')
    record('mcp-tools-list', { toolCount: catalogue.tools.length })
    await assertBinding()
    completed = true
  } catch (error) {
    if (error instanceof DeployedTargetError) report.targetFailure = publicTargetFailure(error)
    report.failureCode = error instanceof ProbeError || error instanceof DeployedTargetError ? error.code : 'protocol_failed'
  } finally {
    // Cleanup remains authorized if main advances: only the exact newly owned
    // client/token and this run's session are removed. Never repeat registration.
    if (sessionObserved && registrationStarted) {
      try {
        if (!clientId && !registrationSettled) {
          const matches = (await readClients(true)).filter(row => row.client_name === name && !baselineIds.has(row.client_id))
          need(matches.length <= 1, 'registration_ambiguous')
          if (matches.length === 1) {
            clientId = matches[0].client_id; remember([clientId])
            assertOwnedClient(matches[0], { clientId, ownerId, name, baselineIds })
          } else registrationSettled = true
        }
        if (clientId) {
          await readOwned(clientId, true)
          if (token) {
            try {
              const revoked = await raw(AUTH + '/oauth2/revoke', { method: 'POST',
                headers: { 'content-type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({ token, client_id: clientId, token_type_hint: 'access_token' }) }, { cleanup: true })
              report.cleanup.tokenRevoked = revoked.status === 200
              await close(revoked)
              if (!report.cleanup.tokenRevoked) cleanupErrors.push('token_revoke')
              const rejected = await raw(MCP, { method: 'POST', headers: {
                authorization: 'Bearer ' + token, 'content-type': 'application/json',
                accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18',
              }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) }, { cleanup: true })
              report.cleanup.tokenRejected = rejected.status === 401
              await close(rejected)
              if (!report.cleanup.tokenRejected) cleanupErrors.push('token_still_accepted')
            } catch { cleanupErrors.push('token_cleanup_unproven') }
          }
          // Even an unavailable revoke response must not prevent normal
          // deletion of the independently proven, newly owned client.
          try {
            const deleted = await ownPost(AUTH + '/oauth2/delete-client', { client_id: clientId }, true)
            report.cleanup.clientDeleted = [200, 204].includes(deleted.status)
            await close(deleted)
            if (!report.cleanup.clientDeleted) cleanupErrors.push('client_delete')
          } catch { cleanupErrors.push('client_delete_response') }
          const absent = await ownerRead(AUTH + '/oauth2/get-client?client_id=' + encodeURIComponent(clientId), true)
          report.cleanup.clientAbsent = absent.status === 404 && absent.value?.error === 'not_found'
          if (!report.cleanup.clientAbsent) cleanupErrors.push('client_remains')
        }
      } catch { cleanupErrors.push('oauth_cleanup_unproven') }
    }
    if (signInStarted) {
      try {
        const response = await ownPost(AUTH + '/sign-out', {}, true)
        report.cleanup.normalSessionClosed = response.status === 200
        await close(response)
        const after = await ownerRead(AUTH + '/get-session', true)
        report.cleanup.sessionAbsent = after.status === 200 && after.value === null
        if (!report.cleanup.normalSessionClosed || !report.cleanup.sessionAbsent || !sessionObserved)
          cleanupErrors.push('session_cleanup_unproven')
      } catch { cleanupErrors.push('session_cleanup_unproven') }
    }
    report.cleanup.unresolvedResources = Boolean(
      registrationStarted && (clientId ? !report.cleanup.clientAbsent : !registrationSettled)
      || signInStarted && (!report.cleanup.normalSessionClosed || !report.cleanup.sessionAbsent || !sessionObserved))
    report.cleanup.failureCodes = [...new Set(cleanupErrors)]
    if (initialTargetVerified) {
      // Observe the target after every started proof, including failed business
      // or cleanup. Existing failure codes and unresolved resources stay primary.
      try {
        await assertBinding()
        report.targetAfter = { verified: true, status: 'ready' }
      } catch (error) {
        const failure = publicTargetFailure(error)
        report.targetAfter = { verified: false, ...failure }
        report.targetFailure ??= failure
        if (completed && !cleanupErrors.length && !report.cleanup.unresolvedResources) {
          completed = false
          report.failureCode = failure.code
        }
      }
    }
    report.finishedAt = new Date(now()).toISOString()
    report.status = completed && !cleanupErrors.length && !report.cleanup.unresolvedResources ? 'passed' : 'failed'
    if (completed && report.status === 'failed') report.failureCode = 'cleanup_failed'
    cookies.clear(); token = undefined
    const publicText = JSON.stringify(report)
    if ([...secretValues].some(value => value.length >= 8 && publicText.includes(value))) {
      return { version: 1, purpose: 'production-oauth-mcp', status: 'failed', failureCode: 'evidence_rejected' }
    }
  }
  return report
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let report
  try {
    const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'))
    const attestation = process.env.MIKKA_ACCEPTANCE_TARGET_MODE === 'deployed-target'
      ? JSON.parse(await readFile('production-read-cache-report/attestation.json', 'utf8')) : undefined
    report = await runProductionMcpProof({ event, attestation })
  } catch {
    report = { version: 1, purpose: 'production-oauth-mcp', status: 'failed', failureCode: 'trigger_rejected' }
  }
  await mkdir('production-transport-proof-report', { recursive: true, mode: 0o700 })
  await writeFile('production-transport-proof-report/mcp.json', JSON.stringify(report, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
  console.log(JSON.stringify({ purpose: report.purpose, status: report.status, failureCode: report.failureCode ?? null }))
  process.exitCode = report.status === 'passed' ? 0 : 1
}
