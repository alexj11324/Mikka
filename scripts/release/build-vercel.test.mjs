import assert from 'node:assert/strict'
import { test } from 'node:test'
import { REQUIRED } from './web-deploy.mjs'
import { productionBuildEnvironment } from './build-vercel.mjs'

const sourceSha = 'a'.repeat(40)
const env = { GITHUB_SHA: sourceSha, VERCEL_GIT_COMMIT_SHA: sourceSha, MIKKA_DEPLOYMENT_ID: 'aaaaaaaaaaaa-123-1' }
const text = ['VERCEL_ENV="production"', ...REQUIRED.map(key => `${key}="fixture-${key}"`)].join('\n')

test('production build binds the exact source and deployment without acceptance credentials', () => {
  const result = productionBuildEnvironment({ text, sourceSha, nodeVersion: 'v24.22.1', env: { ...env,
    MIKKA_TEST_DEPLOYMENT_SHA: sourceSha, MIKKA_LOCAL_TEST_ACCOUNTS: '1', MIKKA_TEST_ENVIRONMENT_FILE: 'fixture-only' } })
  assert.equal(result.NITRO_PRESET, 'vercel')
  assert.equal(result.NEXT_PUBLIC_MIKKA_BUILD, sourceSha)
  assert.equal(result.MIKKA_DEPLOYMENT_ID, env.MIKKA_DEPLOYMENT_ID)
  assert.equal(result.MIKKA_DATABASE_URL, 'fixture-MIKKA_DATABASE_URL')
  for (const key of ['MIKKA_TEST_DEPLOYMENT_SHA', 'MIKKA_LOCAL_TEST_ACCOUNTS', 'MIKKA_TEST_ENVIRONMENT_FILE']) assert.equal(result[key], undefined)
})

test('production preflight rejects stale source, missing values and an unbound deployment', () => {
  const prepare = overrides => productionBuildEnvironment({ text, sourceSha, env, nodeVersion: 'v24.22.1', ...overrides })
  assert.throws(() => prepare({ sourceSha: 'b'.repeat(40) }), /sourceMismatch/)
  assert.throws(() => prepare({ env: { ...env, VERCEL_GIT_COMMIT_SHA: 'b'.repeat(40) } }), /sourceMismatch/)
  assert.throws(() => prepare({ text: text.replace('fixture-BETTER_AUTH_SECRET', '') }), /missing:BETTER_AUTH_SECRET/)
  assert.throws(() => prepare({ text: text.replace('"production"', '"preview"') }), /productionEnvironmentRequired/)
  assert.throws(() => prepare({ env: { ...env, MIKKA_DEPLOYMENT_ID: '' } }), /deploymentIdRequired/)
  assert.throws(() => prepare({ nodeVersion: 'v22.23.4' }), /node24Required/)
})
