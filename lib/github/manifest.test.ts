import assert from 'node:assert/strict'
import { generateKeyPairSync, randomBytes } from 'node:crypto'
import test from 'node:test'
import { isServerAdmin } from '@/lib/server-admin'
import { githubAppManifest, githubManifestAction, githubManifestStateMatches, exchangeGitHubAppManifest, startGitHubAppManifest, type GitHubAppTemplate } from './manifest'
import { GitHubAppSetupError, type GitHubAppQuery } from './app-config'
import { githubManifestOrigin } from './manifest-http'

const template: GitHubAppTemplate = { permissions: { contents: 'write', metadata: 'read' }, events: ['push'] }
const state = `ghm_${randomBytes(32).toString('base64url')}`
const pem = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
const response = { id: 78412345, slug: 'self-hosted-fixture', pem, webhook_secret: randomBytes(32).toString('hex'), client_id: 'Iv23.fixtureapp', client_secret: randomBytes(32).toString('hex') }
const failure = (detail: string) => (error: unknown) => error instanceof GitHubAppSetupError && error.detail === detail

test('manifest URLs use the operator origin and base path, with a private App and the supplied permission snapshot', () => {
  for (const basePath of ['', '/mikka']) {
    const manifest = githubAppManifest({ origin: 'https://self.example', basePath, template })
    assert.equal(manifest.url, `https://self.example${basePath || '/'}`)
    assert.equal(manifest.redirect_url, `https://self.example${basePath}/api/github/manifest/callback`)
    assert.equal(manifest.hook_attributes.url, `https://self.example${basePath}/api/webhooks/github`)
    assert.equal(manifest.setup_url, `https://self.example${basePath}/?section=plugins&app=github`.replace('/?section', basePath ? '?section' : '/?section'))
    assert.deepEqual(manifest.callback_urls, [`https://self.example${basePath}/api/auth/callback/github`])
    assert.equal(manifest.public, false)
    assert.deepEqual(manifest.default_permissions, template.permissions)
    assert.deepEqual(manifest.default_events, template.events)
  }
})

test('organization input and deployment origin cannot select an arbitrary host, path or credential recipient', () => {
  assert.equal(new URL(githubManifestAction(state)).pathname, '/settings/apps/new')
  assert.equal(new URL(githubManifestAction(state, 'team-name')).pathname, '/organizations/team-name/settings/apps/new')
  for (const organization of ['', '../attacker', 'a/b', 'a?next=evil', 'a#evil', '-team', 'team-', 'a'.repeat(40)]) assert.throws(() => githubManifestAction(state, organization), failure('request'))
  for (const origin of ['https://self.example/path', 'https://user:pass@self.example', 'javascript:alert(1)', 'not a URL']) assert.throws(() => githubAppManifest({ origin, template }), failure('origin'))
  assert.equal(githubManifestOrigin(new Request('https://self.example/api'), { BETTER_AUTH_URL: 'https://self.example' }), 'https://self.example')
  assert.throws(() => githubManifestOrigin(new Request('https://attacker.example/api', { headers: { 'x-forwarded-host': 'self.example' } }), { BETTER_AUTH_URL: 'https://self.example' }), failure('origin'))
})

test('server administration is an exact explicit user-id allowlist, not signup order or workspace role', () => {
  assert.equal(isServerAdmin('first-user', {}), false)
  assert.equal(isServerAdmin('admin', { MIKKA_SERVER_ADMIN_USER_IDS: 'administrator,other' }), false)
  assert.equal(isServerAdmin('second', { MIKKA_SERVER_ADMIN_USER_IDS: ' first, second, ' }), true)
  assert.equal(isServerAdmin('', { MIKKA_SERVER_ADMIN_USER_IDS: ',' }), false)
})

test('state comparison is exact and a missing encryption key stops before any registration is stored', async () => {
  assert.equal(githubManifestStateMatches(state, state), true)
  for (const cookie of [undefined, '', `${state}a`, `ghi_${state.slice(4)}`, state.slice(0, -1)]) assert.equal(githubManifestStateMatches(state, cookie), false)
  let queries = 0
  const query = { query: async () => { queries++; return { rowCount: 1, rows: [] } } } as unknown as GitHubAppQuery
  await assert.rejects(startGitHubAppManifest(query, { userId: 'admin', sessionId: 'session', origin: 'https://self.example' }, { env: {} }), failure('encryption'))
  assert.equal(queries, 0)
})

test('the manifest exchange only posts to the fixed GitHub endpoint, rejects redirects, and validates all six credentials', async () => {
  const code = randomBytes(20).toString('hex')
  let calls = 0
  const credentials = await exchangeGitHubAppManifest(code, async (url, init) => {
    calls++
    assert.equal(url, `https://api.github.com/app-manifests/${code}/conversions`)
    assert.equal(init?.method, 'POST')
    assert.equal(init?.redirect, 'error')
    assert.equal(init?.cache, 'no-store')
    assert.ok(init?.signal instanceof AbortSignal)
    return Response.json({ ...response, unexpected: 'discarded' })
  })
  assert.deepEqual(credentials, { id: String(response.id), slug: response.slug, pem, webhookSecret: response.webhook_secret, clientId: response.client_id, clientSecret: response.client_secret })
  await assert.rejects(exchangeGitHubAppManifest('../other', async () => { calls++; return Response.json(response) }), failure('request'))
  assert.equal(calls, 1)
  for (const body of [{ ...response, pem: 'not a private key' }, { ...response, client_secret: null }, { ...response, id: 0 }, { ...response, slug: '../evil' }]) {
    await assert.rejects(exchangeGitHubAppManifest(code, async () => Response.json(body)), failure('response'))
  }
  await assert.rejects(exchangeGitHubAppManifest(code, async () => new Response('provider body must stay private', { status: 302, headers: { location: 'https://attacker.example' } })), failure('request'))
})
