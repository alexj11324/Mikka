import assert from 'node:assert/strict'
import { test } from 'node:test'
import { decisionTimeoutMs } from './decision-timeout'

test('LiteLLM decisions default to 30 seconds', () => {
  assert.equal(decisionTimeoutMs({}), 30_000)
})

test('decision timeout accepts an environment override', () => {
  assert.equal(decisionTimeoutMs({ MIKKA_DECISION_TIMEOUT_MS: '45000' }), 45_000)
})

test('empty, invalid and out-of-range overrides use the default', () => {
  for (const value of ['', ' ', 'invalid', '0', '-1', '1.5', 'Infinity', '2147483648']) {
    assert.equal(decisionTimeoutMs({ MIKKA_DECISION_TIMEOUT_MS: value }), 30_000)
  }
})
