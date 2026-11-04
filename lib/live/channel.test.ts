import assert from 'node:assert/strict'
import test from 'node:test'
import { LiveChannel, LIVE_FALLBACK_MS, type LiveRuntime, type LiveSocket, type LiveTicket } from './channel'

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
  sent: string[] = []
  open() { this.readyState = 1; if (this.onopen) Reflect.apply(this.onopen, this, [new Event('open')]) }
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
  const timers = new Map<number, { at: number; callback: () => void }>()
  const watchers = new Set<() => void>()
  const sockets: Socket[] = [], reads: string[] = [], signals: AbortSignal[] = []
  const runtime: LiveRuntime = {
    ticket: async signal => { signals.push(signal); ticketCalls++; return available ? { url: 'wss://gateway.test/socket', protocol: 'ticket', expiresAt: now + lifetime } : null },
    socket: () => { const socket = new Socket(); sockets.push(socket); return socket },
    visible: () => visible,
    watchVisibility: changed => { watchers.add(changed); return () => { watchers.delete(changed) } },
    now: () => now,
    later: (callback, milliseconds) => { const id = ++nextTimer; timers.set(id, { at: now + milliseconds, callback }); return id },
    cancel: timer => { timers.delete(timer as number) },
  }
  const channel = new LiveChannel(runtime)
  return {
    channel, runtime, sockets, reads, signals,
    subscribe: (id = task, keys = ['detail', 'ledger']) => channel.subscribe('factory_task', id, keys, key => { reads.push(key) }),
    ticketCalls: () => ticketCalls,
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
