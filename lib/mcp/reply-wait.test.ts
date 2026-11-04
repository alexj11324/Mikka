import assert from 'node:assert/strict'
import test from 'node:test'
import { REPLY_FALLBACK_MS, waitForReply, type ReplyRead } from './reply-wait'

const flush = async () => { for (let n = 0; n < 8; n++) await Promise.resolve() }
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
function bus() {
  let listener = () => {}
  let subscribed = 0, disposed = 0
  return {
    subscribe(changed: () => void) { subscribed++; listener = changed; return () => { disposed++; listener = () => {} } },
    changed() { listener() },
    get subscribed() { return subscribed },
    get disposed() { return disposed },
  }
}

test('an immediate read uses the authoritative final path without opening a channel', async () => {
  const events = bus()
  const value = await waitForReply(async final => {
    assert.equal(final, true)
    return { done: true, value: 'current' }
  }, { deadline: Date.now(), subscribe: events.subscribe })
  assert.equal(value, 'current')
  assert.equal(events.subscribed, 0)
})

test('the subscription is registered before the first read and a push wakes the waiter', async () => {
  const events = bus()
  let reads = 0, available = false
  const pending = waitForReply(async () => {
    assert.equal(events.subscribed, 1)
    reads++
    return available ? { done: true, value: 'committed reply' } : { done: false }
  }, { deadline: Date.now() + 90_000, subscribe: events.subscribe })
  await flush()
  assert.equal(reads, 1)
  available = true
  events.changed()
  assert.equal(await pending, 'committed reply')
  assert.equal(reads, 2)
  assert.equal(events.disposed, 1)
})

test('a push during an in-flight stale read is retained and forces a new authoritative read', async () => {
  const events = bus(), old = deferred<ReplyRead<string>>()
  let reads = 0
  const pending = waitForReply(async () => {
    reads++
    return reads === 1 ? old.promise : { done: true, value: 'new commit' }
  }, { deadline: Date.now() + 90_000, subscribe: events.subscribe })
  await flush()
  events.changed()
  old.resolve({ done: false })
  assert.equal(await pending, 'new commit')
  assert.equal(reads, 2)
  assert.equal(events.disposed, 1)
})

test('bursts coalesce while reading, and a later push is not swallowed by that coalescing', async () => {
  const events = bus(), first = deferred<ReplyRead<string>>(), second = deferred<ReplyRead<string>>()
  let reads = 0, active = 0, maxActive = 0
  const pending = waitForReply(async () => {
    reads++; active++; maxActive = Math.max(active, maxActive)
    try {
      if (reads === 1) return await first.promise
      if (reads === 2) return await second.promise
      return { done: true, value: 'latest' }
    } finally { active-- }
  }, { deadline: Date.now() + 90_000, subscribe: events.subscribe })
  await flush()
  for (let n = 0; n < 20; n++) events.changed()
  first.resolve({ done: false })
  await flush()
  assert.equal(reads, 2)
  for (let n = 0; n < 20; n++) events.changed()
  second.resolve({ done: false })
  assert.equal(await pending, 'latest')
  assert.equal(reads, 3)
  assert.equal(maxActive, 1)
})

test('a lost push still causes a read after 15 seconds, without the old 2 second polling', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_000_000 })
  const events = bus()
  let reads = 0, available = false
  const pending = waitForReply(async () => {
    reads++
    return available ? { done: true, value: 'missed notification' } : { done: false }
  }, { deadline: Date.now() + 90_000, subscribe: events.subscribe })
  await flush()
  t.mock.timers.tick(REPLY_FALLBACK_MS - 1)
  await flush()
  assert.equal(reads, 1)
  available = true
  t.mock.timers.tick(1)
  assert.equal(await pending, 'missed notification')
  assert.equal(reads, 2)
  assert.equal(events.disposed, 1)
})

test('the exact deadline performs one last authoritative read, including a shorter wait', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 2_000_000 })
  const events = bus(), finals: boolean[] = []
  let current = 'before'
  const pending = waitForReply(async final => {
    finals.push(final)
    return final ? { done: true, value: current } : { done: false }
  }, { deadline: Date.now() + 5_000, subscribe: events.subscribe })
  await flush()
  t.mock.timers.tick(4_999)
  await flush()
  assert.deepEqual(finals, [false])
  current = 'at deadline'
  t.mock.timers.tick(1)
  assert.equal(await pending, 'at deadline')
  assert.deepEqual(finals, [false, true])
  assert.equal(events.disposed, 1)
})

test('an in-flight read crossing the deadline is followed by a final fresh read', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 3_000_000 })
  const events = bus(), old = deferred<ReplyRead<string>>(), finals: boolean[] = []
  const pending = waitForReply(async final => {
    finals.push(final)
    return final ? { done: true, value: 'final state' } : old.promise
  }, { deadline: Date.now() + 5_000, subscribe: events.subscribe })
  await flush()
  t.mock.timers.tick(5_000)
  old.resolve({ done: false })
  assert.equal(await pending, 'final state')
  assert.deepEqual(finals, [false, true])
})

test('cancelling a waiting MCP request immediately disposes its subscriber and timer', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 4_000_000 })
  const events = bus(), controller = new AbortController()
  let reads = 0
  const pending = waitForReply(async () => { reads++; return { done: false } }, {
    deadline: Date.now() + 90_000, subscribe: events.subscribe, signal: controller.signal,
  })
  const cancelled = assert.rejects(pending, /request cancelled/)
  await flush()
  controller.abort(new Error('request cancelled'))
  await cancelled
  t.mock.timers.tick(90_000)
  await flush()
  assert.equal(reads, 1)
  assert.equal(events.disposed, 1)
})

test('cancellation does not wait for a slow query and its late result cannot restart the waiter', async () => {
  const events = bus(), controller = new AbortController(), old = deferred<ReplyRead<string>>()
  let reads = 0
  const pending = waitForReply(async () => { reads++; return old.promise }, {
    deadline: Date.now() + 90_000, subscribe: events.subscribe, signal: controller.signal,
  })
  const cancelled = assert.rejects(pending, /request cancelled/)
  await flush()
  controller.abort(new Error('request cancelled'))
  await cancelled
  assert.equal(events.disposed, 1)
  old.resolve({ done: false })
  events.changed()
  await flush()
  assert.equal(reads, 1)
})

test('an already cancelled request opens no channel and performs no read', async () => {
  const events = bus(), controller = new AbortController()
  controller.abort(new Error('already cancelled'))
  let reads = 0
  await assert.rejects(waitForReply(async () => { reads++; return { done: false } }, {
    deadline: Date.now() + 90_000, subscribe: events.subscribe, signal: controller.signal,
  }), /already cancelled/)
  assert.equal(reads, 0)
  assert.equal(events.subscribed, 0)
})

test('an authoritative read failure cleans up its subscription', async () => {
  const events = bus()
  await assert.rejects(waitForReply(async () => { throw new Error('database unavailable') }, {
    deadline: Date.now() + 90_000, subscribe: events.subscribe,
  }), /database unavailable/)
  assert.equal(events.disposed, 1)
})
