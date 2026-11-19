import assert from 'node:assert/strict'
import test from 'node:test'
import { retryReply, replyRetryLine } from '../lib/reply-retry.ts'
import { mobileMessages } from '../lib/messages.ts'

test('the phone preserves confirmed retry outcomes even when refresh fails', async () => {
  for (const response of [{ queued: true }, { queued: false, reason: 'working' }, { queued: false, reason: 'nothingToRetry' }, { queued: false, reason: 'unavailable' }] as const) {
    assert.equal(await retryReply(async () => response, async () => { throw new Error('fixture-refetch-error') }), response.queued ? 'queued' : response.reason)
  }
})

test('transport loss, explicit refusal and older replies never claim an enqueue', async () => {
  let refreshes = 0
  assert.equal(await retryReply(async () => { throw new Error('fixture-private-provider-text') }, () => { refreshes++ }), 'unconfirmed')
  assert.equal(await retryReply(async () => ({ error: 'fixture-private-provider-text' }), () => { refreshes++ }), 'unavailable')
  assert.equal(await retryReply(async () => ({ queued: false }), () => { refreshes++ }), 'unconfirmed')
  assert.equal(refreshes, 1)
})

test('retry result words match the web without showing raw errors', () => {
  // The phone reads its own catalog now (R-42), so compare against it rather than the Chinese one:
  // this suite runs under whatever the device locale is.
  const copy = mobileMessages.Coordinator.replyRetry
  for (const outcome of ['queued', 'working', 'nothingToRetry', 'unavailable', 'unconfirmed'] as const) assert.equal(replyRetryLine(outcome), copy[outcome])
})
