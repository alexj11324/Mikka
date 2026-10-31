import assert from 'node:assert/strict'
import test from 'node:test'
import { coordinatorChatState } from './chat-state'
import { MAX_WAKE_ATTEMPTS } from './wake-recovery'

const now = new Date('2026-10-31T12:00:00Z')
const expired = new Date(now.getTime() - 1)
const future = new Date(now.getTime() + 120_000)
const event = { kind: 'user_message', tier: 'attention', wakeAttempts: 0, wakeLeaseUntil: null, wakeLastError: null }

test('new pending input and an active startup claim show work', () => {
  assert.deepEqual(coordinatorChatState(undefined, [event], now), { working: true, error: null })
  assert.equal(coordinatorChatState(undefined, [{ ...event, wakeAttempts: 1, wakeLeaseUntil: future }], now).working, true)
})

test('failed and unacknowledged starts stop the spinner while preserving pending input', () => {
  const pending = [{ ...event, wakeAttempts: 1, wakeLeaseUntil: expired }]
  assert.deepEqual(coordinatorChatState(undefined, pending, now), { working: false, error: 'wake_start_unconfirmed' })
  assert.equal(pending.length, 1)
  assert.deepEqual(coordinatorChatState(undefined, [{ ...pending[0], wakeLeaseUntil: null, wakeLastError: 'wake_failed' }], now), { working: false, error: 'wake_failed' })
  assert.equal(coordinatorChatState(undefined, [{ ...pending[0], wakeLastError: 'private-provider-detail' }], now).error, 'wake_start_unconfirmed')
})

test('the last live delivery attempt can run; exhaustion remains visible afterwards', () => {
  const last = { ...event, wakeAttempts: MAX_WAKE_ATTEMPTS, wakeLastError: 'wake_exhausted', wakeLeaseUntil: future }
  assert.equal(coordinatorChatState(undefined, [last], now).working, true)
  assert.deepEqual(coordinatorChatState(undefined, [{ ...last, wakeLeaseUntil: expired }], now), { working: false, error: 'wake_exhausted' })
})

test('a real active turn and new input take precedence over earlier delivery failures', () => {
  const failed = { ...event, wakeAttempts: MAX_WAKE_ATTEMPTS, wakeLastError: 'wake_exhausted' }
  assert.equal(coordinatorChatState({ leaseHolder: 'turn', leaseUntil: future, lastError: null }, [failed], now).working, true)
  assert.equal(coordinatorChatState(undefined, [failed, event], now).working, true)
  assert.deepEqual(coordinatorChatState(undefined, [failed, { ...event, wakeAttempts: 1, wakeLastError: 'wake_failed' }], now), { working: false, error: 'wake_failed' }, 'another retryable request must not be labelled exhausted')
})

test('background and handoff inbox rows stay quiet, and completed turns retain existing errors only', () => {
  assert.deepEqual(coordinatorChatState(undefined, [{ ...event, tier: 'background' }, { ...event, kind: 'matter_handoff' }], now), { working: false, error: null })
  assert.deepEqual(coordinatorChatState({ leaseHolder: null, leaseUntil: null, lastError: 'turn_failed' }, [], now), { working: false, error: 'turn_failed' })
  assert.deepEqual(coordinatorChatState(undefined, [], now), { working: false, error: null })
})
