import assert from 'node:assert/strict'
import test from 'node:test'
import { LiveChannel, LIVE_FALLBACK_MS, type LiveRuntime, type LiveSocket, type LiveTicket } from './channel'
import { DEVICE_GATEWAY_TICKET_SECONDS } from '../device-gateway-ticket'

import { LIVE_KINDS, type LiveKind } from './events'

const task = '19df8afd-0f8c-4c6b-bc9c-20df0b046a72'
const other = 'e4ec7f73-0a59-4ad4-8b3c-41f8cd510c6d'
const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }

class Socket implements LiveSocket {
  onopen: LiveSocket['onopen'] = null
  onmessage: LiveSocket['onmessage'] = null
  onclose: LiveSocket['onclose'] = null
  onerror: LiveSocket['onerror'] = null
  readyState: 0 | 1 | 2 | 3 = 0
  respond = true
  constructor(private supported: readonly LiveKind[] | null = LIVE_KINDS) {}
  sent: string[] = []
  open() { this.readyState = 1; if (this.onopen) Reflect.apply(this.onopen, this, [new Event('open')]); if (this.supported) this.message(JSON.stringify({ type: 'live_ready', version: 1, kinds: this.supported })) }
  message(data: string) { if (this.onmessage) Reflect.apply(this.onmessage, this, [{ data }]) }
  close() { this.readyState = 3; if (this.onclose) Reflect.apply(this.onclose, this, [{}]) }
  send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
    this.sent.push(String(data))
    if (this.respond && data === 'ping') this.message('pong')
  }
}

function fixture() {
  let now = 1_800_000_000_000, visible = true, nextTimer = 0, available = true
  let ticketCalls = 0, lifetime = 600_000
  let supported: readonly LiveKind[] | null = LIVE_KINDS
  let clockOffset = 0
  const timers = new Map<number, { at: number; callback: () => void }>()
  const watchers = new Set<() => void>()
  const sockets: Socket[] = [], reads: string[] = [], signals: AbortSignal[] = []
  const runtime: LiveRuntime = {
    ticket: async signal => { signals.push(signal); ticketCalls++; return available ? { url: 'wss://gateway.test/socket', protocol: 'ticket', expiresAt: now + lifetime } : null },
    socket: () => { const socket = new Socket(supported); sockets.push(socket); return socket },
    visible: () => visible,
    watchVisibility: changed => { watchers.add(changed); return () => { watchers.delete(changed) } },
    now: () => now + clockOffset,
    monotonicNow: () => now,
    later: (callback, milliseconds) => { const id = ++nextTimer; timers.set(id, { at: now + milliseconds, callback }); return id },
    cancel: timer => { timers.delete(timer as number) },
  }
  const channel = new LiveChannel(runtime)
  return {
    channel, runtime, sockets, reads, signals,
    subscribe: (id = task, keys = ['detail', 'ledger']) => channel.subscribe('factory_task', id, keys, key => { reads.push(key) }),
    ticketCalls: () => ticketCalls,
    capabilities: (value: readonly LiveKind[] | null) => { supported = value },
    wallClock: (offset: number) => { clockOffset = offset },
    available: (value: boolean) => { available = value },
    lifetime: (value: number) => { lifetime = value },
    visibility(value: boolean) { visible = value; for (const watcher of watchers) watcher() },
    async advance(milliseconds: number) {
      const until = now + milliseconds
      for (;;) {
        const next = [...timers].sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0]
        if (!next || next[1].at > until) break
        now = next[1].at; timers.delete(next[0]); next[1].callback(); await settle()
      }
      now = until; await settle()
    },
    async open() { await settle(); sockets.at(-1)!.open(); await this.advance(100) },
  }
}

test('duplicate badges share a connection and one revalidation per SWR key', async () => {
  const f = fixture(), stop = f.subscribe()
  const stopDuplicate = f.subscribe()
  await f.open()
  assert.equal(f.sockets.length, 1)
  assert.deepEqual(f.reads, ['detail', 'ledger'])
  f.reads.length = 0
  f.sockets[0].message(JSON.stringify({ kind: 'factory_task', id: task }))
  f.sockets[0].message(JSON.stringify({ kind: 'factory_task', id: task }))
  await f.advance(100)
  assert.deepEqual(f.reads, ['detail', 'ledger'])
  stop(); assert.equal(f.sockets[0].readyState, 1)
  stopDuplicate(); assert.equal(f.sockets[0].readyState, 3)
})

test('online idle channels send pings and perform no polling reads', async () => {
  const f = fixture(); f.subscribe(); await f.open(); f.reads.length = 0
  await f.advance(180_000)
  assert.deepEqual(f.reads, [])
  assert.equal(f.ticketCalls(), 1)
  assert.ok(f.sockets[0].sent.every(value => value === 'ping'))
  assert.equal(f.sockets[0].sent.length, 6)
  f.channel.dispose()
})

test('offline fallback waits at least 60 seconds; hidden tabs make no requests', async () => {
  const f = fixture(); f.available(false); f.subscribe(); await settle()
  await f.advance(LIVE_FALLBACK_MS - 1)
  assert.deepEqual(f.reads, [])
  assert.equal(f.ticketCalls(), 1)
  await f.advance(101)
  assert.deepEqual(f.reads, ['detail', 'ledger'])
  f.visibility(false); const calls = f.ticketCalls(); f.reads.length = 0
  await f.advance(180_000)
  assert.deepEqual(f.reads, [])
  assert.equal(f.ticketCalls(), calls)
  f.available(true); f.visibility(true); await f.open()
  assert.deepEqual(f.reads, ['detail', 'ledger'])
  f.channel.dispose()
})

test('a reconnect reconciles missed changes immediately and resets the offline fallback', async () => {
  const f = fixture(); f.subscribe(); await f.open(); f.reads.length = 0
  f.sockets[0].close()
  await f.advance(1_000)
  await f.open()
  assert.equal(f.ticketCalls(), 2)
  assert.deepEqual(f.reads, ['detail', 'ledger'])
  f.reads.length = 0; await f.advance(LIVE_FALLBACK_MS)
  assert.deepEqual(f.reads, [])
  f.channel.dispose()
})

test('unknown ids, kinds and payload fields cannot trigger revalidation', async () => {
  const f = fixture(); f.subscribe(); await f.open(); f.reads.length = 0
  for (const value of [{ kind: 'factory_task', id: other }, { kind: 'run', id: task }, { kind: 'factory_task', id: task, prompt: 'private' }, { kind: 'anything', id: task }]) f.sockets[0].message(JSON.stringify(value))
  f.sockets[0].message('not json')
  await f.advance(100)
  assert.deepEqual(f.reads, [])
  f.channel.dispose()
})

test('workspace teardown aborts a pending ticket and discards late events', async () => {
  const f = fixture(); f.subscribe(); await f.open(); f.reads.length = 0
  const oldSocket = f.sockets[0]
  f.channel.dispose()
  assert.equal(f.signals[0].aborted, true)
  oldSocket.message(JSON.stringify({ kind: 'factory_task', id: task }))
  await f.advance(180_000)
  assert.deepEqual(f.reads, [])
  assert.equal(f.ticketCalls(), 1)
})

test('ticket renewal reauthenticates and catches up without keeping an expired subscription', async () => {
  const f = fixture(); f.lifetime(10_000); f.subscribe(); await f.open(); f.reads.length = 0
  await f.advance(9_900)
  assert.equal(f.sockets[0].readyState, 3)
  assert.equal(f.ticketCalls(), 2)
  await f.open()
  assert.deepEqual(f.reads, ['detail', 'ledger'])
  f.channel.dispose()
})

test('a late ticket cannot open a socket after the tab becomes hidden', async () => {
  const f = fixture()
  let resolve!: (ticket: LiveTicket) => void
  f.runtime.ticket = async () => new Promise<LiveTicket>(done => { resolve = done })
  f.subscribe(); await settle(); f.visibility(false)
  resolve({ url: 'wss://gateway.test/socket', protocol: 'ticket', expiresAt: f.runtime.now() + 300_000 })
  await settle()
  assert.equal(f.sockets.length, 0)
  await f.advance(180_000)
  assert.deepEqual(f.reads, [])
  f.channel.dispose()
})

test('a half-open socket becomes offline when pongs stop', async () => {
  const f = fixture(); f.subscribe(); await f.open(); f.reads.length = 0
  f.sockets[0].respond = false
  await f.advance(60_000)
  assert.equal(f.sockets[0].readyState, 3)
  await f.advance(1_000)
  assert.equal(f.ticketCalls(), 2)
  f.channel.dispose()
})

test('a healthy socket catches a lost invalidation at the full ticket lifetime', async () => {
  const f = fixture(), lifetime = DEVICE_GATEWAY_TICKET_SECONDS * 1_000
  let committedVersion = 0
  const observed: number[] = []
  f.lifetime(lifetime)
  f.channel.subscribe('factory_task', task, ['detail'], () => { observed.push(committedVersion) })
  await f.open()
  assert.deepEqual(observed, [0])
  // The database commits, but every delivery attempt fails before reaching the
  // healthy socket. Pongs continue; no invalidation message is received.
  committedVersion = 1
  await f.advance(lifetime - 101)
  assert.deepEqual(observed, [0])
  assert.equal(f.sockets[0].readyState, 1)
  await f.advance(1)
  assert.equal(f.sockets[0].readyState, 3)
  assert.equal(f.ticketCalls(), 2)
  await f.open()
  assert.deepEqual(observed, [0, 1])
  f.channel.dispose()
})

test('a hung renewal still reconciles a lost invalidation after one offline fallback interval', async () => {
  const f = fixture(), lifetime = DEVICE_GATEWAY_TICKET_SECONDS * 1_000
  const mint = f.runtime.ticket
  let first = true, finishRenew!: (ticket: LiveTicket | null) => void
  let renewalSignal: AbortSignal | null = null
  f.runtime.ticket = signal => {
    if (first) { first = false; return mint(signal) }
    renewalSignal = signal
    return new Promise<LiveTicket | null>(resolve => { finishRenew = resolve })
  }
  f.lifetime(lifetime); f.subscribe(); await f.open(); f.reads.length = 0
  await f.advance(lifetime - 100)
  assert.equal(f.sockets[0].readyState, 3)
  assert.equal(f.sockets.length, 1)
  assert.ok(renewalSignal)
  await f.advance(LIVE_FALLBACK_MS - 1)
  assert.deepEqual(f.reads, [])
  await f.advance(101)
  assert.deepEqual(f.reads, ['detail', 'ledger'])
  // Teardown also aborts the pending renewal; a late response cannot reopen it.
  f.channel.dispose()
  assert.equal((renewalSignal as AbortSignal).aborted, true)
  finishRenew(null); await settle()
  assert.equal(f.sockets.length, 1)
})

test('stream bursts retain the last change without reading more often than the old two-second cadence', async () => {
  const f = fixture(), observed: number[] = []
  let revision = 0
  f.channel.subscribe('thread', task, ['transcript'], () => { observed.push(revision) }, { minIntervalMs: 2_000 })
  await f.open(); observed.length = 0
  for (let i = 1; i <= 20; i++) {
    revision = i
    f.sockets[0].message(JSON.stringify({ kind: 'thread', id: task }))
    await f.advance(100)
  }
  assert.deepEqual(observed, [20])
  revision = 21
  f.sockets[0].message(JSON.stringify({ kind: 'thread', id: task }))
  await f.advance(1_999); assert.deepEqual(observed, [20])
  await f.advance(1); assert.deepEqual(observed, [20, 21])
  await f.advance(10_000); assert.deepEqual(observed, [20, 21], 'an idle stream never keeps polling')
  f.channel.dispose()
})

test('semantic changes bypass a pending stream delay and deduplicate the same SWR key', async () => {
  const f = fixture()
  f.channel.subscribe('thread', task, ['transcript'], key => { f.reads.push(key) }, { minIntervalMs: 2_000 })
  f.channel.subscribe('run', task, ['transcript'], key => { f.reads.push(key) })
  await f.open(); f.reads.length = 0
  f.sockets[0].message(JSON.stringify({ kind: 'thread', id: task }))
  await f.advance(100); assert.deepEqual(f.reads, [])
  f.sockets[0].message(JSON.stringify({ kind: 'run', id: task }))
  await f.advance(100); assert.deepEqual(f.reads, ['transcript'])
  await f.advance(2_000); assert.deepEqual(f.reads, ['transcript'])
  f.channel.dispose()
})

test('a change during an in-flight read gets one trailing read after it settles', async () => {
  const f = fixture()
  let finish!: () => void
  f.channel.subscribe('thread', task, ['transcript'], key => {
    f.reads.push(key)
    if (f.reads.length === 1) return new Promise<void>(resolve => { finish = resolve })
  }, { minIntervalMs: 2_000 })
  await f.open()
  for (let i = 0; i < 10; i++) f.sockets[0].message(JSON.stringify({ kind: 'thread', id: task }))
  await f.advance(5_000); assert.deepEqual(f.reads, ['transcript'])
  finish(); await settle(); await f.advance(100)
  assert.deepEqual(f.reads, ['transcript', 'transcript'])
  f.channel.dispose()
})

test('hidden documents discard delayed reads and reconcile the current document on visibility return', async () => {
  const f = fixture()
  f.channel.subscribe('approved_writes', task, ['document'], key => { f.reads.push(key) }, { minIntervalMs: 1_500 })
  await f.open(); f.reads.length = 0
  f.sockets[0].message(JSON.stringify({ kind: 'approved_writes', id: task }))
  f.visibility(false); await f.advance(60_000)
  assert.deepEqual(f.reads, [])
  f.visibility(true); await f.open()
  assert.deepEqual(f.reads, ['document'])
  f.channel.dispose()
})

test('teardown during a read cannot schedule an old owner or workspace trailing read', async () => {
  const f = fixture()
  let finish!: () => void
  f.channel.subscribe('thread', task, ['transcript'], key => {
    f.reads.push(key)
    return new Promise<void>(resolve => { finish = resolve })
  }, { minIntervalMs: 2_000 })
  await f.open()
  f.sockets[0].message(JSON.stringify({ kind: 'thread', id: task }))
  f.channel.dispose(); finish(); await settle(); await f.advance(60_000)
  assert.deepEqual(f.reads, ['transcript'])
})

test('a server question deadline performs one catch-up read and never becomes a poll', async () => {
  const f = fixture()
  f.channel.subscribe('factory_issue', task, ['thread'], key => { f.reads.push(key) },
    { minIntervalMs: 30_000, deadline: { at: 'server-expiry', afterMs: 2_000 } })
  await f.open(); f.reads.length = 0
  await f.advance(1_899)
  assert.deepEqual(f.reads, [])
  await f.advance(101)
  assert.deepEqual(f.reads, ['thread'], 'the deadline bypasses stream cadence once')
  f.reads.length = 0
  await f.advance(180_000)
  assert.deepEqual(f.reads, [])
  f.channel.dispose()
})

test('hidden question deadlines make no reads; visibility and teardown reconcile or discard them', async () => {
  const f = fixture()
  const stop = f.channel.subscribe('factory_issue', task, ['thread'], key => { f.reads.push(key) },
    { deadline: { at: 'server-expiry', afterMs: 2_000 } })
  await f.open(); f.reads.length = 0
  f.visibility(false)
  await f.advance(5_000)
  assert.deepEqual(f.reads, [])
  f.visibility(true); await f.open()
  assert.deepEqual(f.reads, ['thread'])
  f.reads.length = 0
  stop(); await f.advance(60_000)
  assert.deepEqual(f.reads, [])
})

test('a subscriber joining an already healthy channel reconciles a read that started before its subscription', async () => {
  const f = fixture(); f.subscribe(); await f.open(); f.reads.length = 0
  // The first read of this newly mounted view may have missed a commit while
  // its subscription was being installed. Do not wait for another event.
  f.channel.subscribe('approved_write', other, ['new-result'], key => { f.reads.push(key) })
  await f.advance(100)
  assert.deepEqual(f.reads, ['new-result'])
  f.reads.length = 0; await f.advance(180_000)
  assert.deepEqual(f.reads, [])
  f.channel.dispose()
})

test('a new client on an old Worker keeps the sixty-second fallback despite healthy auto-pongs', async () => {
  const f = fixture(); f.capabilities(null)
  f.channel.subscribe('approved_writes', task, ['approvals'], key => { f.reads.push(key) })
  await f.open(); f.reads.length = 0
  await f.advance(LIVE_FALLBACK_MS - 101); assert.deepEqual(f.reads, [])
  await f.advance(101); assert.deepEqual(f.reads, ['approvals'])
  assert.equal(f.sockets[0].readyState, 1)
  assert.ok(f.sockets[0].sent.includes('ping'))
  f.channel.dispose()
})

test('capabilities are per-kind, including subscriptions added after the channel is ready', async () => {
  const f = fixture(); f.capabilities(['factory_task'])
  f.subscribe(task, ['factory']); await f.open(); f.reads.length = 0
  const stop = f.channel.subscribe('approved_writes', other, ['approvals'], key => { f.reads.push(key) })
  await f.advance(100); assert.deepEqual(f.reads, ['approvals'])
  f.reads.length = 0
  await f.advance(LIVE_FALLBACK_MS); assert.deepEqual(f.reads, ['approvals'])
  f.reads.length = 0; stop()
  await f.advance(LIVE_FALLBACK_MS * 2); assert.deepEqual(f.reads, [])
  f.channel.dispose()
})

test('malformed readiness cannot suppress fallback, and a verified readiness stops only supported-key fallback', async () => {
  const f = fixture(); f.capabilities(null)
  f.channel.subscribe('approved_write', task, ['result'], key => { f.reads.push(key) })
  await f.open(); f.reads.length = 0
  for (const value of [
    { type: 'live_ready', version: 2, kinds: ['approved_write'] },
    { type: 'live_ready', version: 1, kinds: ['approved_write'], private: 'ignored' },
    { type: 'live_ready', version: 1, kinds: ['approved_write', 'approved_write'] },
    { type: 'live_ready', version: 1, kinds: 'approved_write' },
  ]) f.sockets[0].message(JSON.stringify(value))
  await f.advance(LIVE_FALLBACK_MS); assert.deepEqual(f.reads, ['result'])
  f.reads.length = 0
  f.sockets[0].message(JSON.stringify({ type: 'live_ready', version: 1, kinds: ['approved_write', 'future_kind'] }))
  await f.advance(LIVE_FALLBACK_MS * 2); assert.deepEqual(f.reads, [])
  f.channel.dispose()
})

test('approval expiry still triggers one authoritative read when the old Worker has no capability announcement', async () => {
  const f = fixture(); f.capabilities(null)
  f.channel.subscribe('approved_writes', task, ['approvals'], key => { f.reads.push(key) }, { deadline: { at: 'approval-expiry', afterMs: 1_000 } })
  await f.open(); f.reads.length = 0
  await f.advance(1_000); assert.deepEqual(f.reads, ['approvals'])
  f.reads.length = 0; await f.advance(10_000); assert.deepEqual(f.reads, [])
  f.channel.dispose()
})

test('moving the browser wall clock backwards cannot postpone a server-derived approval expiry', async () => {
  const f = fixture()
  f.channel.subscribe('approved_writes', task, ['approvals'], key => { f.reads.push(key) }, { deadline: { at: 'approval-expiry', afterMs: 1_000 } })
  await f.open(); f.reads.length = 0
  f.wallClock(-3_600_000)
  await f.advance(1_000); assert.deepEqual(f.reads, ['approvals'])
  f.reads.length = 0; await f.advance(10_000); assert.deepEqual(f.reads, [])
  f.channel.dispose()
})

test('a backward wall-clock correction cannot postpone a pushed key beyond its existing pacing interval', async () => {
  const f = fixture()
  f.channel.subscribe('approved_writes', task, ['approvals'], key => { f.reads.push(key) }, { minIntervalMs: 500 })
  await f.open(); f.reads.length = 0
  f.wallClock(-3_600_000)
  f.sockets[0].message(JSON.stringify({ kind: 'approved_writes', id: task }))
  await f.advance(499); assert.deepEqual(f.reads, [])
  await f.advance(1); assert.deepEqual(f.reads, ['approvals'])
  f.channel.dispose()
})
