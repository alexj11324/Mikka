import assert from 'node:assert/strict'
import { test } from 'node:test'
import { timedModelStream, type ModelCallTiming } from './model-call-timing'

test('an error part followed by EOF is interrupted even when the reader itself does not throw', async () => {
  const error = new Error('Synthetic private provider failure')
  const parts = [{ type: 'text-delta', delta: 'Synthetic private reply' }, { type: 'error', error }]
  const stream = new ReadableStream({ start(controller) { for (const part of parts) controller.enqueue(part); controller.close() } })
  const logs: ModelCallTiming[] = []
  const timed = timedModelStream({ stream }, { route: 'subscription', model: 'synthetic', tools: 0, startedAt: 0, requestedAt: 1 }, () => 5, line => logs.push(line))
  const received = []
  for await (const part of timed.stream) received.push(part)
  assert.deepEqual(received, parts, 'diagnostics do not alter the failure or response')
  assert.equal(logs.length, 1)
  assert.equal(logs[0].interrupted, true)
  assert.equal(logs[0].firstTextMs, 4)
  assert.doesNotMatch(JSON.stringify(logs), /private/)
})

test('a later finish cannot erase a preceding error part; clean finish remains uninterrupted', async () => {
  for (const failed of [false, true]) {
    const parts = [...(failed ? [{ type: 'error' }] : []), { type: 'finish', finishReason: 'stop' }]
    const stream = new ReadableStream({ start(controller) { for (const part of parts) controller.enqueue(part); controller.close() } })
    const logs: ModelCallTiming[] = []
    const timed = timedModelStream({ stream }, { route: 'subscription', model: 'synthetic', tools: 0, startedAt: 0, requestedAt: 1 }, () => 5, line => logs.push(line))
    for await (const _ of timed.stream) { /* consume the actual stream */ }
    assert.equal(logs.length, 1)
    assert.equal(logs[0].interrupted, failed)
    assert.equal(logs[0].finishReason, 'stop')
  }
})
