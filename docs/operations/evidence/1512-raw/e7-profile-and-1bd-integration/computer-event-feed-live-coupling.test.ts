import assert from 'node:assert/strict'
import test from 'node:test'
import { LiveChannel, type LiveSocket } from '/workspace/scratch/812e3b7d6d45/Mikka/lib/live/channel.ts'
import { ComputerEventFeed, type ComputerEventRuntime } from '/workspace/scratch/812e3b7d6d45/Mikka/lib/computer/event-stream.ts'
import { readBoundary } from '/workspace/scratch/812e3b7d6d45/Mikka/lib/swr/read-observer.ts'

const workspace = '11111111-1111-4111-8111-111111111111'
const subagent = '22222222-2222-4222-8222-222222222222'
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }
class Socket implements LiveSocket {
  onopen: LiveSocket['onopen'] = null
  onmessage: LiveSocket['onmessage'] = null
  onclose: LiveSocket['onclose'] = null
  onerror: LiveSocket['onerror'] = null
  readyState: 0 | 1 | 2 | 3 = 0
  open() {
    this.readyState = 1
    this.onopen?.(new Event('open'))
    this.message(JSON.stringify({ type: 'live_ready', version: 1, kinds: ['factory_task', 'subagent_events'] }))
  }
  message(data: string) { this.onmessage?.({ data } as MessageEvent) }
  send(data: string | ArrayBufferLike | Blob | ArrayBufferView) { if (data === 'ping') this.message('pong') }
  close() { this.readyState = 3; this.onclose?.({} as CloseEvent) }
}

/** Actual LiveChannel scheduling and after boundaries; no mocked invalidate. */
function fixture() {
  let now = 1_800_000_000_000, nextTimer = 0
  const timers = new Map<number, { at: number; callback: () => void }>()
  const later = (callback: () => void, milliseconds: number) => {
    const id = ++nextTimer; timers.set(id, { at: now + milliseconds, callback }); return id
  }
  const cancel = (id: unknown) => { timers.delete(id as number) }
  const sockets: Socket[] = []
  const channel = new LiveChannel({
    ticket: async () => ({ url: 'wss://fixture.invalid/socket', protocol: 'fixture', expiresAt: now + 600_000 }),
    socket: () => { const socket = new Socket(); sockets.push(socket); return socket },
    visible: () => true, watchVisibility: () => () => {}, now: () => now, monotonicNow: () => now,
    later, cancel,
  })
  const calls: Array<{ began: number; cursor: string }> = []
  const catchups: Array<{ after: number; invoked: number }> = []
  const stopped = new AbortController()
  const runtime: ComputerEventRuntime = {
    page: async cursor => {
      calls.push({ began: readBoundary(), cursor })
      const sequence = String(calls.length)
      return { events: [{ id: sequence, data: { botId: workspace, subagentId: subagent, task: 'Fixture', state: 'needs_you', step: `accepted-${sequence}`, needs: { kind: 'login', site: 'fixture.invalid' } } }], cursor: sequence, hasMore: false }
    },
    visible: () => true, watchVisibility: () => () => {}, stopped: stopped.signal, later, cancel,
    invalidations: refresh => channel.subscribe('subagent_events', workspace, [`computer-events:${workspace}`], (_key, _required, _reuse, after) => {
      assert.equal(typeof after, 'number', 'the real LiveChannel must supply its catch-up boundary')
      catchups.push({ after: after!, invoked: readBoundary() })
      // Exact current useSubagentUpdates bridge: its callback discards after.
      void refresh()
    }),
  }
  const feed = new ComputerEventFeed(runtime)
  const stops: Array<() => void> = []
  return {
    channel, feed, calls, catchups, sockets,
    keepConnection() { stops.push(channel.subscribe('factory_task', workspace, ['fixture-keepalive'], () => {})) },
    subscribe() { const stop = feed.subscribe(() => {}); stops.push(stop); return stop },
    async open() { await settle(); assert.equal(sockets.length, 1); sockets[0].open(); await settle() },
    async advance(milliseconds: number) {
      const until = now + milliseconds
      for (;;) {
        const entry = [...timers].sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0]
        if (!entry || entry[1].at > until) break
        now = entry[1].at; timers.delete(entry[0]); entry[1].callback(); await settle()
      }
      now = until; await settle()
    },
    committed() { return feed.getSnapshot().get(subagent)?.step },
    dispose() { for (const stop of stops.reverse()) stop(); stopped.abort(); channel.dispose(); assert.equal(timers.size, 0) },
  }
}

test('late feed initial read committed after actual channel catch-up boundary must cover that catch-up', async t => {
  const f = fixture(); t.after(() => f.dispose())
  f.keepConnection(); await f.open(); await f.advance(100)
  f.subscribe(); await settle()
  assert.equal(f.calls.length, 1)
  assert.equal(f.committed(), 'accepted-1', 'the initial result was accepted into the actual feed snapshot')
  await f.advance(100)
  assert.equal(f.catchups.length, 1)
  assert.ok(f.calls[0].began > f.catchups[0].after, 'the initial HTTP read began after the exact queued obligation')
  t.diagnostic(JSON.stringify({ initialBegan: f.calls[0].began, catchupAfter: f.catchups[0].after, physicalReads: f.calls.length, committed: f.committed() }))
  assert.equal(f.calls.length, 1, 'a committed post-boundary initial read should not be repeated by the older queued catch-up')
})

test('a feed initial read begun before socket open must still perform the actual channel catch-up', async t => {
  const f = fixture(); t.after(() => f.dispose())
  f.subscribe(); await settle()
  assert.equal(f.calls.length, 1); assert.equal(f.committed(), 'accepted-1')
  await f.open(); await f.advance(100)
  assert.equal(f.catchups.length, 1)
  assert.ok(f.calls[0].began < f.catchups[0].after)
  assert.equal(f.calls.length, 2)
  assert.equal(f.committed(), 'accepted-2')
})

test('a newer real live event after a committed feed read must still trigger another page', async t => {
  const f = fixture(); t.after(() => f.dispose())
  f.keepConnection(); await f.open(); await f.advance(100)
  f.subscribe(); await settle(); await f.advance(100)
  const before = f.calls.length, began = f.calls.at(-1)!.began
  f.sockets[0].message(JSON.stringify({ kind: 'subagent_events', id: workspace }))
  await f.advance(100)
  assert.ok(f.catchups.at(-1)!.after > began)
  assert.equal(f.calls.length, before + 1)
  assert.equal(f.committed(), `accepted-${before + 1}`)
})
