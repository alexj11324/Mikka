import assert from 'node:assert/strict'
import { before, beforeEach, mock, test } from 'node:test'

let owner: string | null = 'owner'
let resultOwner = 'owner'
let cloud = true
let failure: Error | null = null
let authorizations = 0
const token = 'synthetic-provider-token-canary'
const stub = (path: string, namedExports: Record<string, unknown>) => mock.module(new URL(path, import.meta.url).href, { namedExports })
const auth = { api: { getSession: async () => owner ? { user: { id: owner } } : null } }
class GitHubAccessError extends Error {
  constructor(readonly code: string, readonly status: number) { super(code) }
}
class CloudServiceError extends Error {
  constructor(readonly code: string) { super(code) }
}
stub('../../../../lib/api-auth.ts', { auth })
stub('../../../../lib/auth.ts', { auth })
stub('../../../../lib/fresh-session.ts', { freshSessionRoute: (handler: unknown) => handler })
stub('../../../../lib/request-log.ts', { withRequestLog: (_path: string, handler: unknown) => handler })
stub('../../../../lib/github/cloud.ts', { useCloudGitHub: async () => cloud })
stub('../../../../lib/cloud-services/errors.ts', { CloudServiceError, cloudErrorStatus: () => 403 })
stub('../../../../lib/github/connection.ts', {
  githubConnection: async () => ({ githubLogin: 'test-owner', accessToken: token }),
  githubConnectConfigured: async () => true,
  disconnectGitHub: async () => assert.fail('read cannot disconnect the provider'),
})
stub('../../../../lib/github/user-access.ts', { GitHubAccessError, listAuthorizedRepositories: async () => {
  authorizations++
  if (failure) throw failure
  return { userId: resultOwner, githubAccountId: '42', token, installations: ['100'], repositories: [{ fullName: 'test/repository' }] }
} })
let route: typeof import('./route')
before(async () => { route = await import('./route') })
beforeEach(() => { owner = 'owner'; resultOwner = 'owner'; cloud = true; failure = null; authorizations = 0 })
const request = () => new Request('https://mikka.example/api/integrations/github', { headers: { cookie: 'session=synthetic' } })

test('verified cloud identity is readable by its owner without exposing credentials or making another authorization call', async () => {
  for (const isCloud of [true, false]) {
    cloud = isCloud
    const response = await route.GET(request()), body = await response.json()
    assert.equal(response.status, 200)
    assert.equal(body.viewerId, 'owner'); assert.equal(body.githubAccountId, '42')
    assert.equal(body.login, cloud ? null : 'test-owner'); assert.equal(body.source, cloud ? 'cloud' : undefined)
    assert.equal(body.connected, true); assert.equal(body.installed, true)
    assert.equal(response.headers.get('cache-control'), 'private, no-store')
    assert.equal(JSON.stringify(body).includes(token), false)
  }
  assert.equal(authorizations, 2, 'one existing authorized discovery per normal request')
})

test('anonymous and mismatched viewer identities cannot read a linked GitHub account', async () => {
  owner = null
  assert.deepEqual(await (await route.GET(request())).json(), { error: 'authRequired' })
  assert.equal(authorizations, 0)
  owner = 'owner'; resultOwner = 'peer'
  const response = await route.GET(request())
  assert.equal(response.status, 401)
  assert.deepEqual(await response.json(), { viewerId: 'owner', error: 'authRequired' })
})

test('a failed or disconnected provider cannot leave a verified account in the response', async () => {
  for (const error of [new GitHubAccessError('githubNotConnected', 409), new Error(token), new CloudServiceError('cloud_access_denied')]) {
    failure = error
    const body = await (await route.GET(request())).json()
    assert.equal(body.githubAccountId, undefined)
    assert.equal(JSON.stringify(body).includes(token), false)
  }
})
