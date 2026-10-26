import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AGENT_MAX_ROUNDS, ROUND_WARNING_LINE } from '../agent-rounds'
import { coordinatorStep, turnWarning } from './model'

test('the Coordinator follows the shared round cap', () => {
  assert.deepEqual(coordinatorStep({ stepNumber: 0, initialInstructions: 'base' }), {})
  assert.deepEqual(coordinatorStep({ stepNumber: ROUND_WARNING_LINE - 1, initialInstructions: 'base' }), {})
  assert.match(coordinatorStep({ stepNumber: ROUND_WARNING_LINE, initialInstructions: 'base' }).system ?? '', /^base\n\n.*还剩 30 轮/)
  const last = coordinatorStep({ stepNumber: AGENT_MAX_ROUNDS - 1, initialInstructions: 'base' })
  assert.equal(last.toolChoice, 'none')
  assert.match(last.system ?? '', /还剩 1 轮/)
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
