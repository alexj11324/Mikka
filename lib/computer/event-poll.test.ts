import assert from 'node:assert/strict'
import test from 'node:test'
import { COMPUTER_EVENT_ACTIVE_MS, COMPUTER_EVENT_IDLE_MS, computerEventPollDelay } from './event-poll'

test('a computer event stream polls quickly only while events are arriving', () => {
  assert.equal(computerEventPollDelay(3), COMPUTER_EVENT_ACTIVE_MS)
  assert.equal(computerEventPollDelay(0), COMPUTER_EVENT_IDLE_MS)
  assert.ok(COMPUTER_EVENT_IDLE_MS > COMPUTER_EVENT_ACTIVE_MS)
})
