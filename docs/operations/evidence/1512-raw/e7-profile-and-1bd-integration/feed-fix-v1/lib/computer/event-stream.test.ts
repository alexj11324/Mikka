import assert from 'node:assert/strict'
import { test } from 'node:test'
import { LiveChannel, type LiveSocket } from '../live/channel'
import { readBoundary } from '../swr/read-observer'
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

class FeedSocket implements LiveSocket {
  onopen: LiveSocket['onopen'] = null
  onmessage: LiveSocket['onmessage'] = null
  onclose: LiveSocket['onclose'] = null
  onerror: LiveSocket['onerror'] = null
  readyState: 0 | 1 | 2 | 3 = 0
  open() {
    this.readyState = 1
    if (this.onopen) Reflect.apply(this.onopen, this, [new Event('open')])
    this.message(JSON.stringify({ type: 'live_ready', version: 1, kinds: ['factory_task', 'subagent_events'] }))
  }
  message(data: string) { if (this.onmessage) Reflect.apply(this.onmessage, this, [{ data }]) }
  send(data: string | ArrayBufferLike | Blob | ArrayBufferView) { if (data === 'ping') this.message('pong') }
  close() { this.readyState = 3; if (this.onclose) Reflect.apply(this.onclose, this, [{}]) }
}

/** The real Channel produces and queues the boundary consumed by the real Feed. */
function coupledFixture() {
  let now = 1_800_000_000_000, nextTimer = 0
  const timers = new Map<number, { at: number; callback: () => void }>()
  const later = (callback: () => void, milliseconds: number) => {
    const id = ++nextTimer; timers.set(id, { at: now + milliseconds, callback }); return id
  }
  const cancel = (id: unknown) => { timers.delete(id as number) }
  const sockets: FeedSocket[] = []
  const channel = new LiveChannel({
    ticket: async () => ({ url: 'wss://fixture.invalid/socket', protocol: 'fixture', expiresAt: now + 600_000 }),
    socket: () => { const socket = new FeedSocket(); sockets.push(socket); return socket },
    visible: () => true, watchVisibility: () => () => {}, now: () => now, monotonicNow: () => now,
    later, cancel,
  })
  const calls: Array<{ began: number; cursor: string }> = []
  const catchups: number[] = []
  const stopped = new AbortController()
  const feed = new ComputerEventFeed({
    page: async cursor => {
      calls.push({ began: readBoundary(), cursor })
      return page(String(calls.length), `accepted-${calls.length}`)
    },
    visible: () => true, watchVisibility: () => () => {}, stopped: stopped.signal, later, cancel,
    invalidations: refresh => channel.subscribe('subagent_events', botId, [`computer-events:${botId}`], (_key, _required, _reuse, after) => {
      assert.equal(typeof after, 'number', 'the actual Channel supplies its catch-up boundary')
      catchups.push(after!)
      return refresh(after)
    }),
  })
  const stops: Array<() => void> = []
  return {
    feed, calls, catchups, sockets,
    keepConnection() { stops.push(channel.subscribe('factory_task', botId, ['fixture-keepalive'], () => {})) },
    subscribe() { stops.push(feed.subscribe(() => {})) },
    async open() { await tick(); assert.equal(sockets.length, 1); sockets[0].open(); await tick() },
    async advance(milliseconds: number) {
      const until = now + milliseconds
      for (;;) {
        const entry = [...timers].sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0]
        if (!entry || entry[1].at > until) break
        now = entry[1].at; timers.delete(entry[0]); entry[1].callback(); await tick()
      }
      now = until; await tick()
    },
    dispose() { for (const stop of stops.reverse()) stop(); stopped.abort(); channel.dispose(); assert.equal(timers.size, 0) },
  }
}

test('a late feed read committed after the actual channel boundary covers its queued catch-up', async t => {
  const f = coupledFixture(); t.after(() => f.dispose())
  f.keepConnection(); await f.open(); await f.advance(100)
  f.subscribe(); await tick()
  assert.equal(f.calls.length, 1)
  assert.equal(f.feed.getSnapshot().get(subagentId)?.step, 'accepted-1')
  await f.advance(100)
  assert.equal(f.catchups.length, 1)
  assert.ok(f.calls[0].began > f.catchups[0])
  assert.equal(f.calls.length, 1, 'the older queued catch-up must not repeat the committed post-boundary read')
})

test('the actual channel still catches up a feed read begun before socket open', async t => {
  const f = coupledFixture(); t.after(() => f.dispose())
  f.subscribe(); await tick()
  assert.equal(f.calls.length, 1)
  await f.open(); await f.advance(100)
  assert.equal(f.catchups.length, 1)
  assert.ok(f.calls[0].began < f.catchups[0])
  assert.equal(f.calls.length, 2)
  assert.equal(f.feed.getSnapshot().get(subagentId)?.step, 'accepted-2')
})

test('a newer actual live push is not covered by an earlier completed feed read', async t => {
  const f = coupledFixture(); t.after(() => f.dispose())
  f.keepConnection(); await f.open(); await f.advance(100)
  f.subscribe(); await tick(); await f.advance(100)
  const before = f.calls.length, began = f.calls.at(-1)!.began
  f.sockets[0].message(JSON.stringify({ kind: 'subagent_events', id: botId }))
  await f.advance(100)
  assert.ok(f.catchups.at(-1)! > began)
  assert.equal(f.calls.length, before + 1)
  assert.equal(f.feed.getSnapshot().get(subagentId)?.step, `accepted-${before + 1}`)
})

test('a partially accepted pagination wave cannot cover a boundary until the final page succeeds', async t => {
  const f = fixture(), after = readBoundary()
  f.handle(async cursor => {
    if (cursor === '0') return page('1', 'partial', true)
    throw new Error('continuation unavailable')
  })
  const stop = f.feed.subscribe(() => {}); t.after(stop)
  await tick()
  assert.equal(f.calls.length, 2)
  assert.equal(f.feed.getSnapshot().get(subagentId)?.step, 'partial')
  assert.equal(f.timers.size, 1)
  f.handle(async () => page('2', 'complete'))
  await f.feed.refresh(after)
  assert.equal(f.calls.length, 3, 'the accepted first page alone provides no completed-wave proof')
  assert.equal(f.calls[2].cursor, '1')
  assert.equal(f.timers.size, 0)
  await f.feed.refresh(after)
  assert.equal(f.calls.length, 3, 'the fully accepted recovery now covers the same boundary')
})

test('reusing an older boundary cannot erase a newer pending wave or cancel a failed-read retry', async t => {
  const f = fixture(), oldAfter = readBoundary()
  f.handle(async () => page('1', 'first'))
  const stop = f.feed.subscribe(() => {}); t.after(stop)
  await tick()
  let resolveSecond!: (value: unknown) => void
  f.handle(async cursor => cursor === '1' ? new Promise(resolve => { resolveSecond = resolve }) : page('3', 'newer obligation'))
  const running = f.feed.refresh()
  const newerAfter = readBoundary()
  const pending = f.feed.refresh(newerAfter)
  const covered = f.feed.refresh(oldAfter)
  assert.equal(f.calls.length, 2)
  resolveSecond(page('2', 'second'))
  await Promise.all([running, pending, covered])
  assert.deepEqual(f.calls.map(call => call.cursor), ['0', '1', '2'])
  assert.equal(f.feed.getSnapshot().get(subagentId)?.step, 'newer obligation')
  f.handle(async () => { throw new Error('temporary outage') })
  await f.feed.refresh()
  assert.equal(f.timers.size, 1)
  await f.feed.refresh(oldAfter)
  assert.equal(f.calls.length, 4)
  assert.equal(f.timers.size, 1, 'a stale covered notification cannot cancel a newer failed-read retry')
  f.handle(async () => page('4', 'retried'))
  f.retry(); await tick()
  assert.equal(f.calls.length, 5)
  assert.equal(f.feed.getSnapshot().get(subagentId)?.step, 'retried')
})

test('a remounted generation cannot use a previous generation successful read as proof', async t => {
  const f = fixture(), after = readBoundary()
  f.handle(async () => page('1', 'old generation'))
  const stop = f.feed.subscribe(() => {})
  await tick(); stop()
  f.handle(async () => { throw new Error('new generation unavailable') })
  const remount = f.feed.subscribe(() => {}); t.after(remount)
  await tick()
  assert.equal(f.calls.length, 2)
  assert.equal(f.timers.size, 1)
  f.handle(async () => page('2', 'new generation'))
  await f.feed.refresh(after)
  assert.equal(f.calls.length, 3)
  assert.equal(f.feed.getSnapshot().get(subagentId)?.step, 'new generation')
  assert.equal(f.timers.size, 0)
})
