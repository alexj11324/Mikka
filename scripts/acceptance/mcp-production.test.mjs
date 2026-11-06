import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { attestDeployedTarget } from './deployed-target.mjs'
import { PROJECT, TEAM, PRODUCTION_ALIAS } from '../ops/deployment-regression.mjs'
import { ORIGIN, OPS_REF, productionMcpGuard, runProductionMcpProof } from './mcp-production.mjs'
import { authorizeMcpSession } from '../../tests/support/mcp-closeout-session.mjs'

const APP = 'a'.repeat(40), SOURCE = 'b'.repeat(40), OTHER = 'c'.repeat(40)
const EMAIL = 'owner+mikka-smoke@example.invalid', PASSWORD = 'SYNTHETIC_PASSWORD_FOR_MCP'
const OWNER = 'synthetic-owner-identity', COOKIE = 'synthetic-private-cookie'
const CLIENT = 'synthetic_new_client', PREVIOUS = 'synthetic_previous_client'
const ACCESS = 'mka_SYNTHETIC_PRIVATE_ACCESS_TOKEN'
const event = { ref: OPS_REF, after: SOURCE, repository: { full_name: 'alexj11324/Mikka' } }
const environment = () => ({ GITHUB_REPOSITORY: 'alexj11324/Mikka', GITHUB_EVENT_NAME: 'push',
  GITHUB_REF: OPS_REF, GITHUB_SHA: SOURCE, APPLICATION_SHA: APP, GH_TOKEN: 'SYNTHETIC_GH_TOKEN',
  SMOKE_OWNER_EMAIL: EMAIL, SMOKE_OWNER_PASSWORD: PASSWORD })
const json = (value, status = 200, headers = {}) => Response.json(value, { status, headers })

function fixture(options = {}) {
  const requests = []
  let alive = false, client, registered = 0, revoked = false, deleted = false, authorization
  let versionReads = 0, mainReads = 0
  const privateValues = [EMAIL, PASSWORD, OWNER, COOKIE, CLIENT, ACCESS]
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(input), method = init.method ?? 'GET', headers = new Headers(init.headers)
    requests.push({ origin: url.origin, path: url.pathname, method })
    assert.ok(['manual', 'error'].includes(init.redirect))
    if (url.origin === 'https://api.github.com') {
      assert.equal(method, 'GET')
      assert.equal(headers.get('authorization'), 'Bearer SYNTHETIC_GH_TOKEN')
      if (url.pathname.endsWith('/git/ref/heads/main')) {
        mainReads++
        return json({ object: { type: 'commit', sha: options.wrongMain || options.advanceMain && mainReads > 2 ? OTHER : APP } })
      }
      if (url.pathname.endsWith('/actions/workflows/web-deploy.yml/runs')) return json({ workflow_runs: [{
        id: 51, run_attempt: 1, head_sha: APP, head_branch: 'main', event: 'push',
        path: '.github/workflows/web-deploy.yml', repository: { full_name: 'alexj11324/Mikka' },
        head_repository: { full_name: 'alexj11324/Mikka' }, status: 'completed', conclusion: 'success',
      }] })
      if (url.pathname.endsWith('/actions/runs/51/attempts/1/jobs')) return json({ total_count: 1, jobs: [{
        name: 'deploy', head_sha: APP, status: 'completed', conclusion: 'success',
        steps: ['Build (runs migrations last, as the Vercel build did)',
          'Upload the prebuilt output to production', 'Verify the public production version before releasing the deployment queue']
          .map(name => ({ name, status: 'completed', conclusion: 'success' })),
      }] })
      assert.fail('Unexpected GitHub path')
    }
    assert.equal(url.origin, ORIGIN)
    if (url.pathname === '/mikka/api/version') { versionReads++; return json({ build: APP }) }
    if (url.pathname === '/mikka/api/auth/sign-in/email') {
      assert.equal(method, 'POST'); assert.equal(headers.get('origin'), ORIGIN)
      assert.deepEqual(JSON.parse(init.body), { email: EMAIL, password: PASSWORD })
      alive = true
      return json({ user: { id: OWNER, email: EMAIL }, token: COOKIE }, 200,
        { 'set-cookie': 'better-auth.session_token=' + COOKIE + '; Path=/; Secure; HttpOnly' })
    }
    if (url.pathname === '/mikka/api/auth/get-session') {
      return json(alive ? { user: { id: OWNER, email: EMAIL }, session: {} } : null)
    }
    if (url.pathname === '/mikka/api/auth/sign-out') {
      assert.equal(method, 'POST')
      alive = false
      return json({ success: true }, 200, { 'set-cookie': 'better-auth.session_token=; Path=/; Max-Age=0; Secure; HttpOnly' })
    }
    if (url.pathname.startsWith('/mikka/api/auth/oauth2/') && !['token', 'revoke'].includes(url.pathname.split('/').at(-1))) {
      if (!alive) return json({ error: 'unauthorized' }, 401)
      assert.ok(headers.get('cookie')?.split('; ').includes('better-auth.session_token=' + COOKIE))
      assert.equal(headers.get('origin'), ORIGIN)
    }
    if (url.pathname.endsWith('/oauth2/get-clients')) return json([
      { client_id: PREVIOUS, client_name: 'Existing owner app' }, ...(client && !deleted ? [client] : []),
    ])
    if (url.pathname.endsWith('/oauth2/create-client')) {
      assert.equal(++registered, 1)
      if (options.expireSessionBeforeCreate) { alive = false; return json({ error: 'unauthorized' }, 401) }
      const metadata = JSON.parse(init.body)
      assert.equal(metadata.scope, 'mikka')
      assert.deepEqual(metadata.grant_types, ['authorization_code'])
      client = { ...metadata, client_id: CLIENT,
        user_id: options.foreignOwner ? 'different-owner-identity' : OWNER }
      privateValues.push(client.client_name)
      if (options.lostRegistration) throw new Error('PRIVATE_HTTP_FAILURE')
      if (options.registration500AfterCreate) return json({ error: 'server_error' }, 500)
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
      privateValues.push(authorization.get('state'), authorization.get('code_challenge'))
      const consent = new URL(ORIGIN + '/mikka/oauth/consent')
      consent.search = authorization.toString()
      return new Response(null, { status: 302, headers: { location: consent.href,
        'set-cookie': 'oauth_state=synthetic_signed_state; Path=/mikka/api/auth; Secure; HttpOnly' } })
    }
    if (url.pathname.endsWith('/oauth2/consent')) {
      const body = JSON.parse(init.body)
      assert.equal(body.accept, true)
      const query = new URLSearchParams(body.oauth_query)
      assert.equal(query.get('state'), authorization.get('state'))
      const callback = new URL(authorization.get('redirect_uri'))
      callback.searchParams.set('state', authorization.get('state'))
      callback.searchParams.set('code', 'synthetic-private-authorization-code')
      return json({ url: callback.href })
    }
    if (url.pathname.endsWith('/oauth2/token')) {
      assert.equal(headers.has('cookie'), false); assert.equal(headers.has('authorization'), false)
      const body = new URLSearchParams(init.body)
      assert.equal(body.get('grant_type'), 'authorization_code')
      assert.equal(body.get('client_id'), CLIENT)
      assert.equal(createHash('sha256').update(body.get('code_verifier')).digest('base64url'), authorization.get('code_challenge'))
      privateValues.push(body.get('code'), body.get('code_verifier'))
      return json({ access_token: ACCESS, token_type: 'Bearer', scope: 'mikka',
        ...(options.unexpectedRefresh ? { refresh_token: 'mkr_SYNTHETIC_UNEXPECTED_REFRESH' } : {}) })
    }
    if (url.pathname.endsWith('/oauth2/revoke')) {
      const body = new URLSearchParams(init.body)
      assert.equal(body.get('client_id'), CLIENT)
      assert.equal(body.get('token'), ACCESS)
      assert.equal(body.get('token_type_hint'), 'access_token')
      assert.equal(headers.has('cookie'), false)
      if (options.revokeUnavailable) throw new Error('PRIVATE_REVOKE_FAILURE')
      revoked = true
      return json({})
    }
    if (url.pathname.endsWith('/oauth2/delete-client')) {
      assert.deepEqual(JSON.parse(init.body), { client_id: CLIENT })
      assert.notEqual(CLIENT, PREVIOUS)
      deleted = true
      return json({})
    }
    if (url.pathname === '/mikka/api/mcp') {
      assert.equal(headers.get('authorization'), 'Bearer ' + ACCESS)
      assert.equal(headers.has('cookie'), false)
      const body = JSON.parse(init.body)
      assert.notEqual(body.method, 'tools/call')
      if (revoked || deleted) return json({ error: 'invalid_token' }, 401)
      if (body.method === 'initialize') return json({ jsonrpc: '2.0', id: body.id,
        result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'mikka', version: '1.0.0' } } })
      if (body.method === 'notifications/initialized') return new Response(null, { status: 202 })
      assert.equal(body.method, 'tools/list')
      return json({ jsonrpc: '2.0', id: body.id,
        result: { tools: options.emptyCatalogue ? [] : [{ name: 'list_issues', inputSchema: { type: 'object' } }] } })
    }
    assert.fail('Unexpected application path')
  }
  return { requests, privateValues, fetchImpl, run: (env, overrides) => runProductionMcpProof({ env: env ?? environment(), event, fetchImpl, ...overrides }),
    state: () => ({ alive, client, registered, revoked, deleted, versionReads, mainReads }) }
}

test('actual existing PKCE helper: one owned client, catalogue only, normal revoke/delete/sign-out and safe report', async () => {
  const f = fixture(), report = await f.run()
  assert.equal(report.status, 'passed')
  assert.equal(report.registrationMode, 'owner-managed')
  assert.equal(report.registrationStatus, 201)
  assert.equal(report.loopbackCallbackObserved, true)
  assert.equal(report.browserConsentUI, false)
  assert.equal(f.requests.some(row => row.path.endsWith('/oauth2/register')), false)
  assert.deepEqual(report.requestedScopes, ['mikka'])
  assert.equal(report.refreshRequested, false)
  assert.equal(report.toolsInvoked, 0)
  assert.equal(report.cleanup.unresolvedResources, false)
  for (const key of ['tokenRevoked', 'tokenRejected', 'clientDeleted', 'clientAbsent', 'normalSessionClosed', 'sessionAbsent'])
    assert.equal(report.cleanup[key], true, key)
  assert.equal(f.state().registered, 1); assert.equal(f.state().deleted, true); assert.equal(f.state().alive, false)
  const output = JSON.stringify(report)
  for (const value of f.privateValues) assert.equal(output.includes(value), false)
  assert.equal(f.requests.some(row => row.path.includes('/admin/') || row.path.includes('/api/rpc')), false)
})

test('a lost registration response is not retried; only the unique new owned intent is reconciled and deleted', async () => {
  const f = fixture({ lostRegistration: true }), report = await f.run()
  assert.equal(report.status, 'failed')
  assert.equal(report.failureCode, 'request_failed')
  assert.equal(f.state().registered, 1)
  assert.equal(report.cleanup.clientDeleted, true)
  assert.equal(report.cleanup.clientAbsent, true)
  assert.equal(report.cleanup.unresolvedResources, false)
  assert.equal(f.requests.some(row => row.path.endsWith('/oauth2/token')), false)
})

test('a JSON server error after registration may have written the client and must reconcile the same unique intent', async () => {
  const f = fixture({ registration500AfterCreate: true }), report = await f.run()
  assert.equal(report.status, 'failed')
  assert.equal(f.state().registered, 1)
  assert.equal(report.cleanup.clientDeleted, true)
  assert.equal(report.cleanup.clientAbsent, true)
  assert.equal(report.cleanup.unresolvedResources, false)
  assert.equal(f.requests.filter(row => row.path.endsWith('/oauth2/create-client')).length, 1)
  assert.equal(f.requests.some(row => row.path.endsWith('/oauth2/token')), false)
})

test('foreign ownership fails closed before authorization and never deletes an unproven client', async () => {
  const f = fixture({ foreignOwner: true }), report = await f.run()
  assert.equal(report.status, 'failed'); assert.equal(report.failureCode, 'client_ownership')
  assert.equal(f.requests.some(row => /\/(authorize|delete-client|revoke)$/.test(row.path)), false)
  assert.equal(report.cleanup.unresolvedResources, true)
  assert.equal(report.cleanup.normalSessionClosed, true)
})

test('an unexpected refresh token fails the probe but still removes this exact owned grant/client/session', async () => {
  const f = fixture({ unexpectedRefresh: true }), report = await f.run()
  assert.equal(report.status, 'failed'); assert.equal(report.failureCode, 'token_policy')
  assert.equal(report.cleanup.tokenRevoked, true)
  assert.equal(report.cleanup.clientAbsent, true)
  assert.equal(report.cleanup.unresolvedResources, false)
  assert.equal(f.requests.some(row => row.path === '/mikka/api/mcp' && row.method === 'POST'), true)
})

test('a revoke transport failure cannot prevent owned client deletion and original session closure', async () => {
  const f = fixture({ revokeUnavailable: true }), report = await f.run()
  assert.equal(report.status, 'failed'); assert.equal(report.failureCode, 'cleanup_failed')
  assert.equal(report.cleanup.clientAbsent, true)
  assert.equal(report.cleanup.normalSessionClosed, true)
  assert.ok(report.cleanup.failureCodes.includes('token_cleanup_unproven'))
  assert.equal(f.state().deleted, true)
})

test('catalogue failure remains a failure after successful cleanup; missing binding does not read credentials', async () => {
  const f = fixture({ emptyCatalogue: true }), report = await f.run()
  assert.equal(report.status, 'failed'); assert.equal(report.failureCode, 'catalogue_invalid')
  assert.equal(report.cleanup.clientAbsent, true)
  const noSecrets = environment()
  Object.defineProperty(noSecrets, 'SMOKE_OWNER_PASSWORD', { get() { return assert.fail('must not read credentials') } })
  const mismatch = fixture({ wrongMain: true }), rejected = await mismatch.run(noSecrets)
  assert.equal(rejected.failureCode, 'application_binding')
  assert.equal(mismatch.requests.some(row => row.origin === ORIGIN), false)
})

test('ops source identity and application identity stay distinct; a main branch or altered event cannot authorize it', () => {
  assert.deepEqual(productionMcpGuard(environment(), event), { applicationSha: APP, sourceRevision: SOURCE })
  for (const patch of [{ GITHUB_REF: 'refs/heads/main' }, { GITHUB_REPOSITORY: 'someone/other' },
    { GITHUB_EVENT_NAME: 'pull_request' }, { APPLICATION_SHA: 'main' }, { GITHUB_SHA: OTHER }])
    assert.throws(() => productionMcpGuard({ ...environment(), ...patch }, event), /trigger_rejected/)
})


test('an owner session lost before managed creation cannot continue as anonymous DCR', async () => {
  const f = fixture({ expireSessionBeforeCreate: true }), report = await f.run()
  assert.equal(report.status, 'failed')
  assert.equal(f.state().registered, 1)
  assert.equal(f.state().client, undefined)
  assert.equal(f.requests.some(row => /\/(register|authorize|token|delete-client)$/.test(row.path)), false)
  assert.equal(report.cleanup.sessionAbsent, true)
  // A refused ownership read is not invented into proof of no resource.
  assert.equal(report.cleanup.unresolvedResources, true)
})

test('the shared helper retains its DCR default and rejects unknown registration endpoints before any request', async () => {
  let requested
  const owner = { async request(path) { requested = path; return json({}, 400) } }
  await assert.rejects(authorizeMcpSession(owner, { origin: ORIGIN }, async () => {}), /registration must succeed/)
  assert.equal(requested, '/api/auth/oauth2/register')
  requested = undefined
  await assert.rejects(authorizeMcpSession(owner, { origin: ORIGIN }, async () => {},
    { registrationPath: '/api/auth/admin/create-client' }))
  assert.equal(requested, undefined)
})

function deployedFixture(business, originalEnv, { changed = () => false } = {}) {
  const env = { ...originalEnv, MIKKA_ACCEPTANCE_TARGET_MODE: 'deployed-target',
    GITHUB_REPOSITORY_OWNER: 'alexj11324', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main',
    GITHUB_WORKFLOW_REF: 'alexj11324/Mikka/.github/workflows/issue1415-deployed-production.yml@refs/heads/main',
    GITHUB_RUN_ID: '99', GITHUB_RUN_ATTEMPT: '1', WEB_DEPLOY_RUN_ID: '51',
    VERCEL_DEPLOYMENT_ID: 'dpl_transport', VERCEL_TEAM_TOKEN: 'SYNTHETIC_VERCEL_READ_TOKEN' }
  const repository = { full_name: 'alexj11324/Mikka', owner: { login: 'alexj11324' } }
  const event = { repository, inputs: { application_sha: env.APPLICATION_SHA,
    web_run_id: env.WEB_DEPLOY_RUN_ID, deployment_id: env.VERCEL_DEPLOYMENT_ID } }
  const api = 'https://api.github.com/repos/alexj11324/Mikka'
  const metadata = []
  const now = business.now ?? Date.now
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(input)
    if (url.origin === 'https://api.github.com' || url.origin === 'https://api.vercel.com'
      || url.pathname === '/mikka/api/version') {
      metadata.push(url.pathname)
      assert.equal(init.method, 'GET')
      assert.equal(new Headers(init.headers).has('cookie'), false)
      if (url.origin === 'https://api.github.com') {
        assert.equal(new Headers(init.headers).get('authorization'), 'Bearer ' + env.GH_TOKEN)
        if (url.href === api + '/actions/runs/99') return Response.json({ id: 99, run_attempt: 1,
          url: url.href, path: '.github/workflows/issue1415-deployed-production.yml',
          repository, head_repository: repository, event: 'workflow_dispatch', head_branch: 'main',
          head_sha: env.GITHUB_SHA, status: 'in_progress', conclusion: null })
        if (url.href === api + '/issues/1415') return Response.json({ number: 1415, url: url.href,
          repository_url: api, state: 'open' })
        if (url.href === api + '/actions/runs/51') return Response.json({ id: 51, run_attempt: 1,
          url: url.href, name: 'Web deploy', path: '.github/workflows/web-deploy.yml',
          repository, head_repository: repository, event: 'push', head_branch: 'main',
          head_sha: env.APPLICATION_SHA, status: 'completed', conclusion: 'success' })
        if (url.pathname.endsWith('/actions/runs/51/attempts/1/jobs')) return Response.json({
          total_count: 1, jobs: [{ id: 61, run_id: 51, name: 'deploy', head_sha: env.APPLICATION_SHA,
            status: 'completed', conclusion: 'success', steps: [
              'Build (runs migrations last, as the Vercel build did)', 'Upload the prebuilt output to production',
              'Verify the public production version before releasing the deployment queue',
            ].map(name => ({ name, status: 'completed', conclusion: 'success' })) }] })
        assert.fail('Unexpected metadata path')
      }
      if (url.origin === 'https://api.vercel.com') {
        assert.equal(new Headers(init.headers).get('authorization'), 'Bearer ' + env.VERCEL_TEAM_TOKEN)
        if (url.pathname.startsWith('/v4/aliases/')) return Response.json({
          alias: PRODUCTION_ALIAS, projectId: PROJECT, deploymentId: changed() ? 'dpl_changed' : env.VERCEL_DEPLOYMENT_ID,
          updatedAt: 1 })
        if (url.pathname === '/v13/deployments/' + env.VERCEL_DEPLOYMENT_ID) return Response.json({
          id: env.VERCEL_DEPLOYMENT_ID, projectId: PROJECT, teamId: TEAM, readyState: 'READY',
          target: 'production', gitSource: { sha: env.APPLICATION_SHA } })
        assert.fail('Unexpected deployment path')
      }
      return Response.json({ build: env.APPLICATION_SHA })
    }
    return business.fetchImpl(input, init)
  }
  return { env, event, fetchImpl, metadata, now,
    proof: () => attestDeployedTarget({ env, event, fetchImpl, now }) }
}

test('deployed MCP accepts a different real manual driver only after the immutable target proof', async () => {
  const f = fixture(), target = deployedFixture(f, environment())
  const report = await f.run(target.env, { ...target, attestation: await target.proof() })
  assert.equal(report.status, 'passed', JSON.stringify(report))
  assert.equal(report.targetMode, 'deployed-target')
  assert.equal(report.applicationSha, APP); assert.equal(report.driverRevision, SOURCE)
  assert.notEqual(report.applicationSha, report.driverRevision)
  assert.equal(report.sourceRevision, report.driverRevision)
  assert.equal(report.webDeployRunId, 51); assert.equal(report.webAttempt, 1)
  assert.equal(report.deploymentId, 'dpl_transport')
  assert.equal(target.metadata.some(path => path.endsWith('/git/ref/heads/main')), false)
  assert.equal(report.registrationAttempts, 1)
  assert.equal(report.toolsInvoked, 0); assert.equal(report.modelCalls, 0)
  assert.equal(report.cleanup.unresolvedResources, false)
  for (const value of [...f.privateValues, target.env.VERCEL_TEAM_TOKEN]) assert.equal(JSON.stringify(report).includes(value), false)
})

test('deployed MCP rejects a foreign attestation before reading owner credentials or registration', async () => {
  const f = fixture(), target = deployedFixture(f, environment())
  const attestation = { ...await target.proof(), driverRunId: 98 }
  Object.defineProperty(target.env, 'SMOKE_OWNER_PASSWORD', { get() { return assert.fail('unproven target must not read credentials') } })
  const report = await f.run(target.env, { ...target, attestation })
  assert.equal(report.status, 'failed')
  assert.equal(report.targetFailure.code, 'target_attestation')
  assert.equal(f.state().registered, 0)
  assert.equal(f.requests.length, 0)
})

test('target drift before or during MCP cleanup still revokes/deletes/logs out once and never reports PASS', async () => {
  for (const when of ['before-cleanup', 'during-cleanup']) {
    const f = fixture(), target = deployedFixture(f, environment(), {
      changed: () => when === 'before-cleanup' ? f.state().registered === 1 : f.state().deleted,
    })
    const report = await f.run(target.env, { ...target, attestation: await target.proof() })
    assert.equal(report.status, 'failed', when)
    assert.equal(report.targetFailure.code, 'target_changed', when)
    assert.equal(report.targetFailure.status, 'inconclusive', when)
    for (const key of ['tokenRevoked', 'tokenRejected', 'clientDeleted', 'clientAbsent', 'normalSessionClosed', 'sessionAbsent'])
      assert.equal(report.cleanup[key], true, when + ':' + key)
    assert.equal(report.cleanup.unresolvedResources, false)
    assert.equal(f.state().registered, 1)
    assert.equal(f.requests.filter(row => row.path.endsWith('/oauth2/create-client')).length, 1)
    assert.equal(f.requests.filter(row => row.path.endsWith('/oauth2/delete-client')).length, 1)
    assert.equal(f.requests.filter(row => row.path.endsWith('/sign-out')).length, 1)
    for (const value of f.privateValues) assert.equal(JSON.stringify(report).includes(value), false)
  }
})

test('failed MCP business or cleanup still observes drift without overwriting its original failure', async () => {
  for (const [options, expectedCode] of [[{ emptyCatalogue: true }, 'catalogue_invalid'],
    [{ revokeUnavailable: true }, 'cleanup_failed']]) {
    const f = fixture(options), target = deployedFixture(f, environment(), {
      changed: () => f.state().registered === 1 && !f.state().alive,
    })
    const report = await f.run(target.env, { ...target, attestation: await target.proof() })
    assert.equal(report.status, 'failed')
    assert.equal(report.failureCode, expectedCode)
    assert.equal(report.targetAfter.verified, false)
    assert.equal(report.targetAfter.status, 'inconclusive')
    assert.equal(report.targetAfter.code, 'target_changed')
    assert.equal(report.targetFailure.code, 'target_changed')
    assert.equal(report.cleanup.clientDeleted, true)
    assert.equal(report.cleanup.clientAbsent, true)
    assert.equal(report.cleanup.normalSessionClosed, true)
    assert.equal(report.cleanup.sessionAbsent, true)
    assert.equal(report.cleanup.unresolvedResources, false)
    if (options.revokeUnavailable) assert.ok(report.cleanup.failureCodes.includes('token_cleanup_unproven'))
    else assert.deepEqual(report.cleanup.failureCodes, [])
    assert.equal(f.state().registered, 1)
    assert.equal(f.requests.filter(row => row.path.endsWith('/oauth2/delete-client')).length, 1)
    assert.equal(f.requests.filter(row => row.path.endsWith('/sign-out')).length, 1)
    for (const value of f.privateValues) assert.equal(JSON.stringify(report).includes(value), false)
  }
})
