import assert from 'node:assert/strict'
import { before, beforeEach, mock, test } from 'node:test'
import { metadataSchema, withIssueMetadata } from '@/lib/issue-metadata'

const issueId = '00000000-0000-4000-8000-000000000001'
const url = 'https://github.com/private/repo/pull/81'
const content = withIssueMetadata({ type: 'doc' }, metadataSchema.parse({ pullRequests: [{ url, state: 'open' }] }))
let userId: string | null = 'viewer'
let canReadIssue = true
const issueLookup = mock.fn(async (_user: { id: string }, _issueId: string) => canReadIssue ? { content } : null)
class GitHubAccessError extends Error {
  constructor(readonly code: string, readonly status: number) { super(code) }
}
const githubResult = () => ({ userId: 'viewer', githubAccountId: '12', repoId: '34', installationId: '56', number: 81, url, state: 'merged', updatedAt: '2026-10-27T12:00:00Z', token: 'never-return-this' })
const readPr = mock.fn(async (_headers: Headers, _url: string) => githubResult())
mock.module(new URL('../../../../lib/auth.ts', import.meta.url).href, { namedExports: { auth: { api: { getSession: async () => userId ? { user: { id: userId }, session: { id: 'pull-request-status-fixture-session' } } : null } } } })
mock.module(new URL('../../../../lib/issue-access.ts', import.meta.url).href, { namedExports: { issueForUser: issueLookup } })
mock.module(new URL('../../../../lib/github/user-access.ts', import.meta.url).href, { namedExports: { GitHubAccessError, readAuthorizedPullRequest: readPr } })
const liveWorkspaceId = '00000000-0000-4000-8000-0000000000aa'
const liveLookup = mock.fn(async (_database: unknown, _workspaceDatabase: unknown, _issueId: string, _viewerId: string) => liveWorkspaceId)
mock.module(new URL('../../../../lib/live/panels.ts', import.meta.url).href, { namedExports: { documentLiveWorkspace: liveLookup } })
mock.module(new URL('../../../../lib/db/index.ts', import.meta.url).href, { namedExports: { pool: {} } })
mock.module(new URL('../../../../lib/workspace-db.ts', import.meta.url).href, { namedExports: { workspacePool: {} } })
let POST: typeof import('./route')['POST']
before(async () => { ({ POST } = await import('./route')) })
beforeEach(() => {
  userId = 'viewer'; canReadIssue = true
  issueLookup.mock.resetCalls(); readPr.mock.resetCalls()
  readPr.mock.mockImplementation(async () => githubResult())
})
const call = (body: unknown = { issueId, url }, origin: string | null = 'https://preview.example') => POST(new Request('https://preview.example/api/github/pull-request-status', {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...(origin ? { origin } : {}) }, body: JSON.stringify(body),
}))

test('requires a session and same origin before reading issues or GitHub', async () => {
  userId = null
  assert.equal((await call()).status, 401)
  userId = 'viewer'
  for (const origin of ['https://other.example', null]) assert.equal((await call(undefined, origin)).status, 403)
  assert.equal(issueLookup.mock.callCount(), 0)
  assert.equal(readPr.mock.callCount(), 0)
})

test('rejects invalid, arbitrary and unlinked URLs before GitHub access', async () => {
  for (const candidate of ['https://evil.example/repo/pull/81', `${url}?token=x`, 'https://github.com/private/repo/pull/82']) {
    const response = await call({ issueId, url: candidate })
    assert.ok([400, 404].includes(response.status))
  }
  assert.equal((await call({ issueId: 'invalid', url })).status, 400)
  assert.equal(readPr.mock.callCount(), 0)
})

test('issue visibility is checked for the current viewer before GitHub', async () => {
  canReadIssue = false
  assert.equal((await call()).status, 404)
  const [reader, requestedIssue] = issueLookup.mock.calls[0].arguments
  assert.equal(reader.id, 'viewer'); assert.equal(requestedIssue, issueId)
  const { enterprisePrincipal } = await import('@/lib/enterprise/principal')
  assert.deepEqual((reader as { id: string; [enterprisePrincipal]?: unknown })[enterprisePrincipal], { kind: 'session', sessionId: 'pull-request-status-fixture-session' })
  assert.equal(readPr.mock.callCount(), 0)
})

test('only minimal viewer-authorized state is returned and shared metadata is unchanged', async () => {
  const beforeContent = JSON.stringify(content)
  const response = await call({ issueId, url: `${url}/` })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'private, no-store')
  assert.deepEqual(await response.json(), { viewerId: 'viewer', url, state: 'merged', updatedAt: '2026-10-27T12:00:00Z', live: { workspaceId: liveWorkspaceId } })
  // The channel is the viewer's own for this task (#1212), looked up only after the task and GitHub checks.
  assert.deepEqual(liveLookup.mock.calls.at(-1)!.arguments.slice(2), [issueId, 'viewer'])
  assert.equal(readPr.mock.calls[0].arguments[1], url)
  assert.equal(JSON.stringify(content), beforeContent)
})

test('revoked repository access fails closed without stale state', async () => {
  assert.equal((await call()).status, 200)
  readPr.mock.mockImplementation(async () => { throw new GitHubAccessError('githubRepositoryForbidden', 403) })
  const response = await call()
  assert.equal(response.status, 403)
  assert.equal(response.headers.get('cache-control'), 'private, no-store')
  assert.deepEqual(await response.json(), { error: 'githubRepositoryForbidden' })
})

test('session changes and unexpected provider failures never return state or internal details', async () => {
  readPr.mock.mockImplementation(async () => ({ ...githubResult(), userId: 'other' }))
  assert.equal((await call()).status, 401)
  readPr.mock.mockImplementation(async () => { throw new Error('private provider payload') })
  const response = await call()
  assert.equal(response.status, 502)
  assert.deepEqual(await response.json(), { error: 'githubUnavailable' })
})
