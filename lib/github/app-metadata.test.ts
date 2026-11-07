import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import test from 'node:test'
import { GitHubAppSetupError, type GitHubAppConfig, type GitHubAppQuery } from './app-config'
import { publicGitHubAppMetadata, readGitHubAppMetadata } from './app-metadata'
import { githubManifestHandlers } from './manifest-http'

const config: GitHubAppConfig = { source: 'environment', id: '12345', slug: 'fixture-app',
  pem: generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
  webhookSecret: 'fixture-webhook-secret', clientId: 'fixture-client-id', clientSecret: 'fixture-client-secret' }
const metadata = { slug: config.slug, permissions: { contents: 'write', metadata: 'read' }, events: ['push'] }

test('App metadata exposes only validated public fields and calls only fixed GET /app', async () => {
  let token = ''
  const projection = await readGitHubAppMetadata(config, async (url, init) => {
    assert.equal(url, 'https://api.github.com/app')
    assert.equal(init?.method, 'GET'); assert.equal(init?.redirect, 'error'); assert.equal(init?.cache, 'no-store')
    token = new Headers(init?.headers).get('authorization')!
    assert.match(token, /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/)
    return Response.json({ ...metadata, pem: config.pem, client_secret: config.clientSecret, html_url: 'https://attacker.example' })
  })
  assert.deepEqual(projection, metadata)
  for (const secret of [config.pem!, config.webhookSecret!, config.clientSecret!, config.clientId!, token]) assert.ok(!JSON.stringify(projection).includes(secret))
  assert.throws(() => publicGitHubAppMetadata({ ...metadata, permissions: { contents: 'provider-private-value' } }), GitHubAppSetupError)
  await assert.rejects(readGitHubAppMetadata(config, async () => Response.json({ ...metadata, slug: 'other-app' })), GitHubAppSetupError)
})

test('ordinary users cannot invoke metadata readback and a missing verified template cannot register an empty App', async () => {
  let userId = 'member', reads = 0, requests = 0
  const query = { query: async () => { throw new Error('No database mutation expected') } } as unknown as GitHubAppQuery
  const env = { BETTER_AUTH_URL: 'https://self.example', MIKKA_SERVER_ADMIN_USER_IDS: 'operator' }
  const handlers = githubManifestHandlers({ query, env, template: null,
    session: async () => ({ user: { id: userId }, session: { id: 'session' } }),
    config: async () => { reads++; return { ...config, id: null, pem: null } },
    save: async () => { throw new Error('No credential save expected') },
    fetcher: async () => { requests++; return Response.json(metadata) },
  })
  const status = await handlers.GET(new Request('https://self.example/api/github/manifest?metadata=1'))
  assert.deepEqual(await status.json(), { viewerId: 'member', admin: false })
  assert.equal(reads, 0); assert.equal(requests, 0)
  userId = 'operator'
  const start = await handlers.POST(new Request('https://self.example/api/github/manifest', { method: 'POST', headers: { origin: env.BETTER_AUTH_URL }, body: '{}' }))
  assert.equal(start.status, 503)
  assert.equal((await start.json()).detail, 'template')
  assert.equal(requests, 0)
})
