import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { getReviewChecks, getReviewDiff, getReviewFile, getReviewSummary, mergeReview, REVIEW_ENDPOINTS, ReviewRequestError, sendToAgent } from './client'
import type { ReviewSummary } from './contract'

const TASK = '6f1c8a52-1b0e-4c3a-9d2f-0a1b2c3d4e5f'
const realFetch = globalThis.fetch
type Call = { url: string; method: string; body: unknown }
let calls: Call[] = []

function answer(status: number, body: unknown) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined })
    return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
}

afterEach(() => { globalThis.fetch = realFetch; calls = [] })

const summary: ReviewSummary = {
  taskId: TASK,
  pr: { number: 1471, state: 'open', url: 'https://github.com/acme/app/pull/1471' },
  files: 3, additions: 42, deletions: 7,
  checks: { failed: 1, passed: 5, pending: 0 },
  running: false,
  branch: 'fix/ios-login',
  permissions: { canMerge: false, canSend: true, canTerminal: false, reasons: { merge: 'not_owner_merge', terminal: 'not_owner_terminal' } },
  live: { workspaceId: '0d9e8f7a-6b5c-4d3e-8f2a-1b0c9d8e7f6a' },
}

test('the endpoints live in one map under the task', () => {
  assert.equal(REVIEW_ENDPOINTS.summary(TASK), `/api/tasks/${TASK}/review/summary`)
  assert.equal(REVIEW_ENDPOINTS.merge('a/b'), '/api/tasks/a%2Fb/review/merge')
})

test('check contracts retain native log links while accepting historical checks without links', async () => {
  const checks = [{ id: 'native-check-19', name: 'Build', status: 'failed', logExcerpt: 'Build failed',
    logUrl: 'https://github.com/fixture/review/runs/19' }, { id: 'historical-check', name: 'Tests', status: 'passed' }]
  answer(200, checks)
  assert.deepEqual(await getReviewChecks(TASK), checks)
  assert.equal(calls[0]!.url, `/api/tasks/${TASK}/review/checks`)
})

test('a summary is narrowed to the contract: unknown fields drop, permissions keep their reasons', async () => {
  answer(200, { ...summary, extra: 'ignored' })
  const read = await getReviewSummary(TASK)
  assert.deepEqual(read, summary)
  assert.equal(calls[0].url, `/api/tasks/${TASK}/review/summary`)
})

test('a running task with no PR is a valid summary, and missing reasons default to none', async () => {
  answer(200, { ...summary, pr: null, running: true, branch: undefined, live: undefined, permissions: { canMerge: true, canSend: true, canTerminal: true } })
  const read = await getReviewSummary(TASK)
  assert.ok(read)
  assert.equal(read.pr, null)
  assert.deepEqual(read.permissions.reasons, {})
})

test('a body of the wrong shape or a failed request throws ReviewRequestError', async () => {
  answer(200, { ...summary, files: -1 })
  await assert.rejects(getReviewSummary(TASK), (error: unknown) => error instanceof ReviewRequestError && error.status === 200 && error.cause !== undefined)
  answer(200, { ...summary, pr: { number: 1, state: 'draft', url: 'https://github.com/x/y/pull/1' } })
  await assert.rejects(getReviewSummary(TASK), ReviewRequestError)
  answer(500, { error: 'boom' })
  await assert.rejects(getReviewSummary(TASK), (error: unknown) => error instanceof ReviewRequestError && error.status === 500)
})

test('the review read passes the cursor and commit, and keeps a paged file without its patch', async () => {
  const diff = {
    source: { kind: 'checkpoint', at: '2026-11-08T10:00:00Z', reclaimed: true }, live: false, base: 'main', head: 'abc123',
    files: [{ path: 'ios/Login.swift', status: 'modified', additions: 40, deletions: 7, patch: null, tooLarge: true }], empty: false, nextCursor: 'c2',
  }
  answer(200, { summary, diff })
  const read = await getReviewDiff(TASK, { cursor: 'c1', commit: 'abc123' })
  assert.equal(calls[0].url, `/api/tasks/${TASK}/review?cursor=c1&commit=abc123`)
  assert.ok(read)
  assert.equal(read.diff.files[0].patch, null)
  assert.equal(read.diff.source.reclaimed, true)
  answer(200, { summary, diff: { ...diff, source: { ...diff.source, kind: 'attempt' } } })
  await assert.rejects(getReviewDiff(TASK), ReviewRequestError)
})

test('one file is read by path, with the comments already sent on it', async () => {
  answer(200, { file: { path: 'a b.ts', status: 'added', additions: 1, deletions: 0, patch: '@@ -0,0 +1 @@\n+x', comments: 1 },
    comments: [{ id: 'c1', path: 'a b.ts', line: 1, side: 'new', body: '这里加注释', author: 'Test owner', sentAt: '2026-11-08T12:00:00Z' }] })
  const read = await getReviewFile(TASK, 'a b.ts')
  assert.equal(calls[0].url, `/api/tasks/${TASK}/review/file?path=a+b.ts`)
  assert.equal(read.file.patch, '@@ -0,0 +1 @@\n+x')
  assert.equal(read.file.comments, 1)
  assert.equal(read.comments[0].author, 'Test owner')
})

test('发给 Agent sends path, line, side and body, never the local id, and maps a 403 to a denial', async () => {
  answer(200, { messageId: 'm1', attempt: 2 })
  const sent = await sendToAgent(TASK, { comments: [{ id: 'local-1', path: 'a.ts', line: 22, side: 'new', body: '改这里' }], note: '  ', attachedChecks: ['check-ios-unit'], idempotencyKey: 'k1' })
  assert.deepEqual(sent, { kind: 'sent', messageId: 'm1', attempt: 2 })
  assert.deepEqual(calls[0], { url: `/api/tasks/${TASK}/review/send`, method: 'POST', body: { comments: [{ path: 'a.ts', line: 22, side: 'new', body: '改这里' }], attachedChecks: ['check-ios-unit'], idempotencyKey: 'k1' } })
  answer(403, { error: 'not_owner_send', reason: 'not_owner_send' })
  assert.deepEqual(await sendToAgent(TASK, { comments: [], attachedChecks: [], idempotencyKey: 'k2' }), { kind: 'denied', reason: 'not_owner_send', message: null })
  answer(403, { error: 'somebody_else', reason: 'somebody_else' })
  await assert.rejects(sendToAgent(TASK, { comments: [], attachedChecks: [], idempotencyKey: 'k3' }), (error: unknown) => error instanceof ReviewRequestError && error.status === 403)
})

test('批准合并 maps 200, 409 and 403 to the merge result', async () => {
  answer(409, { error: 'needs_confirm', failing: 1 })
  assert.deepEqual(await mergeReview(TASK, { confirm: false }), { kind: 'needs_confirm', failing: 1 })
  assert.deepEqual(calls[0].body, { confirmFailedChecks: false })
  answer(200, { merged: true })
  assert.deepEqual(await mergeReview(TASK, { confirm: true }), { kind: 'merged' })
  assert.deepEqual(calls[1].body, { confirmFailedChecks: true })
  answer(403, { error: 'github_permission', reason: 'github_permission', message: 'Resource not accessible by integration' })
  assert.deepEqual(await mergeReview(TASK, { confirm: true }), { kind: 'denied', reason: 'github_permission', message: 'Resource not accessible by integration' })
  answer(409, { conflict: true })
  await assert.rejects(mergeReview(TASK, { confirm: false }), ReviewRequestError)
  answer(200, { merged: false })
  await assert.rejects(mergeReview(TASK, { confirm: true }), ReviewRequestError)
})

test('no scoped coding source is a normal null read and an access failure stays a failure', async () => {
  answer(200, null)
  assert.equal(await getReviewSummary(TASK), null)
  assert.equal(await getReviewDiff(TASK), null)
  answer(404, { error: 'workspace_not_found' })
  await assert.rejects(getReviewSummary(TASK), ReviewRequestError)
  await assert.rejects(getReviewDiff(TASK), ReviewRequestError)
})

test('file, check and cursor reads reject a different immutable snapshot even when the path or HEAD matches', async () => {
  const reference = { snapshotId: TASK, sourceVersion: 'a'.repeat(64) }
  const different = { ...reference, sourceVersion: 'b'.repeat(64) }
  const file = { path: 'a.ts', status: 'modified', additions: null, deletions: null, patch: null, comments: 0 }
  answer(200, { reviewRef: different, file, comments: [] })
  await assert.rejects(getReviewFile(TASK, file.path, reference), ReviewRequestError)
  assert.equal(new URL(calls[0].url, 'https://example.test').searchParams.get('sourceVersion'), reference.sourceVersion)
  answer(200, { reviewRef: reference, file: { ...file, path: 'different.ts' }, comments: [] })
  await assert.rejects(getReviewFile(TASK, file.path, reference), ReviewRequestError)
  const checks = [{ id: 'skipped-native', status: 'neutral', name: 'Optional validation' }]
  answer(200, { reviewRef: different, state: 'complete', checks })
  await assert.rejects(getReviewChecks(TASK, reference), ReviewRequestError)
  answer(200, { reviewRef: reference, state: 'complete', checks })
  assert.deepEqual(await getReviewChecks(TASK, reference), checks)
  const diff = { reviewRef: different, source: { kind: 'commit', at: '2026-11-08T00:00:00Z', reclaimed: false },
    live: false, base: null, head: null, files: [file], empty: false }
  answer(200, { summary, diff })
  await assert.rejects(getReviewDiff(TASK, { cursor: 'next', reference }), ReviewRequestError)
  assert.ok(calls.every(call => call.method === 'GET'))
})
