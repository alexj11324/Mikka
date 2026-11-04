import test from 'node:test'
import assert from 'node:assert/strict'
import { assertClaims, assertWorkflow, BRANCH, CONFIG_IDS, diagnose, diagnoseRuntime, metadataOnly, permissionMetadata } from './subscription-auth-metadata.mjs'

const env = { GITHUB_REPOSITORY: 'alexj11324/Mikka', GITHUB_REPOSITORY_ID: '1427517699', GITHUB_REPOSITORY_OWNER_ID: '183887963',
  GITHUB_REF: 'refs/heads/' + BRANCH, GITHUB_EVENT_NAME: 'push', GITHUB_RUN_ATTEMPT: '1', GITHUB_SHA: 'a'.repeat(40),
  ACTIONS_ID_TOKEN_REQUEST_URL: 'https://test.actions.githubusercontent.com/id-token', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'fake-runner-token' }
const claims = { iss: 'https://token.actions.githubusercontent.com', aud: 'mikka-infisical',
  sub: `repo:alexj11324@183887963/Mikka@1427517699:ref:${env.GITHUB_REF}`, repository: env.GITHUB_REPOSITORY,
  repository_id: env.GITHUB_REPOSITORY_ID, repository_owner_id: env.GITHUB_REPOSITORY_OWNER_ID, ref: env.GITHUB_REF,
  sha: env.GITHUB_SHA, event_name: 'push', workflow_ref: `alexj11324/Mikka/.github/workflows/subscription-auth-metadata.yml@${env.GITHUB_REF}` }

test('only the exact first push and immutable repository claims can reach the existing identity', async () => {
  assert.doesNotThrow(() => assertWorkflow(env)); assert.doesNotThrow(() => assertClaims(claims, env))
  for (const change of [{ GITHUB_RUN_ATTEMPT: '2' }, { GITHUB_REF: 'refs/heads/main' }, { GITHUB_EVENT_NAME: 'pull_request' }, { GITHUB_REPOSITORY_ID: '1' }]) {
    let calls = 0
    await assert.rejects(diagnose({ env: { ...env, ...change }, fetchImpl: async () => { calls++; throw Error('must not call') } }), /diagnostic_workflow_refused/)
    assert.equal(calls, 0)
  }
  for (const change of [{ sub: 'repo:alexj11324/Mikka:ref:' + env.GITHUB_REF }, { aud: 'other' }, { repository_owner_id: '1' }, { sha: 'b'.repeat(40) }, { workflow_ref: 'other' }])
    assert.throws(() => assertClaims({ ...claims, ...change }, env), /diagnostic_oidc_claims_refused/)
})

const PROJECT = 'prj_VdNz3P0FmuRbZKeI40hbCqwR0NVH', TEAM = 'team_C7lwxVVvnUicFli6112mvxpv'
const SCOPE_PROJECT = '11111111-1111-4111-8111-111111111111'
const ACCESS_PROJECT = '22222222-2222-4222-8222-222222222222'
const IDENTITY = '33333333-3333-4333-8333-333333333333'
const ORG = '44444444-4444-4444-8444-444444444444'
const SECRET = 'SENTINEL-NEVER-OUTPUT'
const runtimeToken = 'x.' + Buffer.from(JSON.stringify({ identityId: IDENTITY, identityName: SECRET, private: SECRET })).toString('base64url') + '.x'

function runtimeFixture({ separate = false, loginStatus = 200, membershipStatus = 200, membershipExtra = {}, change } = {}) {
  const rows = [], values = new Map(), seen = []
  for (const target of ['production', 'preview']) {
    const config = {
      INFISICAL_ORIGIN: 'https://app.infisical.com', INFISICAL_PROJECT: SCOPE_PROJECT,
      INFISICAL_ENVIRONMENT: target === 'production' ? 'prod' : 'staging', INFISICAL_PATH: '/byos/custody',
      ACCESS_INFISICAL_PROJECT: ACCESS_PROJECT, ACCESS_INFISICAL_PATH: '/byos/access',
      SHARED_CUSTODY_IDENTITY: separate && target === 'production' ? '0' : '1',
      CUSTODY_CLIENT_ID: target === 'preview' && separate ? 'preview-custody' : 'custody', CUSTODY_CLIENT_SECRET: SECRET,
      ACCESS_CLIENT_ID: 'access', ACCESS_CLIENT_SECRET: SECRET + '-access',
    }
    for (const [suffix, id] of Object.entries(CONFIG_IDS[target])) {
      const row = { id, key: 'MIKKA_BYOS_' + suffix, target: [target], updatedAt: 42 }
      rows.push({ ...row, value: 'CIPHERTEXT-' + SECRET })
      values.set(id, { ...row, value: config[suffix] })
    }
  }
  change?.({ rows, values })
  const fetchImpl = async (input, options) => {
    const url = new URL(input), method = options.method ?? 'GET'
    seen.push({ url, options, method })
    assert.equal(options.redirect, 'error')
    if (url.hostname === 'test.actions.githubusercontent.com') return Response.json({ value: 'x.' + Buffer.from(JSON.stringify(claims)).toString('base64url') + '.x' })
    if (url.origin === 'https://api.vercel.com') {
      assert.equal(options.headers.authorization, 'Bearer vercel-only'); assert.equal(method, 'GET')
      if (url.pathname === '/v9/projects/' + PROJECT) return Response.json({ id: PROJECT, accountId: TEAM, link: { type: 'github', repoId: 1427517699 } })
      if (url.pathname === '/v10/projects/' + PROJECT + '/env') { assert.equal(url.searchParams.get('decrypt'), 'false'); return Response.json({ envs: rows }) }
      const id = url.pathname.split('/').at(-1)
      assert.ok(values.has(id), 'only observed allowlisted variable IDs may be read')
      return Response.json(values.get(id))
    }
    assert.equal(url.origin, 'https://app.infisical.com')
    if (url.pathname === '/api/v1/auth/oidc-auth/login') return Response.json({ accessToken: 'oidc-only' })
    if (url.pathname === '/api/v4/secrets/VERCEL_DEPLOY_TOKEN') {
      assert.equal(options.headers.authorization, 'Bearer oidc-only')
      return Response.json({ secret: { secretKey: 'VERCEL_DEPLOY_TOKEN', secretValue: 'vercel-only' } })
    }
    if (url.pathname === '/api/v1/auth/universal-auth/login') {
      assert.equal(method, 'POST')
      return Response.json(loginStatus === 200 ? { accessToken: runtimeToken, expiresIn: 7200, private: SECRET } : { message: SECRET }, { status: loginStatus })
    }
    assert.equal(method, 'GET'); assert.equal(options.headers.authorization, 'Bearer ' + runtimeToken)
    if (url.pathname === '/api/v1/identities/details') return Response.json({ identityDetails: { organization: { id: ORG, name: SECRET, slug: SECRET }, private: SECRET } })
    if (url.pathname.endsWith('/memberships/identities/' + IDENTITY)) return Response.json(membershipStatus === 200
      ? { identityMembership: { identity: { id: IDENTITY, name: SECRET, metadata: [{ key: 'secret', value: SECRET }] },
        roles: [{ role: 'custom', customRoleSlug: 'byos-test', isTemporary: false }], private: SECRET, ...membershipExtra } }
      : { message: SECRET }, { status: membershipStatus })
    if (url.pathname.endsWith('/roles/slug/byos-test')) return Response.json({ role: {
      slug: 'byos-test', projectId: url.pathname.split('/')[4], description: SECRET,
      permissions: [{ action: ['read', 'create'], subject: 'secrets', conditions: { environment: { $in: ['prod', 'staging'] }, secretPath: { $glob: '/byos/*' }, secretName: SECRET }, private: SECRET }],
    } })
    throw Error('unexpected route ' + url.pathname)
  }
  return { seen, fetchImpl, rows, values }
}

test('shared runtime reads only the approved default-target configuration and authenticates a shared client once', async () => {
  const fixture = runtimeFixture({ change: ({ rows }) => {
    rows.push({ key: 'MIKKA_BYOS_INFISICAL_PATH', id: 'branch-only', target: ['preview'], gitBranch: 'another-branch', value: SECRET })
    rows.push({ key: 'MIKKA_BYOS_TRANSFER_SOURCE_CLIENT_SECRET', id: 'not-allowed', target: ['production'], value: SECRET })
  } })
  const report = await diagnoseRuntime({ env, fetchImpl: fixture.fetchImpl })
  assert.equal(report.status, 'read')
  assert.deepEqual(report.targets.map(target => target.mode), ['shared_custody_authorized_access_snapshot', 'shared_custody_authorized_access_snapshot'])
  assert.equal(report.identities.length, 1)
  assert.equal(fixture.seen.filter(call => call.url.pathname.endsWith('/universal-auth/login')).length, 1)
  assert.equal(report.identities[0].memberships.length, 2)
  assert.ok(report.targets.every(target => target.newIsolatedConnectionReadiness === 'not_established'))
  assert.equal(report.deployedConfigurationVerified, false)
  assert.equal(report.featureFlagStateVerified, false)
  assert.ok(report.targets.every(target => target.configurationReads.every(read => !read.key.includes('ACCESS_CLIENT'))))
  assert.ok(fixture.seen.filter(call => call.url.pathname.includes('/secrets/')).every(call => call.url.pathname === '/api/v4/secrets/VERCEL_DEPLOY_TOKEN'))
  assert.equal(JSON.stringify(report).includes(SECRET), false)
  assert.equal(JSON.stringify(report).includes(runtimeToken), false)
  assert.equal(report.identities[0].memberships[0].roles[0].permissionMetadata.permissions[0].otherConditionsPresent, true)
})

test('separate runtime authenticates only its selected existing identities, once each, without provider or mutation routes', async () => {
  const fixture = runtimeFixture({ separate: true })
  const report = await diagnoseRuntime({ env, fetchImpl: fixture.fetchImpl })
  assert.equal(report.status, 'read')
  assert.equal(report.targets[0].mode, 'separate_custody_and_access_workload')
  assert.equal(report.identities.length, 3)
  const logins = fixture.seen.filter(call => call.url.pathname.endsWith('/universal-auth/login'))
  assert.deepEqual(logins.map(call => JSON.parse(call.options.body).clientId), ['custody', 'access', 'preview-custody'])
  assert.ok(fixture.seen.filter(call => call.method !== 'GET').every(call => call.method === 'POST'
    && ['/api/v1/auth/oidc-auth/login', '/api/v1/auth/universal-auth/login'].includes(call.url.pathname)))
  assert.ok(report.identities.every(identity => identity.loginAttempts === 1))
  assert.equal(JSON.stringify(report).includes(SECRET), false)
})

test('a rejected login is preserved and never retried for the other target or with another credential source', async () => {
  const fixture = runtimeFixture({ loginStatus: 403 })
  const report = await diagnoseRuntime({ env, fetchImpl: fixture.fetchImpl })
  assert.equal(report.status, 'partial')
  assert.equal(report.identities[0].code, 'runtime_login_http_403')
  assert.equal(fixture.seen.filter(call => call.url.pathname.endsWith('/universal-auth/login')).length, 1)
  assert.equal(fixture.seen.filter(call => call.url.pathname.includes('/memberships/')).length, 0)
  assert.equal(JSON.stringify(report).includes(SECRET), false)
})

test('permission metadata denied by the selected identity stays unknown without a privileged identity fallback', async () => {
  const fixture = runtimeFixture({ membershipStatus: 403 })
  const report = await diagnoseRuntime({ env, fetchImpl: fixture.fetchImpl })
  assert.equal(report.status, 'partial')
  assert.equal(report.identities[0].status, 'authenticated')
  assert.ok(report.identities[0].memberships.every(membership => membership.code === 'runtime_membership_http_403' && membership.effectivePermissionDecision === 'not_evaluated'))
  assert.ok(report.targets.every(target => target.permissionMetadataStatus === 'partial' && target.newIsolatedConnectionReadiness === 'not_established'))
  assert.equal(fixture.seen.filter(call => call.url.pathname.includes('/roles/')).length, 0)
})

test('unapproved origins, changed IDs, branch-only defaults and static modes fail before any runtime credential login', async () => {
  const changes = [
    ({ values }) => { for (const [id, row] of values) if (row.key === 'MIKKA_BYOS_INFISICAL_ORIGIN') values.set(id, { ...row, value: 'https://unapproved.invalid' }) },
    ({ rows }) => { for (const row of rows) if (row.key === 'MIKKA_BYOS_INFISICAL_ORIGIN') row.id = 'changed-id' },
    ({ rows }) => { for (const row of rows) if (row.key === 'MIKKA_BYOS_INFISICAL_ORIGIN') row.gitBranch = 'branch-override' },
    ({ rows, values }) => {
      for (const [id, row] of values) if (row.key === 'MIKKA_BYOS_SHARED_CUSTODY_IDENTITY') values.set(id, { ...row, value: '0' })
      for (const target of ['production', 'preview']) rows.push({ key: 'MIKKA_BYOS_INFISICAL_TOKEN', id: 'do-not-read-' + target, target: [target] })
    },
  ]
  for (const change of changes) {
    const fixture = runtimeFixture({ change })
    const report = await diagnoseRuntime({ env, fetchImpl: fixture.fetchImpl })
    assert.equal(report.status, 'partial')
    assert.ok(report.targets.every(target => target.status === 'blocked'))
    assert.equal(fixture.seen.filter(call => call.url.pathname.endsWith('/universal-auth/login')).length, 0)
    assert.ok(report.targets.every(target => target.configurationReads.every(read => !read.key.includes('CLIENT'))))
  }
})

test('permission reporting never evaluates or exposes unknown conditions and never returns role free-text metadata', () => {
  const permissions = permissionMetadata({ role: { projectId: SCOPE_PROJECT, slug: 'limited', description: SECRET,
    permissions: [{ action: 'read', subject: 'secrets', inverted: true, conditions: { secretPath: { $regex: SECRET }, secretName: SECRET } }] } }, SCOPE_PROJECT, 'limited')
  assert.deepEqual(permissions, [{ actions: ['read'], subjects: ['secrets'], inverted: true, scoped: { secretPath: { unreadableCondition: true } }, otherConditionsPresent: true }])
  assert.equal(JSON.stringify(permissions).includes(SECRET), false)
})

test('a configuration updated after the metadata observation is rejected before credential reads or login', async () => {
  const fixture = runtimeFixture({ change: ({ values }) => {
    for (const [id, row] of values) if (row.key === 'MIKKA_BYOS_INFISICAL_ORIGIN') values.set(id, { ...row, updatedAt: 43 })
  } })
  const report = await diagnoseRuntime({ env, fetchImpl: fixture.fetchImpl })
  assert.equal(report.status, 'partial')
  assert.ok(report.targets.every(target => target.code === 'runtime_config_changed_during_read'))
  assert.ok(report.targets.every(target => target.configurationReads.length === 1 && target.configurationReads[0].status === 'blocked'))
  assert.equal(fixture.seen.filter(call => call.url.pathname.endsWith('/universal-auth/login')).length, 0)
})

test('another target cannot retry the same client with a differently configured secret', async () => {
  const fixture = runtimeFixture({ change: ({ values }) => {
    const id = CONFIG_IDS.preview.CUSTODY_CLIENT_SECRET
    values.set(id, { ...values.get(id), value: SECRET + '-different' })
  } })
  const report = await diagnoseRuntime({ env, fetchImpl: fixture.fetchImpl })
  assert.equal(report.status, 'partial')
  assert.equal(report.targets[0].status, 'authenticated_config')
  assert.equal(report.targets[1].code, 'runtime_same_client_different_configured_secret')
  assert.equal(fixture.seen.filter(call => call.url.pathname.endsWith('/universal-auth/login')).length, 1)
  assert.equal(JSON.stringify(report).includes(SECRET), false)
})

test('every present project locator in membership metadata must match the configured query scope', async () => {
  const wrongProject = '55555555-5555-4555-8555-555555555555'
  for (const membershipExtra of [{ projectId: wrongProject }, { project: { id: wrongProject } }, { identity: { id: IDENTITY, projectId: wrongProject } }]) {
    const fixture = runtimeFixture({ membershipExtra })
    const report = await diagnoseRuntime({ env, fetchImpl: fixture.fetchImpl })
    assert.equal(report.status, 'partial')
    assert.ok(report.identities[0].memberships.every(membership => membership.code === 'runtime_membership_shape'))
    assert.equal(fixture.seen.filter(call => call.url.pathname.includes('/roles/')).length, 0)
  }
})

test('metadata allowlist discards all secret values, comments and unrelated environment entries', () => {
  const input = { envs: [
    { key: 'MIKKA_BYOS_CUSTODY_CLIENT_SECRET', id: 'env_1', target: ['production'], value: 'SENTINEL', comment: 'SENTINEL' },
    { key: 'DATABASE_URL', id: 'env_2', target: ['production'], value: 'SENTINEL' },
  ] }
  assert.deepEqual(metadataOnly(input), [{ key: 'MIKKA_BYOS_CUSTODY_CLIENT_SECRET', id: 'env_1', target: ['production'] }])
  assert.equal(JSON.stringify(metadataOnly(input)).includes('SENTINEL'), false)
})

test('transport sends each bearer only to its intended service and makes no non-authentication writes', async () => {
  const seen = [], token = 'SENTINEL'
  const replies = [{ value: 'x.' + Buffer.from(JSON.stringify(claims)).toString('base64url') + '.x' },
    { accessToken: 'infisical-only' }, { secret: { secretKey: 'VERCEL_DEPLOY_TOKEN', secretValue: token } },
    { id: 'prj_VdNz3P0FmuRbZKeI40hbCqwR0NVH', accountId: 'team_C7lwxVVvnUicFli6112mvxpv', link: { type: 'github', repoId: 1427517699 } },
    { envs: [{ key: 'MIKKA_BYOS_CUSTODY_CLIENT_ID', id: 'env_1', target: ['production'], value: token }] }]
  const report = await diagnose({ env, fetchImpl: async (url, options) => { seen.push({ url: new URL(url), options }); return Response.json(replies.shift()) } })
  assert.equal(seen.length, 5)
  assert.equal(report.receivedEnvCount, 1)
  assert.equal(report.relevantEnvCount, 1)
  assert.deepEqual(seen.map(call => call.options.method ?? 'GET'), ['GET', 'POST', 'GET', 'GET', 'GET'])
  assert.equal(seen[1].url.href, 'https://app.infisical.com/api/v1/auth/oidc-auth/login')
  assert.equal(seen[2].url.searchParams.get('secretPath'), '/platform')
  assert.equal(seen[2].url.searchParams.get('includeImports'), 'false')
  assert.equal(seen[2].options.headers.authorization, 'Bearer infisical-only')
  assert.equal(seen[4].url.origin, 'https://api.vercel.com')
  assert.equal(seen[4].url.searchParams.get('decrypt'), 'false')
  assert.ok(seen.every(call => call.options.redirect === 'error'))
  assert.equal(JSON.stringify(report).includes(token), false)
})
