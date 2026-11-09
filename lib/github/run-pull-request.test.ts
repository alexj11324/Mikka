import assert from 'node:assert/strict'
import test from 'node:test'
import { githubRepository, openRunPullRequest, PublicationError } from './run-pull-request'

const issueId = '10000000-0000-4000-8000-000000000001'
const commit = 'a'.repeat(40)
const token = 'synthetic-user-token'
const input = { remoteKey: 'v2/github.com/owner/repo', githubAccountId: '456', token, issueId, identifier: 'MIK-42', title: 'Fix redirect', summary: 'Fixed and verified.', branch: 'mikka/mik-42', commit, baseBranch: null }
const marker = `<!-- mikka-issue:${issueId} -->`
const pr = { number: 77, node_id: 'PR_synthetic_77', html_url: 'https://github.com/owner/repo/pull/77', state: 'open', draft: false, merged_at: null, body: `Result\n\n${marker}`, head: { ref: input.branch, repo: { id: 789 } }, base: { repo: { id: 789 } } }

function stub(options: { installation?: 'allowed' | 'denied'; title?: string; userId?: number; repository?: 'missing' | 'renamed'; existing?: unknown[]; create?: 'timeout' | '422' | 'malformed'; head?: string; lines?: { additions: number; deletions: number }; review?: boolean; checksDenied?: boolean } = {}) {
  const calls: { path: string; method: string; body: Record<string, unknown> | null; authorization: string }[] = []
  let created = false
  let createdPr: typeof pr & { title?: string; additions?: number; deletions?: number; changed_files?: number } = pr
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    const parsed = new URL(String(url))
    assert.equal(parsed.origin, 'https://api.github.com')
    assert.equal(init?.redirect, 'error')
    const path = parsed.pathname
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : null
    const authorization = new Headers(init?.headers).get('authorization') ?? ''
    calls.push({ path, method, body, authorization })
    assert.equal(authorization, `Bearer ${token}`, 'every request uses the person\'s own token')
    if (path === '/user') return Response.json({ id: options.userId ?? 456, login: 'new-login' })
    if (path === '/installation/repositories') return Response.json({ repositories: options.installation === 'allowed' ? [{ id: 789, full_name: 'owner/repo', default_branch: 'trunk' }] : [] })
    if (path === '/repos/owner/repo') return options.repository === 'missing' ? Response.json({}, { status: 404 })
      : Response.json({ id: 789, full_name: options.repository === 'renamed' ? 'owner/other' : 'owner/repo', default_branch: 'trunk' })
    if (path.endsWith('/git/ref/heads/mikka/mik-42')) return Response.json({ object: { sha: options.head ?? commit } })
    if (path.endsWith('/pulls') && method === 'GET') {
      assert.equal(parsed.searchParams.get('head'), 'owner:mikka/mik-42')
      assert.equal(parsed.searchParams.get('state'), 'all')
      return Response.json(created ? [createdPr] : options.existing ?? [])
    }
    if (path.endsWith('/pulls/77') && method === 'GET') return Response.json({ ...(created ? createdPr : options.existing?.[0] as object ?? pr), ...options.lines,
      ...(options.review ? { head: { ...pr.head, sha: commit }, changed_files: 3 } : {}) })
    if (path.endsWith('/check-runs')) return options.checksDenied ? Response.json({}, { status: 403 }) : Response.json({ total_count: 1, check_runs: [
      { id: 1, name: 'CI', head_sha: commit, app: { id: 10 }, check_suite: { id: 100 }, status: 'completed', conclusion: 'success', started_at: '2026-11-09T13:00:00Z', completed_at: '2026-11-09T13:01:00Z' },
    ] })
    if (path.endsWith('/status')) return Response.json({ sha: commit, total_count: 0, statuses: [] })
    if (path.endsWith('/pulls') && method === 'POST') {
      created = true
      createdPr = { ...pr, ...(options.title ? { title: options.title } : {}), ...options.lines, draft: body?.draft === true }
      if (options.create === 'timeout') throw new Error('transport failure containing synthetic-secret')
      if (options.create === '422') return Response.json({ message: 'synthetic-secret' }, { status: 422 })
      if (options.create === 'malformed') return Response.json({}, { status: 201 })
      return Response.json(createdPr, { status: 201 })
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

test('opens one issue-marked PR on the default branch with the person\'s own token, after checking it is theirs', async () => {
  const { calls, fetcher } = stub()
  assert.deepEqual(await openRunPullRequest({ ...input, fetcher }), { url: pr.html_url, state: 'open' })
  assert.ok(calls.findIndex(call => call.path === '/user') < calls.findIndex(call => call.path.endsWith('/pulls')))
  assert.ok(!calls.some(call => call.path.includes('/installation') || call.path.includes('/access_tokens')), 'no App installation token is minted')
  const create = calls.find(call => call.path.endsWith('/pulls') && call.method === 'POST')!
  assert.equal(create.body?.base, 'trunk')
  assert.equal(create.body?.head, input.branch)
  assert.equal(create.body?.title, 'MIK-42: Fix redirect')
  assert.ok(String(create.body?.body).endsWith(marker))
})

test('a host-issued cloud installation token verifies its repository membership without pretending to be a user', async () => {
  const { calls, fetcher } = stub({ installation: 'allowed' })
  assert.deepEqual(await openRunPullRequest({ ...input, githubAccountId: undefined, installationId: '99', fetcher }), { url: pr.html_url, state: 'open' })
  assert.ok(calls.some(call => call.path === '/installation/repositories'))
  assert.ok(!calls.some(call => call.path === '/user'))
  assert.equal(calls.filter(call => call.method === 'POST' && call.path.endsWith('/pulls')).length, 1)
})

test('an installation token that merely reads a public repository cannot publish without installation membership', async () => {
  const { calls, fetcher } = stub({ installation: 'denied' })
  await assert.rejects(openRunPullRequest({ ...input, githubAccountId: undefined, installationId: '99', fetcher }), { code: 'github_access_denied' })
  assert.ok(!calls.some(call => call.method === 'POST'))
})

test('a created PR carries the line counts GitHub reported; a reply without them stores none', async () => {
  const { fetcher } = stub({ lines: { additions: 18, deletions: 4 } })
  assert.deepEqual(await openRunPullRequest({ ...input, fetcher }), { url: pr.html_url, state: 'open', additions: 18, deletions: 4 })
  const { fetcher: bare } = stub()
  assert.deepEqual(await openRunPullRequest({ ...input, fetcher: bare }), { url: pr.html_url, state: 'open' })
})

test('a duplicate completion finds its existing PR without posting', async () => {
  const { calls, fetcher } = stub({ existing: [pr] })
  assert.deepEqual(await openRunPullRequest({ ...input, fetcher }), { url: pr.html_url, state: 'open' })
  assert.equal(calls.filter(call => call.path.endsWith('/pulls') && call.method === 'POST').length, 0)
})

test('publication ingestion resolves list omissions and synchronizes checks once for the verified PR head', async () => {
  const { calls, fetcher } = stub({ existing: [pr], lines: { additions: 8, deletions: 2 }, review: true })
  const result = await openRunPullRequest({ ...input, fetcher })
  assert.equal(result.branch, input.branch)
  assert.equal(result.headSha, commit)
  assert.equal(result.changedFiles, 3)
  assert.equal(result.additions, 8)
  assert.equal(result.reviewChecks?.complete, true)
  assert.deepEqual(Object.values(result.reviewChecks!.entries).map(item => item.state), ['passed'])
  assert.equal(calls.filter(call => call.path.endsWith('/pulls/77')).length, 1)
  assert.equal(calls.filter(call => call.path.includes(`/commits/${commit}/`)).length, 2)
  assert.equal(calls.filter(call => call.method === 'POST').length, 0)
})

test('a newly created PR resolves full details before persisting its approval summary', async () => {
  const { calls, fetcher } = stub({ review: true, lines: { additions: 7, deletions: 1 } })
  const result = await openRunPullRequest({ ...input, fetcher })
  assert.equal(result.changedFiles, 3)
  assert.equal(result.additions, 7)
  assert.equal(result.reviewChecks?.complete, true)
  assert.ok(calls.findIndex(call => call.path.endsWith('/pulls/77')) > calls.findIndex(call => call.path.endsWith('/pulls') && call.method === 'POST'))
})

test('a missing checks permission leaves review metadata unknown without blocking an existing publication', async () => {
  const { fetcher } = stub({ existing: [pr], review: true, checksDenied: true })
  const result = await openRunPullRequest({ ...input, fetcher })
  assert.equal(result.url, pr.html_url)
  assert.equal(result.reviewChecks, null)
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
  assert.equal(convert.authorization, `Bearer ${token}`)
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

test('a token of another GitHub account, or a repository it cannot reach, opens no PR', async () => {
  for (const [options, code] of [
    [{ userId: 999 }, 'github_reconnect_required'], [{ repository: 'missing' }, 'github_access_denied'], [{ repository: 'renamed' }, 'github_access_denied'],
  ] as const) {
    const { fetcher, calls } = stub(options)
    await assert.rejects(openRunPullRequest({ ...input, fetcher }), { code })
    assert.ok(!calls.some(call => call.path.endsWith('/pulls')))
  }
})

test('no token or no linked identity sends nothing to GitHub', async () => {
  const { fetcher, calls } = stub()
  await assert.rejects(openRunPullRequest({ ...input, fetcher, githubAccountId: '' }), { code: 'github_identity_required' })
  await assert.rejects(openRunPullRequest({ ...input, fetcher, token: '' }), { code: 'github_identity_required' })
  assert.equal(calls.length, 0)
})

test('verifies the pushed SHA and refuses a changed branch before any write', async () => {
  const { fetcher, calls } = stub({ head: 'b'.repeat(40) })
  await assert.rejects(openRunPullRequest({ ...input, fetcher }), { code: 'branch_changed' })
  assert.ok(!calls.some(call => call.path.endsWith('/pulls')))
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

test('GitHub rejecting the person\'s token asks them to reconnect; other refusals keep their status without the body', async () => {
  const rejected = (status: number) => (async () => Response.json({ message: 'synthetic-secret' }, { status })) as unknown as typeof fetch
  await assert.rejects(openRunPullRequest({ ...input, fetcher: rejected(401) }), { code: 'github_reconnect_required', retryable: false })
  await assert.rejects(openRunPullRequest({ ...input, fetcher: rejected(400) }), error => {
    assert.ok(error instanceof PublicationError)
    assert.equal(error.code, 'github_request_failed')
    assert.equal(error.status, 400)
    assert.doesNotMatch(error.message, /synthetic-secret|synthetic-user-token/)
    return true
  })
})
