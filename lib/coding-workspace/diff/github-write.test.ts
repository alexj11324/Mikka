import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { after, before, mock, test, type TestContext } from 'node:test'
import { CodingWorkspaceError } from '@mikka/protocol/coding-workspace'
import { diffSnapshot, WorkspaceReviewError, type DiffSnapshot, type ReviewAnchor } from '@mikka/protocol/coding-workspace-review'
import { GitHubAccessError } from '../../github/user-access-error'
import type { RequestBudget } from '../../request-budget'
import { diffDigest } from './patch'
import type { NativeReviewWrite } from './github-write'

const viewer = 'native-write-viewer', owner = 'different-run-owner', repositoryKey = 'v2/github.com/fixture/review'
const repositoryId = '9007199254740993', accountId = '9007199254740995', reviewId = '9007199254740997'
const parentId = '9007199254740999', replyId = '9007199254741001', number = 7
const fullName = 'Fixture/Review', path = '/repos/fixture/review', api = `https://api.github.com${path}/pulls/${number}`
const publicPull = `https://github.com/${fullName}/pull/${number}`, token = 'fixture-personal-review-token'
const observed = '2026-11-08T12:00:00.000Z'
const gitObject = (kind: string, value: string) => {
  const bytes = Buffer.from(value)
  return createHash('sha1').update(`${kind} ${bytes.length}\0`).update(bytes).digest('hex')
}
const emptyTree = gitObject('tree', '')
const commit = (label: string) => gitObject('commit', `tree ${emptyTree}\nauthor Fixture <fixture@example.invalid> 0 +0000\ncommitter Fixture <fixture@example.invalid> 0 +0000\n\n${label}\n`)
const baseSha = commit('base'), headSha = commit('reviewed head'), oldCommentSha = commit('original comment'), movedSha = commit('force push')
const code = (expected: string) => (error: unknown) =>
  (error instanceof CodingWorkspaceError || error instanceof WorkspaceReviewError) && error.code === expected
type UserCredential = Awaited<ReturnType<typeof import('../../github/user-access')['githubTokenForUser']>>
const userToken = mock.fn(async (_userId: string, _options: { minValidityMs?: number; budget?: RequestBudget } = {}): Promise<UserCredential> => {
  throw new Error('A write fixture must install the actual viewer credential')
})
const readCredential = mock.fn(async () => { throw new Error('An installation/read grant cannot authorize a native write') })
const credentialModule = mock.module(new URL('../../github/user-access.ts', import.meta.url).href, { namedExports: {
  githubTokenForUser: userToken, githubRepositoryReadCredential: readCredential, GitHubAccessError,
} })
let native: typeof import('./github-write')
before(async () => { native = await import('./github-write') })
after(() => credentialModule.restore())

function snapshot(): DiffSnapshot {
  return diffSnapshot.parse({ id: randomUUID(), identity: { version: 1, runId: randomUUID(), repoId: randomUUID(),
    workspaceId: randomUUID(), ownerId: owner, repositoryKey }, taskId: randomUUID(),
  revision: { source: 'pull_request', baseSha, headSha, treeSha: null, version: diffDigest('native write frozen source') },
  observedAt: observed, isStale: false, availability: 'available', reason: null,
  counts: { files: 2, additions: 2, deletions: 1, complete: true }, policy: 'whole_pull_request',
  sourceAccess: { kind: 'github', repositoryId, pullRequestNumber: number, pullRequestBaseSha: baseSha, manifestComplete: true },
  pullRequest: { number, url: publicPull, baseSha, headSha, state: 'open' } })
}
function anchor(saved: DiffSnapshot, side: 'LEFT' | 'RIGHT', start: number, end = start): ReviewAnchor {
  return { snapshotId: saved.id, sourceVersion: saved.revision.version, path: side === 'LEFT' ? 'before.ts' : 'after.ts',
    side, lineStart: start, lineEnd: end, hunkFingerprint: diffDigest(`native hunk ${side}:${start}:${end}`) }
}
type Review = Extract<NativeReviewWrite, { kind: 'github_review' }>
type ProviderReceipt = { id: string | number; body: string; user: { id: string | number }; html_url: string;
  pull_request_url: string; commit_id: string; state?: string; submitted_at?: string | null; in_reply_to_id?: string | null }
type InlineComment = { id: string; pull_request_review_id: string; body: string; user: { id: string };
  html_url: string; pull_request_url: string; commit_id: string; original_commit_id: string; path: string;
  side: 'LEFT' | 'RIGHT'; line: number; original_line: number; start_side: 'LEFT' | 'RIGHT' | null;
  start_line: number | null; original_start_line: number | null; in_reply_to_id: null }

function fixture(t: TestContext, kind: NativeReviewWrite['kind'] = 'github_review', event: Review['event'] = 'COMMENT') {
  const saved = snapshot(), batchId = randomUUID(), fingerprint = diffDigest('first durable native batch')
  const marker = `<!-- mikka-workspace-review:${batchId}:${fingerprint} -->`
  const write: NativeReviewWrite = kind === 'github_reply' ? { kind, commentId: parentId, body: 'Reply to the original native thread.' }
    : { kind, event, note: 'Explicit review decision.', comments: [
      { id: randomUUID(), anchor: anchor(saved, 'LEFT', 4), body: 'Please preserve the old-side behavior.' },
      { id: randomUUID(), anchor: anchor(saved, 'RIGHT', 8, 10), body: 'These three new lines need a guard.' },
    ] }
  const body = `${write.kind === 'github_reply' ? write.body : write.note}\n\n${marker}`
  const receipt: ProviderReceipt = { id: kind === 'github_review' ? reviewId : replyId, body, user: { id: accountId },
    html_url: `${publicPull}#${kind === 'github_review' ? `pullrequestreview-${reviewId}` : `discussion_r${replyId}`}`,
    pull_request_url: api, commit_id: kind === 'github_reply' ? oldCommentSha : headSha,
    ...(kind === 'github_review' ? { state: { COMMENT: 'COMMENTED', REQUEST_CHANGES: 'CHANGES_REQUESTED', APPROVE: 'APPROVED' }[event],
      submitted_at: observed } : { in_reply_to_id: parentId }) }
  const inline: InlineComment[] = write.kind === 'github_review' ? write.comments.map((item, index) => {
    const id = (9007199254741101n + BigInt(index)).toString(), multiple = item.anchor.lineStart !== item.anchor.lineEnd
    return { id, pull_request_review_id: reviewId, body: item.body, user: { id: accountId },
      html_url: `${publicPull}#discussion_r${id}`, pull_request_url: api, commit_id: headSha, original_commit_id: headSha,
      path: item.anchor.path, side: item.anchor.side, line: item.anchor.lineEnd, original_line: item.anchor.lineEnd,
      start_side: multiple ? item.anchor.side : null, start_line: multiple ? item.anchor.lineStart : null,
      original_start_line: multiple ? item.anchor.lineStart : null, in_reply_to_id: null }
  }) : []
  const state = {
    repository: { id: repositoryId, full_name: fullName },
    pull: { number, html_url: publicPull, state: 'open', merged: false, changed_files: 2,
      base: { sha: baseSha, repo: { id: repositoryId, full_name: fullName } }, head: { sha: headSha } },
    parent: { id: parentId, pull_request_url: api, in_reply_to_id: null as string | null, path: 'after.ts',
      commit_id: oldCommentSha, original_commit_id: oldCommentSha },
    receipt, inline, inlineByReview: new Map([[reviewId, inline]]), rows: [receipt] as ProviderReceipt[], next: false, inlineNext: false,
    gateReady: false, onFetch: undefined as ((url: URL, init: RequestInit) => Response | undefined) | undefined,
  }
  const calls: { url: URL; method: string; payload?: Record<string, unknown> }[] = [], events: string[] = []
  const budget: RequestBudget = { deadline: Date.now() + 30_000, signal: new AbortController().signal }
  userToken.mock.resetCalls(); readCredential.mock.resetCalls()
  userToken.mock.mockImplementation(async (userId, options) => {
    events.push(`token:${userId}`)
    assert.equal(userId, viewer)
    assert.deepEqual(options, { minValidityMs: 45_000, budget })
    return { token, githubAccountId: accountId, expiresAt: new Date(Date.now() + 60_000) }
  })
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input)), method = init.method ?? 'GET'
    const payload = init.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined
    calls.push({ url, method, ...(payload ? { payload } : {}) }); events.push(`${method} ${url.pathname}`)
    assert.equal(url.origin, 'https://api.github.com')
    assert.equal(init.redirect, 'error'); assert.equal(init.credentials, 'omit'); assert.equal(init.cache, 'no-store')
    assert.equal(new Headers(init.headers).get('authorization'), `Bearer ${token}`)
    assert.ok(init.signal instanceof AbortSignal)
    const response = state.onFetch?.(url, init)
    if (response) return response
    if (method === 'POST') {
      assert.equal(state.gateReady, true, 'beforeSend must finish before any provider write')
      assert.equal(url.pathname, `${path}/pulls/${number}/${kind === 'github_review' ? 'reviews' : `comments/${parentId}/replies`}`)
      return Response.json(state.receipt, { status: 201 })
    }
    if (url.pathname === path) return Response.json(state.repository)
    if (url.pathname === `${path}/pulls/${number}`) return Response.json(state.pull)
    if (url.pathname === `${path}/pulls/comments/${parentId}`) return Response.json(state.parent)
    // The official PR comments example includes original line/side fields;
    // the review-scoped list example omits those modern coordinates.
    // https://docs.github.com/en/rest/pulls/comments#list-review-comments-on-a-pull-request
    if (kind === 'github_review' && url.pathname === `${path}/pulls/${number}/comments`) {
      assert.equal(url.searchParams.get('per_page'), '100')
      return Response.json([...state.inlineByReview.values()].flat(), { headers: state.inlineNext ? { link: '<https://outside.invalid/unused>; rel="next"' } : {} })
    }
    if (url.pathname === `${path}/pulls/${number}/${kind === 'github_review' ? 'reviews' : 'comments'}`) {
      assert.equal(url.searchParams.get('per_page'), '100')
      return Response.json(state.rows, { headers: state.next ? { link: '<https://outside.invalid/unused>; rel="next"' } : {} })
    }
    throw new Error(`Unexpected native-write fixture endpoint ${url.pathname}`)
  })
  const authorize = () => native.nativeReviewUserGrant(viewer, repositoryKey, repositoryId, budget)
  const beforeSend = async () => { events.push('beforeSend'); state.gateReady = true }
  const publish = async (gate = beforeSend) => native.publishNativeGitHubReview(await authorize(), saved, write, batchId, fingerprint, gate)
  const reconcile = async () => native.reconcileNativeGitHubReview(await authorize(), saved, write, batchId, fingerprint)
  const posts = () => calls.filter(call => call.method === 'POST')
  return { state, saved, write, batchId, fingerprint, marker, budget, calls, events, authorize, beforeSend, publish, reconcile, posts }
}

function unrelatedInline(f: ReturnType<typeof fixture>, offset: number, count: number): InlineComment[] {
  return Array.from({ length: count }, (_, index) => ({ ...f.state.inline[0]!,
    id: (9007199254750001n + BigInt(offset + index)).toString(), pull_request_review_id: '62', user: { id: '63' },
    body: `A different person's older review ${offset + index}`, original_commit_id: oldCommentSha }))
}
function inlinePages(f: ReturnType<typeof fixture>, pages: InlineComment[][], continued = false) {
  f.state.onFetch = url => {
    if (url.pathname !== `${path}/pulls/${number}/comments`) return
    assert.equal(url.searchParams.get('per_page'), '100')
    const page = Number(url.searchParams.get('page'))
    assert.ok(page >= 1 && page <= pages.length, 'the provider cannot fetch outside the bounded fixture pages')
    return Response.json(pages[page - 1], { headers: page < pages.length || continued
      ? { link: '<https://outside.invalid/unused>; rel="next"' } : {} })
  }
}

test('reconcile requires the complete submitted inline payload, not just a matching review marker', async t => {
  for (const mismatch of ['inline body', 'path', 'side', 'line', 'multiline start', 'multiline side', 'missing comment', 'extra comment',
    'duplicate id', 'inline account', 'inline review id', 'inline PR', 'inline original commit', 'incomplete inline page'] as const)
    await t.test(mismatch, async t => {
      const f = fixture(t)
      if (mismatch === 'inline body') f.state.inline[0]!.body = 'Different text under the same marker'
      if (mismatch === 'path') f.state.inline[0]!.path = 'other.ts'
      if (mismatch === 'side') f.state.inline[0]!.side = 'RIGHT'
      if (mismatch === 'line') { f.state.inline[0]!.line++; f.state.inline[0]!.original_line++ }
      if (mismatch === 'multiline start') { f.state.inline[1]!.start_line = 9; f.state.inline[1]!.original_start_line = 9 }
      if (mismatch === 'multiline side') f.state.inline[1]!.start_side = 'LEFT'
      if (mismatch === 'missing comment') f.state.inline.pop()
      if (mismatch === 'extra comment') f.state.inline.push({ ...f.state.inline[0]!, id: '9007199254741201' })
      if (mismatch === 'duplicate id') f.state.inline[1]!.id = f.state.inline[0]!.id
      if (mismatch === 'inline account') f.state.inline[0]!.user.id = '73'
      if (mismatch === 'inline review id') f.state.inline[0]!.pull_request_review_id = '74'
      if (mismatch === 'inline PR') f.state.inline[0]!.pull_request_url = `https://api.github.com${path}/pulls/8`
      if (mismatch === 'inline original commit') f.state.inline[0]!.original_commit_id = movedSha
      if (mismatch === 'incomplete inline page') f.state.inlineNext = true
      assert.equal(await f.reconcile(), null, 'a marker and review header cannot certify a different inline write')
      assert.equal(f.posts().length, 0)
    })
})

test('native review grants use only the actual viewer user token and preserve large repository/account IDs', async t => {
  const f = fixture(t), grant = await f.authorize()
  assert.equal(userToken.mock.callCount(), 1)
  assert.deepEqual(userToken.mock.calls[0]!.arguments, [viewer, { minValidityMs: 45_000, budget: f.budget }])
  assert.notEqual(viewer, f.saved.identity.ownerId)
  assert.equal(grant.githubAccountId, accountId)
  assert.equal(grant.repositoryId, repositoryId)
  assert.equal(readCredential.mock.callCount(), 0)
  assert.deepEqual(f.calls.map(call => [call.method, call.url.pathname]), [['GET', path]])
})

test('a missing or revoked user credential never falls back to an installation or the Run owner', async t => {
  for (const failure of [new GitHubAccessError('githubNotConnected', 409), new GitHubAccessError('githubReconnectRequired', 401),
    new GitHubAccessError('githubRepositoryForbidden', 403)]) await t.test(failure.code, async t => {
    const f = fixture(t)
    userToken.mock.mockImplementation(async userId => { assert.equal(userId, viewer); throw failure })
    await assert.rejects(f.publish(), code('workspace_review_github_forbidden'))
    assert.equal(userToken.mock.callCount(), 1)
    assert.equal(readCredential.mock.callCount(), 0)
    assert.equal(f.calls.length, 0)
  })
})

test('COMMENT, REQUEST_CHANGES and APPROVE send explicit events and immutable modern line coordinates', async t => {
  for (const event of ['COMMENT', 'REQUEST_CHANGES', 'APPROVE'] as const) await t.test(event, async t => {
    const f = fixture(t, 'github_review', event)
    const payload = native.nativeReviewPayload(f.write, f.saved, f.batchId, f.fingerprint)
    assert.deepEqual(payload, { commit_id: headSha, event, body: `Explicit review decision.\n\n${f.marker}`, comments: [
      { path: 'before.ts', body: 'Please preserve the old-side behavior.', line: 4, side: 'LEFT' },
      { path: 'after.ts', body: 'These three new lines need a guard.', line: 10, side: 'RIGHT', start_line: 8, start_side: 'RIGHT' },
    ] })
    assert.doesNotMatch(JSON.stringify(payload), /"position"|"original_position"/)
    assert.deepEqual(native.nativeReviewPayload(f.write, f.saved, f.batchId, f.fingerprint), payload)
    const receipt = await f.publish()
    assert.equal(f.posts().length, 1)
    assert.deepEqual(f.posts()[0]!.payload, payload)
    assert.equal(receipt.id, reviewId)
    assert.equal(receipt.headSha, headSha)
    assert.equal(receipt.commitSha, headSha)
    assert.equal(receipt.outdated, false)
    assert.equal(receipt.url, `${publicPull}#pullrequestreview-${reviewId}`)
    assert.match(receipt.evidenceDigest, /^[a-f0-9]{64}$/)
  })
})

test('anchors and explicit write events must validate before any provider POST', async t => {
  for (const mismatch of ['snapshot', 'source version', 'hidden path', 'event'] as const) await t.test(mismatch, async t => {
    const f = fixture(t)
    assert.equal(f.write.kind, 'github_review')
    if (f.write.kind !== 'github_review') throw new Error('Fixture kind')
    if (mismatch === 'snapshot') f.write.comments[0]!.anchor.snapshotId = randomUUID()
    if (mismatch === 'source version') f.write.comments[0]!.anchor.sourceVersion = diffDigest('another source')
    if (mismatch === 'hidden path') f.write.comments[0]!.anchor.path = '.env'
    if (mismatch === 'event') (f.write as unknown as { event: string }).event = 'APPROVED'
    await assert.rejects(f.publish())
    assert.equal(f.posts().length, 0)
    assert.equal(f.state.gateReady, false)
  })
})

test('repository identity, PR number, base and head stay frozen through the pre-write verification', async t => {
  for (const mismatch of ['repository id', 'repository name', 'PR repository', 'PR number', 'base', 'head', 'closed', 'merged',
    'snapshot repository', 'snapshot PR', 'source kind'] as const) await t.test(mismatch, async t => {
    const f = fixture(t)
    if (mismatch === 'repository id') f.state.repository.id = '9007199254740994'
    if (mismatch === 'repository name') f.state.repository.full_name = 'Other/Review'
    if (mismatch === 'PR repository') f.state.pull.base.repo.id = '9007199254740994'
    if (mismatch === 'PR number') f.state.pull.number++
    if (mismatch === 'base') f.state.pull.base.sha = movedSha
    if (mismatch === 'head') f.state.pull.head.sha = movedSha
    if (mismatch === 'closed') f.state.pull.state = 'closed'
    if (mismatch === 'merged') f.state.pull.merged = true
    if (mismatch === 'snapshot repository') f.saved.sourceAccess!.repositoryId = '9007199254740994'
    if (mismatch === 'snapshot PR') f.saved.sourceAccess!.pullRequestNumber = 8
    if (mismatch === 'source kind') f.saved.revision.source = 'commit'
    await assert.rejects(f.publish(), error => error instanceof WorkspaceReviewError)
    assert.equal(f.posts().length, 0)
    assert.equal(f.state.gateReady, false)
    assert.equal(readCredential.mock.callCount(), 0)
  })
})

test('beforeSend completes before POST and a refused gate sends no write', { timeout: 10_000 }, async t => {
  await t.test('blocked gate', async t => {
    const f = fixture(t), entered = Promise.withResolvers<void>(), released = Promise.withResolvers<void>()
    const pending = f.publish(async () => { f.events.push('gate entered'); entered.resolve(); await released.promise; f.state.gateReady = true; f.events.push('gate finished') })
    try {
      await Promise.race([entered.promise, pending.then(() => { throw new Error('Publish returned before its gate completed') })])
      assert.equal(f.posts().length, 0)
      assert.ok(f.calls.some(call => call.url.pathname === `${path}/pulls/${number}`), 'the frozen target is read before invoking the gate')
    } finally { released.resolve() }
    await pending
    assert.equal(f.posts().length, 1)
    assert.ok(f.events.indexOf('gate finished') < f.events.findIndex(event => event.startsWith('POST ')))
  })
  await t.test('refused gate', async t => {
    const f = fixture(t), refusal = new Error('Fixture final authority was revoked')
    await assert.rejects(f.publish(async () => { throw refusal }), error => error === refusal)
    assert.equal(f.posts().length, 0)
  })
})

test('reply targets are exact top-level native IDs in the frozen PR, including IDs above 2^53', async t => {
  await t.test('exact top-level parent', async t => {
    const f = fixture(t, 'github_reply'), receipt = await f.publish()
    assert.equal(f.posts().length, 1)
    assert.equal(f.posts()[0]!.url.pathname, `${path}/pulls/${number}/comments/${parentId}/replies`)
    assert.deepEqual(f.posts()[0]!.payload, { body: `Reply to the original native thread.\n\n${f.marker}` })
    assert.equal(receipt.id, replyId)
    assert.equal(receipt.commitSha, oldCommentSha, 'the actual provider comment commit is retained')
    assert.equal(receipt.headSha, headSha, 'the reviewed source is not replaced by the old thread commit')
    assert.equal(receipt.url, `${publicPull}#discussion_r${replyId}`)
    assert.equal(receipt.outdated, false)
  })
  for (const mismatch of ['parent id', 'foreign PR', 'reply-to-reply', 'hidden path', 'unsafe numeric id'] as const)
    await t.test(mismatch, async t => {
      const f = fixture(t, 'github_reply')
      if (mismatch === 'parent id') f.state.parent.id = '9007199254741000'
      if (mismatch === 'foreign PR') f.state.parent.pull_request_url = `https://api.github.com${path}/pulls/8`
      if (mismatch === 'reply-to-reply') f.state.parent.in_reply_to_id = '9007199254740888'
      if (mismatch === 'hidden path') f.state.parent.path = '.env'
      if (mismatch === 'unsafe numeric id') (f.write as unknown as { commentId: number }).commentId = Number(parentId)
      await assert.rejects(f.publish())
      assert.equal(f.posts().length, 0)
      assert.equal(f.state.gateReady, false)
    })
})

test('every POST transport or provider error is surfaced once with no automatic retry', async t => {
  for (const failure of ['timeout', '403', '422', '500', 'invalid JSON'] as const) await t.test(failure, async t => {
    const f = fixture(t)
    f.state.onFetch = (_url, init) => {
      if (init.method !== 'POST') return
      if (failure === 'timeout') throw new DOMException('Fixture transport ambiguity', 'TimeoutError')
      if (failure === 'invalid JSON') return new Response('accepted-but-unreadable', { status: 201 })
      return Response.json({ message: 'Fixture native write rejected' }, { status: Number(failure) })
    }
    await assert.rejects(f.publish(), code(failure === '403' ? 'workspace_review_github_forbidden' : 'workspace_review_github_unavailable'))
    assert.equal(f.posts().length, 1)
    assert.equal(f.events.filter(event => event === 'beforeSend').length, 1)
    assert.equal(readCredential.mock.callCount(), 0)
  })
})

test('an accepted POST followed by head/base drift stays accepted and outdated without resending', async t => {
  for (const change of ['head', 'base', 'unreadable'] as const) await t.test(change, async t => {
    const f = fixture(t)
    f.state.onFetch = (url, init) => {
      if (init.method === 'POST') {
        if (change === 'head') f.state.pull.head.sha = movedSha
        if (change === 'base') f.state.pull.base.sha = movedSha
      }
      if (change === 'unreadable' && f.posts().length && url.pathname === `${path}/pulls/${number}`)
        return Response.json({ message: 'Fixture post-write check unavailable' }, { status: 503 })
    }
    const receipt = await f.publish()
    assert.equal(receipt.id, reviewId)
    assert.equal(receipt.headSha, headSha)
    assert.equal(receipt.commitSha, headSha)
    assert.equal(receipt.outdated, change === 'unreadable' ? undefined : true)
    assert.equal(f.posts().length, 1)
  })
})

test('malformed or mismatched accepted receipts never become a confirmed delivery or a second POST', async t => {
  for (const mismatch of ['id zero', 'unsafe numeric id', 'account', 'commit', 'state', 'pending', 'body', 'URL id', 'foreign URL', 'PR URL'] as const)
    await t.test(mismatch, async t => {
      const f = fixture(t), value = f.state.receipt
      if (mismatch === 'id zero') value.id = '0'
      if (mismatch === 'unsafe numeric id') value.id = Number(reviewId)
      if (mismatch === 'account') value.user.id = '74'
      if (mismatch === 'commit') value.commit_id = movedSha
      if (mismatch === 'state') value.state = 'APPROVED'
      if (mismatch === 'pending') value.submitted_at = null
      if (mismatch === 'body') value.body += ' altered'
      if (mismatch === 'URL id') value.html_url = `${publicPull}#pullrequestreview-8`
      if (mismatch === 'foreign URL') value.html_url = `https://github.com/other/private/pull/7#pullrequestreview-${reviewId}`
      if (mismatch === 'PR URL') value.pull_request_url = `https://api.github.com${path}/pulls/8`
      await assert.rejects(f.publish(), code('workspace_review_github_unavailable'))
      assert.equal(f.posts().length, 1, 'a potentially accepted write is never attempted again')
    })
  await t.test('wrong reply parent in returned receipt', async t => {
    const f = fixture(t, 'github_reply'); f.state.receipt.in_reply_to_id = '9007199254740888'
    await assert.rejects(f.publish(), code('workspace_review_github_unavailable'))
    assert.equal(f.posts().length, 1)
  })
  await t.test('the review header succeeds but inline readback differs', async t => {
    const f = fixture(t); f.state.inline[0]!.body = 'Not the posted inline body'
    await assert.rejects(f.publish(), code('workspace_review_github_unavailable'))
    assert.equal(f.posts().length, 1)
  })
})

test('reconcile returns only a unique full payload/account/commit match, without a provider write', async t => {
  for (const kind of ['github_review', 'github_reply'] as const) await t.test(kind, async t => {
    const f = fixture(t, kind)
    f.state.inline.reverse()
    const receipt = await f.reconcile()
    assert.ok(receipt)
    assert.equal(receipt.id, kind === 'github_review' ? reviewId : replyId)
    assert.equal(receipt.commitSha, kind === 'github_review' ? headSha : oldCommentSha)
    assert.equal(receipt.headSha, headSha)
    assert.equal(f.posts().length, 0)
    if (kind === 'github_review') assert.ok(f.calls.some(call => call.url.pathname === `${path}/pulls/${number}/comments`))
  })
  await t.test('provider current coordinates may drift while original anchors stay fixed', async t => {
    const f = fixture(t)
    for (const item of f.state.inline) { item.line += 20; item.commit_id = movedSha; if (item.start_line) item.start_line += 20 }
    assert.ok(await f.reconcile(), 'original line/commit evidence, not current moved coordinates, binds the native payload')
    assert.equal(f.posts().length, 0)
  })
})

test('native inline confirmation enumerates the complete PR and selects the exact review across pages', async t => {
  for (const operation of ['publish', 'reconcile'] as const) await t.test(operation, async t => {
    const f = fixture(t)
    inlinePages(f, [[f.state.inline[1]!, ...unrelatedInline(f, 0, 99)], [...unrelatedInline(f, 99, 3), f.state.inline[0]!]])
    const receipt = await (operation === 'publish' ? f.publish() : f.reconcile())
    assert.ok(receipt)
    assert.equal(receipt.id, reviewId)
    assert.equal(receipt.headSha, headSha)
    assert.equal(receipt.commitSha, headSha)
    assert.equal(f.posts().length, operation === 'publish' ? 1 : 0)
    assert.deepEqual(f.calls.filter(call => call.url.pathname === `${path}/pulls/${number}/comments`)
      .map(call => call.url.searchParams.get('page')), ['1', '2'])
  })
  for (const mismatch of ['missing later comment', 'later body', 'later extra comment', 'duplicate selected id'] as const)
    await t.test(mismatch, async t => {
      const f = fixture(t), first = f.state.inline[0]!, second = { ...f.state.inline[1]! }
      const pages = [[first, ...unrelatedInline(f, 0, 99)], [second]]
      if (mismatch === 'missing later comment') pages[1] = unrelatedInline(f, 99, 1)
      if (mismatch === 'later body') second.body = 'A later page does not match the submitted draft'
      if (mismatch === 'later extra comment') {
        pages[0] = [first, second, ...unrelatedInline(f, 0, 98)]
        pages[1] = [{ ...first, id: '9007199254742111' }]
      }
      if (mismatch === 'duplicate selected id') second.id = first.id
      inlinePages(f, pages)
      assert.equal(await f.reconcile(), null)
      assert.equal(f.posts().length, 0)
    })
  for (const continued of [false, true]) await t.test(continued ? 'page ten still has a continuation' : 'page ten closes the complete enumeration', async t => {
    const f = fixture(t), pages = Array.from({ length: 10 }, (_, index) => unrelatedInline(f, index * 100, 100))
    pages[0] = [...f.state.inline, ...unrelatedInline(f, 0, 98)]
    inlinePages(f, pages, continued)
    const receipt = await f.reconcile()
    if (continued) assert.equal(receipt, null, 'even a full matching batch on page one is insufficient before the enumeration closes')
    else assert.equal(receipt?.id, reviewId)
    assert.equal(f.calls.filter(call => call.url.pathname === `${path}/pulls/${number}/comments`).length, 10)
    assert.equal(f.posts().length, 0)
  })
  await t.test('a legacy position field cannot substitute for missing original line evidence', async t => {
    const f = fixture(t), legacy = f.state.inline[0]! as unknown as Record<string, unknown>
    delete legacy.original_line; delete legacy.original_start_line; delete legacy.side; delete legacy.start_side
    legacy.position = 4; legacy.original_position = 4
    assert.equal(await f.reconcile(), null)
    assert.equal(f.posts().length, 0)
  })
})

test('reconcile never treats a marker alone, foreign account or different commit as accepted', async t => {
  for (const mismatch of ['marker only', 'other marker', 'body changed', 'account', 'commit', 'event', 'not submitted', 'URL'] as const)
    await t.test(mismatch, async t => {
      const f = fixture(t)
      if (mismatch === 'marker only') f.state.receipt.body = f.marker
      if (mismatch === 'other marker') f.state.receipt.body = f.state.receipt.body.replace(f.fingerprint, diffDigest('another batch'))
      if (mismatch === 'body changed') f.state.receipt.body = `Other review.\n\n${f.marker}`
      if (mismatch === 'account') f.state.receipt.user.id = '74'
      if (mismatch === 'commit') f.state.receipt.commit_id = movedSha
      if (mismatch === 'event') f.state.receipt.state = 'CHANGES_REQUESTED'
      if (mismatch === 'not submitted') f.state.receipt.submitted_at = null
      if (mismatch === 'URL') f.state.receipt.html_url = `${publicPull}#pullrequestreview-8`
      assert.equal(await f.reconcile(), null)
      assert.equal(f.posts().length, 0)
    })
})

test('empty, ambiguous, timed-out or incomplete reconciliation never invokes POST', async t => {
  await t.test('empty', async t => {
    const f = fixture(t); f.state.rows = []
    assert.equal(await f.reconcile(), null)
    assert.equal(f.posts().length, 0)
  })
  await t.test('two full matches', async t => {
    const f = fixture(t), second = '9007199254742001'
    f.state.rows.push({ ...f.state.receipt, id: second, html_url: `${publicPull}#pullrequestreview-${second}` })
    f.state.inlineByReview.set(second, f.state.inline.map(item => ({ ...item, pull_request_review_id: second })))
    assert.equal(await f.reconcile(), null)
    assert.equal(f.posts().length, 0)
  })
  await t.test('timeout', async t => {
    const f = fixture(t)
    f.state.onFetch = url => { if (url.pathname.endsWith('/reviews')) throw new DOMException('Fixture read timeout', 'TimeoutError') }
    await assert.rejects(f.reconcile(), code('workspace_review_github_unavailable'))
    assert.equal(f.posts().length, 0)
  })
  await t.test('a short page claiming continuation', async t => {
    const f = fixture(t); f.state.rows = [{ ...f.state.receipt, body: 'Unrelated review' }]; f.state.next = true
    await assert.rejects(f.reconcile(), code('workspace_review_github_unavailable'))
    assert.equal(f.posts().length, 0)
  })
  await t.test('a positive on page one cannot finalize while page ten still has a continuation', async t => {
    const f = fixture(t)
    const unrelated = Array.from({ length: 100 }, (_, index) => ({ ...f.state.receipt,
      id: (9007199254743001n + BigInt(index)).toString(), body: `Unrelated review ${index}` }))
    f.state.onFetch = url => {
      if (url.pathname !== `${path}/pulls/${number}/reviews`) return
      const page = Number(url.searchParams.get('page'))
      return Response.json(page === 1 ? [f.state.receipt, ...unrelated.slice(1)] : unrelated,
        { headers: { link: '<https://outside.invalid/unused>; rel="next"' } })
    }
    assert.equal(await f.reconcile(), null)
    assert.equal(f.calls.filter(call => call.url.pathname === `${path}/pulls/${number}/reviews`).length, 10)
    assert.equal(f.posts().length, 0)
  })
})
