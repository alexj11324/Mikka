import assert from 'node:assert/strict'
import test from 'node:test'

import { threadGroupOfRun } from './thread-status-icon'

test('a card or chip shows the run\'s group: done is 已解决, blocked and failed 受阻', () => {
  assert.equal(threadGroupOfRun('running'), 'running')
  assert.equal(threadGroupOfRun('succeeded', 'done'), 'resolved')
  assert.equal(threadGroupOfRun('succeeded', 'blocked'), 'blocked')
  assert.equal(threadGroupOfRun('failed', 'failed'), 'blocked')
  assert.equal(threadGroupOfRun('stopped', 'idle'), 'idle')
  assert.equal(threadGroupOfRun('succeeded', 'needs_input'), 'waiting')
})

test('not judged yet: failed is 受阻, any other ended run 等待你, never 已解决; a question waits', () => {
  assert.equal(threadGroupOfRun('failed'), 'blocked')
  assert.equal(threadGroupOfRun('succeeded'), 'waiting')
  assert.equal(threadGroupOfRun('succeeded', null), 'waiting')
  assert.equal(threadGroupOfRun('stopped', null, true), 'waiting')
  assert.equal(threadGroupOfRun('waiting_input'), 'waiting')
})
