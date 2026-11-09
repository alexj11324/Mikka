import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runResult } from './use-run-result'

// One set of words for how a run came out (glossary: Run result): the task page's and the right column's 活动 rows.
test('the latest run reads as its own result', () => {
  assert.deepEqual(runResult({ status: 'running' }, true), { result: 'running', reason: null })
  assert.deepEqual(runResult({ status: 'queued' }, true), { result: 'queued', reason: null })
  assert.deepEqual(runResult({ status: 'succeeded', outcome: 'done' }, true), { result: 'done', reason: null })
  assert.deepEqual(runResult({ status: 'failed', outcome: 'failed' }, true), { result: 'failed', reason: null })
  assert.deepEqual(runResult({ status: 'failed', outcome: 'blocked' }, true), { result: 'blocked', reason: 'blocked' })
  assert.deepEqual(runResult({ status: 'waiting_input' }, true), { result: 'waiting', reason: 'needs_input' })
  assert.deepEqual(runResult({ status: 'paused' }, true), { result: 'blocked', reason: 'quota' })
})

test('an earlier run keeps its result, except one left waiting, which has ended', () => {
  assert.deepEqual(runResult({ status: 'succeeded', outcome: 'done' }, false), { result: 'done', reason: null })
  assert.deepEqual(runResult({ status: 'failed', outcome: 'failed' }, false), { result: 'failed', reason: null })
  assert.deepEqual(runResult({ status: 'failed', outcome: 'blocked' }, false), { result: 'blocked', reason: 'blocked' })
  assert.deepEqual(runResult({ status: 'waiting_input' }, false), { result: 'ended', reason: null })
  assert.deepEqual(runResult({ status: 'succeeded', outcome: 'needs_input' }, false), { result: 'ended', reason: null })
})
