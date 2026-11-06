import assert from 'node:assert/strict'
import test from 'node:test'
import { clearedBlock, FLAGGED_BLOCK, taskBlock, type BlockIssue } from './task-blocked'

const todo = (metadata: Partial<BlockIssue['metadata']> = {}): BlockIssue => ({ status: 'todo', metadata: { pullRequests: [], ...metadata } })
const none = () => false

test('a failed thread blocks its task (ALEX-2: todo, newest run failed)', () => {
  assert.deepEqual(taskBlock(todo(), { runId: 'r1', status: 'failed', outcome: 'failed' }, none), { reason: 'failed' })
  assert.deepEqual(taskBlock(todo(), { runId: 'r1', status: 'failed', outcome: null }, none), { reason: 'failed' })
  assert.deepEqual(taskBlock(todo(), { runId: 'r1', status: 'succeeded', outcome: 'blocked' }, none), { reason: 'run' })
  assert.deepEqual(taskBlock(todo(), { runId: 'r1', status: 'paused', outcome: null }, none), { reason: 'quota' })
})

test('a thread asking a question blocks; a PR waiting for review does not', () => {
  assert.deepEqual(taskBlock(todo(), { runId: 'r1', status: 'waiting_input', outcome: null }, none), { reason: 'question' })
  assert.deepEqual(taskBlock(todo(), { runId: 'r1', status: 'succeeded', outcome: 'needs_input' }, none), { reason: 'question' })
  const review = { status: 'review', metadata: { pullRequests: [{ url: 'https://github.com/a/b/pull/1', state: 'open' as const }] } }
  assert.equal(taskBlock(review, { runId: 'r1', status: 'succeeded', outcome: 'done' }, none), null)
})

test('a running, idle or done thread does not block; the task goes back to its column', () => {
  assert.equal(taskBlock(todo(), { runId: 'r2', status: 'running', outcome: null }, none), null)
  assert.equal(taskBlock(todo(), { runId: 'r2', status: 'succeeded', outcome: 'idle' }, none), null)
  assert.equal(taskBlock(todo(), { runId: 'r2', status: 'succeeded', outcome: 'done' }, none), null)
  assert.equal(taskBlock(todo(), undefined, none), null)
})

test('a closed task is never blocked', () => {
  for (const status of ['done', 'canceled', 'duplicate']) assert.equal(taskBlock({ status, metadata: { pullRequests: [], block: FLAGGED_BLOCK } }, { runId: 'r1', status: 'failed', outcome: 'failed' }, () => true), null)
})

test('an open blocker blocks; a closed one does not', () => {
  const issue = todo({ blockedByIds: ['a', 'b'] })
  assert.deepEqual(taskBlock(issue, undefined, id => id === 'b'), { reason: 'dependency', blockerId: 'b' })
  assert.equal(taskBlock(issue, undefined, none), null)
})

test('a person flags a task in and out of 受阻', () => {
  assert.deepEqual(taskBlock(todo({ block: FLAGGED_BLOCK }), undefined, none), { reason: 'flagged' })
  const run = { runId: 'r1', status: 'failed', outcome: 'failed' as const }
  // Moved out: the failed thread is set aside...
  assert.equal(taskBlock(todo({ block: clearedBlock(run) }), run, none), null)
  // ...until a newer thread blocks again.
  assert.deepEqual(taskBlock(todo({ block: clearedBlock(run) }), { runId: 'r2', status: 'waiting_input', outcome: null }, none), { reason: 'question' })
  // Cleared with no thread also sets a dependency aside.
  assert.equal(taskBlock(todo({ blockedByIds: ['a'], block: clearedBlock(undefined) }), undefined, () => true), null)
  // Flagged and failed: the thread's reason names it.
  assert.deepEqual(taskBlock(todo({ block: FLAGGED_BLOCK }), run, none), { reason: 'failed' })
})

test('the board can save the 受阻 flag through the RPC allowlist', async () => {
  const { desktopActionSchemas } = await import('./desktop-rpc/schemas')
  const schema = desktopActionSchemas['issue-metadata.updateIssueMetadata']
  const id = '6f1b5f3e-8c1a-4f3e-9a51-0a8c2f1d9b10'
  assert.equal(schema.safeParse([{ id, revision: 2, patch: { block: FLAGGED_BLOCK } }]).success, true)
  assert.equal(schema.safeParse([{ id, revision: 2, patch: { block: clearedBlock({ runId: 'r1' }) } }]).success, true)
  assert.equal(schema.safeParse([{ id, revision: 2, patch: { block: { blocked: 'yes', runId: null } } }]).success, false)
})
