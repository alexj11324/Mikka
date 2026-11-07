import assert from 'node:assert/strict'
import test from 'node:test'
import type { SharedSubscription } from '../db/listen'
import { observeReplySignals } from './reply-signals'
import { waitForReply } from './reply-wait'

type Wake = Awaited<ReturnType<SharedSubscription['next']>>
const flush = async () => { for (let n = 0; n < 16; n++) await Promise.resolve() }
function subscription() {
  let heard = false, lost = false, wake: (() => void) | undefined, closed = 0, waiting = 0
  const value: SharedSubscription = {
    reset() { heard = false }, get lost() { return lost }, close() { closed++ },
    next(_milliseconds, signal) {
      if (signal?.aborted) return Promise.resolve('aborted')
      if (heard) return Promise.resolve('notified')
      waiting++
      return new Promise<Wake>(resolve => {
        const done = (reason: Wake) => { waiting--; signal?.removeEventListener('abort', abort); wake = undefined; resolve(reason) }
        const abort = () => done('aborted')
        wake = () => done('notified'); signal?.addEventListener('abort', abort, { once: true })
      })
    },
  }
  return { value, push() { heard = true; wake?.() }, lose() { lost = true; heard = true; wake?.() },
    get closed() { return closed }, get waiting() { return waiting } }
}

test('either database wakes the same dirty latch; closing releases both pending waits', async () => {
  const app = subscription(), workspace = subscription(), controller = new AbortController()
  let notifications = 0
  const observer = await observeReplySignals(async () => [app.value, workspace.value], () => { notifications++ }, controller.signal)
  assert.equal(observer.lost, false)
  app.push(); await flush()
  workspace.push(); await flush()
  assert.equal(notifications, 2)
  observer.close(); observer.close()
  await flush()
  assert.equal(app.closed, 1); assert.equal(workspace.closed, 1)
  assert.equal(app.waiting, 0); assert.equal(workspace.waiting, 0)
  app.push(); workspace.push(); await flush()
  assert.equal(notifications, 2)
})

test('a notification during a stale authoritative read forces a second read with no reconciliation timer', async () => {
  const app = subscription(), workspace = subscription()
  let finish!: () => void, reads = 0
  const stale = new Promise<void>(resolve => { finish = resolve })
  const pending = waitForReply(async () => {
    if (++reads === 1) { await stale; return { done: false } }
    return { done: true, value: 'fresh and authorized' }
  }, { deadline: Date.now() + 90_000,
    subscribe: (changed, signal) => observeReplySignals(async () => [app.value, workspace.value], changed, signal),
  })
  await flush()
  assert.equal(reads, 1)
  workspace.push(); await flush(); finish()
  assert.equal(await pending, 'fresh and authorized')
  assert.equal(reads, 2)
  assert.equal(app.closed, 1); assert.equal(workspace.closed, 1)
})

test('one missing or lost listener degrades the observer and loss wakes only once', async () => {
  const app = subscription(), controller = new AbortController()
  let notifications = 0
  const observer = await observeReplySignals(async () => [app.value, null], () => { notifications++ }, controller.signal)
  assert.equal(observer.lost, true)
  app.lose(); await flush()
  assert.equal(notifications, 1)
  assert.equal(app.waiting, 0)
  await flush()
  assert.equal(notifications, 1)
  observer.close()
  assert.equal(app.closed, 1)
})

test('abort while listeners are being prepared is passed through and closes any returned subscriptions', async () => {
  const app = subscription(), controller = new AbortController()
  let resolve!: (value: (SharedSubscription | null)[]) => void, signal: AbortSignal | undefined, notifications = 0
  const opening = new Promise<(SharedSubscription | null)[]>(done => { resolve = done })
  const pending = observeReplySignals(async value => { signal = value; return opening }, () => { notifications++ }, controller.signal)
  controller.abort()
  assert.equal(signal?.aborted, true)
  resolve([app.value, null])
  const observer = await pending
  observer.close()
  assert.equal(app.closed, 1)
  assert.equal(app.waiting, 0)
  assert.equal(notifications, 0)
})
