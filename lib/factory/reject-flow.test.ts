import assert from 'node:assert/strict'
import { test } from 'node:test'
import { canReject, canSubmitReject, closedReject, rejectFlow } from './reject-flow'

test('open → edit → submit → succeed closes and clears the note', () => {
  let f = rejectFlow(closedReject, { type: 'open' })
  assert.equal(f.phase, 'editing')
  assert.equal(canSubmitReject(f), false)
  f = rejectFlow(f, { type: 'edit', note: '标题不对' })
  assert.equal(canSubmitReject(f), true)
  f = rejectFlow(f, { type: 'submit' })
  assert.equal(f.phase, 'submitting')
  assert.deepEqual(rejectFlow(f, { type: 'succeed' }), closedReject)
})

test('submitting freezes edits and ignores cancel; failure keeps the note', () => {
  let f = rejectFlow(rejectFlow(rejectFlow(closedReject, { type: 'open' }), { type: 'edit', note: 'x' }), { type: 'submit' })
  assert.equal(rejectFlow(f, { type: 'edit', note: 'y' }).note, 'x')
  assert.equal(rejectFlow(f, { type: 'cancel' }).phase, 'submitting')
  f = rejectFlow(f, { type: 'fail' })
  assert.deepEqual(f, { phase: 'failed', note: 'x' })
  assert.equal(rejectFlow(f, { type: 'submit' }).phase, 'submitting')
  assert.deepEqual(rejectFlow(f, { type: 'cancel' }), closedReject)
})

test('send-back is offered only on pending and only when the server supports it', () => {
  assert.equal(canReject('pending', true), true)
  assert.equal(canReject('pending', false), false)
  for (const s of ['approved', 'publishing', 'failed', 'live', 'expired', 'invalidated'] as const) assert.equal(canReject(s, true), false)
})
