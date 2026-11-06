import assert from 'node:assert/strict'
import { test } from 'node:test'
import { REQUIRED, buildEnvironment } from './web-deploy.mjs'
import { directDatabaseURL } from '../postgres-connection.mjs'
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

test('the filled build file preserves JSON-escaped connection and auth values byte for byte', () => {
  const plain = 'postgresql://fixture:plain@ep-fixture-pooler.us-east-2.aws.neon.tech/app?sslmode=require'
  const cases = [
    ['plain', plain],
    ['quoted password', plain.replace('plain', 'quoted"password')],
    ['backslash password', plain.replace('plain', 'back\\slash')],
    ['dollar password', plain.replace('plain', 'dollar$password')],
    ['escaped dollar password', plain.replace('plain', 'back\\$password')],
    ['leading CR', '\r' + plain],
    ['trailing LF', plain + '\n'],
    ['literal backslash n', plain.replace('plain', 'literal\\npassword')],
  ]
  const authSecret = 'fixture\r\n"quoted"\\literal\\$cash'
  const withheld = text.replace('fixture-MIKKA_DATABASE_URL', '')
    .replace('fixture-DATABASE_URL', '').replace('fixture-BETTER_AUTH_SECRET', '')
  const observed = cases.map(([name, connection]) => {
    const values = { ...env, MIKKA_DATABASE_URL: connection,
      DATABASE_URL: connection.replace('/app?', '/workspace?'), BETTER_AUTH_SECRET: authSecret }
    // The production workflow first fills the file, then the direct builder
    // reads that already-filled file. Neither pass may reinterpret credentials.
    const filled = buildEnvironment(withheld, values)
    const result = productionBuildEnvironment({ text: filled, sourceSha, env: values, nodeVersion: 'v24.22.1' })
    let directUsable = false
    try {
      directUsable = ['MIKKA_DATABASE_URL', 'DATABASE_URL'].every(key =>
        new URL(directDatabaseURL(result[key])).password === new URL(values[key]).password)
    } catch { /* Report only the closed observation, never the connection value. */ }
    return { name, applicationUnchanged: result.MIKKA_DATABASE_URL === values.MIKKA_DATABASE_URL,
      workspaceUnchanged: result.DATABASE_URL === values.DATABASE_URL,
      authUnchanged: result.BETTER_AUTH_SECRET === authSecret, directUsable }
  })
  assert.deepEqual(observed, cases.map(([name]) => ({ name, applicationUnchanged: true,
    workspaceUnchanged: true, authUnchanged: true, directUsable: true })))
})

test('the codec does not repair or dequote an originally invalid database value', () => {
  const invalid = '"postgresql://fixture:password@database.invalid/app"'
  const withheld = text.replace('fixture-MIKKA_DATABASE_URL', '')
  const values = { ...env, MIKKA_DATABASE_URL: invalid }
  const filled = buildEnvironment(withheld, values)
  const result = productionBuildEnvironment({ text: filled, sourceSha, env: values, nodeVersion: 'v24.22.1' })
  assert.equal(result.MIKKA_DATABASE_URL === invalid, true)
  assert.throws(() => directDatabaseURL(result.MIKKA_DATABASE_URL), /DATABASE_CONNECTION_URL_INVALID/)
})
