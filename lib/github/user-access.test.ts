import '../../tests/support/server-only.mjs'
import assert from 'node:assert/strict'
import { after, before, beforeEach, mock, test } from 'node:test'

const originalAppId = process.env.GITHUB_APP_ID
const requestHeaders = new Headers({ cookie: 'test-session' })
let user: string | null = 'person-1'
let sessionUsers: (string | null)[] = []
mock.module(new URL('../auth.ts', import.meta.url).href, { namedExports: { auth: { api: {
  getSession: async ({ headers }: { headers: Headers }) => { assert.equal(headers, requestHeaders); const id = sessionUsers.length ? sessionUsers.shift() : user; return id ? { user: { id } } : null },
  listUserAccounts: async () => assert.fail('a GitHub sign-in account is not a repository connection'),
  getAccessToken: async () => assert.fail('a GitHub sign-in token is not a repository connection'),
} } } })
let connected: { token: string; githubAccountId: string } | null = null
let connectionFails = false
let connectionLogin: string | null = null
let connectConfigured = true
mock.module(new URL('./connection.ts', import.meta.url).href, { namedExports: {
  githubConnectConfigured: () => connectConfigured,
  githubConnectionToken: async () => { if (connectionFails) throw new Error('private provider response'); return connected },
  githubConnection: async () => connectionLogin ? { githubAccountId: '42', githubLogin: connectionLogin } : null,
  disconnectGitHub: async () => {},
} })
mock.module(new URL('../request-log.ts', import.meta.url).href, { namedExports: { withRequestLog: (_path: string, handler: unknown) => handler } })

const repository = { id: 91, full_name: 'Owner/Project', private: true }
const installation = { id: 11, app_id: 4840908, suspended_at: null }
const pullRequest = { number: 7, state: 'open', merged: false, merged_at: null, updated_at: '2026-10-27T12:00:00Z', base: { repo: repository } }
const json = (value: unknown, next = false) => Response.json(value, { headers: next ? { link: '<https://api.github.com/ignored?cursor=next>; rel="next"' } : {} })
let answer: (url: URL) => Response = () => { throw new Error('Unexpected GitHub request') }
const fetchMock = mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input))
  assert.equal(url.origin, 'https://api.github.com')
  assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer private-test-token')
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
  connected = { token: 'private-test-token', githubAccountId: '42' }
  connectionFails = false
  connectionLogin = null
  connectConfigured = true
  fetchMock.mock.resetCalls()
  answer = url => {
    if (url.pathname === '/user') return json({ id: 42 })
    if (url.pathname === '/user/installations') return json({ installations: [installation] })
    if (url.pathname === '/user/installations/11/repositories') return json({ repositories: [repository] })
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

test('the connection gives the repositories, and the token stays out of the result', async () => {
  const result = await access.listAuthorizedRepositories(requestHeaders)
  assert.deepEqual(result, { userId: 'person-1', githubAccountId: '42', installations: ['11'], repositories: [{ id: '91', installationId: '11', fullName: 'Owner/Project', htmlUrl: 'https://github.com/Owner/Project', private: true }] })
  assert.equal(JSON.stringify(result).includes('private-test-token'), false)
})

test('signing in with GitHub is not a connection: the plugin says not connected and never reads the sign-in account', async () => {
  connected = null
  const body = await (await GET({ headers: requestHeaders } as Request)).json()
  assert.equal(body.connected, false)
  assert.equal(body.configured, true)
  assert.equal(fetchMock.mock.callCount(), 0)
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
  assert.equal(paths().some(path => path.includes('/12/')), false)
})

test('session, account and configuration failures do not call GitHub', async () => {
  user = null
  await assert.rejects(access.listAuthorizedRepositories(requestHeaders), failure('authRequired', 401))
  user = 'person-1'; connected = null
  await assert.rejects(access.listAuthorizedRepositories(requestHeaders), failure('githubNotConnected', 409))
  delete process.env.GITHUB_APP_ID
  await assert.rejects(access.listAuthorizedRepositories(requestHeaders), failure('githubNotConfigured', 503))
  assert.equal(fetchMock.mock.callCount(), 0)
})

test('missing or revoked token and token/account identity mismatch require reconnection', async () => {
  connectionFails = true
  await assert.rejects(access.listAuthorizedRepositories(requestHeaders), failure('githubReconnectRequired', 401))
  connectionFails = false
  answer = () => new Response('private upstream body', { status: 401 })
  await assert.rejects(access.listAuthorizedRepositories(requestHeaders), failure('githubReconnectRequired', 401))
  answer = () => json({ id: 43 })
  await assert.rejects(access.listAuthorizedRepositories(requestHeaders), failure('githubReconnectRequired', 401))
  assert.equal(paths().includes('/user/installations'), false)
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
  assert.equal('userId' in result, false)
  assert.equal(JSON.stringify(result).includes('private-test-token'), false)
  answer = url => url.pathname === '/user' ? json({ id: 42 }) : json({ installations: [] })
  assert.deepEqual(await (await call()).json(), { viewerId: 'person-1', configured: true, connected: true, login: null, installed: false, repositories: [] })
  connected = null
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
  answer = () => new Response('private revoked token response', { status: 401 })
  const response = await GET({ headers: requestHeaders } as Request)
  assert.equal(response.status, 401)
  assert.deepEqual(await response.json(), { viewerId: 'person-2', error: 'githubReconnectRequired' })
  assert.equal(response.headers.get('cache-control'), 'private, no-store')
})
