import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import type { SharedSubscription } from '../db/listen'
import { logReplyCompletion } from './reply-completion'
import { observeReplySignals } from './reply-signals'
import { REPLY_FALLBACK_MS, waitForReply, type ReplyObserver, type ReplyWaitCompletion, type ReplyChanged, type ReplyRead } from './reply-wait'

const flush = async () => { for (let n = 0; n < 24; n++) await Promise.resolve() }
const deferred = <T>() => Promise.withResolvers<T>()

test('completion counts actual quiet reads and setup time once, after unsubscribe', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_000_000 })
  const opening = deferred<ReplyObserver>(), records: ReplyWaitCompletion[] = []
  let closed = 0, reads = 0
  const pending = waitForReply(async final => {
    reads++
    return final ? { done: true, value: 'current state' } : { done: false }
  }, { deadline: Date.now() + 90_000, subscribe: () => opening.promise,
    onComplete: summary => { assert.equal(closed, 1); records.push(summary) },
  })
  t.mock.timers.tick(12)
  opening.resolve({ lost: false, close() { closed++ } })
  await flush()
  for (let n = 0; n < 5; n++) { t.mock.timers.tick(15_000); await flush() }
  assert.equal(reads, 1)
  t.mock.timers.tick(14_988)
  assert.equal(await pending, 'current state')
  assert.deepEqual(records, [{ outcome: 'deadline', readCalls: 2, finalReadCalls: 1,
    notificationWakes: 0, lossWakes: 0, fallbackWakes: 0, observedLost: false,
    observerKind: 'transactional', setupState: 'ready', observerClosed: true,
    aborted: false, setupMs: 12, durationMs: 90_000,
  }])
})

test('completion distinguishes real signal-adapter notifications, loss and the existing fallback', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 2_000_000 })
  let lost = false, ready = false, closed = 0, waiting = deferred<void>()
  const subscription: SharedSubscription = {
    reset() {}, get lost() { return lost }, close() { closed++ },
    next(_ms, signal) {
      const current = waiting, abort = () => current.resolve()
      signal?.addEventListener('abort', abort, { once: true })
      return current.promise.finally(() => signal?.removeEventListener('abort', abort))
    },
  }
  const push = () => { const current = waiting; waiting = deferred<void>(); current.resolve() }
  const records: ReplyWaitCompletion[] = []
  const pending = waitForReply(async () => ready ? { done: true, value: 'current state' } : { done: false }, {
    deadline: Date.now() + 90_000,
    subscribe: (changed, signal) => observeReplySignals(async () => [subscription], changed, signal),
    onComplete: summary => records.push(summary),
  })
  await flush()
  t.mock.timers.tick(1_000); push(); await flush()
  t.mock.timers.tick(1_000); lost = true; push(); await flush()
  ready = true
  t.mock.timers.tick(REPLY_FALLBACK_MS)
  assert.equal(await pending, 'current state')
  assert.deepEqual(records, [{ outcome: 'resolved', readCalls: 4, finalReadCalls: 0,
    notificationWakes: 1, lossWakes: 1, fallbackWakes: 1, observedLost: true,
    observerKind: 'transactional', setupState: 'ready', observerClosed: true,
    aborted: false, setupMs: 0, durationMs: 17_000,
  }])
  assert.equal(closed, 1)
})

test('completion reports abort after cleanup without awaiting a slow read or logging its late result', async () => {
  const controller = new AbortController(), read = deferred<ReplyRead<string>>()
  const reason = new Error('private cancellation reason'), records: ReplyWaitCompletion[] = []
  let closed = 0, changed: ReplyChanged = () => {}
  const pending = waitForReply(async () => read.promise, {
    deadline: Date.now() + 90_000, signal: controller.signal,
    subscribe: wake => { changed = wake; return { lost: false, close() { closed++ } } },
    onComplete: summary => { assert.equal(closed, 1); records.push(summary) },
  })
  const cancelled = assert.rejects(pending, error => error === reason)
  await flush()
  controller.abort(reason)
  await cancelled
  assert.equal(records.length, 1)
  assert.equal(records[0].outcome, 'aborted')
  assert.equal(records[0].readCalls, 1)
  assert.equal(records[0].aborted, true)
  assert.equal(records[0].observerClosed, true)
  assert.equal(records[0].finalReadCalls, 0)
  read.resolve({ done: true, value: 'private late reply' }); changed('notification')
  await flush()
  assert.equal(records.length, 1)
  assert.equal(records[0].notificationWakes, 0, 'completion is an immutable snapshot, not late activity')
})

test('completion does not claim a pending observer closed and does not log twice after late setup', async () => {
  const controller = new AbortController(), opening = deferred<ReplyObserver>()
  const records: ReplyWaitCompletion[] = []
  let closed = 0
  const pending = waitForReply(async () => { throw new Error('read must not run') }, {
    deadline: Date.now() + 90_000, signal: controller.signal, subscribe: () => opening.promise,
    onComplete: summary => records.push(summary),
  })
  const cancelled = assert.rejects(pending, { name: 'AbortError' })
  controller.abort()
  await cancelled
  assert.equal(records.length, 1)
  assert.equal(records[0].outcome, 'aborted')
  assert.equal(records[0].readCalls, 0)
  assert.equal(records[0].setupState, 'pending')
  assert.equal(records[0].observerClosed, false)
  opening.resolve({ lost: false, close() { closed++ } })
  await flush()
  assert.equal(closed, 1)
  assert.equal(records.length, 1)
  assert.equal(records[0].observerClosed, false)

  const preAborted: ReplyWaitCompletion[] = []
  await assert.rejects(waitForReply(async () => { throw new Error('read must not run') }, {
    deadline: Date.now() + 90_000, signal: controller.signal,
    subscribe: () => { throw new Error('subscribe must not run') },
    onComplete: summary => preAborted.push(summary),
  }), { name: 'AbortError' })
  assert.equal(preAborted.length, 1)
  assert.equal(preAborted[0].setupState, 'not_started')
  assert.equal(preAborted[0].readCalls, 0)
})

test('completion logging uses only the fixed field allowlist and a short Bot hash', async () => {
  const botId = 'd0123456-1234-4234-8234-123456789012', logs: string[] = []
  const answer = 'PRIVATE_REPLY', owner = 'PRIVATE_OWNER', input = 'PRIVATE_INPUT', token = 'PRIVATE_TOKEN'
  assert.equal(await waitForReply(async () => ({ done: true, value: answer }), {
    deadline: Date.now(), subscribe: () => { throw new Error('no subscription') },
    onComplete: summary => logReplyCompletion(botId, { ...summary, owner, input, token } as ReplyWaitCompletion, line => logs.push(line)),
  }), answer)
  assert.equal(logs.length, 1)
  for (const value of [botId, answer, owner, input, token]) assert.equal(logs[0].includes(value), false)
  const record = JSON.parse(logs[0])
  assert.equal(record.msg, 'mcp_reply_wait_complete')
  assert.equal(record.version, 1)
  assert.equal(record.botRef, createHash('sha256').update(botId).digest('hex').slice(0, 12))
  assert.deepEqual(Object.keys(record).sort(), ['msg', 'version', 'botRef', 'outcome', 'readCalls', 'finalReadCalls',
    'notificationWakes', 'lossWakes', 'fallbackWakes', 'observedLost', 'observerKind', 'setupState',
    'observerClosed', 'aborted', 'setupMs', 'durationMs'].sort())
})

test('a completion logger failure cannot replace success, the original read error or cleanup failure', async () => {
  let completed = 0, closed = 0
  const broken = () => { completed++; throw new Error('private logger failure') }
  assert.equal(await waitForReply(async () => ({ done: true, value: 'reply' }), {
    deadline: Date.now() + 90_000, subscribe: () => () => { closed++ }, onComplete: broken,
  }), 'reply')
  const readError = new Error('private database detail')
  await assert.rejects(waitForReply(async () => { throw readError }, {
    deadline: Date.now() + 90_000, subscribe: () => () => { closed++ }, onComplete: broken,
  }), error => error === readError)
  const cleanupError = new Error('private cleanup detail')
  await assert.rejects(waitForReply(async () => ({ done: true, value: 'reply' }), {
    deadline: Date.now() + 90_000, subscribe: () => () => { closed++; throw cleanupError }, onComplete: broken,
  }), error => error === cleanupError)
  assert.equal(completed, 3)
  assert.equal(closed, 3)
})
