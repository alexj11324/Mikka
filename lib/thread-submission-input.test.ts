import assert from 'node:assert/strict'
import { test } from 'node:test'
import { prepareThreadReply } from './thread-submission-input'

const original = 'c37ee5ec-6be7-42e7-8b5d-09bebc50ed22', latest = '8ea3fe69-1974-4012-8030-7ac4cffca45f'
const firstId = '767c5d2a-26ce-4123-a395-7df2ecf9c071', nextId = 'fcd35a77-e49f-4db0-805f-c4a205de7de1'
test('a refreshed unknown submission retains its original ID and run despite an advanced chain', () => {
  const first = prepareThreadReply(null, original, 'Exactly one request.', () => firstId)
  const restored = JSON.parse(JSON.stringify(first))
  assert.deepEqual(prepareThreadReply(restored, latest, first.text, () => { throw Error('must not mint another request') }), first)
})
test('edited text is a new explicit request; damaged saved state is not reused', () => {
  const first = prepareThreadReply(null, original, 'Original.', () => firstId)
  assert.deepEqual(prepareThreadReply(first, latest, 'Edited.', () => nextId), { requestId: nextId, runId: latest, text: 'Edited.' })
  assert.equal(prepareThreadReply({ ...first, requestId: 'invalid' }, latest, 'Original.', () => nextId).requestId, nextId)
})

test('changing only the next model or its funded account creates a fresh submission and preserves the old retry', () => {
  const modelChoice = { model: 'coding', source: { kind: 'subscription' as const, connectionId: crypto.randomUUID() } }
  const first = prepareThreadReply(null, crypto.randomUUID(), 'Continue', undefined, modelChoice)
  const retry = prepareThreadReply(first, crypto.randomUUID(), 'Continue', undefined, modelChoice)
  assert.deepEqual(retry, first)
  const switched = prepareThreadReply(first, first.runId, first.text, undefined, { ...modelChoice, source: { ...modelChoice.source, connectionId: crypto.randomUUID() } })
  assert.notEqual(switched.requestId, first.requestId)
  assert.notEqual(prepareThreadReply(first, first.runId, first.text).requestId, first.requestId)
})
