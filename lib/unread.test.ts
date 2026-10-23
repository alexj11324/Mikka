import assert from 'node:assert/strict'
import test from 'node:test'
import { arrivedSinceLeftBottom, createReadReporter, dividerPosition, formatCount, isHalfVisible, lastVisiblePosition, mergeReadPosition, unreadBelowDivider } from './unread'
import { createMockReadSource, MOCK_READ_KEY, ReadError } from './conversation-reads'

const items = [
  { position: 1, own: false }, { position: 2, own: true }, { position: 3, own: false },
  { position: 4, own: true }, { position: 5, own: false }, { position: 6, own: false },
]

test('read position only moves forward', () => {
  assert.equal(mergeReadPosition(null, 3), 3)
  assert.equal(mergeReadPosition(5, 3), 5)
  assert.equal(mergeReadPosition(5, null), 5)
  assert.equal(mergeReadPosition(5, 7), 7)
})

test('divider: none on first visit, none when all read, skips own messages', () => {
  assert.equal(dividerPosition(items, null), null)
  assert.equal(dividerPosition(items, 6), null)
  assert.equal(dividerPosition(items, 1), 3)
  assert.equal(dividerPosition(items, 3), 5)
  assert.equal(dividerPosition([{ position: 7, own: true }], 6), null)
})

test('top count = unread (not own) at or below divider', () => {
  assert.equal(unreadBelowDivider(items, null), 0)
  assert.equal(unreadBelowDivider(items, 3), 3)
  assert.equal(unreadBelowDivider(items, 5), 2)
})

test('bottom count = arrivals after leaving bottom; 0 at bottom', () => {
  assert.equal(arrivedSinceLeftBottom(items, null), 0)
  assert.equal(arrivedSinceLeftBottom(items, 4), 2)
  assert.equal(arrivedSinceLeftBottom(items, 6), 0)
})

test('99+ cap', () => {
  assert.equal(formatCount(99), '99')
  assert.equal(formatCount(100), '99+')
})

test('half-visible rule', () => {
  const viewport = { top: 0, bottom: 100 }
  assert.equal(isHalfVisible({ top: 80, bottom: 120 }, viewport), true) // exactly half
  assert.equal(isHalfVisible({ top: 81, bottom: 121 }, viewport), false)
  assert.equal(isHalfVisible({ top: 100, bottom: 140 }, viewport), false)
  assert.equal(isHalfVisible({ top: -300, bottom: 50 }, viewport), true) // tall: fills half the viewport
  assert.equal(isHalfVisible({ top: -300, bottom: 40 }, viewport), false)
  assert.equal(lastVisiblePosition([
    { position: 1, top: 0, bottom: 40 }, { position: 2, top: 50, bottom: 90 }, { position: 3, top: 95, bottom: 140 },
  ], viewport), 2)
})

function fakeTimers() {
  let now = 0
  const queue: { at: number; fn: () => void; id: number }[] = []
  let next = 1
  return {
    now: () => now,
    setTimeout: (fn: () => void, ms: number) => { const id = next++; queue.push({ at: now + ms, fn, id }); return id },
    clearTimeout: (id: unknown) => { const i = queue.findIndex(item => item.id === id); if (i >= 0) queue.splice(i, 1) },
    advance(ms: number) { now += ms; for (const item of [...queue].sort((a, b) => a.at - b.at)) if (item.at <= now) { queue.splice(queue.indexOf(item), 1); item.fn() } },
  }
}

test('reporter: leading send, 2s throttle with trailing latest, forward-only, flush via beacon', () => {
  const timers = fakeTimers()
  const sent: number[] = [], beacons: number[] = []
  const reporter = createReadReporter<{ position: number }>({ timers, send: t => sent.push(t.position), sendNow: t => beacons.push(t.position) })
  reporter.report({ position: 3 })
  assert.deepEqual(sent, [3])
  reporter.report({ position: 4 })
  reporter.report({ position: 6 })
  reporter.report({ position: 5 })
  assert.deepEqual(sent, [3])
  timers.advance(1999)
  assert.deepEqual(sent, [3])
  timers.advance(1)
  assert.deepEqual(sent, [3, 6])
  reporter.report({ position: 2 })
  timers.advance(5000)
  assert.deepEqual(sent, [3, 6])
  timers.advance(0)
  reporter.report({ position: 8 })
  assert.deepEqual(sent, [3, 6, 8])
  reporter.report({ position: 9 })
  reporter.flush()
  assert.deepEqual(beacons, [9])
  timers.advance(5000)
  assert.deepEqual(sent, [3, 6, 8])
  reporter.flush()
  assert.deepEqual(beacons, [9])
})

function memoryStorage() {
  const map = new Map<string, string>()
  return { getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => { map.set(key, value) } }
}

test('mock source mirrors backend: no record, forward-only via max, two pages share state without rollback', async () => {
  const storage = memoryStorage()
  const pageA = createMockReadSource(() => storage)
  const pageB = createMockReadSource(() => storage)
  for (const page of [pageA, pageB]) page.observe?.('c', ['1', '3', '5', '7'])
  assert.deepEqual(await pageA.get('c'), { lastReadMessageId: null, lastReadPosition: null, unreadCount: 0 })
  await pageA.mark('c', { messageId: '5', position: 5 })
  const stale = await pageB.mark('c', { messageId: '3', position: 3 })
  assert.equal(stale.lastReadPosition, 5)
  assert.equal(stale.lastReadMessageId, '5')
  pageB.beacon('c', { messageId: '7', position: 7 })
  assert.equal((await pageA.get('c')).lastReadPosition, 7)
})

test('mock source rejects unknown or non-persisted ids with 422, like the server', async () => {
  const storage = memoryStorage()
  const page = createMockReadSource(() => storage)
  page.observe?.('c', ['1', '2'])
  await assert.rejects(page.mark('c', { messageId: '3', position: 3 }), (error: unknown) => error instanceof ReadError && error.status === 422)
  await assert.rejects(page.mark('c', { messageId: '2', position: 9 }), (error: unknown) => error instanceof ReadError && error.status === 422)
  page.beacon('c', { messageId: '3', position: 3 })
  assert.equal((await page.get('c')).lastReadPosition, null)
  storage.setItem(MOCK_READ_KEY + 'c', JSON.stringify({ simulateStatus: 403 }))
  await assert.rejects(page.mark('c', { messageId: '2', position: 2 }), (error: unknown) => error instanceof ReadError && error.status === 403)
})

test('reporter: server position is authoritative and stop() ends all requests', () => {
  const clock = fakeTimers()
  const sent: number[] = []
  const reporter = createReadReporter<{ position: number }>({ send: t => sent.push(t.position), timers: clock })
  reporter.advance(10)
  reporter.report({ position: 8 })
  assert.deepEqual(sent, [])
  reporter.report({ position: 11 })
  assert.deepEqual(sent, [11])
  reporter.stop()
  clock.advance(5000)
  reporter.report({ position: 12 })
  reporter.flush()
  assert.deepEqual(sent, [11])
})
