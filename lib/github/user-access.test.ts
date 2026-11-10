import '../../tests/support/server-only.mjs'
import assert from 'node:assert/strict'
import { after, before, beforeEach, mock, test } from 'node:test'
import type { RequestBudget } from '../request-budget'

const originalAppId = process.env.GITHUB_APP_ID
let cloudMode = false
let cloudCredential: { token: string; expiresAt: Date; installationId: string; githubAccountId?: string } | null = null
const cloudMint = mock.fn(async (_userId: string, _remoteKey?: string, _budget?: RequestBudget) => cloudCredential)
const cloudRepositories = mock.fn(async () => null)
mock.module(new URL('./cloud.ts', import.meta.url).href, { namedExports: {
  cloudGitHubRepositories: cloudRepositories, cloudGitHubCredential: cloudMint, useCloudGitHub: async () => cloudMode,
} })
mock.module(new URL('./app-config.ts', import.meta.url).href, { namedExports: { readGitHubAppConfig: async () => ({ id: process.env.GITHUB_APP_ID ?? null }) } })
const requestHeaders = new Headers({ cookie: 'test-session' })
let user: string | null = 'person-1'
let sessionUsers: (string | null)[] = []
let accounts = [{ id: 'internal-account', userId: 'person-1', providerId: 'github', accountId: '42' }]
const getAccessToken = mock.fn(async (_input: { headers?: Headers; body: { accountId: string; userId?: string } }) => ({ accessToken: 'private-test-token' }))
// The server-side account lookup with no request: Better Auth's adapter, by user id.
const findAccounts = mock.fn(async (userId: string) => accounts.filter(row => row.userId === userId))
mock.module(new URL('../auth.ts', import.meta.url).href, { namedExports: { auth: { api: {
  getSession: async ({ headers }: { headers: Headers }) => { assert.equal(headers, requestHeaders); const id = sessionUsers.length ? sessionUsers.shift() : user; return id ? { user: { id }, session: { id: 'github-fixture-session' } } : null },
  listUserAccounts: async () => accounts,
  getAccessToken,
}, $context: Promise.resolve({ internalAdapter: { findAccounts } }) } } })
let connected: { token: string; githubAccountId: string } | null = null
let connectionLogin: string | null = null
let connectConfigured = true
const connectionToken = mock.fn(async (_userId: string, _options?: { minValidityMs?: number; budget?: RequestBudget }) => connected)
mock.module(new URL('./connection.ts', import.meta.url).href, { namedExports: {
  githubConnectConfigured: () => connectConfigured,
  githubConnectionToken: connectionToken,
  githubConnection: async () => connectionLogin ? { githubAccountId: '42', githubLogin: connectionLogin } : null,
  disconnectGitHub: async () => {},
} })
mock.module(new URL('../request-log.ts', import.meta.url).href, { namedExports: { noteLogRpcAction: () => {}, withRequestLog: (_path: string, handler: unknown) => handler } })

const repository = { id: 91, full_name: 'Owner/Project', private: true }
const installation = { id: 11, app_id: 4840908, suspended_at: null }
const pullRequest = { number: 7, state: 'open', merged: false, merged_at: null, updated_at: '2026-10-27T12:00:00Z', base: { repo: repository } }
const json = (value: unknown, next = false) => Response.json(value, { headers: next ? { link: '<https://api.github.com/ignored?cursor=next>; rel="next"' } : {} })
let answer: (url: URL) => Response | Promise<Response> = () => { throw new Error('Unexpected GitHub request') }
let expectedToken = 'private-test-token'
const fetchMock = mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input))
  assert.equal(url.origin, 'https://api.github.com')
  assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${expectedToken}`)
  assert.equal(init?.redirect, 'error')
  assert.equal(init?.cache, 'no-store')
  return answer(url)
})
let access: typeof import('./user-access')
let GET: typeof import('../../app/api/integrations/github/route')['GET']
before(async () => {
  access = await import('./user-access')
  ;({ GET } = await import('../../app/api/integrations/github/route'))
})
beforeEach(() => {
  process.env.GITHUB_APP_ID = '4840908'
  user = 'person-1'
  sessionUsers = []
  accounts = [{ id: 'internal-account', userId: user, providerId: 'github', accountId: '42' }]
  connected = null
  cloudMode = false
  cloudCredential = null
  expectedToken = 'private-test-token'
  cloudMint.mock.resetCalls()
  cloudMint.mock.mockImplementation(async () => cloudCredential)
  cloudRepositories.mock.resetCalls()
  connectionLogin = null
  connectConfigured = true
  connectionToken.mock.resetCalls()
  connectionToken.mock.mockImplementation(async () => connected)
  getAccessToken.mock.resetCalls()
  getAccessToken.mock.mockImplementation(async () => ({ accessToken: 'private-test-token' }))
  fetchMock.mock.resetCalls()
  answer = url => {
    if (url.pathname === '/user') return json({ id: 42 })
    if (url.pathname === '/user/installations') return json({ installations: [installation] })
    if (url.pathname === '/user/installations/11/repositories') return json({ repositories: [repository] })
    if (url.pathname === '/repos/owner/project') return json(repository)
    if (url.pathname === '/repos/Owner/Project/pulls/7') return json(pullRequest)
    throw new Error(`Unexpected path ${url.pathname}`)
  }
})
after(() => {
  fetchMock.mock.restore()
  if (originalAppId === undefined) delete process.env.GITHUB_APP_ID
  else process.env.GITHUB_APP_ID = originalAppId
})
const paths = () => fetchMock.mock.calls.map(call => new URL(String(call.arguments[0])).pathname)
const failure = (code: string, status: number) => (error: unknown) => error instanceof access.GitHubAccessError && error.code === code && error.status === status


function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(accept => { resolve = accept })
  return { promise, resolve }
}
const nextTurn = () => new Promise<void>(resolve => setImmediate(resolve))

test('an exact repository read uses one viewer token for live user/App intersection and the final repository identity', async () => {
  connected = { token: 'private-test-token', githubAccountId: '42' }
  const budget = { deadline: Date.now() + 25_000, signal: new AbortController().signal }
  const credential = await access.githubRepositoryReadCredential('person-1', 'v2/github.com/owner/project', budget)
  assert.deepEqual(credential, { token: 'private-test-token', githubAccountId: '42', kind: 'user', repository: {
    id: '91', installationId: '11', fullName: 'Owner/Project', htmlUrl: 'https://github.com/Owner/Project', private: true,
  } })
  assert.deepEqual(paths(), ['/user', '/user/installations', '/user/installations/11/repositories', '/repos/owner/project'])
  assert.deepEqual(connectionToken.mock.calls.map(call => call.arguments), [['person-1', { budget }]])
  assert.equal(getAccessToken.mock.callCount(), 0)
  assert.equal(cloudMint.mock.callCount(), 0)
  assert.equal(cloudRepositories.mock.callCount(), 0, 'an exact read does not discover unrelated cloud repositories')
  assert.ok(fetchMock.mock.calls.every(call => call.arguments[1]?.signal instanceof AbortSignal))
})

test('an unselected exact repository never receives a credential, even if another repository is authorized', async () => {
  await assert.rejects(access.githubRepositoryReadCredential('person-1', 'v2/github.com/owner/unselected'), failure('githubRepositoryForbidden', 403))
  assert.deepEqual(paths(), ['/user', '/user/installations', '/user/installations/11/repositories'])
  assert.equal(cloudMint.mock.callCount(), 0)
})

test('a repository name reused for a different GitHub ID is refused after the live intersection', async () => {
  const previous = answer
  answer = url => url.pathname === '/repos/owner/project' ? json({ ...repository, id: 92 }) : previous(url)
  await assert.rejects(access.githubRepositoryReadCredential('person-1', 'v2/github.com/owner/project'), failure('githubRepositoryForbidden', 403))
  assert.equal(paths().at(-1), '/repos/owner/project')
  assert.equal(connectionToken.mock.callCount(), 1)
})

test('a cloud read mints only the frozen repository with the caller budget and then verifies its actual identity', async () => {
  cloudMode = true
  expectedToken = 'installation-read-fixture'
  cloudCredential = { token: expectedToken, installationId: '22', githubAccountId: '42', expiresAt: new Date(Date.now() + 3_600_000) }
  const budget = { deadline: Date.now() + 25_000 }
  const credential = await access.githubRepositoryReadCredential('person-1', 'v2/github.com/owner/project', budget)
  assert.equal(credential.kind, 'installation')
  assert.equal(credential.repository.id, '91')
  assert.equal(credential.repository.installationId, '22')
  assert.equal(credential.token, expectedToken)
  assert.deepEqual(cloudMint.mock.calls.map(call => call.arguments), [['person-1', 'v2/github.com/owner/project', budget]])
  assert.deepEqual(paths(), ['/repos/owner/project'])
  assert.equal(cloudRepositories.mock.callCount(), 0)
  assert.equal(connectionToken.mock.callCount(), 0)
  assert.equal(getAccessToken.mock.callCount(), 0)
})

test('a refused cloud mint never falls back to a local user credential', async () => {
  cloudMode = true
  const refusal = new Error('Fixture broker refusal')
  cloudMint.mock.mockImplementation(async () => { throw refusal })
  await assert.rejects(access.githubRepositoryReadCredential('person-1', 'v2/github.com/owner/project'), error => error === refusal)
  assert.equal(connectionToken.mock.callCount(), 0)
  assert.equal(getAccessToken.mock.callCount(), 0)
  assert.equal(fetchMock.mock.callCount(), 0)
})

test('a cloud installation credential can never supply a missing human write identity', async () => {
  cloudMode = true
  cloudCredential = { token: 'installation-read-fixture', installationId: '22', expiresAt: new Date(Date.now() + 3_600_000) }
  accounts = []
  await assert.rejects(access.githubTokenForUser('person-1'), failure('githubNotConnected', 409))
  assert.equal(cloudMint.mock.callCount(), 0)
  assert.equal(fetchMock.mock.callCount(), 0)
})

test('cancellation observed after credential persistence prevents downstream GitHub reads', async () => {
  const controller = new AbortController(), reason = new DOMException('Fixture request cancelled', 'AbortError')
  connectionToken.mock.mockImplementation(async () => {
    controller.abort(reason)
    return { token: 'private-test-token', githubAccountId: '42' }
  })
  await assert.rejects(access.githubRepositoryReadCredential('person-1', 'v2/github.com/owner/project', {
    deadline: Date.now() + 25_000, signal: controller.signal,
  }), error => error === reason)
  assert.equal(connectionToken.mock.callCount(), 1)
  assert.equal(fetchMock.mock.callCount(), 0)
  assert.equal(getAccessToken.mock.callCount(), 0)
})

test('the repository authorization chain has one aggregate page budget before an exact read', async () => {
  answer = url => {
    if (url.pathname === '/user') return json({ id: 42 })
    if (url.pathname === '/user/installations') return json({ installations: [installation] })
    if (url.pathname === '/user/installations/11/repositories') return json({ repositories: [] }, true)
    throw new Error('No exact repository request may escape an incomplete authorization catalogue')
  }
  await assert.rejects(access.githubRepositoryReadCredential('person-1', 'v2/github.com/owner/project', {
    deadline: Date.now() + 25_000,
  }), failure('githubUnavailable', 502))
  assert.equal(fetchMock.mock.callCount(), 100)
  assert.equal(paths().some(path => path.startsWith('/repos/')), false)
})

test('one fresh token starts identity and the first installation page together, then gates repositories on both', { timeout: 2_000 }, async () => {
  const userStarted = deferred<void>(), identity = deferred<Response>(), firstPage = deferred<Response>()
  const previous = answer
  answer = url => {
    if (url.pathname === '/user') { userStarted.resolve(); return identity.promise }
    if (url.pathname === '/user/installations') return firstPage.promise
    return previous(url)
  }
  let completed = false
  const pending = access.listRepositoriesForUser('person-1').finally(() => { completed = true })
  try {
    await userStarted.promise
    assert.deepEqual(paths(), ['/user', '/user/installations'])
    assert.equal(connectionToken.mock.callCount(), 1)
    assert.equal(getAccessToken.mock.callCount(), 1)
    firstPage.resolve(json({ installations: [installation] }))
    await nextTurn()
    assert.equal(completed, false)
    assert.equal(paths().some(path => path.endsWith('/repositories')), false)
    identity.resolve(json({ id: 42 }))
    assert.deepEqual((await pending).repositories.map(repo => repo.fullName), ['Owner/Project'])
    assert.equal(fetchMock.mock.callCount(), 3)
  } finally {
    identity.resolve(json({ id: 42 }))
    firstPage.resolve(json({ installations: [installation] }))
    await pending.catch(() => {})
  }
})

test('an identity rejection waits for the already-started installation read and keeps identity error priority', { timeout: 2_000 }, async () => {
  const userStarted = deferred<void>(), firstPage = deferred<Response>()
  answer = url => {
    if (url.pathname === '/user') { userStarted.resolve(); return new Response('private identity body', { status: 401 }) }
    if (url.pathname === '/user/installations') return firstPage.promise
    throw new Error('Repository read before identity approval')
  }
  let completed = false
  const pending = access.listRepositoriesForUser('person-1')
  const checked = assert.rejects(pending, failure('githubReconnectRequired', 401)).finally(() => { completed = true })
  try {
    await userStarted.promise
    await nextTurn()
    assert.deepEqual(paths(), ['/user', '/user/installations'])
    assert.equal(completed, false)
    firstPage.resolve(new Response('private installation body', { status: 503 }))
    await checked
    assert.equal(fetchMock.mock.callCount(), 2)
    assert.equal(connectionToken.mock.callCount(), 1)
  } finally {
    firstPage.resolve(json({ installations: [] }))
    await checked
  }
})

for (const scenario of [
  { name: 'identity mismatch wins over installation refusal', identity: () => json({ id: 43 }), installations: () => new Response('private body', { status: 403 }), code: 'githubReconnectRequired', status: 401 },
  { name: 'malformed identity wins over revoked installation', identity: () => json({ id: [] }), installations: () => new Response('private body', { status: 401 }), code: 'githubUnavailable', status: 502 },
  { name: 'revoked identity wins over malformed installation', identity: () => new Response('private body', { status: 401 }), installations: () => json({ installations: null }), code: 'githubReconnectRequired', status: 401 },
  { name: 'valid identity preserves installation refusal', identity: () => json({ id: 42 }), installations: () => new Response('private body', { status: 403 }), code: 'githubRepositoryForbidden', status: 403 },
]) {
  test(scenario.name, async () => {
    connected = { token: 'private-test-token', githubAccountId: '42' }
    answer = url => url.pathname === '/user' ? scenario.identity() : scenario.installations()
    await assert.rejects(access.listRepositoriesForUser('person-1'), failure(scenario.code, scenario.status))
    assert.deepEqual(paths(), ['/user', '/user/installations'])
    assert.equal(connectionToken.mock.callCount(), 1)
    assert.equal(getAccessToken.mock.callCount(), 0)
  })
}

test('only the current session account is selected, and Better Auth receives its internal id', async () => {
  accounts.unshift({ id: 'other-account', userId: 'other-person', providerId: 'github', accountId: '50' })
  const result = await access.listAuthorizedRepositories(requestHeaders)
  assert.deepEqual(result, { userId: 'person-1', githubAccountId: '42', installations: ['11'], repositories: [{ id: '91', installationId: '11', fullName: 'Owner/Project', htmlUrl: 'https://github.com/Owner/Project', private: true, description: null, homepage: null, pushedAt: null }] })
  assert.deepEqual(getAccessToken.mock.calls[0].arguments, [{ headers: requestHeaders, body: { accountId: 'internal-account' } }])
  assert.equal(JSON.stringify(result).includes('private-test-token'), false)
})

test('a Plugins → GitHub connection is used before any GitHub sign-in account, even one for another GitHub id', async () => {
  connected = { token: 'private-test-token', githubAccountId: '42' }
  accounts = [{ id: 'internal-account', userId: 'person-1', providerId: 'github', accountId: '77' }]
  const result = await access.listAuthorizedRepositories(requestHeaders)
  assert.equal(result.githubAccountId, '42')
  assert.equal(getAccessToken.mock.callCount(), 0)
})

test('a user id with no request reads that user\'s own legacy GitHub account server-side', async () => {
  findAccounts.mock.resetCalls()
  accounts = [{ id: 'other-account', userId: 'other-person', providerId: 'github', accountId: '50' }, { id: 'internal-account', userId: 'person-1', providerId: 'github', accountId: '42' }]
  answer = url => {
    if (url.pathname === '/user') return json({ id: 42, login: 'octo' })
    if (url.pathname === '/user/installations') return json({ installations: [{ ...installation, account: { login: 'octo' } }] })
    if (url.pathname === '/user/installations/11/repositories') return json({ repositories: [repository] })
    throw new Error(`Unexpected path ${url.pathname}`)
  }
  const result = await access.listRepositoriesForUser('person-1')
  assert.deepEqual(result, { githubAccountId: '42', login: 'octo', installationAccounts: ['octo'], installations: ['11'], repositories: [{ id: '91', installationId: '11', fullName: 'Owner/Project', htmlUrl: 'https://github.com/Owner/Project', private: true, description: null, homepage: null, pushedAt: null }] })
  assert.deepEqual(findAccounts.mock.calls.map(call => call.arguments), [['person-1']])
  assert.deepEqual(getAccessToken.mock.calls[0].arguments, [{ body: { accountId: 'internal-account', userId: 'person-1' } }])
  assert.equal(JSON.stringify(result).includes('private-test-token'), false)
})

test('a user id with no request uses that user\'s connection first, and has no fallback to another user\'s account', async () => {
  findAccounts.mock.resetCalls()
  connected = { token: 'private-test-token', githubAccountId: '42' }
  assert.deepEqual((await access.listRepositoriesForUser('person-1')).repositories.map(repo => repo.fullName), ['Owner/Project'])
  assert.equal(findAccounts.mock.callCount(), 0)
  connected = null
  accounts = [{ id: 'other-account', userId: 'other-person', providerId: 'github', accountId: '42' }]
  await assert.rejects(access.listRepositoriesForUser('person-1'), failure('githubNotConnected', 409))
  assert.equal(getAccessToken.mock.callCount(), 0)
})

test('the integration status names the connected GitHub login', async () => {
  connected = { token: 'private-test-token', githubAccountId: '42' }
  connectionLogin = 'octo'
  const body = await (await GET({ headers: requestHeaders } as Request)).json()
  assert.equal(body.login, 'octo')
  assert.equal(body.connected, true)
})

test('all installation and repository pages are read; other apps, suspended installs and empty repos are excluded', async () => {
  answer = url => {
    const page = url.searchParams.get('page')
    if (url.pathname === '/user') return json({ id: 42 })
    if (url.pathname === '/user/installations') return page === '1'
      ? json({ installations: [{ ...installation, app_id: 99 }, { ...installation, id: 12, suspended_at: '2026-10-27T10:00:00Z' }, installation] }, true)
      : json({ installations: [{ ...installation, id: 13 }] })
    if (url.pathname === '/user/installations/11/repositories') return page === '1' ? json({ repositories: [repository, null] }, true) : json({ repositories: [{ ...repository, id: 92, full_name: 'Owner/Second' }] })
    if (url.pathname === '/user/installations/13/repositories') return json({ repositories: [] })
    throw new Error('Unexpected repository scope')
  }
  const result = await access.listAuthorizedRepositories(requestHeaders)
  assert.deepEqual(result.installations, ['11', '13'])
  assert.deepEqual(result.repositories.map(repo => repo.id), ['91', '92'])
  assert.equal(fetchMock.mock.callCount(), 6)
  assert.deepEqual(fetchMock.mock.calls.map(call => { const url = new URL(String(call.arguments[0])); return url.pathname + url.search }), [
    '/user', '/user/installations?per_page=100&page=1',
    '/user/installations/11/repositories?per_page=100&page=1', '/user/installations/11/repositories?per_page=100&page=2',
    '/user/installations?per_page=100&page=2', '/user/installations/13/repositories?per_page=100&page=1',
  ])
  assert.equal(paths().some(path => path.includes('/12/')), false)
})

test('session, account and configuration failures do not call GitHub', async () => {
  user = null
  await assert.rejects(access.listAuthorizedRepositories(requestHeaders), failure('authRequired', 401))
  user = 'person-1'; accounts = []
  await assert.rejects(access.listAuthorizedRepositories(requestHeaders), failure('githubNotConnected', 409))
  delete process.env.GITHUB_APP_ID
  await assert.rejects(access.listAuthorizedRepositories(requestHeaders), failure('githubNotConfigured', 503))
  assert.equal(fetchMock.mock.callCount(), 0)
})

test('missing or revoked token and token/account identity mismatch require reconnection', async () => {
  getAccessToken.mock.mockImplementation(async () => { throw new Error('private provider response') })
  await assert.rejects(access.listAuthorizedRepositories(requestHeaders), failure('githubReconnectRequired', 401))
  getAccessToken.mock.mockImplementation(async () => ({ accessToken: 'private-test-token' }))
  answer = () => new Response('private upstream body', { status: 401 })
  await assert.rejects(access.listAuthorizedRepositories(requestHeaders), failure('githubReconnectRequired', 401))
  answer = () => json({ id: 43 })
  await assert.rejects(access.listAuthorizedRepositories(requestHeaders), failure('githubReconnectRequired', 401))
  assert.deepEqual(paths(), ['/user', '/user/installations', '/user', '/user/installations'])
})

test('permissions and upstream faults fail clearly without exposing provider bodies', async () => {
  for (const [status, code, expected] of [[403, 'githubRepositoryForbidden', 403], [404, 'githubRepositoryForbidden', 403], [500, 'githubUnavailable', 502]] as const) {
    answer = () => new Response('private provider error with credentials', { status })
    await assert.rejects(access.listAuthorizedRepositories(requestHeaders), failure(code, expected))
  }
  answer = () => new Response('rate limit', { status: 403, headers: { 'x-ratelimit-remaining': '0' } })
  await assert.rejects(access.listAuthorizedRepositories(requestHeaders), failure('githubUnavailable', 502))
  answer = () => json({ installations: 'malformed' })
  await assert.rejects(access.listAuthorizedRepositories(requestHeaders), failure('githubUnavailable', 502))
})

test('PR state comes from the authorized repository and returns canonical data', async () => {
  for (const [state, merged, expected] of [['open', false, 'open'], ['closed', false, 'closed'], ['closed', true, 'merged']] as const) {
    const previous = answer
    answer = url => url.pathname.startsWith('/repos/') ? json({ ...pullRequest, state, merged }) : previous(url)
    const result = await access.readAuthorizedPullRequest(requestHeaders, 'https://github.com/owner/project/pull/7/')
    assert.deepEqual(result, { userId: 'person-1', githubAccountId: '42', repoId: '91', installationId: '11', number: 7, url: 'https://github.com/Owner/Project/pull/7', state: expected, updatedAt: '2026-10-27T12:00:00Z' })
  }
})

test('PR URLs cannot redirect credentials or select another host', async () => {
  for (const url of ['http://github.com/Owner/Project/pull/7', 'https://github.com.evil.test/Owner/Project/pull/7', 'https://evil.test/Owner/Project/pull/7', 'https://github.com@evil.test/Owner/Project/pull/7', 'https://github.com/Owner/Project/pull/7?url=https://evil.test', 'https://github.com/Owner/Project/pull/7#x', 'https://github.com/Owner/Project/pull/9007199254740992', 'https://github.com/Owner/Project/pull/0']) {
    await assert.rejects(access.readAuthorizedPullRequest(requestHeaders, url), failure('githubPullRequestInvalid', 400))
  }
  assert.equal(fetchMock.mock.callCount(), 0)
  assert.equal(getAccessToken.mock.callCount(), 0)
})

test('unknown repository and repository removed between requests cannot be read', async () => {
  await assert.rejects(access.readAuthorizedPullRequest(requestHeaders, 'https://github.com/Owner/Unselected/pull/7'), failure('githubRepositoryForbidden', 403))
  assert.equal(paths().some(path => path.startsWith('/repos/')), false)
  await access.readAuthorizedPullRequest(requestHeaders, 'https://github.com/Owner/Project/pull/7')
  const previous = answer
  answer = url => url.pathname.endsWith('/repositories') ? json({ repositories: [] }) : previous(url)
  fetchMock.mock.resetCalls()
  await assert.rejects(access.readAuthorizedPullRequest(requestHeaders, 'https://github.com/Owner/Project/pull/7'), failure('githubRepositoryForbidden', 403))
  assert.equal(paths().some(path => path.startsWith('/repos/')), false)
})

test('a mismatched repository or malformed PR response is never persisted as trusted status', async () => {
  const previous = answer
  answer = url => url.pathname.startsWith('/repos/') ? json({ ...pullRequest, base: { repo: { id: 92 } } }) : previous(url)
  await assert.rejects(access.readAuthorizedPullRequest(requestHeaders, 'https://github.com/Owner/Project/pull/7'), failure('githubUnavailable', 502))
})

test('issue readback uses the selected repository and rejects PR objects without returning private content', async () => {
  const previous=answer
  const issue={id:703,number:7,html_url:'https://github.com/Owner/Project/issues/7',state:'open',updated_at:'2026-10-31T04:00:00Z',body:'private provider body'}
  answer=url=>url.pathname==='/repos/Owner/Project/issues/7'?json(issue):previous(url)
  assert.deepEqual(await access.readAuthorizedIssue(requestHeaders,issue.html_url),{userId:'person-1',githubAccountId:'42',repoId:'91',installationId:'11',issueId:'703',number:7,url:issue.html_url,state:'open',updatedAt:issue.updated_at})
  answer=url=>url.pathname==='/repos/Owner/Project/issues/7'?json({...issue,pull_request:{url:'https://api.github.com/repos/Owner/Project/pulls/7'}}):previous(url)
  await assert.rejects(access.readAuthorizedIssue(requestHeaders,issue.html_url),failure('githubUnavailable',502))
})

test('issue URLs cannot choose another host, redirect credentials, or infer an issue from a PR',async()=>{
  for(const url of ['https://github.com/Owner/Project/pull/7','https://github.com.evil.test/Owner/Project/issues/7','http://github.com/Owner/Project/issues/7','https://github.com/Owner/Project/issues/7?x=1','https://github.com/Owner/Project/issues/7#x'])
    await assert.rejects(access.readAuthorizedIssue(requestHeaders,url),failure('githubIssueInvalid',400))
  assert.equal(fetchMock.mock.callCount(),0)
  await assert.rejects(access.readAuthorizedIssue(requestHeaders,'https://github.com/Owner/Unselected/issues/7'),failure('githubRepositoryForbidden',403))
  assert.equal(paths().some(path=>path.startsWith('/repos/')),false)
})

test('settings API exposes connection/install state and never credentials', async () => {
  const call = () => GET({ headers: requestHeaders } as Request)
  let response = await call()
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'private, no-store')
  const result = await response.json()
  assert.equal(result.installed, true)
  assert.equal(result.viewerId, 'person-1')
  assert.equal(result.githubAccountId, '42')
  assert.equal('userId' in result, false)
  assert.equal(JSON.stringify(result).includes('private-test-token'), false)
  answer = url => url.pathname === '/user' ? json({ id: 42 }) : json({ installations: [] })
  assert.deepEqual(await (await call()).json(), { viewerId: 'person-1', configured: true, connected: true, githubAccountId: '42', login: null, installed: false, repositories: [] })
  accounts = []
  assert.deepEqual(await (await call()).json(), { viewerId: 'person-1', configured: true, connected: false, installed: false, repositories: [] })
  // Link GitHub is offered only when the connect route can start GitHub's authorization.
  connectConfigured = false
  assert.deepEqual(await (await call()).json(), { viewerId: 'person-1', configured: false, connected: false, installed: false, repositories: [] })
  connectConfigured = true
  delete process.env.GITHUB_APP_ID
  assert.deepEqual(await (await call()).json(), { viewerId: 'person-1', configured: false, connected: false, installed: false, repositories: [] })
})

test('settings API refuses repository data resolved for a different session viewer', async () => {
  sessionUsers = ['person-1', 'person-2']
  accounts = [{ id: 'internal-account', userId: 'person-2', providerId: 'github', accountId: '42' }]
  const response = await GET({ headers: requestHeaders } as Request)
  assert.equal(response.status, 401)
  assert.deepEqual(await response.json(), { viewerId: 'person-1', error: 'authRequired' })
  assert.equal(response.headers.get('cache-control'), 'private, no-store')
})

test('settings API returns sanitized auth/provider failures with no-store', async () => {
  answer = () => new Response('private token error', { status: 401 })
  let response = await GET({ headers: requestHeaders } as Request)
  assert.equal(response.status, 401)
  assert.deepEqual(await response.json(), { viewerId: 'person-1', error: 'githubReconnectRequired' })
  user = null
  response = await GET({ headers: requestHeaders } as Request)
  assert.equal(response.status, 401)
  assert.equal(response.headers.get('cache-control'), 'private, no-store')
  assert.deepEqual(await response.json(), { error: 'authRequired' })
})

test('settings errors carry the cookie viewer so another displayed account cannot offer reconnection', async () => {
  user = 'person-2'
  accounts = [{ id: 'second-account', userId: user, providerId: 'github', accountId: '42' }]
  answer = () => new Response('private revoked token response', { status: 401 })
  const response = await GET({ headers: requestHeaders } as Request)
  assert.equal(response.status, 401)
  assert.deepEqual(await response.json(), { viewerId: 'person-2', error: 'githubReconnectRequired' })
  assert.equal(response.headers.get('cache-control'), 'private, no-store')
})
