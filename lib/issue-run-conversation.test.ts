import test from 'node:test'
import assert from 'node:assert/strict'
import { runIsActive, runDiscussionId, isRunDiscussion, runOutput } from './issue-run-conversation'

test('only active run states offer messages; completed history stays readable', () => {
  for (const state of ['queued', 'preparing', 'running', 'waiting_input', 'finishing']) assert.equal(runIsActive(state), true)
  for (const state of ['succeeded', 'stopped', 'failed', 'cancelled', 'unknown']) assert.equal(runIsActive(state), false)
})
test('run comments use distinct existing collaborative discussion threads', () => {
  assert.equal(runDiscussionId('run-1'), 'discussion-run-run-1')
  assert.notEqual(runDiscussionId('run-1'), runDiscussionId('run-2'))
  assert.equal(isRunDiscussion(runDiscussionId('run-1')), true)
  assert.equal(isRunDiscussion('discussion-other'), false)
})
test('durable chunk replay merges deltas and preserves tools/errors in order', () => {
  assert.deepEqual(runOutput([
    { type: 'start' }, { type: 'reasoning-delta', id: 'r', delta: 'Think' },
    { type: 'text-delta', id: 'a', delta: 'Hello ' }, { type: 'text-delta', id: 'a', delta: '世界' },
    { type: 'tool-input-available', toolCallId: 't', toolName: 'read' },
    { type: 'tool-output-available', toolCallId: 't', output: { ok: true } },
    { type: 'tool-output-error', toolCallId: 'u', errorText: 'No access' },
    { type: 'error', errorText: 'Interrupted' }, { type: 'unknown', data: 'ignored' },
  ]), [
    { id: 'reasoning:r', kind: 'reasoning', text: 'Think' },
    { id: 'text:a', kind: 'text', text: 'Hello 世界' },
    { id: 'tool:t', kind: 'tool', text: 'read\n{"ok":true}' },
    { id: 'tool:u', kind: 'tool', text: 'No access' },
    { id: 'error:7', kind: 'error', text: 'Interrupted' },
  ])
  assert.deepEqual(runOutput([]), [])
})
