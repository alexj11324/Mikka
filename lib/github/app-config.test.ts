import assert from 'node:assert/strict'
import { generateKeyPairSync, randomBytes } from 'node:crypto'
import test from 'node:test'
import { GitHubAppSetupError, githubSignInClient, readGitHubAppConfig, resolveGitHubAppConfig, sealGitHubAppConfig, type GitHubAppCredentials, type GitHubAppQuery } from './app-config'
import { githubAppEnvironmentConfig } from './app-env'
import { githubAppInstallUrlFromSlug } from './install-url'
import { sealSecret } from '@/lib/secrets/crypto'

const credentials: GitHubAppCredentials = {
  id: '78412345', slug: 'self-hosted-fixture',
  pem: generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  webhookSecret: randomBytes(32).toString('hex'), clientId: 'Iv23.fixtureapp', clientSecret: randomBytes(32).toString('hex'),
}
const env = { WORKSPACE_SECRETS_KEY: randomBytes(32).toString('hex'), GITHUB_APP_ID: 'different-cloud-app', GITHUB_APP_SLUG: 'cloud-fixture',
  GITHUB_APP_PRIVATE_KEY: 'different-pem', GITHUB_WEBHOOK_SECRET: 'different-webhook', GITHUB_CLIENT_ID: 'different-oauth', GITHUB_CLIENT_SECRET: 'different-secret' }
const failure = (detail: string) => (error: unknown) => error instanceof GitHubAppSetupError && error.detail === detail

test('all six App fields are authenticated ciphertext and the stored App wins over every environment field', () => {
  const sealed = sealGitHubAppConfig(credentials, env)
  for (const value of Object.values(credentials)) assert.ok(!JSON.stringify(sealed).includes(value))
  assert.deepEqual(resolveGitHubAppConfig(sealed, env), { source: 'database', ...credentials })
  assert.equal(githubAppInstallUrlFromSlug(resolveGitHubAppConfig(sealed, env).slug), 'https://github.com/apps/self-hosted-fixture/installations/new')
  const second = sealGitHubAppConfig(credentials, env)
  assert.notEqual(sealed.iv, second.iv)
  assert.notEqual(sealed.ciphertext, second.ciphertext)
})

test('tampered, moved, unknown-version and wrong-key records fail closed instead of selecting the environment App', () => {
  const sealed = sealGitHubAppConfig(credentials, env)
  const badCiphertext = Buffer.from(sealed.ciphertext, 'base64'); badCiphertext[0] ^= 1
  for (const stored of [{ ...sealed, ciphertext: badCiphertext.toString('base64') }, { ...sealed, keyVersion: 999 }, sealSecret(JSON.stringify(credentials), 'different-row', env)]) {
    assert.throws(() => resolveGitHubAppConfig(stored, env), failure('encryption'))
  }
  assert.throws(() => resolveGitHubAppConfig(sealed, { ...env, WORKSPACE_SECRETS_KEY: randomBytes(32).toString('hex') }), failure('encryption'))
  assert.throws(() => resolveGitHubAppConfig(sealed, {}), failure('encryption'))
  assert.deepEqual(resolveGitHubAppConfig(null, env), githubAppEnvironmentConfig(env))
})

test('database failures do not silently use a different App and retain their cause', async () => {
  const cause = new Error('database fixture unavailable')
  const query = { query: async () => { throw cause } } as unknown as GitHubAppQuery
  await assert.rejects(readGitHubAppConfig({ query, env }), error => failure('storage')(error) && (error as Error).cause === cause)
  const absent = { query: async () => ({ rows: [] }) } as unknown as GitHubAppQuery
  assert.deepEqual(await readGitHubAppConfig({ query: absent, env }), githubAppEnvironmentConfig(env))
})

test('the official cloud App uses its deployment configuration without a self-hosted credential lookup', async () => {
  let reads = 0
  const query = { query: async () => { reads++; throw new Error('official App must not read self-hosted credentials') } } as unknown as GitHubAppQuery
  assert.deepEqual(await readGitHubAppConfig({ query, env: { ...env, MIKKA_EDITION: 'cloud' } }), githubAppEnvironmentConfig(env))
  assert.equal(reads, 0)
})

test('community still reads and selects its stored App ahead of environment credentials', async () => {
  let reads = 0
  const stored = sealGitHubAppConfig(credentials, env)
  const query = { query: async () => { reads++; return { rows: [stored] } } } as unknown as GitHubAppQuery
  assert.deepEqual(await readGitHubAppConfig({ query, env: { ...env, MIKKA_EDITION: 'community' } }), { source: 'database', ...credentials })
  assert.equal(reads, 1)
})

test('sign-in uses the original OAuth client unless App sign-in is explicitly selected', async () => {
  assert.deepEqual(await githubSignInClient(env), { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET, enabled: true })
  assert.deepEqual(await githubSignInClient({}), { clientId: '', clientSecret: '', enabled: false })
  assert.deepEqual(await githubSignInClient({ GITHUB_SIGN_IN_USE_APP: 'false' }), { clientId: '', clientSecret: '', enabled: false })
})
