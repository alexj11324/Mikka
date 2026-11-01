// A cited thread's icon follows the group the server decided, never the run's raw status (R-52).
import assert from 'node:assert/strict'
import test from 'node:test'
import { runIcon } from '../lib/thread-icon.ts'

test('the server group decides the icon, whatever the raw status says', () => {
  assert.equal(runIcon({ status: 'succeeded', group: 'blocked' } as { group: 'blocked' }), 'failed')
  assert.equal(runIcon({ status: 'failed', group: 'idle' } as { group: 'idle' }), 'stopped')
  assert.equal(runIcon({ group: 'resolved' }), 'done')
  assert.equal(runIcon({ group: 'waiting' }), 'waiting')
  assert.equal(runIcon({ group: 'running' }), 'running')
})

test('a lost or queued run without a group never spins', () => {
  assert.equal(runIcon({}), 'waiting')
})
