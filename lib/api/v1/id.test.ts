import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import test from 'node:test'
import { apiRunDispatchKey } from './id'

test('apiRunDispatchKey namespaces token + task and stores only the key hash', () => {
  const token = randomUUID(), task = randomUUID(), key = 'retry-1'
  const value = apiRunDispatchKey(token, task, key)
  assert.equal(value, `api:${token}:${task}:${createHash('sha256').update(key).digest('hex')}`)
  assert.ok(value.length <= 200)
  assert.equal(value, apiRunDispatchKey(token, task, key))
  assert.ok(!value.includes(key))
  assert.notEqual(value, apiRunDispatchKey(token, randomUUID(), key))
  assert.notEqual(value, apiRunDispatchKey(randomUUID(), task, key))
  assert.notEqual(value, apiRunDispatchKey(token, task, 'retry-2'))
})

test('apiRunDispatchKey rejects malformed ids and client keys', () => {
  const token = randomUUID(), task = randomUUID()
  for (const id of ['', 'not-a-uuid', '11111111-1111-1111-1111-111111111111'])
    assert.throws(() => apiRunDispatchKey(id, task, 'key'), /apiTokenIdInvalid/)
  assert.throws(() => apiRunDispatchKey(token, 'not-a-uuid', 'key'), /apiTaskIdInvalid/)
  for (const key of ['', 'with space', 'slash/key', 'x'.repeat(201)])
    assert.throws(() => apiRunDispatchKey(token, task, key), /apiIdempotencyKeyInvalid/)
  assert.doesNotThrow(() => apiRunDispatchKey(token, task, 'A-Z_a.z~0'))
})
