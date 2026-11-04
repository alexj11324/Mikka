import test from 'node:test'
import assert from 'node:assert/strict'
import { assertClaims, assertWorkflow, BRANCH, diagnose, metadataOnly } from './subscription-auth-metadata.mjs'

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
