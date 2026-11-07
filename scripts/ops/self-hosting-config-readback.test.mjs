import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import test from 'node:test'
import { BOOLEAN_NAMES, configurationReadback, publicAppConfiguration, readbackDiagnostics, readVercelFallback, runReadback, valueShape } from './self-hosting-config-readback.mjs'

test('Vercel fallback decrypts only exact production entries on the fixed project and never trusts inventory values or URLs', async () => {
  const project = 'prj_VdNz3P0FmuRbZKeI40hbCqwR0NVH', team = 'team_C7lwxVVvnUicFli6112mvxpv'
  const env = { READ_VERCEL_DEPLOY_TOKEN: 'success', VERCEL_DEPLOY_TOKEN: 'fixture-deploy-token' }
  const requests = []
  const { env: result, evidence } = await readVercelFallback(env, async (url, init) => {
    requests.push(url)
    assert.equal(init.method, 'GET'); assert.equal(init.redirect, 'error'); assert.equal(init.cache, 'no-store')
    assert.equal(init.headers.authorization, `Bearer ${env.VERCEL_DEPLOY_TOKEN}`)
    if (url === `https://api.vercel.com/v10/projects/${project}/env?teamId=${team}&decrypt=false`) return Response.json({ envs: [
      { id: 'preview-id', key: 'GITHUB_APP_ID', target: ['preview'], value: 'never-use-preview' },
      { id: 'prod-id', key: 'GITHUB_APP_ID', target: ['production'], value: 'never-use-encrypted', url: 'https://attacker.example' },
      { id: 'irrelevant-id', key: 'UNRELATED_SECRET', target: ['production'], value: 'never-decrypt' },
      { id: 'unsafe/path', key: 'MIKKA_EDITION', target: ['production'] },
    ] })
    assert.equal(url, `https://api.vercel.com/v1/projects/${project}/env/prod-id?teamId=${team}`)
    return Response.json({ id: 'prod-id', key: 'GITHUB_APP_ID', target: ['production'], value: '12345', decrypted: true })
  })
  assert.equal(requests.length, 2)
  assert.equal(result.GITHUB_APP_ID, '12345')
  assert.equal(result.READ_GITHUB_APP_ID, 'success')
  assert.equal(result.READ_GITHUB_APP_PRIVATE_KEY, 'success')
  assert.equal(result.GITHUB_APP_PRIVATE_KEY, undefined)
  assert.deepEqual(evidence, { GITHUB_APP_ID: 'found', GITHUB_APP_PRIVATE_KEY: 'absent', NEXT_PUBLIC_COMPUTER_ENABLED: 'absent', MIKKA_EDITION: 'ambiguous' })
  for (const secret of ['12345', 'fixture-deploy-token', 'never-use-encrypted', 'never-use-preview', 'never-decrypt']) assert.ok(!JSON.stringify(evidence).includes(secret))
})

test('representation diagnostics disclose only closed shapes and lengths', () => {
  assert.deepEqual(valueShape(undefined), { shape: 'unset', length: 0 })
  assert.deepEqual(valueShape(''), { shape: 'empty', length: 0 })
  assert.deepEqual(valueShape(' \n'), { shape: 'whitespace', length: 2 })
  assert.equal(valueShape(' cloud ', ['cloud']).shape, 'trimmed_known_value')
  assert.equal(valueShape('"cloud"', ['cloud']).shape, 'quoted_known_value')
  const env = { GITHUB_APP_ID: 'Iv23.fixtureonly12345', GITHUB_APP_PRIVATE_KEY: 'private-not-for-logs', MIKKA_EDITION: 'arbitrary-secret-value' }
  const diagnostics = readbackDiagnostics(env)
  assert.equal(diagnostics.GITHUB_APP_ID.shape, 'app_client_id')
  assert.equal(diagnostics.GITHUB_APP_PRIVATE_KEY.shape, 'invalid_private_key')
  for (const value of Object.values(env)) assert.ok(!JSON.stringify(diagnostics).includes(value))
})

test('flags expose only exact enums and distinguish a failed read from an unset value', () => {
  const env = Object.fromEntries([...BOOLEAN_NAMES, 'MIKKA_EDITION'].map(name => [`READ_${name}`, 'success']))
  Object.assign(env, { MIKKA_BYOS_ENABLED: '1', MIKKA_BYOS_CLAUDE_OAUTH: '0', MIKKA_BYOS_CODEX_OAUTH: 'not-a-boolean', MIKKA_EDITION: 'cloud' })
  assert.deepEqual(configurationReadback(env), { MIKKA_BYOS_ENABLED: 'true', MIKKA_BYOS_CLAUDE_OAUTH: 'false', MIKKA_BYOS_CODEX_OAUTH: 'invalid', NEXT_PUBLIC_COMPUTER_ENABLED: 'unset', MIKKA_EDITION: 'true' })
  env.READ_NEXT_PUBLIC_COMPUTER_ENABLED = 'failure'
  assert.equal(configurationReadback(env).NEXT_PUBLIC_COMPUTER_ENABLED, 'invalid')
  env.MIKKA_EDITION = 'community'
  assert.equal(configurationReadback(env).MIKKA_EDITION, 'false')
})

test('app projection cannot emit extra fields or unvalidated permissions/events', () => {
  assert.deepEqual(publicAppConfiguration({ slug: 'app-fixture', permissions: { contents: 'write', metadata: 'read' }, events: ['push', 'push'], pem: 'not-for-output', client_secret: 'not-for-output' }),
    { slug: 'app-fixture', permissions: { contents: 'write', metadata: 'read' }, events: ['push'] })
  for (const value of [null, {}, { slug: 'app-fixture', permissions: { contents: 'a-secret' }, events: [] }, { slug: 'app-fixture', permissions: { metadata: 'read' }, events: ['not an event'] }]) assert.throws(() => publicAppConfiguration(value))
})

test('the probe only GETs the fixed GitHub endpoint and never logs credentials or responses', async () => {
  const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  const env = { GITHUB_APP_ID: 'Iv23.fixtureonly12345', GITHUB_APP_PRIVATE_KEY: privateKey, READ_GITHUB_APP_ID: 'success', READ_GITHUB_APP_PRIVATE_KEY: 'success',
    ...Object.fromEntries([...BOOLEAN_NAMES, 'MIKKA_EDITION'].map(name => [`READ_${name}`, 'success'])) }
  const lines = []
  let authorization
  const code = await runReadback({ env, write: line => lines.push(line), fetcher: async (url, init) => {
    assert.equal(url, 'https://api.github.com/app')
    assert.equal(init.method, 'GET')
    assert.equal(init.redirect, 'error')
    assert.ok(init.signal instanceof AbortSignal)
    authorization = init.headers.authorization
    assert.match(authorization, /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/)
    return Response.json({ slug: 'app-fixture', permissions: { metadata: 'read' }, events: ['issues'], pem: privateKey, client_secret: 'fixture-provider-secret' })
  } })
  assert.equal(code, 0)
  for (const secret of [privateKey, authorization, 'fixture-provider-secret']) assert.ok(!lines.join('\n').includes(secret))
  const refused = []
  assert.equal(await runReadback({ env, write: line => refused.push(line), fetcher: async () => new Response('fixture-provider-secret', { status: 401 }) }), 1)
  assert.ok(!refused.join('\n').includes('fixture-provider-secret'))
  assert.equal(JSON.parse(refused.at(-1)).githubApp.reason, 'github_request_refused')
})
