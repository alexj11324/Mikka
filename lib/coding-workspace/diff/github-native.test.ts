import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { after, before, mock, test, type TestContext } from 'node:test'
import type { Pool } from 'pg'
import { CodingWorkspaceError } from '@mikka/protocol/coding-workspace'
import { diffSnapshot, githubReviewPage, WorkspaceReviewError,
  type DiffSnapshot, type GitHubReviewQuery } from '@mikka/protocol/coding-workspace-review'
import { GitHubAccessError } from '../../github/user-access-error'
import { CloudServiceError } from '../../cloud-services/errors'
import type { RequestBudget } from '../../request-budget'
import { createSecretMasker, identityMasker, maskCredentials, type Masker } from '../../secrets/mask'
import type { ReviewActor, ReviewScope } from './authority'
import { GitHubDiffClient } from './github-api'

const owner = 'native-run-owner', viewer = 'native-review-viewer', repositoryKey = 'v2/github.com/fixture/review'
const repositoryId = '61393725', number = 7, headSha = 'b'.repeat(40), baseSha = 'c'.repeat(40)
const token = 'fixture-native-read-credential', observed = '2026-11-08T12:00:00.000Z'
const digest = (text: string) => createHash('sha256').update(text).digest('hex')
const code = (expected: string) => (error: unknown) =>
  (error instanceof CodingWorkspaceError || error instanceof WorkspaceReviewError) && error.code === expected
type Credential = Awaited<ReturnType<typeof import('../../github/user-access')['githubRepositoryReadCredential']>>
const credential = mock.fn(async (_userId: string, _key: string, _budget?: RequestBudget): Promise<Credential> => {
  throw new Error('A native review integration fixture must supply its current viewer credential')
})
const scopeReader = mock.fn(async (_database: unknown, _membership: unknown, _actor: unknown, _runId: string, _repoId: string): Promise<ReviewScope> => {
  throw new Error('A native review integration fixture must supply its current scope')
})
const secretReader = mock.fn(async (_scope: { workspaceId: string; ownerId: string }): Promise<Masker> => {
  throw new Error('A native review integration fixture must supply its masking policy')
})
const modules = [
  mock.module(new URL('../../github/user-access.ts', import.meta.url).href, { namedExports: { githubRepositoryReadCredential: credential, GitHubAccessError } }),
  mock.module(new URL('./authority.ts', import.meta.url).href, { namedExports: { resolveReviewScope: scopeReader } }),
  mock.module(new URL('../../secrets/runtime.ts', import.meta.url).href, { namedExports: { secretMaskerFor: secretReader } }),
]
let native: typeof import('./github-native')
before(async () => { native = await import('./github-native') })
after(() => { for (const module of modules) module.restore() })

function snapshot(): DiffSnapshot {
  return diffSnapshot.parse({ id: randomUUID(), identity: { version: 1, runId: randomUUID(), repoId: randomUUID(),
    ownerId: owner, workspaceId: randomUUID(), repositoryKey }, taskId: randomUUID(),
  revision: { source: 'pull_request', baseSha: 'a'.repeat(40), headSha, treeSha: null, version: digest('native snapshot') },
  observedAt: observed, isStale: false, availability: 'empty', reason: null,
  counts: { files: 0, additions: 0, deletions: 0, complete: true }, policy: 'whole_pull_request',
  sourceAccess: { kind: 'github', repositoryId, pullRequestNumber: number, pullRequestBaseSha: baseSha, manifestComplete: true },
  pullRequest: { number, url: `https://github.com/fixture/review/pull/${number}`, headSha, baseSha, state: 'open' } })
}
function comment(index: number) {
  return { id: `PRRC_${index}`, fullDatabaseId: (9007199254740993n + BigInt(index)).toString(), replyTo: null,
    body: `Native comment ${index}`, author: { login: `reviewer${index}` },
    commit: { oid: headSha }, originalCommit: { oid: 'd'.repeat(40) }, createdAt: observed, updatedAt: observed }
}
const pageInfo = (hasNextPage = false, endCursor: string | null = null) => ({ hasNextPage, endCursor })
function thread(index: number, comments: unknown[] = [comment(index)]) {
  return { id: `PRRT_${index}`, path: `src/file-${index}.ts`, diffSide: 'RIGHT', startDiffSide: 'LEFT',
    line: 12, startLine: 10, originalLine: 22, originalStartLine: 20, subjectType: 'LINE',
    isResolved: true, isOutdated: true, comments: { nodes: comments, pageInfo: pageInfo() } }
}
const pull = () => ({ number, headRefOid: headSha, baseRefOid: baseSha,
  repository: { databaseId: repositoryId, nameWithOwner: 'Fixture/Review' } })
const outer = (threads: unknown[] = [thread(1)], pagination = pageInfo(), current = pull()) => ({ data: {
  repository: { pullRequest: { ...current, reviewThreads: { nodes: threads, pageInfo: pagination } } },
} })
const inner = (value = thread(1), current = pull()) => ({ data: { node: { ...value,
  __typename: 'PullRequestReviewThread', pullRequest: current } } })
type Call = { query: string; variables: Record<string, unknown> }
function fixture(t: TestContext, response: unknown = outer()) {
  const state = { response, onFetch: undefined as ((call: Call) => void) | undefined }
  const calls: Call[] = []
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init: RequestInit = {}) => {
    assert.equal(String(input), 'https://api.github.com/graphql')
    assert.equal(init.method, 'POST'); assert.equal(init.redirect, 'error')
    assert.equal(init.credentials, 'omit'); assert.equal(init.cache, 'no-store')
    assert.equal(new Headers(init.headers).get('authorization'), `Bearer ${token}`)
    assert.ok(init.signal instanceof AbortSignal)
    const call = JSON.parse(String(init.body)) as Call
    assert.match(call.query, /^query\b/); assert.doesNotMatch(call.query, /\b(?:mutation|diffHunk)\b/)
    calls.push(call); state.onFetch?.(call)
    return Response.json(state.response)
  })
  const saved = snapshot(), grant = { client: new GitHubDiffClient(token, { deadline: Date.now() + 30_000 }),
    owner: 'fixture', repo: 'review', repositoryId, number }
  return { state, calls, saved, grant,
    read: (query: GitHubReviewQuery = {}, mask = identityMasker, selected = saved) => native.readNativeGitHubReview(grant, selected, query, mask) }
}
const decode = (cursor: string) => JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Record<string, unknown>
const encode = (cursor: Record<string, unknown>) => Buffer.from(JSON.stringify(cursor)).toString('base64url')

test('native review preserves provider coordinates, large decimal IDs, original commits and resolution without inventing local anchors', async t => {
  const root = comment(1), reply = { ...comment(2), replyTo: { fullDatabaseId: root.fullDatabaseId } }
  const f = fixture(t, outer([thread(1, [root, reply])]))
  const page = await f.read(), value = page.threads[0]!
  assert.ok(githubReviewPage.safeParse(page).success)
  assert.equal(page.snapshotId, f.saved.id); assert.equal(page.sourceVersion, f.saved.revision.version)
  assert.equal(page.repositoryId, repositoryId); assert.equal(page.pullRequestNumber, number); assert.equal(page.isStale, false)
  assert.deepEqual({ side: value.side, startSide: value.startSide, line: value.line, startLine: value.startLine,
    originalLine: value.originalLine, originalStartLine: value.originalStartLine, subjectType: value.subjectType,
    resolved: value.resolved, outdated: value.outdated },
  { side: 'RIGHT', startSide: 'LEFT', line: 12, startLine: 10, originalLine: 22, originalStartLine: 20,
    subjectType: 'LINE', resolved: true, outdated: true })
  assert.equal(value.comments[0]!.id, '9007199254740994')
  assert.equal(value.comments[0]!.nodeId, root.id); assert.equal(value.comments[1]!.replyToId, root.fullDatabaseId)
  assert.equal(value.comments[0]!.commitSha, headSha); assert.equal(value.comments[0]!.originalCommitSha, 'd'.repeat(40))
  assert.equal(value.comments[0]!.url, `https://github.com/fixture/review/pull/${number}#discussion_r${root.fullDatabaseId}`)
  assert.ok(!JSON.stringify(page).includes('diffHunk')); assert.ok(!JSON.stringify(page).includes('hunkFingerprint'))
  assert.equal(f.calls.length, 1)
})

test('outer and per-thread connections each page at twenty and never auto-drain private comments', async t => {
  const rows = Array.from({ length: 20 }, (_, index) => ({ ...thread(index,
    Array.from({ length: 20 }, (_, offset) => comment(index * 100 + offset))),
  comments: { nodes: Array.from({ length: 20 }, (_, offset) => comment(index * 100 + offset)),
    pageInfo: pageInfo(true, `comments-${index}-20`) } }))
  const f = fixture(t, outer(rows, pageInfo(true, 'threads-20')))
  const first = await f.read()
  assert.equal(first.threads.length, 20); assert.ok(first.threads.every(value => value.comments.length === 20 && value.nextCursor))
  assert.ok(first.nextCursor); assert.equal(f.calls.length, 1)
  assert.match(f.calls[0]!.query, /reviewThreads\(first:20,after:\$after\)/)
  assert.match(f.calls[0]!.query, /comments\(first:20\)/)
  assert.deepEqual(f.calls[0]!.variables, { owner: 'fixture', name: 'review', number, after: null })
  f.state.response = outer([thread(30)])
  assert.equal((await f.read({ cursor: first.nextCursor! })).threads[0]!.id, 'PRRT_30')
  assert.equal(f.calls[1]!.variables.after, 'threads-20')
  f.state.response = inner(thread(0, [comment(20)]))
  const more = await f.read({ threadId: 'PRRT_0', cursor: first.threads[0]!.nextCursor! })
  assert.equal(more.threads.length, 1); assert.equal(more.nextCursor, null)
  assert.equal(more.threads[0]!.comments[0]!.id, comment(20).fullDatabaseId)
  assert.deepEqual(f.calls[2]!.variables, { id: 'PRRT_0', after: 'comments-0-20' })
  assert.match(f.calls[2]!.query, /comments\(first:20,after:\$after\)/)
})

test('continuation cursors cannot cross repository, PR, source version or thread connections', async t => {
  const f = fixture(t, outer([{ ...thread(1), comments: { nodes: [comment(1)], pageInfo: pageInfo(true, 'comments-20') } }], pageInfo(true, 'threads-20')))
  const first = await f.read(), cursor = decode(first.nextCursor!)
  for (const change of [{ repositoryId: '99' }, { number: number + 1 }, { sourceVersion: 'e'.repeat(64) }, { threadId: 'PRRT_1' }]) {
    const count = f.calls.length
    await assert.rejects(() => f.read({ cursor: encode({ ...cursor, ...change }) }), code('workspace_snapshot_outdated'))
    assert.equal(f.calls.length, count, 'a cursor scope mismatch is rejected before GitHub')
  }
  await assert.rejects(() => f.read({ threadId: 'PRRT_1', cursor: first.nextCursor! }), code('workspace_snapshot_outdated'))
  await assert.rejects(() => f.read({ threadId: 'PRRT_2', cursor: first.threads[0]!.nextCursor! }), code('workspace_snapshot_outdated'))
})

test('a cursor remains bound to its snapshot ID even when another snapshot has the same source version', async t => {
  const f = fixture(t, outer([thread(1)], pageInfo(true, 'threads-20'))), first = await f.read()
  const another = { ...f.saved, id: randomUUID() }, count = f.calls.length
  f.state.response = outer([thread(2)])
  await assert.rejects(() => f.read({ cursor: first.nextCursor! }, identityMasker, another), code('workspace_snapshot_outdated'))
  assert.equal(f.calls.length, count)
})

test('head and target-base movement marks first pages stale but invalidates either kind of continuation', async t => {
  for (const field of ['headRefOid', 'baseRefOid'] as const) await t.test(field, async t => {
    const value = { ...thread(1), comments: { nodes: [comment(1)], pageInfo: pageInfo(true, 'comments-20') } }
    const f = fixture(t, outer([value], pageInfo(true, 'threads-20'))), first = await f.read()
    const changed = { ...pull(), [field]: 'f'.repeat(40) }
    f.state.response = outer([thread(1)], pageInfo(), changed)
    assert.equal((await f.read()).isStale, true)
    await assert.rejects(() => f.read({ cursor: first.nextCursor! }), code('workspace_snapshot_outdated'))
    f.state.response = inner(thread(1), changed)
    await assert.rejects(() => f.read({ threadId: 'PRRT_1', cursor: first.threads[0]!.nextCursor! }), code('workspace_snapshot_outdated'))
  })
})

test('malformed cursors cannot become an unscoped first-page fetch', async t => {
  const f = fixture(t)
  for (const cursor of ['not-json', encode({ version: 1 }), encode({ version: 2, after: 'x' }), Buffer.from('[]').toString('base64url')])
    await assert.rejects(() => f.read({ cursor }), code('workspace_invalid_request'))
  assert.equal(f.calls.length, 0)
})

test('wrong repository ID, repository name or PR is forbidden for outer and node pagination', async t => {
  for (const current of [
    { ...pull(), number: number + 1 },
    { ...pull(), repository: { ...pull().repository, databaseId: '99' } },
    { ...pull(), repository: { ...pull().repository, nameWithOwner: 'other/private' } },
  ]) await t.test(JSON.stringify(current), async t => {
    const f = fixture(t, outer([thread(1)], pageInfo(), current))
    await assert.rejects(() => f.read(), code('workspace_review_github_forbidden'))
    f.state.response = inner(thread(1), current)
    await assert.rejects(() => f.read({ threadId: 'PRRT_1' }), code('workspace_review_github_forbidden'))
  })
})

test('a snapshot without the exact GitHub PR provenance is refused before fetch', async t => {
  const f = fixture(t)
  for (const changed of [
    { ...f.saved, sourceAccess: undefined }, { ...f.saved, pullRequest: null },
    { ...f.saved, sourceAccess: { ...f.saved.sourceAccess!, repositoryId: '99' } },
    { ...f.saved, sourceAccess: { ...f.saved.sourceAccess!, pullRequestNumber: number + 1 } },
  ]) await assert.rejects(() => f.read({}, identityMasker, changed), code('workspace_review_github_forbidden'))
  assert.equal(f.calls.length, 0)
})

test('node continuation requires the exact requested PullRequestReviewThread rather than an arbitrary GraphQL node', async t => {
  const good = inner()
  const f = fixture(t)
  for (const node of [null, { ...good.data.node, __typename: 'Issue' }, { ...good.data.node, id: 'PRRT_2' }]) {
    f.state.response = { data: { node } }
    await assert.rejects(() => f.read({ threadId: 'PRRT_1' }), code('workspace_review_github_unavailable'))
  }
})

test('null repository, PR, thread or comment nodes are unavailable rather than partial success', async t => {
  const f = fixture(t)
  for (const response of [{ data: { repository: null } }, { data: { repository: { pullRequest: null } } },
    outer([null]), outer([thread(1, [null])])]) {
    f.state.response = response
    await assert.rejects(() => f.read(), code('workspace_review_github_unavailable'))
  }
})

test('duplicate thread and decimal comment IDs are rejected even across different threads', async t => {
  const f = fixture(t)
  for (const rows of [[thread(1), thread(1)], [thread(1, [comment(1), comment(1)])], [thread(1), thread(2, [comment(1)])]]) {
    f.state.response = outer(rows)
    await assert.rejects(() => f.read(), code('workspace_review_github_unavailable'))
  }
})

test('duplicate GraphQL comment node IDs cannot impersonate distinct decimal comment IDs', async t => {
  const f = fixture(t, outer([thread(1, [comment(1), { ...comment(2), id: comment(1).id }])]))
  await assert.rejects(() => f.read(), code('workspace_review_github_unavailable'))
})

test('unsafe paths and numeric identifiers that have lost precision cannot be returned', async t => {
  const f = fixture(t)
  for (const path of ['../outside', '/absolute', 'src/../outside', 'src\\file.ts', 'src/file\n.ts', '.env', '.git/config']) {
    f.state.response = outer([{ ...thread(1), path }])
    await assert.rejects(() => f.read(), error => code('workspace_path_unavailable')(error) || code('workspace_review_github_unavailable')(error))
  }
  for (const fullDatabaseId of [Number.MAX_SAFE_INTEGER + 1, 0, -1, '0', '1e18', '9'.repeat(41)]) {
    f.state.response = outer([thread(1, [{ ...comment(1), fullDatabaseId }])])
    await assert.rejects(() => f.read(), code('workspace_review_github_unavailable'))
  }
  f.state.response = outer([thread(1, [{ ...comment(1), fullDatabaseId: Number.MAX_SAFE_INTEGER }])])
  assert.equal((await f.read()).threads[0]!.comments[0]!.id, String(Number.MAX_SAFE_INTEGER))
})

test('null historical author, commits and line coordinates are preserved without a guessed current anchor', async t => {
  const f = fixture(t, outer([{ ...thread(1, [{ ...comment(1), author: null, commit: null, originalCommit: null }]),
    line: null, startLine: null, originalLine: null, originalStartLine: null, startDiffSide: null, subjectType: 'FILE' }]))
  const value = (await f.read()).threads[0]!
  assert.equal(value.line, null); assert.equal(value.originalLine, null); assert.equal(value.startSide, null)
  assert.equal(value.subjectType, 'FILE'); assert.equal(value.comments[0]!.author, null)
  assert.equal(value.comments[0]!.commitSha, null); assert.equal(value.comments[0]!.originalCommitSha, null)
})

test('page limits, missing continuation cursors, empty continuing pages and cursor loops fail closed', async t => {
  const f = fixture(t)
  for (const response of [outer(Array.from({ length: 21 }, (_, index) => thread(index))),
    outer([thread(1, Array.from({ length: 21 }, (_, index) => comment(index)))]),
    outer([thread(1)], pageInfo(true)), outer([], pageInfo(true, 'next')),
    outer([{ ...thread(1), comments: { nodes: [], pageInfo: pageInfo(true, 'next') } }])]) {
    f.state.response = response
    await assert.rejects(() => f.read(), code('workspace_review_github_unavailable'))
  }
  f.state.response = outer([thread(1)], pageInfo(true, 'same-cursor'))
  const first = await f.read()
  await assert.rejects(() => f.read({ cursor: first.nextCursor! }), code('workspace_review_github_unavailable'))
})

test('HTTP 200 GraphQL errors never expose otherwise usable partial review bodies', async t => {
  const f = fixture(t)
  for (const [type, expected] of [['FORBIDDEN', 'workspace_review_github_forbidden'], ['NOT_FOUND', 'workspace_review_github_forbidden'],
    ['INTERNAL', 'workspace_review_github_unavailable']] as const) {
    f.state.response = { ...outer(), errors: [{ type, message: 'private provider failure' }] }
    await assert.rejects(() => f.read(), error => {
      assert.ok(code(expected)(error)); assert.ok(!String(error).includes('private provider failure')); return true
    })
  }
})

test('complete multiline bodies are masked before truncation at four thousand characters', async t => {
  const secret = 'begin-private-value\n' + 's'.repeat(70) + '\nend-private-value'
  const body = 'p'.repeat(3970) + secret + ' tail'.repeat(40)
  const base = createSecretMasker([{ name: 'BOUNDARY', value: secret }]), inputs: string[] = []
  const mask: Masker = value => { inputs.push(value); return base(value) }
  const f = fixture(t, outer([thread(1, [{ ...comment(1), body }])]))
  const value = (await f.read({}, mask)).threads[0]!.comments[0]!
  assert.ok(inputs.includes(body), 'the masker sees the entire provider body, including text beyond the display boundary')
  assert.equal(value.body, base(body).slice(0, 4000)); assert.equal(value.bodyTruncated, true)
  assert.ok(value.body.includes('[secret:BOUNDARY]')); assert.ok(!value.body.includes('begin-private-value'))
})

test('a body which becomes short after masking is not falsely reported as truncated', async t => {
  const body = 'long-private-value:'.repeat(240), mask = createSecretMasker([{ name: 'WHOLE', value: body }])
  const f = fixture(t, outer([thread(1, [{ ...comment(1), body }])]))
  const value = (await f.read({}, mask)).threads[0]!.comments[0]!
  assert.equal(value.body, '[secret:WHOLE]'); assert.equal(value.bodyTruncated, false)
})

function policyMask(policy: string, secrets: Array<{ name: string; value: string }> = []): Masker {
  const saved = createSecretMasker(secrets), mask: Masker = value => maskCredentials(saved(value))
  mask.sourcePolicy = digest(policy)
  return mask
}
function integration(t: TestContext, kind: Credential['kind'] = 'installation') {
  const f = fixture(t), actor: ReviewActor = { userId: viewer, workspaceId: f.saved.identity.workspaceId,
    credential: { kind: 'session', id: randomUUID() } }
  const scope: ReviewScope = { identity: f.saved.identity, taskId: f.saved.taskId, boardId: digest('native board'), status: 'stopped', stopped: true }
  const state = Object.assign(f.state, { masks: [policyMask('owner-policy'), policyMask('viewer-policy')], publishedNumber: number,
    onQuery: undefined as ((sql: string) => void) | undefined })
  const queries: string[] = []
  const database = { async query(sql: string, values: unknown[] = []) {
    queries.push(sql); state.onQuery?.(sql)
    let rows: unknown[]
    if (sql.startsWith('SELECT s.snapshot,count(f.path)')) {
      assert.deepEqual(values, [f.saved.id, scope.identity.runId, scope.identity.repoId, scope.boardId, actor.workspaceId])
      rows = [{ snapshot: structuredClone(f.saved), files: 0, additions: 0, deletions: 0, complete: true }]
    } else {
      assert.deepEqual(values, [scope.identity.runId, owner, scope.taskId, repositoryKey])
      if (sql.includes('FROM run_publications p')) rows = [{ pullRequest: { url: `https://github.com/fixture/review/pull/${state.publishedNumber}` } }]
      else if (sql.includes('WITH related AS')) rows = []
      else throw new Error('Unexpected native review database operation')
    }
    return { rows, rowCount: rows.length, command: 'SELECT', fields: [], oid: 0 }
  } } as unknown as Pool
  credential.mock.resetCalls(); scopeReader.mock.resetCalls(); secretReader.mock.resetCalls()
  credential.mock.mockImplementation(async (userId, key, budget) => {
    assert.equal(userId, viewer); assert.notEqual(userId, owner); assert.equal(key, repositoryKey)
    assert.ok(budget && budget.deadline > Date.now())
    return { token, kind, githubAccountId: kind === 'user' ? '123' : null,
      repository: { id: repositoryId, installationId: '31', fullName: 'Fixture/Review', htmlUrl: 'https://github.com/Fixture/Review', private: true } }
  })
  scopeReader.mock.mockImplementation(async (db, membership, who, runId, repoId) => {
    assert.equal(db, database); assert.equal(membership, database); assert.equal(who, actor)
    assert.equal(runId, scope.identity.runId); assert.equal(repoId, scope.identity.repoId)
    return scope
  })
  secretReader.mock.mockImplementation(async value => {
    assert.equal(value.workspaceId, actor.workspaceId)
    assert.ok([owner, viewer].includes(value.ownerId))
    return state.masks[value.ownerId === owner ? 0 : 1]!
  })
  return { ...f, actor, state, queries, scope,
    readIntegrated: (query: unknown = {}) => native.readGitHubReview({ database, membership: database }, actor,
      scope.identity.runId, scope.identity.repoId, f.saved.id, query) }
}

test('integration uses the actual viewer read credential and retained association without inferring installation-token write authority', async t => {
  const f = integration(t), page = await f.readIntegrated()
  assert.equal(credential.mock.calls.length, 1); assert.equal(f.calls.length, 1)
  assert.equal(secretReader.mock.calls.length, 2); assert.equal(page.threads[0]!.comments[0]!.body, 'Native comment 1')
  assert.ok(native.nativeReviewPolicyMatches(page, f.state.masks))
  const json = JSON.stringify(page)
  for (const privateValue of [token, 'sourcePolicy', 'nativeReviewFullBodyPolicy', 'installationId', 'canWrite', 'canSubmitReview'])
    assert.ok(!json.includes(privateValue))
  assert.ok(f.queries.every(sql => /^\s*(SELECT|WITH)\b/.test(sql)), 'reading does not persist provider bodies or mutate the local board')
})

test('integration composes owner and viewer masking over the complete body and rejects changed policies or unproven DTO copies', async t => {
  const f = integration(t, 'user'), ownerSecret = 'owner-private-multiline\nvalue', viewerSecret = 'viewer-private-multiline\nvalue'
  f.state.masks = [policyMask('owner-policy', [{ name: 'OWNER', value: ownerSecret }]),
    policyMask('viewer-policy', [{ name: 'VIEWER', value: viewerSecret }])]
  f.state.response = outer([thread(1, [{ ...comment(1), body: ownerSecret + '\n' + 'x'.repeat(3950) + viewerSecret }])])
  const page = await f.readIntegrated(), raw = JSON.stringify(page)
  assert.ok(!raw.includes('owner-private')); assert.ok(!raw.includes('viewer-private'))
  assert.ok(native.nativeReviewPolicyMatches(page, f.state.masks))
  assert.equal(native.nativeReviewPolicyMatches(page, [policyMask('new-owner-policy'), f.state.masks[1]!]), false)
  assert.equal(native.nativeReviewPolicyMatches(page, [f.state.masks[0]!, policyMask('new-viewer-policy')]), false)
  assert.equal(native.nativeReviewPolicyMatches(page, [identityMasker, f.state.masks[1]!]), false)
  assert.equal(native.nativeReviewPolicyMatches(page, [f.state.masks[0]!]), false)
  for (const value of [null, {}, JSON.parse(raw), { ...page }, { ...page, sourcePolicy: f.state.masks[0]!.sourcePolicy }])
    assert.equal(native.nativeReviewPolicyMatches(value, f.state.masks), false)
})

test('integration rechecks the immutable publication after the remote wait and refuses a changed association', async t => {
  const f = integration(t)
  f.state.onFetch = () => { f.state.publishedNumber = number + 1 }
  await assert.rejects(() => f.readIntegrated(), code('workspace_snapshot_outdated'))
})

test('integration does not return a native DTO without both complete-body policy fingerprints', async t => {
  const f = integration(t)
  f.state.masks = [identityMasker, policyMask('viewer-policy')]
  await assert.rejects(() => f.readIntegrated(), code('workspace_path_unavailable'))
})

test('credential and Cloud failures have typed public errors and reveal no token or provider body', async t => {
  const f = integration(t)
  for (const [failure, expected] of [
    [new GitHubAccessError('githubRepositoryForbidden', 403), 'workspace_review_github_forbidden'],
    [new GitHubAccessError('githubUnavailable', 502), 'workspace_review_github_unavailable'],
    [new CloudServiceError('cloud_scope_missing'), 'workspace_review_github_forbidden'],
    [new CloudServiceError('cloud_unavailable'), 'workspace_review_github_unavailable'],
    [new Error(token), 'workspace_review_github_unavailable'],
  ] as const) {
    credential.mock.mockImplementation(async () => { throw failure })
    await assert.rejects(() => f.readIntegrated(), error => {
      assert.ok(code(expected)(error)); assert.ok(!String(error).includes(token)); return true
    })
  }
  assert.equal(f.calls.length, 0)
})
