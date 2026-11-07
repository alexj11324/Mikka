import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import test from 'node:test'
import { BOOLEAN_NAMES, configurationReadback, publicAppConfiguration, runReadback } from './self-hosting-config-readback.mjs'

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
  const env = { GITHUB_APP_ID: '12345', GITHUB_APP_PRIVATE_KEY: privateKey, READ_GITHUB_APP_ID: 'success', READ_GITHUB_APP_PRIVATE_KEY: 'success',
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
