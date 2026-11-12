import assert from 'node:assert/strict'
import { generateKeyPairSync, verify } from 'node:crypto'
import { test } from 'node:test'
import { privateSourceCompilerEnvironment, privateSourceGitEnvironment } from './private-source-auth.mjs'

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const now = () => Date.parse('2026-11-12T23:00:00Z')
const env = {
  PATH: '/source-test/bin', WORKERS_CI: '1',
  PRIVATE_SOURCE_GITHUB_APP_ID: '12345',
  PRIVATE_SOURCE_GITHUB_APP_INSTALLATION_ID: '173164679',
  PRIVATE_SOURCE_GITHUB_APP_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }).replaceAll('\n', '\\n'),
  MIKKA_CLOUD_READ_TOKEN: 'old-cloud-token', MIKKA_MARKETING_READ_TOKEN: 'old-marketing-token',
}

test('public builds mint a fresh contents-read token scoped to each known source repository', async () => {
  const calls = []
  const fetchImpl = async (url, options) => {
    calls.push({ url, options })
    return { status: 201, json: async () => ({ token: `fresh-token-${calls.length}`, expires_at: '2026-11-13T00:00:00Z' }) }
  }
  for (const [repository, repositoryId] of [
    ['alexj11324/mikka-cloud', 1448851980], ['alexj11324/mikka-web', 1429004608],
  ]) {
    const result = await privateSourceGitEnvironment({ env, repository, fetchImpl, now })
    const { url, options } = calls.at(-1)
    assert.equal(url, 'https://api.github.com/app/installations/173164679/access_tokens')
    assert.equal(options.method, 'POST')
    assert.equal(options.redirect, 'error')
    assert.ok(options.signal instanceof AbortSignal)
    assert.deepEqual(JSON.parse(options.body), { repository_ids: [repositoryId], permissions: { contents: 'read' } })
    const [header, claims, signature] = options.headers.Authorization.slice('Bearer '.length).split('.')
    assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url')), { alg: 'RS256', typ: 'JWT' })
    assert.deepEqual(JSON.parse(Buffer.from(claims, 'base64url')), {
      iat: now() / 1000 - 60, exp: now() / 1000 - 60 + 9 * 60, iss: '12345',
    })
    assert.equal(verify('RSA-SHA256', Buffer.from(`${header}.${claims}`), publicKey, Buffer.from(signature, 'base64url')), true)
    assert.equal(result.GIT_CONFIG_COUNT, '1')
    assert.equal(result.GIT_CONFIG_KEY_0, 'http.https://github.com/.extraheader')
    assert.equal(result.GIT_CONFIG_VALUE_0, `AUTHORIZATION: basic ${Buffer.from(`x-access-token:fresh-token-${calls.length}`).toString('base64')}`)
    assert.equal(result.PATH, env.PATH)
    for (const key of Object.keys(env).filter(key => key.startsWith('PRIVATE_SOURCE_') || key.endsWith('_READ_TOKEN'))) assert.equal(result[key], undefined)
  }
  assert.equal(calls.length, 2)
})

test('manual tokens use the same ephemeral Git header and compiler environments remove source credentials', async () => {
  const result = await privateSourceGitEnvironment({
    env, repository: 'alexj11324/mikka-cloud', token: 'manual-token',
    fetchImpl: () => { throw new Error('manual token unexpectedly minted') },
  })
  assert.equal(result.GIT_CONFIG_VALUE_0, `AUTHORIZATION: basic ${Buffer.from('x-access-token:manual-token').toString('base64')}`)
  assert.deepEqual(privateSourceCompilerEnvironment(env), { PATH: env.PATH, WORKERS_CI: '1' })
  assert.equal(env.MIKKA_CLOUD_READ_TOKEN, 'old-cloud-token')
})

test('unknown repositories and malformed source credentials fail before making requests', async () => {
  let calls = 0
  const fetchImpl = () => { calls++; throw new Error('unexpected request') }
  await assert.rejects(privateSourceGitEnvironment({ env, repository: 'alexj11324/Mikka', token: 'manual', fetchImpl }), /PRIVATE_SOURCE_REPOSITORY_INVALID/)
  for (const override of [
    { PRIVATE_SOURCE_GITHUB_APP_ID: '' }, { PRIVATE_SOURCE_GITHUB_APP_INSTALLATION_ID: 'https://wrong-host' },
    { PRIVATE_SOURCE_GITHUB_APP_PRIVATE_KEY: undefined },
  ]) await assert.rejects(privateSourceGitEnvironment({ env: { ...env, ...override }, repository: 'alexj11324/mikka-cloud', fetchImpl }), /PRIVATE_SOURCE_APP_CREDENTIALS_REQUIRED/)
  assert.equal(calls, 0)
})

test('provider, signing and malformed response errors cannot expose credentials or response bodies', async () => {
  for (const options of [
    { fetchImpl: async () => { throw new Error(`transport leaked ${env.PRIVATE_SOURCE_GITHUB_APP_PRIVATE_KEY}`) } },
    { fetchImpl: async () => ({ status: 403, json: async () => { throw new Error('secret response body') } }) },
    { fetchImpl: async () => ({ status: 201, json: async () => { throw new Error('secret response body') } }) },
    { fetchImpl: async () => ({ status: 201, json: async () => ({ token: 'secret', expires_at: 'invalid' }) }) },
    { fetchImpl: async () => ({ status: 201, json: async () => ({ token: 'secret', expires_at: '2026-11-12T22:59:59Z' }) }) },
    { fetchImpl: async () => ({ status: 201, json: async () => ({ token: 'secret\nheader', expires_at: '2026-11-13T00:00:00Z' }) }) },
    { env: { ...env, PRIVATE_SOURCE_GITHUB_APP_PRIVATE_KEY: 'invalid-secret-key' } },
  ]) await assert.rejects(privateSourceGitEnvironment({ env, repository: 'alexj11324/mikka-cloud', now, ...options }), { message: 'PRIVATE_SOURCE_APP_TOKEN_FAILED' })
})
