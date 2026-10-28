import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computerEventsMatch } from './events'

test('computer events must match the server-bound run and Bot', () => {
  const runId = randomUUID(), botId = randomUUID()
  const event = { type: 'data-computer', data: { runId, botId, task: 'Open the page', state: 'working' } }
  assert.equal(computerEventsMatch([event], runId, botId), true)
  assert.equal(computerEventsMatch([event], runId, randomUUID()), false)
  assert.equal(computerEventsMatch([event], randomUUID(), botId), false)
  assert.equal(computerEventsMatch([event], runId, null), false)
  assert.equal(computerEventsMatch([{ ...event, data: { ...event.data, task: 'x'.repeat(201) } }], runId, botId), false)
  assert.equal(computerEventsMatch([{ ...event, data: { ...event.data, state: 'done' } }], runId, botId), false)
  assert.equal(computerEventsMatch([{ type: 'text-delta' }], runId, null), true)
})
