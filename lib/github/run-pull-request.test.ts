import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import test from 'node:test'
import { githubRepository, openRunPullRequest, PublicationError, verifyGitHubRepositoryAccess } from './run-pull-request'

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } })
const env = { GITHUB_APP_ID: '123', GITHUB_APP_PRIVATE_KEY: privateKey }
const issueId = '10000000-0000-4000-8000-000000000001'
const commit = 'a'.repeat(40)
const input = { remoteKey: 'v2/github.com/owner/repo', githubAccountId: '456', env, issueId, identifier: 'MIK-42', title: 'Fix redirect', summary: 'Fixed and verified.', branch: 'mikka/mik-42', commit, baseBranch: null }
const marker = `<!-- mikka-issue:${issueId} -->`
const pr = { number: 77, node_id: 'PR_synthetic_77', html_url: 'https://github.com/owner/repo/pull/77', state: 'open', draft: false, merged_at: null, body: `Result\n\n${marker}`, head: { ref: input.branch, repo: { id: 789 } }, base: { repo: { id: 789 } } }

function stub(options: { title?: string; permission?: string; userId?: number; prPermission?: string; installed?: boolean; existing?: unknown[]; create?: 'timeout' | '422' | 'malformed'; head?: string; forbiddenUser?: boolean } = {}) {
  const calls: { path: string; method: string; body: Record<string, unknown> | null; authorization: string }[] = []
  let created = false
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    const parsed = new URL(String(url))
    assert.equal(parsed.origin, 'https://api.github.com')
    assert.equal(init?.redirect, 'error')
    const path = parsed.pathname
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : null
    const authorization = new Headers(init?.headers).get('authorization') ?? ''
    calls.push({ path, method, body, authorization })
    if (path.endsWith('/installation')) return options.installed === false ? Response.json({}, { status: 404 }) : Response.json({ id: 99, suspended_at: null, permissions: { pull_requests: options.prPermission ?? 'write', contents: 'read' } })
    if (path.endsWith('/access_tokens')) return Response.json({ token: body?.permissions?.pull_requests === 'write' ? 'synthetic-write-token' : 'synthetic-read-token' })
    if (path === '/user/456') return options.forbiddenUser ? Response.json({}, { status: 404 }) : Response.json({ id: options.userId ?? 456, login: 'new-login' })
    if (path.endsWith('/collaborators/new-login/permission')) return Response.json({ permission: options.permission ?? 'write', user: { id: options.userId ?? 456, login: 'new-login' } })
    if (path === '/repos/owner/repo') return Response.json({ id: 789, full_name: 'owner/repo', default_branch: 'trunk' })
    if (path.endsWith('/git/ref/heads/mikka/mik-42')) return Response.json({ object: { sha: options.head ?? commit } })
    if (path.endsWith('/pulls') && method === 'GET') {
      assert.equal(parsed.searchParams.get('head'), 'owner:mikka/mik-42')
      assert.equal(parsed.searchParams.get('state'), 'all')
      return Response.json(created ? [pr] : options.existing ?? [])
    }
    if (path.endsWith('/pulls') && method === 'POST') {
      created = true
      if (options.create === 'timeout') throw new Error('transport failure containing synthetic-secret')
      if (options.create === '422') return Response.json({ message: 'synthetic-secret' }, { status: 422 })
      if (options.create === 'malformed') return Response.json({}, { status: 201 })
      return Response.json({ ...pr, ...(options.title ? { title: options.title } : {}), draft: body?.draft === true }, { status: 201 })
    }
    if (path === '/graphql') return Response.json({ data: { convertPullRequestToDraft: { pullRequest: { id: pr.node_id, isDraft: true } } } })
    throw new Error(`Unexpected test request ${method} ${path}`)
  }) as typeof fetch
  return { calls, fetcher }
}

test('requires canonical github.com identity; user-controlled URLs cannot receive credentials', () => {
  assert.deepEqual(githubRepository('v2/github.com/a/b'), { owner: 'a', repo: 'b', path: '/repos/a/b' })
  for (const key of ['github.com/a/b', 'https://github.com/a/b', 'v2/github.com.evil/a/b', 'v2/github.com/a/b/extra', 'v2/github.com/a/..', 'v2/file/localhost/tmp/origin', 'v2/github.com/Owner/repo']) assert.throws(() => githubRepository(key), PublicationError)
})

test('opens one issue-marked PR with default branch, restricted write token and checked owner permission', async () => {
  const { calls, fetcher } = stub()
  const bindings: unknown[] = []
  assert.deepEqual(await openRunPullRequest({ ...input, fetcher, onVerified: async binding => { bindings.push(binding) } }), { url: pr.html_url, state: 'open' })
  const tokens = calls.filter(call => call.path.endsWith('/access_tokens'))
  assert.deepEqual(tokens.map(call => call.body), [
    { repositories: ['repo'], permissions: { metadata: 'read', contents: 'read' } },
    { repository_ids: [789], permissions: { metadata: 'read', pull_requests: 'write' } },
  ])
  assert.ok(calls.findIndex(call => call.path.includes('/permission')) < calls.indexOf(tokens[1]))
  const create = calls.find(call => call.path.endsWith('/pulls') && call.method === 'POST')!
  assert.equal(create.body?.base, 'trunk')
  assert.equal(create.body?.head, input.branch)
  assert.equal(create.body?.title, 'MIK-42: Fix redirect')
  assert.ok(String(create.body?.body).endsWith(marker))
  assert.deepEqual(bindings, [{ installationId: 99, repositoryId: 789, githubAccountId: '456', defaultBranch: 'trunk' }])
})

test('a duplicate completion finds its existing PR without posting', async () => {
  const { calls, fetcher } = stub({ existing: [pr] })
  assert.deepEqual(await openRunPullRequest({ ...input, fetcher }), { url: pr.html_url, state: 'open' })
  assert.equal(calls.filter(call => call.path.endsWith('/pulls') && call.method === 'POST').length, 0)
})

test('missing verification opens an explicitly unverified draft PR', async () => {
  const { calls, fetcher } = stub()
  assert.deepEqual(await openRunPullRequest({ ...input, fetcher, draft: true }), { url: pr.html_url, state: 'draft' })
  const create = calls.find(call => call.path.endsWith('/pulls') && call.method === 'POST')!
  assert.equal(create.body?.draft, true)
  assert.match(String(create.body?.body), /Verification was not run/)
})

test('an unverified continuation converts its existing marked open PR to draft', async () => {
  const { calls, fetcher } = stub({ existing: [pr] })
  assert.deepEqual(await openRunPullRequest({ ...input, fetcher, draft: true }), { url: pr.html_url, state: 'draft' })
  assert.ok(!calls.some(call => call.path.endsWith('/pulls') && call.method === 'POST'))
  const convert = calls.find(call => call.path === '/graphql')!
  assert.deepEqual(convert.body?.variables, { id: pr.node_id })
  assert.match(String(convert.body?.query), /convertPullRequestToDraft/)
})

test('a full task output list refuses a new external PR before POST', async () => {
  const { calls, fetcher } = stub()
  await assert.rejects(openRunPullRequest({ ...input, fetcher, allowCreate: false }), { code: 'pull_request_limit' })
  assert.ok(!calls.some(call => call.path.endsWith('/pulls') && call.method === 'POST'))
})

test('each GitHub mutation uses the host authority fence, including conversion', async () => {
  for (const existing of [undefined, [pr]]) {
    const { calls, fetcher } = stub({ existing })
    let inside = false, fences = 0
    const guardedFetch: typeof fetch = async (url, init) => {
      const path = new URL(String(url)).pathname
      if ((path.endsWith('/pulls') || path === '/graphql') && init?.method === 'POST') assert.equal(inside, true)
      return fetcher(url, init)
    }
    await openRunPullRequest({ ...input, draft: Boolean(existing), fetcher: guardedFetch,
      withWrite: async write => { fences++; inside = true; try { return await write() } finally { inside = false } },
    })
    assert.equal(fences, 1)
    assert.equal(calls.filter(call => (call.path.endsWith('/pulls') || call.path === '/graphql') && call.method === 'POST').length, 1)
  }
})

test('authority lost during repository lookup prevents create and draft mutation', async () => {
  for (const existing of [undefined, [pr]]) {
    const { calls, fetcher } = stub({ existing })
    await assert.rejects(openRunPullRequest({ ...input, draft: Boolean(existing), fetcher,
      withWrite: async () => { throw new PublicationError('issue_unavailable') },
    }), { code: 'issue_unavailable' })
    assert.equal(calls.filter(call => (call.path.endsWith('/pulls') || call.path === '/graphql') && call.method === 'POST').length, 0)
  }
})

test('ambiguous POST timeout, malformed reply and concurrent 422 converge on the existing PR', async () => {
  for (const create of ['timeout', '422', 'malformed'] as const) {
    const { calls, fetcher } = stub({ create })
    assert.deepEqual(await openRunPullRequest({ ...input, fetcher }), { url: pr.html_url, state: 'open' })
    assert.equal(calls.filter(call => call.path.endsWith('/pulls') && call.method === 'POST').length, 1)
  }
})

test('reads all GitHub PR states without reopening or duplicating a closed PR', async () => {
  for (const [override, state] of [[{ draft: true }, 'draft'], [{ state: 'closed' }, 'closed'], [{ state: 'closed', merged_at: '2026-10-28T02:00:00Z' }, 'merged']] as const) {
    const { fetcher, calls } = stub({ existing: [{ ...pr, ...override }] })
    assert.equal((await openRunPullRequest({ ...input, fetcher })).state, state)
    assert.equal(calls.filter(call => call.path.endsWith('/pulls') && call.method === 'POST').length, 0)
  }
})

test('never adopts an unrelated PR sharing the branch', async () => {
  const { fetcher, calls } = stub({ existing: [{ ...pr, body: 'A human PR' }] })
  await assert.rejects(openRunPullRequest({ ...input, fetcher }), { code: 'pull_request_conflict' })
  assert.equal(calls.filter(call => call.path.endsWith('/pulls') && call.method === 'POST').length, 0)
})

test('installation, permissions and owner identity gates issue no write token or PR', async () => {
  for (const [options, code] of [
    [{ installed: false }, 'github_not_installed'], [{ prPermission: 'read' }, 'github_permission_required'],
    [{ permission: 'read' }, 'github_access_denied'], [{ userId: 999 }, 'github_access_denied'],
    [{ forbiddenUser: true }, 'github_access_denied'],
  ] as const) {
    const { fetcher, calls } = stub(options)
    await assert.rejects(openRunPullRequest({ ...input, fetcher }), { code })
    assert.ok(!calls.some(call => (call.body?.permissions as Record<string, unknown>)?.pull_requests === 'write'))
    assert.ok(!calls.some(call => call.path.endsWith('/pulls')))
  }
})

test('does not use App credentials without a linked identity, or with missing config', async () => {
  const { fetcher, calls } = stub()
  await assert.rejects(openRunPullRequest({ ...input, fetcher, githubAccountId: null }), { code: 'github_identity_required' })
  await assert.rejects(openRunPullRequest({ ...input, fetcher, env: {} }), { code: 'github_not_configured' })
  assert.equal(calls.length, 0)
})

test('verifies pushed SHA and refuses a changed branch before creating a write token', async () => {
  const { fetcher, calls } = stub({ head: 'b'.repeat(40) })
  await assert.rejects(openRunPullRequest({ ...input, fetcher }), { code: 'branch_changed' })
  assert.equal(calls.filter(call => call.path.endsWith('/access_tokens')).length, 1)
})

test('the persisted installation binding contains no token', async () => {
  const { fetcher, calls } = stub()
  assert.deepEqual(await verifyGitHubRepositoryAccess({ ...input, fetcher }), { installationId: 99, repositoryId: 789, githubAccountId: '456', defaultBranch: 'trunk' })
  assert.equal(calls.filter(call => call.path.endsWith('/access_tokens')).length, 1)
})

test('transport errors become safe retryable codes without leaking request bodies', async () => {
  const fetcher = (async () => { throw new Error('private-key-value token-value') }) as typeof fetch
  await assert.rejects(openRunPullRequest({ ...input, fetcher }), error => {
    assert.ok(error instanceof PublicationError)
    assert.equal(error.code, 'github_unavailable')
    assert.equal(error.retryable, true)
    assert.doesNotMatch(error.message, /private-key-value|token-value/)
    return true
  })
})

 test('delivery records the title returned by GitHub, including a reused PR', async () => {
  const title = 'Actual GitHub title'
  for (const options of [{ title }, { existing: [{ ...pr, title }] }]) {
    const { fetcher } = stub(options)
    const result = await openRunPullRequest({ ...input, fetcher })
    assert.equal(result.title, title)
  }
})
