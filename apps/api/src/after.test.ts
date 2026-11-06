import assert from 'node:assert/strict'
import test from 'node:test'
import { AfterQueue } from './after'

test('response disposal starts independent callbacks concurrently and joins their lifetime once', async () => {
  const slow = Promise.withResolvers<void>(), started: string[] = []
  const queue = new AfterQueue()
  queue.add(async () => { started.push('slow'); await slow.promise })
  queue.add(() => { started.push('independent') })
  assert.deepEqual(started, [])
  const finished = queue.finish()
  assert.equal(queue.finish(), finished); assert.equal(finished, queue.lifetime)
  let done = false
  void finished.then(() => { done = true })
  try {
    await Promise.resolve()
    assert.deepEqual(started, ['slow', 'independent'])
    assert.equal(done, false)
  } finally { slow.resolve(); await finished }
  assert.equal(done, true)
  assert.throws(() => queue.add(() => {}), /API_RESPONSE_LIFETIME_ENDED/)
})

test('nested callbacks start while another task waits; early promise and callback failures do not abandon the lifetime', async () => {
  const parent = Promise.withResolvers<void>(), nested = Promise.withResolvers<void>(), slow = Promise.withResolvers<void>()
  const nestedStarted = Promise.withResolvers<void>(), errors: unknown[] = []
  const earlyFailure = new Error('early promise fixture'), callbackFailure = new Error('callback fixture')
  const queue = new AfterQueue(error => { errors.push(error) })
  queue.add(Promise.reject(earlyFailure))
  await Promise.resolve()
  assert.deepEqual(errors, [earlyFailure])
  queue.add(async () => {
    await parent.promise
    queue.add(async () => { nestedStarted.resolve(); await nested.promise })
    queue.add(() => { throw callbackFailure })
  })
  queue.add(() => slow.promise)
  const finished = queue.finish()
  let done = false
  void finished.then(() => { done = true })
  try {
    parent.resolve(); await nestedStarted.promise
    assert.equal(done, false)
    slow.resolve(); await Promise.resolve(); await Promise.resolve()
    assert.equal(done, false, 'the nested callback still owns the request lifetime')
  } finally { parent.resolve(); nested.resolve(); slow.resolve(); await finished }
  assert.equal(done, true)
  assert.deepEqual(errors, [earlyFailure, callbackFailure])
})
