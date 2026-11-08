import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { inspect } from 'node:util'
import test, { type TestContext } from 'node:test'
import { CodingWorkspaceError } from '@mikka/protocol/coding-workspace'
import { diffSnapshot, WorkspaceReviewError, type DiffSnapshot } from '@mikka/protocol/coding-workspace-review'
import type { RequestBudget } from '../../request-budget'
import { GitHubDiffClient, GitHubWriteRejection } from './github-api'
import { readGitHubPullState } from './github-state'
import { manifestRevision } from './store'

// Native schema, including nullable reviewDecision and string-encoded BigInt:
// https://docs.github.com/en/graphql/reference/pulls#pullrequest
// https://docs.github.com/en/graphql/reference/repos#repository
// https://docs.github.com/en/graphql/reference/other#bigint
const object = (text: string) => createHash('sha1').update(text).digest('hex')
const headSha = object('immutable PR head'), baseSha = object('immutable PR base'), treeSha = object('immutable PR tree')
const repositoryId = '9007199254740993', fullName = 'fixture/review', number = 327
const token = 'fixture-viewer-graphql-credential', privateBody = 'PRIVATE_RESPONSE_BODY_MUST_NOT_ESCAPE'
const sourceAccess = { kind: 'github' as const, repositoryId, pullRequestNumber: number, pullRequestBaseSha: baseSha, manifestComplete: true as const }
const snapshot = diffSnapshot.parse({ id: randomUUID(), taskId: randomUUID(), identity: {
  version: 1, runId: randomUUID(), repoId: randomUUID(), ownerId: 'fixture-run-owner', workspaceId: randomUUID(),
  repositoryKey: 'v2/github.com/' + fullName,
}, revision: manifestRevision('pull_request', baseSha, headSha, treeSha, [], sourceAccess),
observedAt: '2026-11-08T12:00:00.000Z', isStale: false, availability: 'empty', reason: null,
counts: { files: 0, additions: 0, deletions: 0, complete: true }, policy: 'whole_pull_request', sourceAccess,
pullRequest: { number, url: `https://github.com/${fullName}/pull/${number}`, baseSha, headSha, state: 'open' } })

type NativePull = { number: number; headRefOid: string | null; baseRefOid: string | null; state: string;
  reviewDecision?: string | null; repository: { fullDatabaseId?: string | number | null; databaseId?: number; nameWithOwner: string };
  [key: string]: unknown }
const native = (changes: Partial<NativePull> = {}): NativePull => ({ number, headRefOid: headSha, baseRefOid: baseSha, state: 'OPEN',
  reviewDecision: null, repository: { fullDatabaseId: repositoryId, nameWithOwner: fullName },
  body: privateBody, url: 'https://outside.invalid/private-pull-body', ...changes })
const envelope = (pull = native()) => ({ data: { repository: { pullRequest: pull } } })
function fixture(t: TestContext, answer: () => Response | Promise<Response> = () => Response.json(envelope()),
  budget: RequestBudget = { deadline: Date.now() + 30_000 }) {
  const calls: { url: URL; query: string; variables: Record<string, unknown> }[] = []
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input))
    assert.equal(url.href, 'https://api.github.com/graphql')
    assert.equal(init.method, 'POST'); assert.equal(init.redirect, 'error'); assert.equal(init.credentials, 'omit')
    assert.equal(init.cache, 'no-store'); assert.ok(init.signal instanceof AbortSignal)
    const headers = new Headers(init.headers)
    assert.equal(headers.get('authorization'), `Bearer ${token}`)
    assert.equal(headers.get('content-type'), 'application/json')
    assert.equal(headers.get('accept'), 'application/vnd.github+json')
    const body = JSON.parse(String(init.body)) as { query: string; variables: Record<string, unknown> }
    assert.match(body.query.trim(), /^query\b/); assert.doesNotMatch(body.query, /\bmutation\b/)
    calls.push({ url, ...body })
    return answer()
  })
  const client = new GitHubDiffClient(token, budget)
  const grant = { client, repositoryId, fullName, path: '/repos/' + fullName }
  return { client, grant, calls, read: (selected: DiffSnapshot = snapshot) => readGitHubPullState(grant, selected) }
}
const failure = (expected: string) => (error: unknown) => {
  assert.ok(error instanceof WorkspaceReviewError || error instanceof CodingWorkspaceError)
  assert.equal(error.code, expected)
  assert.ok(!(error instanceof GitHubWriteRejection), 'a GraphQL read failure is not evidence of a refused write')
  const rendered = inspect(error, { depth: 8 }) + JSON.stringify(error)
  assert.ok(!rendered.includes(privateBody)); assert.ok(!rendered.includes(token))
  assert.ok(!rendered.includes('https://outside.invalid'))
  return true
}

test('current native review decisions map independently of the PR open, closed and merged lifecycle', async t => {
  for (const [state, decision, expected] of [
    ['OPEN', null, 'open'], ['OPEN', 'REVIEW_REQUIRED', 'open'], ['OPEN', 'APPROVED', 'approved'], ['OPEN', 'CHANGES_REQUESTED', 'changes_requested'],
    ['CLOSED', null, 'closed'], ['CLOSED', 'REVIEW_REQUIRED', 'closed'], ['CLOSED', 'APPROVED', 'closed'], ['CLOSED', 'CHANGES_REQUESTED', 'closed'],
    ['MERGED', null, 'merged'], ['MERGED', 'REVIEW_REQUIRED', 'merged'], ['MERGED', 'APPROVED', 'merged'], ['MERGED', 'CHANGES_REQUESTED', 'merged'],
  ] as const) await t.test(`${state}/${decision ?? 'null'}`, async t => {
    const f = fixture(t, () => Response.json(envelope(native({ state, reviewDecision: decision }))))
    const result = await f.read()
    assert.equal(result.state, expected); assert.equal(result.repositoryId, repositoryId)
    assert.equal(result.headSha, headSha); assert.equal(result.baseSha, baseSha); assert.equal(result.number, number)
    assert.equal(f.calls.length, 1)
  })
})

test('the fixed read document requests the native fields with variables and returns no provider body or URL', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-08T14:00:00.000Z') })
  const f = fixture(t), before = structuredClone(snapshot), value = await f.read()
  assert.deepEqual(f.calls[0]!.variables, { owner: 'fixture', name: 'review', number })
  for (const field of ['headRefOid', 'baseRefOid', 'state', 'reviewDecision', 'fullDatabaseId', 'nameWithOwner'])
    assert.match(f.calls[0]!.query, new RegExp('\\b' + field + '\\b'))
  assert.doesNotMatch(f.calls[0]!.query, /\b(?:body|bodyText|bodyHTML|url|databaseId)\b/)
  assert.deepEqual(value, { repositoryId, number, headSha, baseSha, state: 'open', observedAt: '2026-11-08T14:00:00.000Z' })
  assert.deepEqual(snapshot, before, 'observing lifecycle state never rewrites the immutable source snapshot')
  assert.ok(!JSON.stringify(value).includes(privateBody)); assert.ok(!JSON.stringify(value).includes(token))
})

test('a dismissed or superseded approval is read again and does not remain approved in a local observation', async t => {
  let decision: string | null = 'APPROVED'
  const f = fixture(t, () => Response.json(envelope(native({ reviewDecision: decision }))))
  assert.equal((await f.read()).state, 'approved')
  decision = 'REVIEW_REQUIRED'; assert.equal((await f.read()).state, 'open')
  decision = 'CHANGES_REQUESTED'; assert.equal((await f.read()).state, 'changes_requested')
  decision = null; assert.equal((await f.read()).state, 'open')
  assert.equal(f.calls.length, 4)
})

test('the native number, repository id and repository name are bound to the captured grant', async t => {
  for (const [name, changes] of [
    ['another PR', { number: number + 1 }],
    ['recreated repository', { repository: { fullDatabaseId: '9007199254740994', nameWithOwner: fullName } }],
    ['another repository', { repository: { fullDatabaseId: repositoryId, nameWithOwner: 'other/private' } }],
  ] as const) await t.test(name, async t => {
    const f = fixture(t, () => Response.json(envelope(native(changes))))
    await assert.rejects(f.read(), failure('workspace_review_github_forbidden'))
    assert.equal(f.calls.length, 1)
  })
  await t.test('canonical repository names are case insensitive without changing the id', async t => {
    const f = fixture(t, () => Response.json(envelope(native({ repository: { fullDatabaseId: repositoryId, nameWithOwner: 'FIXTURE/Review' } }))))
    assert.equal((await f.read()).repositoryId, repositoryId)
  })
})

test('native head or base movement rejects even an approved, closed or merged observation', async t => {
  for (const state of ['OPEN', 'CLOSED', 'MERGED']) for (const field of ['headRefOid', 'baseRefOid'] as const)
    await t.test(`${state}/${field}`, async t => {
      const f = fixture(t, () => Response.json(envelope(native({ state, reviewDecision: 'APPROVED', [field]: object('moved ' + field) }))))
      await assert.rejects(f.read(), failure('workspace_snapshot_outdated'))
      assert.equal(f.calls.length, 1)
    })
})

test('BigInt repository identifiers remain exact decimal strings above the JavaScript safe integer limit', async t => {
  for (const id of ['9007199254740993', '9223372036854775807']) await t.test(id, async t => {
    const f = fixture(t, () => Response.json(envelope(native({ repository: { fullDatabaseId: id, nameWithOwner: fullName } }))))
    const selected = { ...snapshot, sourceAccess: { ...snapshot.sourceAccess!, repositoryId: id } }
    const result = await readGitHubPullState({ ...f.grant, repositoryId: id }, selected)
    assert.equal(result.repositoryId, id); assert.equal(typeof result.repositoryId, 'string')
    assert.match(f.calls[0]!.query, /\bfullDatabaseId\b/)
  })
})

test('missing nullable fields and malformed native states or identifiers are not interpreted as open', async t => {
  const withoutDecision = native(); delete withoutDecision.reviewDecision
  const withoutFullId = native({ repository: { databaseId: 61393725, nameWithOwner: fullName } })
  for (const [name, value] of [
    ['reviewDecision omitted', withoutDecision], ['legacy databaseId without fullDatabaseId', withoutFullId],
    ['unknown review decision', native({ reviewDecision: 'DISMISSED' })], ['unknown PR state', native({ state: 'DRAFT' })],
    ['null head', native({ headRefOid: null })], ['null base', native({ baseRefOid: null })],
    ['invalid head', native({ headRefOid: 'refs/heads/main' })], ['invalid base', native({ baseRefOid: 'refs/heads/main' })],
    ['null repository id', native({ repository: { fullDatabaseId: null, nameWithOwner: fullName } })],
    ['unsafe numeric repository id', native({ repository: { fullDatabaseId: Number.MAX_SAFE_INTEGER + 1, nameWithOwner: fullName } })],
    ['fractional repository id', native({ repository: { fullDatabaseId: 1.5, nameWithOwner: fullName } })],
    ['exponential repository id', native({ repository: { fullDatabaseId: '9e15', nameWithOwner: fullName } })],
    ['zero repository id', native({ repository: { fullDatabaseId: '0', nameWithOwner: fullName } })],
  ] as const) await t.test(name, async t => {
    const f = fixture(t, () => Response.json(envelope(value)))
    await assert.rejects(f.read(), failure('workspace_review_github_unavailable'))
    assert.equal(f.calls.length, 1)
  })
})

test('missing captured PR access or a mismatched repository grant rejects before GraphQL', async t => {
  for (const [name, selected] of [
    ['no PR', { ...snapshot, pullRequest: null }], ['no source access', { ...snapshot, sourceAccess: undefined }],
    ['different repository grant', { ...snapshot, sourceAccess: { ...snapshot.sourceAccess!, repositoryId: '9007199254740994' } }],
  ] as const) await t.test(name, async t => {
    const f = fixture(t)
    await assert.rejects(f.read(selected), failure('workspace_review_github_forbidden'))
    assert.equal(f.calls.length, 0)
  })
})

test('GraphQL errors invalidate even otherwise complete data and never expose error bodies', async t => {
  for (const [type, expected] of [
    ['FORBIDDEN', 'workspace_review_github_forbidden'], ['NOT_FOUND', 'workspace_review_github_forbidden'],
    ['UNAUTHORIZED', 'workspace_review_github_forbidden'], ['RATE_LIMITED', 'workspace_review_github_unavailable'],
    ['INTERNAL', 'workspace_review_github_unavailable'], ['RESOURCE_LIMITS_EXCEEDED', 'workspace_review_github_unavailable'],
  ] as const) await t.test(type, async t => {
    const f = fixture(t, () => Response.json({ ...envelope(native({ reviewDecision: 'APPROVED' })),
      errors: [{ type, message: `${privateBody} ${token}`, path: ['repository', 'pullRequest'], extensions: { body: privateBody } }] }))
    await assert.rejects(f.read(), failure(expected)); assert.equal(f.calls.length, 1)
  })
  await t.test('an explicitly empty error list with complete data is accepted', async t => {
    const f = fixture(t, () => Response.json({ ...envelope(), errors: [] }))
    assert.equal((await f.read()).state, 'open')
  })
})

test('partial and invalid GraphQL envelopes are rejected without serializing the response', async t => {
  for (const [name, body] of [
    ['null data', { data: null }], ['missing data', { message: privateBody }], ['null repository', { data: { repository: null } }],
    ['null pull', { data: { repository: { pullRequest: null } } }], ['empty data', { data: {} }],
    ['nonarray errors', { ...envelope(), errors: { message: privateBody } }], ['null errors', { ...envelope(), errors: null }],
    ['error without type', { ...envelope(), errors: [{ message: privateBody }] }], ['array response', []],
  ] as const) await t.test(name, async t => {
    const f = fixture(t, () => Response.json(body))
    await assert.rejects(f.read(), failure('workspace_review_github_unavailable')); assert.equal(f.calls.length, 1)
  })
})

test('HTTP denial or a lost response stays a bounded read failure, with no retry or write-refusal receipt', async t => {
  for (const [status, expected] of [[401, 'workspace_review_github_forbidden'], [403, 'workspace_review_github_forbidden'],
    [404, 'workspace_review_github_forbidden'], [429, 'workspace_review_github_unavailable'], [500, 'workspace_review_github_unavailable']] as const)
    await t.test(String(status), async t => {
      const f = fixture(t, () => Response.json({ message: privateBody }, { status }))
      await assert.rejects(f.read(), failure(expected)); assert.equal(f.calls.length, 1)
    })
  await t.test('a transport error cannot retain credential or source text in its cause', async t => {
    const f = fixture(t, () => { throw new Error(`${privateBody} ${token}`) })
    await assert.rejects(f.read(), failure('workspace_review_github_unavailable')); assert.equal(f.calls.length, 1)
  })
  await t.test('invalid JSON cannot retain raw response text in its cause', async t => {
    const f = fixture(t, () => new Response(privateBody))
    await assert.rejects(f.read(), failure('workspace_review_github_unavailable')); assert.equal(f.calls.length, 1)
  })
})

test('the shared GraphQL entry point refuses mutation documents before making HTTP calls', async t => {
  for (const document of ['mutation { closePullRequest(input:{}) { clientMutationId } }',
    '  mutation Hidden { viewer { login } }', 'subscription { viewer { login } }',
    'query Read { viewer { login } } mutation Write { closePullRequest(input:{}) { clientMutationId } }'])
    await t.test(document.split('{')[0]!.trim(), async t => {
      const f = fixture(t)
      await assert.rejects(f.client.graphql(document, {}), failure('workspace_invalid_request'))
      assert.equal(f.calls.length, 0)
    })
})

test('expired or aborted budgets do not send a GraphQL observation request', async t => {
  for (const [name, budget] of [['expired', { deadline: Date.now() - 1 }],
    ['aborted', { deadline: Date.now() + 30_000, signal: AbortSignal.abort() }]] as const)
    await t.test(name, async t => {
      const f = fixture(t, undefined, budget)
      await assert.rejects(f.read(), failure('workspace_review_github_unavailable')); assert.equal(f.calls.length, 0)
    })
})
