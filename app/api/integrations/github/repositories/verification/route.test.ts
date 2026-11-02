import assert from 'node:assert/strict'
import { before, beforeEach, mock, test } from 'node:test'

let owner: string | null = 'owner'
let accessOwner = 'owner'
let repositories = ['Acme/Repo']
let failure: Error | null = null
const stored = new Map<string, string | null>()
const calls: unknown[][] = []
const stub = (path: string, namedExports: Record<string, unknown>) => mock.module(new URL(path, import.meta.url).href, { namedExports })
stub('../../../../../../lib/auth.ts', { auth: { api: { getSession: async () => owner ? { user: { id: owner } } : null } } })
stub('../../../../../../lib/request-log.ts', { withRequestLog: (_path: string, handler: unknown) => handler })
class GitHubAccessError extends Error {
  constructor(readonly code: string, readonly status: number) { super(code) }
}
stub('../../../../../../lib/github/user-access.ts', { GitHubAccessError, listAuthorizedRepositories: async () => {
  calls.push(['authorize'])
  if (failure) throw failure
  return { userId: accessOwner, repositories: repositories.map(fullName => ({ fullName })) }
} })
stub('../../../../../../lib/device-repositories.ts', {
  readRepositorySettings: async (userId: string, remote: string) => {
    calls.push(['read', userId, remote])
    const key = `${userId}:${remote}`
    return stored.has(key) ? { verifyCommand: stored.get(key) } : null
  },
  saveRepositoryVerifyCommand: async (userId: string, remote: string, command: string | null) => {
    calls.push(['save', userId, remote, command]); stored.set(`${userId}:${remote}`, command)
    return { verifyCommand: command }
  },
})
let route: typeof import('./route')
before(async () => { route = await import('./route') })
beforeEach(() => { owner = 'owner'; accessOwner = 'owner'; repositories = ['Acme/Repo']; failure = null; stored.clear(); calls.length = 0 })
const origin = 'https://mikka.example'
function request(method = 'GET', body?: unknown, extra: Record<string, string> = {}, cookie = true) {
  return new Request(`${origin}/api/integrations/github/repositories/verification?repository=acme/repo`, {
    method, headers: { ...(cookie ? { cookie: 'session=synthetic' } : {}), origin, 'content-type': 'application/json', ...extra },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}
const patch = (verifyCommand: unknown, extra?: Record<string, string>) => route.PATCH(request('PATCH', { repository: 'acme/repo', verifyCommand }, extra))

test('requires cookie sessions and rejects run/device bearer credentials before repository or storage access', async () => {
  for (const token of ['Bearer mkw_run', 'Bearer device_token']) {
    assert.equal((await route.GET(request('GET', undefined, { authorization: token }))).status, 401)
    assert.equal((await patch('pnpm check', { authorization: token })).status, 401)
  }
  assert.equal((await route.GET(request('GET', undefined, {}, false))).status, 401)
  owner = null
  assert.equal((await route.GET(request())).status, 401)
  assert.equal((await patch('pnpm check')).status, 401)
  assert.deepEqual(calls, [])
})

test('requires the same origin and strict bounded input before authorization or writes', async () => {
  assert.equal((await patch('pnpm check', { origin: 'https://evil.example' })).status, 403)
  assert.equal((await patch('pnpm check', { origin: '' })).status, 403)
  for (const body of [null, {}, { repository: 'acme/repo', verifyCommand: 3 }, { repository: 'acme/repo', verifyCommand: 'x'.repeat(2001) }, { repository: 'acme/repo', verifyCommand: 'ok', userId: 'peer' }, { repository: 'https://github.com/acme/repo', verifyCommand: 'ok' }]) {
    assert.equal((await route.PATCH(request('PATCH', body))).status, 400)
  }
  const malformed = new Request(`${origin}/api/integrations/github/repositories/verification`, { method: 'PATCH', headers: { cookie: 'session=synthetic', origin }, body: '{' })
  assert.equal((await route.PATCH(malformed)).status, 400)
  assert.equal((await route.GET(new Request(`${origin}/api/integrations/github/repositories/verification?repository=../repo`, { headers: { cookie: 'session=synthetic' } }))).status, 400)
  assert.deepEqual(calls.filter(call => call[0] !== 'authorize'), [])
})

test('reads null without inventing a command, saves a trimmed owner command, and clears it explicitly', async () => {
  const response = await route.GET(request())
  assert.deepEqual(await response.json(), { viewerId: 'owner', repository: 'Acme/Repo', verifyCommand: null })
  assert.equal(response.headers.get('cache-control'), 'private, no-store')
  assert.deepEqual(await (await patch('  pnpm check\n')).json(), { viewerId: 'owner', repository: 'Acme/Repo', verifyCommand: 'pnpm check' })
  assert.equal((await (await route.GET(request())).json()).verifyCommand, 'pnpm check')
  for (const command of [null, ' \n ']) {
    assert.deepEqual(await (await patch(command)).json(), { viewerId: 'owner', repository: 'Acme/Repo', verifyCommand: null })
  }
  assert.ok(calls.filter(call => ['read', 'save'].includes(String(call[0]))).every(call => call[1] === 'owner' && call[2] === 'https://github.com/Acme/Repo.git'))
})

test('rechecks live repository access for reads and writes and fails closed on identity/provider errors', async () => {
  assert.equal((await patch('pnpm check')).status, 200)
  calls.length = 0; repositories = []
  assert.equal((await route.GET(request())).status, 403)
  assert.equal((await patch('other')).status, 403)
  assert.deepEqual(calls, [['authorize'], ['authorize']])
  repositories = ['Acme/Repo']; accessOwner = 'peer'
  assert.equal((await patch('other')).status, 401)
  accessOwner = 'owner'; failure = new GitHubAccessError('githubReconnectRequired', 401)
  assert.equal((await route.GET(request())).status, 401)
  failure = new Error('provider body must stay private')
  const response = await patch('other')
  assert.equal(response.status, 502)
  assert.equal((await response.text()).includes('provider body'), false)
  assert.equal(stored.get('owner:https://github.com/Acme/Repo.git'), 'pnpm check')
})

test('the same authorized repository has independent settings for each session owner', async () => {
  await patch('owner command')
  owner = 'peer'; accessOwner = 'peer'
  assert.equal((await (await route.GET(request())).json()).verifyCommand, null)
  await patch('peer command')
  owner = 'owner'; accessOwner = 'owner'
  assert.equal((await (await route.GET(request())).json()).verifyCommand, 'owner command')
})
