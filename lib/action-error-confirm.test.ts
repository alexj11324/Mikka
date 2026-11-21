import assert from 'node:assert/strict'
import test from 'node:test'
import { ActionFailureError, runAction } from './action-error'
import { actionErrorStatus } from './action-status'

// The confirmAccess contract at the action boundary (ALE-26): a refused relation
// edit names itself as confirmable, the transport answers 409, and a caller that
// replays with confirmAccess goes through. The audience rules are in
// resource-access/audience.test.ts; the database wiring is in
// tests/resource-access.db.test.ts.

test('a refusal that only asks for confirmation survives as confirmable, with its counts', async () => {
  const result = await runAction(async () => {
    throw new ActionFailureError('accessChangeConfirmationRequired', { tasks: 2, readers: 3 }, true)
  })
  assert.deepEqual(result, { error: 'accessChangeConfirmationRequired', params: { tasks: 2, readers: 3 }, confirmable: true })
})

test('an ordinary failure is not confirmable, and carries no flag at all', async () => {
  const result = await runAction(async () => { throw new ActionFailureError('issueOutdated') })
  // The key is absent rather than undefined: existing callers compare this
  // object with deepEqual, so an extra property would fail them.
  assert.deepEqual(result, { error: 'issueOutdated', params: undefined })
  assert.equal('confirmable' in result, false)
})

test('the confirmation code answers 409 and other codes keep their status', () => {
  assert.equal(actionErrorStatus('accessChangeConfirmationRequired'), 409)
  assert.equal(actionErrorStatus('authRequired'), 401)
  assert.equal(actionErrorStatus('issueOutdated'), 400)
})

test('an unexpected error still propagates instead of reading as a confirmation', async () => {
  const unexpected = new Error('synthetic internal detail')
  await assert.rejects(runAction(async () => { throw unexpected }), error => error === unexpected)
})
