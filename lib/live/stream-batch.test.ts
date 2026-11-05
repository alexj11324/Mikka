import assert from 'node:assert/strict'
import test from 'node:test'
import { batchStreamInvalidation } from './stream-batch'

const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }

test('one committed burst resolves its scope once and includes the final state', async () => {
  const database = {}, timer = deferred(), observed: number[] = []
  let version = 0
  const calls = Array.from({ length: 100 }, () => {
    version++
    return batchStreamInvalidation(database, 'run', async () => { observed.push(version) }, () => timer.promise)
  })
  assert.ok(calls.every(call => call === calls[0]))
  assert.deepEqual(observed, [])
  timer.resolve(); await Promise.all(calls)
  assert.deepEqual(observed, [100])
})

test('a change during delivery retains a next batch; a new database never shares it', async () => {
  const firstTimer = deferred(), io = deferred(), nextTimer = deferred()
  const database = {}, observed: string[] = []
  const first = batchStreamInvalidation(database, 'same-id', async () => { observed.push('first'); await io.promise }, () => firstTimer.promise)
  firstTimer.resolve(); await settle()
  const next = batchStreamInvalidation(database, 'same-id', async () => { observed.push('trailing') }, () => nextTimer.promise)
  const other = batchStreamInvalidation({}, 'same-id', async () => { observed.push('other-database') }, async () => {})
  await other; assert.deepEqual(observed, ['first', 'other-database'])
  assert.notEqual(first, next)
  nextTimer.resolve(); await next; io.resolve(); await first
  assert.deepEqual(observed, ['first', 'other-database', 'trailing'])
})

test('failed delivery releases its batching slot and does not hide a later committed change', async () => {
  const database = {}, error = Error('synthetic delivery failure')
  await assert.rejects(batchStreamInvalidation(database, 'run', async () => { throw error }, async () => {}), error)
  let sent = false
  await batchStreamInvalidation(database, 'run', async () => { sent = true }, async () => {})
  assert.equal(sent, true)
})
