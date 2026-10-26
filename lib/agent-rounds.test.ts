import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AGENT_MAX_ROUNDS, ROUND_WARNING_LINE, roundNotice, roundStep } from './agent-rounds'

test('a generate call may cost 120 rounds; the warning starts at three quarters', () => {
  assert.equal(AGENT_MAX_ROUNDS, 120)
  assert.equal(ROUND_WARNING_LINE, 90)
})

test('below the warning line the step is left alone', () => {
  assert.deepEqual(roundStep(0, 'base'), {})
  assert.deepEqual(roundStep(ROUND_WARNING_LINE - 1, 'base'), {})
  assert.equal(roundNotice(ROUND_WARNING_LINE - 1), null)
})

test('from the warning line the instructions say how many rounds remain', () => {
  const step = roundStep(ROUND_WARNING_LINE, 'base')
  assert.equal(step.toolChoice, undefined)
  assert.match(step.instructions ?? '', /^base\n\n/)
  assert.match(step.instructions ?? '', /用了 90 轮.*还剩 30 轮/)
})

test('the last round has tools off so the message ends with a reply', () => {
  const step = roundStep(AGENT_MAX_ROUNDS - 1, 'base')
  assert.equal(step.toolChoice, 'none')
  assert.match(step.instructions ?? '', /还剩 1 轮/)
})
