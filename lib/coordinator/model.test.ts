import { test } from 'node:test'
import assert from 'node:assert/strict'
import { COORDINATOR_MAX_STEPS, coordinatorStep, turnWarning } from './model'

test('tools stay on until the last allowed step', () => {
  assert.deepEqual(coordinatorStep({ stepNumber: 0 }), {})
  assert.deepEqual(coordinatorStep({ stepNumber: COORDINATOR_MAX_STEPS - 2 }), {})
  assert.deepEqual(coordinatorStep({ stepNumber: COORDINATOR_MAX_STEPS - 1 }), { toolChoice: 'none' })
})

test('a reply that stopped normally with text has no warning', () => {
  assert.equal(turnWarning('stop', '好的'), null)
})

test('a cut-off, filtered, failed or empty reply is flagged', () => {
  assert.match(turnWarning('length', 'half a sente') ?? '', /^replyCutOff/)
  assert.match(turnWarning('content-filter', '') ?? '', /^replyFiltered/)
  assert.match(turnWarning('other', 'x') ?? '', /^replyEndedEarly/)
  assert.match(turnWarning('stop', '  ') ?? '', /^replyEmpty/)
  assert.match(turnWarning('tool-calls', '') ?? '', /^replyEmpty/)
})
