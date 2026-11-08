import assert from 'node:assert/strict'
import test from 'node:test'
import { githubRepository, openRunPullRequest, PublicationError } from './run-pull-request'
import { bodyWithPublicationEvidence, publicationEvidenceDigest, validPublicationEvidence, type PublicationEvidence } from '../captures/publication-contract'

const issueId = '10000000-0000-4000-8000-000000000001'
const commit = 'a'.repeat(40)
const token = 'synthetic-user-token'
const input = { remoteKey: 'v2/github.com/owner/repo', githubAccountId: '456', token, issueId, identifier: 'MIK-42', title: 'Fix redirect', summary: 'Fixed and verified.', branch: 'mikka/mik-42', commit, baseBranch: null }
const marker = `<!-- mikka-issue:${issueId} -->`
const pr = { number: 77, node_id: 'PR_synthetic_77', html_url: 'https://github.com/owner/repo/pull/77', state: 'open', draft: false, merged_at: null, body: `Result\n\n${marker}`, head: { ref: input.branch, sha: commit, repo: { id: 789 } }, base: { repo: { id: 789 } } }

function stub(options: { installation?: 'allowed' | 'denied'; title?: string; userId?: number; repository?: 'missing' | 'renamed'; existing?: unknown[]; create?: 'timeout' | '422' | 'malformed'; head?: string; headAfterRead?: string; prHead?: string; patchHead?: string; patch?: 'malformed' | 'timeout'; lines?: { additions: number; deletions: number } } = {}) {
  const calls: { path: string; method: string; body: Record<string, unknown> | null; authorization: string }[] = []
  let created = false, patched = false, headReads = 0
  let current = { ...pr, ...((options.existing?.[0] ?? {}) as typeof pr) }
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
    if (path.endsWith('/git/ref/heads/mikka/mik-42')) return Response.json({ object: { sha: ++headReads > 1 ? options.headAfterRead ?? options.head ?? commit : options.head ?? commit } })
    if (path.endsWith('/pulls') && method === 'GET') {
      assert.equal(parsed.searchParams.get('head'), 'owner:mikka/mik-42')
      assert.equal(parsed.searchParams.get('state'), 'all')
      return Response.json(created || patched ? [current] : options.existing ?? [])
    }
    if (path.endsWith('/pulls') && method === 'POST') {
      created = true
      current = { ...pr, head: {...pr.head,sha:options.prHead ?? commit}, body: String(body?.body ?? ''), draft: body?.draft === true }
      if (options.create === 'timeout') throw new Error('transport failure containing synthetic-secret')
      if (options.create === '422') return Response.json({ message: 'synthetic-secret' }, { status: 422 })
      if (options.create === 'malformed') return Response.json({}, { status: 201 })
      return Response.json({ ...current, ...(options.title ? { title: options.title } : {}), ...options.lines, draft: body?.draft === true }, { status: 201 })
    }
    if (path.endsWith('/pulls/77') && method === 'GET') return Response.json(current)
    if (path.endsWith('/pulls/77') && method === 'PATCH') {
      patched = true
      current = { ...current, head:{...current.head,sha:options.patchHead ?? current.head.sha}, body: String(body?.body ?? '') }
      if (options.patch === 'timeout') throw new Error('ambiguous patch')
      if (options.patch === 'malformed') return Response.json({ ...current, body: `Missing evidence\n\n${marker}` })
      return Response.json(current)
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

function visualEvidence(patch: Partial<PublicationEvidence> = {}): PublicationEvidence {
  const unsigned = {
    version: 1 as const, taskId: '20000000-0000-4000-8000-000000000001', candidateId: '30000000-0000-4000-8000-000000000001',
    runId: '40000000-0000-4000-8000-000000000001', sha: commit, userId: 'owner', issueId,
    captures: [{ captureId: '50000000-0000-4000-8000-000000000001', kind: 'video' as const, contentType: 'video/mp4' as const,
      size: 1024, durationMs: 1500, sha256: '1'.repeat(64), url: `https://mikka.example/mikka/api/captures/shared/mkc_${'v'.repeat(32)}` }],
    ...patch,
  }
  return { ...unsigned, digest: publicationEvidenceDigest(unsigned) }
}

test('a verified capture receipt appears in the created PR description and is acknowledged by its digest', async () => {
  const evidence = visualEvidence(), { fetcher, calls } = stub()
  const published = await openRunPullRequest({ ...input, fetcher, visualEvidence: evidence })
  assert.equal(published.evidenceDigest, evidence.digest)
  const body = String(calls.find(call => call.method === 'POST' && call.path.endsWith('/pulls'))?.body?.body)
  assert.ok(body.includes(evidence.captures[0].url)); assert.ok(body.includes(commit)); assert.ok(body.endsWith(marker))
  assert.ok(!body.includes(`/api/captures/${evidence.captures[0].captureId}`), 'private capture URLs never enter the public PR')
  assert.equal(calls.filter(call => call.method === 'PATCH').length, 0)
})

test('a new Factory PR uses host prose without disclosing the private task title, summary, URLs, personal data or keys', async () => {
  const { fetcher,calls }=stub()
  const privateValues=['alice.patient@example.invalid','https://internal.invalid/customer/123','ghp_0123456789abcdefghijklmnop','PRIVATE-PROJECT-CODE']
  await openRunPullRequest({...input,fetcher,visualEvidence:visualEvidence(),identifier:privateValues[3],
    title:`Private record for ${privateValues[0]}`,summary:privateValues.join(' ')})
  const created=calls.find(call=>call.method==='POST'&&call.path.endsWith('/pulls'))!
  assert.equal(created.body?.title,`Factory implementation (${issueId})`)
  const publicBody=String(created.body?.body)
  assert.ok(publicBody.includes('Implementation prepared for human review'))
  for (const value of privateValues) assert.ok(!JSON.stringify(created.body).includes(value))
  assert.ok(publicBody.endsWith(marker))
})

test('a repaired run updates only the managed evidence block, preserves human prose and is idempotent', async () => {
  const old = visualEvidence({ sha: 'b'.repeat(40) }), current = visualEvidence()
  const initial = bodyWithPublicationEvidence(`Human introduction\n\n${marker}`, issueId, old)!.replace('\n\n' + marker, '\n\nHuman follow-up.\n\n' + marker)
  const { fetcher, calls } = stub({ existing: [{ ...pr, body: initial }] })
  let fenced = false
  const guarded: typeof fetch = async (url, init) => {
    if (init?.method === 'PATCH') assert.ok(fenced)
    return fetcher(url, init)
  }
  const withWrite = async <T>(write: () => Promise<T>) => { fenced = true; try { return await write() } finally { fenced = false } }
  const first = await openRunPullRequest({ ...input, fetcher: guarded, visualEvidence: current, withWrite })
  assert.equal(first.evidenceDigest, current.digest)
  const patch = String(calls.find(call => call.method === 'PATCH')?.body?.body)
  assert.ok(patch.includes('Human introduction')); assert.ok(patch.includes('Human follow-up.'))
  assert.ok(patch.includes(current.digest)); assert.ok(!patch.includes(old.digest)); assert.ok(patch.endsWith(marker))
  assert.equal((await openRunPullRequest({ ...input, fetcher, visualEvidence: current })).evidenceDigest, current.digest)
  assert.equal(calls.filter(call => call.method === 'PATCH').length, 1)
})

test('private, credential-bearing, foreign-shaped or mismatched evidence never sends a GitHub request', async () => {
  const original = visualEvidence()
  for (const url of [
    `https://mikka.example/api/captures/${original.captures[0].captureId}`,
    `https://user:password@mikka.example/api/captures/shared/mkc_${'v'.repeat(32)}`,
    `https://mikka.example/api/captures/shared/mkc_${'v'.repeat(32)}?token=secret`,
    `http://mikka.example/api/captures/shared/mkc_${'v'.repeat(32)}`,
    `https://127.0.0.1/api/captures/shared/mkc_${'v'.repeat(32)}`,
    `https://mikka.example/api/captures/shared/mkc_${'v'.repeat(32)}\n`,
  ]) {
    const evidence = visualEvidence({ captures: [{ ...original.captures[0], url }] })
    assert.equal(validPublicationEvidence(evidence), null)
    const { fetcher, calls } = stub()
    await assert.rejects(openRunPullRequest({ ...input, fetcher, visualEvidence: evidence }), { code: 'factory_public_evidence_required' })
    assert.equal(calls.length, 0)
  }
  for (const evidence of [visualEvidence({ sha: 'b'.repeat(40) }), { ...original, digest: '0'.repeat(64) },
    visualEvidence({captures:[{...original.captures[0],size:101*1024*1024}]})]) {
    const { fetcher, calls } = stub()
    await assert.rejects(openRunPullRequest({ ...input, fetcher, visualEvidence: evidence }), { code: 'factory_public_evidence_required' })
    assert.equal(calls.length, 0)
  }
})

test('a missing evidence write acknowledgement never returns a successful publication receipt', async () => {
  const { fetcher } = stub({ existing: [pr], patch: 'malformed' })
  await assert.rejects(openRunPullRequest({ ...input, fetcher, visualEvidence: visualEvidence() }), { code: 'github_request_failed' })
})

test('Factory evidence never acknowledges another commit when the branch changes during create or reuse', async () => {
  const evidence=visualEvidence(), other='b'.repeat(40)
  const created=stub({headAfterRead:other})
  await assert.rejects(openRunPullRequest({...input,visualEvidence:evidence,fetcher:created.fetcher}),{code:'branch_changed'})
  assert.equal(created.calls.filter(call=>call.method==='POST').length,0,'the ref is reread inside the create fence')
  const movedOnCreate=stub({prHead:other})
  await assert.rejects(openRunPullRequest({...input,visualEvidence:evidence,fetcher:movedOnCreate.fetcher}),{code:'branch_changed'})
  const reused=stub({headAfterRead:other,existing:[{...pr,body:bodyWithPublicationEvidence(pr.body,issueId,evidence)}]})
  await assert.rejects(openRunPullRequest({...input,visualEvidence:evidence,fetcher:reused.fetcher}),{code:'branch_changed'})
  assert.equal(reused.calls.filter(call=>call.method==='PATCH').length,0,'an unchanged managed body still rechecks its head')
  const movedOnPatch=stub({patchHead:other,existing:[pr]})
  await assert.rejects(openRunPullRequest({...input,visualEvidence:evidence,fetcher:movedOnPatch.fetcher}),{code:'branch_changed'})
})

test('an unrelated or malformed managed block is never overwritten', async () => {
  for (const body of ['Human PR', `Human\n<!-- mikka-visual-evidence:start -->\n\n${marker}`]) {
    const { fetcher, calls } = stub({ existing: [{ ...pr, body }] })
    await assert.rejects(openRunPullRequest({ ...input, fetcher, visualEvidence: visualEvidence() }), { code: 'pull_request_conflict' })
    assert.equal(calls.filter(call => call.method === 'PATCH').length, 0)
  }
})
