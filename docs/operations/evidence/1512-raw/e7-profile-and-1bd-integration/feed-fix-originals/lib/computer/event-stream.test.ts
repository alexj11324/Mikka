import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ComputerEventFeed, type ComputerEventRuntime } from './event-stream'
import { computerEventCursor, computerEventPage, type ComputerEventPage } from './event-page'

const tick = () => new Promise<void>(resolve => setImmediate(resolve))
const botId = '11111111-1111-4111-8111-111111111111'
const subagentId = '22222222-2222-4222-8222-222222222222'
const update = (step: string) => ({ botId, subagentId, task: 'Read the public page', state: 'needs_you', step, needs: { kind: 'login', site: 'example.org' } })
const page = (id: string, step: string, hasMore = false): ComputerEventPage => ({ events: [{ id, data: update(step) }], cursor: id, hasMore })
function fixture() {
  let visible = true, handler: ComputerEventRuntime['page'] = async cursor => ({ events: [], cursor, hasMore: false })
  const calls: { cursor: string; signal: AbortSignal }[] = []
  const visibility = new Set<() => void>(), invalidations = new Set<() => void>()
  const timers = new Map<object, { callback: () => void; delay: number }>()
  const stopped = new AbortController()
  const feed = new ComputerEventFeed({
    page: async (cursor, signal) => { calls.push({ cursor, signal }); return handler(cursor, signal) },
    visible: () => visible,
    watchVisibility: callback => { visibility.add(callback); return () => { visibility.delete(callback) } },
    invalidations: callback => { invalidations.add(callback); return () => { invalidations.delete(callback) } },
    stopped: stopped.signal,
    later: (callback, delay) => { const id = {}; timers.set(id, { callback, delay }); return id },
    cancel: id => { timers.delete(id as object) },
  })
  return { feed, calls, timers, stopped, visibility, invalidations,
    handle(value: ComputerEventRuntime['page']) { handler = value },
    visible(value: boolean) { visible = value; for (const callback of visibility) callback() },
    invalidate() { for (const callback of invalidations) callback() },
    retry() { const jobs = [...timers.values()]; timers.clear(); for (const job of jobs) job.callback() },
  }
}

test('cursor pages preserve bigint precision and reject regressions, non-progressing continuations and oversized batches', () => {
  for (const value of ['0', '9007199254740993', '9223372036854775807']) assert.equal(computerEventCursor(value), value)
  for (const value of ['', '-1', '01', '1.2', '9223372036854775808', '1e3', null, 1]) assert.equal(computerEventCursor(value), null)
  const valid = page('9007199254740994', 'fresh')
  assert.equal(computerEventPage(valid, '9007199254740993'), valid)
  for (const invalid of [
    { ...valid, cursor: '9007199254740993' },
    { ...valid, events: [valid.events[0], valid.events[0]] },
    { events: [], cursor: '9007199254740993', hasMore: true },
    { ...valid, events: Array(101).fill(valid.events[0]) },
  ]) assert.equal(computerEventPage(invalid, '9007199254740993'), null)
})

test('one shared feed drains bounded pages, then reads only after invalidation and resumes its cursor on remount', async () => {
  const f = fixture()
  f.handle(async cursor => cursor === '0' ? page('41', 'first', true) : cursor === '41' ? page('42', 'second') : page('43', 'third'))
  const stop = f.feed.subscribe(() => {})
  await tick()
  assert.deepEqual(f.calls.map(c => c.cursor), ['0', '41'])
  assert.equal(f.feed.getSnapshot().get(subagentId)?.step, 'second')
  const second = f.feed.subscribe(() => {})
  await tick()
  assert.equal(f.calls.length, 2, 'another consumer shares the cache and channel')
  assert.equal(f.invalidations.size, 1)
  assert.equal(f.timers.size, 0, 'a healthy read starts no polling timer')
  second(); stop()
  assert.equal(f.invalidations.size, 0)
  const remount = f.feed.subscribe(() => {})
  await tick()
  assert.equal(f.calls.at(-1)?.cursor, '42')
  assert.equal(f.feed.getSnapshot().get(subagentId)?.step, 'third')
  remount()
})

test('a burst during an in-flight read coalesces into one catch-up and never fetches concurrently', async () => {
  const f = fixture()
  let resolveFirst!: (value: unknown) => void
  f.handle(async cursor => cursor === '0' ? new Promise(resolve => { resolveFirst = resolve }) : page('2', 'caught up'))
  const stop = f.feed.subscribe(() => {})
  for (let i = 0; i < 20; i++) f.invalidate()
  assert.equal(f.calls.length, 1)
  resolveFirst(page('1', 'first'))
  await tick()
  assert.deepEqual(f.calls.map(c => c.cursor), ['0', '1'])
  assert.equal(f.feed.getSnapshot().get(subagentId)?.step, 'caught up')
  stop()
})

test('hidden tabs fetch nothing, abort an active read and ignore its late result before foreground catch-up', async () => {
  const f = fixture()
  f.visible(false)
  let resolveFirst!: (value: unknown) => void
  f.handle(async () => new Promise(resolve => { resolveFirst = resolve }))
  const stop = f.feed.subscribe(() => {})
  assert.equal(f.calls.length, 0)
  f.visible(true)
  assert.equal(f.calls.length, 1)
  f.visible(false)
  assert.equal(f.calls[0].signal.aborted, true)
  resolveFirst(page('8', 'late old request'))
  await tick()
  assert.equal(f.feed.getSnapshot().size, 0)
  f.handle(async () => page('9', 'foreground'))
  f.visible(true)
  await tick()
  assert.equal(f.calls.at(-1)?.cursor, '0', 'aborted responses cannot advance a cursor')
  assert.equal(f.feed.getSnapshot().get(subagentId)?.step, 'foreground')
  stop()
  assert.equal(f.visibility.size, 0)
})

test('failed reads retry at 60 seconds, a notification fetches sooner, and hiding cancels retry', async () => {
  const f = fixture()
  f.handle(async () => { throw new Error('temporary outage') })
  const stop = f.feed.subscribe(() => {})
  await tick()
  assert.deepEqual([...f.timers.values()].map(t => t.delay), [60_000])
  f.handle(async () => page('1', 'recovered'))
  f.invalidate()
  await tick()
  assert.equal(f.timers.size, 0)
  assert.equal(f.feed.getSnapshot().get(subagentId)?.step, 'recovered')
  f.handle(async () => ({ events: [], cursor: '0', hasMore: true }))
  f.invalidate()
  await tick()
  assert.equal(f.timers.size, 1)
  f.visible(false)
  assert.equal(f.timers.size, 0)
  f.retry(); f.invalidate()
  assert.equal(f.calls.length, 3, 'no retry or notification fetch while hidden')
  f.handle(async cursor => ({ events: [], cursor, hasMore: false }))
  f.visible(true)
  await tick()
  assert.equal(f.calls.at(-1)?.cursor, '1', 'malformed pages never reset a cursor')
  stop()
})

test('a required page refresh aborts data reads and visibility or new subscribers cannot restart them', async () => {
  const f = fixture()
  f.handle(async () => page('1', 'before refresh'))
  const stop = f.feed.subscribe(() => {})
  await tick()
  f.stopped.abort()
  f.visible(false); f.visible(true); f.invalidate()
  const second = f.feed.subscribe(() => {})
  await tick()
  assert.equal(f.calls.length, 1)
  assert.equal(f.timers.size, 0)
  second(); stop()
})
