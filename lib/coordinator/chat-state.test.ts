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

test('back-to-back unconsumed wake claims cannot hide an unconfirmed start', () => {
  const first = { ...event, wakeAttempts: 1, wakeLeaseUntil: future }
  assert.deepEqual(coordinatorChatState(undefined, [first], now), { working: true, error: null })
  const retryAt = new Date(future.getTime() + 1)
  assert.deepEqual(coordinatorChatState(undefined, [first], retryAt), { working: false, error: 'wake_start_unconfirmed' })
  const second = { ...first, wakeAttempts: 2, wakeLeaseUntil: new Date(retryAt.getTime() + 120_000) }
  assert.deepEqual(coordinatorChatState(undefined, [second], retryAt), { working: false, error: 'wake_start_unconfirmed' })
  assert.equal(coordinatorChatState({ leaseHolder: 'real-turn', leaseUntil: second.wakeLeaseUntil, lastError: null }, [second], retryAt).working, true)
})

test('the last live startup retry stays unconfirmed until consumption or exhaustion', () => {
  const last = { ...event, wakeAttempts: MAX_WAKE_ATTEMPTS, wakeLastError: 'wake_exhausted', wakeLeaseUntil: future }
  assert.deepEqual(coordinatorChatState(undefined, [last], now), { working: false, error: 'wake_start_unconfirmed' })
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

test('once the turn holding the lease has stored its reply, the chat is no longer working', () => {
  const turn = { leaseHolder: 'wrun_turn', leaseUntil: future, lastError: null }
  // After the reply is stored the workflow still finishes the execution, decides a phone push and releases the lease.
  assert.deepEqual(coordinatorChatState(turn, [], now, { role: 'assistant', streamId: 'wrun_turn:0' }), { working: false, error: null })
  assert.deepEqual(coordinatorChatState(turn, [], now, { role: 'assistant', streamId: 'wrun_turn:2' }), { working: false, error: null }, 'any round of this turn')
  // Still answering: the last stored message is the person's, or a reply from an earlier turn.
  assert.equal(coordinatorChatState(turn, [], now, { role: 'user' }).working, true)
  assert.equal(coordinatorChatState(turn, [], now, { role: 'assistant', streamId: 'wrun_earlier:0' }).working, true)
  assert.equal(coordinatorChatState(turn, [], now, { role: 'assistant' }).working, true, 'a reply with no stream id is not this turn\'s')
  assert.equal(coordinatorChatState(turn, [], now, { role: 'tool', streamId: 'wrun_turn:0' }).working, true, 'tool output is not a finished reply')
  assert.equal(coordinatorChatState(turn, [], now).working, true)
  // A message sent meanwhile is waiting for the next round: that is work still to come.
  assert.equal(coordinatorChatState(turn, [event], now, { role: 'assistant', streamId: 'wrun_turn:0' }).working, true)
  assert.equal(coordinatorChatState(turn, [{ ...event, tier: 'background' }], now, { role: 'assistant', streamId: 'wrun_turn:0' }).working, false)
  // A finished reply keeps the turn's warning, as a released lease does.
  assert.deepEqual(coordinatorChatState({ ...turn, lastError: 'length' }, [], now, { role: 'assistant', streamId: 'wrun_turn:0' }), { working: false, error: 'length' })
})

test('a wake code carries the turn failure stored while that message waited, never an older one', () => {
  const sent = new Date(now.getTime() - 600_000)
  const waited = { ...event, wakeAttempts: MAX_WAKE_ATTEMPTS, wakeLeaseUntil: null, wakeLastError: 'wake_exhausted', createdAt: sent }
  const failed = { leaseHolder: null, leaseUntil: null, lastError: 'subscription_generation_failed (provider_request_rejected)', lastErrorAt: new Date(sent.getTime() + 60_000) }
  assert.deepEqual(coordinatorChatState(failed, [waited], now), { working: false, error: 'wake_exhausted', cause: 'subscription_generation_failed (provider_request_rejected)' })
  // A failure recorded before the message arrived belongs to an earlier message.
  assert.deepEqual(coordinatorChatState({ ...failed, lastErrorAt: new Date(sent.getTime() - 1) }, [waited], now), { working: false, error: 'wake_exhausted' })
  assert.deepEqual(coordinatorChatState({ ...failed, lastErrorAt: null }, [waited], now), { working: false, error: 'wake_exhausted' })
})

test('a failure followed by a newer stored reply is not the chat state any more', () => {
  const sent = new Date(now.getTime() - 600_000)
  // An untriaged runtime row (tier null, not the person's) no turn takes, its wakes used up.
  const stale = { kind: 'run_finished', tier: null, wakeAttempts: MAX_WAKE_ATTEMPTS, wakeLeaseUntil: null, wakeLastError: 'wake_exhausted', createdAt: sent }
  const before = coordinatorChatState(undefined, [stale], now, { role: 'user', createdAt: new Date(sent.getTime() - 1) })
  assert.deepEqual(before, { working: false, error: 'wake_exhausted' }, 'failed first: the line shows')
  const answered = { role: 'assistant', streamId: 'wrun_later:0', createdAt: new Date(sent.getTime() + 60_000) }
  assert.deepEqual(coordinatorChatState(undefined, [stale], now, answered), { working: false, error: null }, 'then a reply: no stale line')
  // A reply stored before the row arrived does not hide it.
  assert.deepEqual(coordinatorChatState(undefined, [stale], now, { ...answered, createdAt: new Date(sent.getTime() - 60_000) }), { working: false, error: 'wake_exhausted' })
  // A newer failing row still shows after an older reply.
  const fresh = { ...stale, kind: 'user_message', tier: 'attention', createdAt: new Date(sent.getTime() + 120_000) }
  assert.equal(coordinatorChatState(undefined, [stale, fresh], now, answered).error, 'wake_exhausted')
})
