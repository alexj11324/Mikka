import assert from 'node:assert/strict'
import test from 'node:test'
import { LiveChannel, type LiveRuntime, type LiveSocket, type LiveTicket } from './channel'
import { LiveChannels } from './channels'
import { LiveChannelOwner, PreparedLiveChannels } from './preparation'
import { LIVE_KINDS } from './events'
import { acceptSWRRead, observeSWRRead, readFresh } from '../swr/read-observer'

const selected = '8d992f67-2388-4372-92eb-410170899f61'
const home = 'a0c73a42-d768-467c-a00a-dc3a03e98273'
const changed = '201be533-6e3f-41df-994d-69da822f2db3'
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }

class Socket implements LiveSocket {
  onopen: LiveSocket['onopen'] = null
  onmessage: LiveSocket['onmessage'] = null
  onclose: LiveSocket['onclose'] = null
  onerror: LiveSocket['onerror'] = null
  readyState: 0 | 1 | 2 | 3 = 0
  constructor(readonly scope: string | null) {}
  open() {
    this.readyState = 1
    if (this.onopen) Reflect.apply(this.onopen, this, [new Event('open')])
    this.message({ type: 'live_ready', version: 1, kinds: LIVE_KINDS })
  }
  message(value: unknown) { if (this.onmessage) Reflect.apply(this.onmessage, this, [{ data: typeof value === 'string' ? value : JSON.stringify(value) }]) }
  fail() { if (this.onerror) Reflect.apply(this.onerror, this, [new Event('error')]) }
  close() { this.readyState = 3; if (this.onclose) Reflect.apply(this.onclose, this, [{}]) }
  send(value: string | ArrayBufferLike | Blob | ArrayBufferView) { if (value === 'ping') this.message('pong') }
}

function fixture() {
  let now = 1_800_000_000_000, visible = true, sequence = 0, lifetime = 600_000
  let mode: 'ok' | 'null' | 'reject' | 'deferred' = 'ok'
  const pending = deferred<LiveTicket | null>()
  const calls: { scope: string | null; signal: AbortSignal }[] = []
  const sockets: Socket[] = [], watchers = new Set<() => void>()
  const timers = new Map<number, { at: number; run: () => void }>()
  const ticket = (): LiveTicket => ({ url: 'wss://fixture.invalid/live', protocol: 'fixture', expiresAt: now + lifetime })
  const runtime = (scope: string | null): LiveRuntime => ({
    async ticket(signal) {
      calls.push({ scope, signal })
      if (mode === 'reject') throw new Error('fixture-ticket-failure')
      if (mode === 'null') return null
      if (mode === 'deferred') return pending.promise
      return ticket()
    },
    socket() { const socket = new Socket(scope); sockets.push(socket); return socket },
    visible: () => visible,
    watchVisibility(changed) { watchers.add(changed); return () => { watchers.delete(changed) } },
    now: () => now, monotonicNow: () => now,
    later(run, milliseconds) { const id = ++sequence; timers.set(id, { at: now + milliseconds, run }); return id },
    cancel(id) { timers.delete(id as number) },
  })
  return { runtime, calls, sockets, watchers, timers,
    mode(value: typeof mode) { mode = value }, lifetime(value: number) { lifetime = value },
    resolveTicket() { pending.resolve(ticket()) },
    visibility(value: boolean) { visible = value; for (const changed of watchers) changed() },
    async open(scope = selected) { await settle(); const socket = sockets.findLast(item => item.scope === scope && item.readyState === 0); assert.ok(socket); socket.open(); await settle(); return socket },
    async advance(milliseconds: number) {
      const end = now + milliseconds
      let steps = 0
      for (;;) {
        const next = [...timers].sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0]
        if (!next || next[1].at > end) break
        assert.ok(++steps < 1000, 'fixture timer cycle')
        now = next[1].at; timers.delete(next[0]); next[1].run(); await settle()
      }
      now = end; await settle()
    },
  }
}

function readFixture() {
  const cache = new Map<string, { data: { items: number[] } }>()
  let reads = 0, refreshes = 0
  const commit = async (wait?: Promise<void>) => {
    const pending = observeSWRRead(cache, 'chat', async () => { reads++; if (wait) await wait; return { items: [reads] } })
    const data = await pending
    acceptSWRRead(cache, 'chat', data); cache.set('chat', { data }); await settle()
    return data
  }
  return { cache, commit, count: () => reads, refreshCount: () => refreshes,
    refresh: (_key: string, _required?: unknown, _reuse?: boolean, after?: number) => {
      refreshes++
      return readFresh(cache, 'chat', after!, () => commit(), () => true, () => true)
    } }
}

test('equal selected and home hints prepare one connection without a business read', async () => {
  const f = fixture(), reads: string[] = []
  const preparation = new PreparedLiveChannels(f.runtime, { workspaceId: selected, homeWorkspaceId: selected })
  assert.equal(f.calls.length, 1)
  assert.equal(f.watchers.size, 1)
  const socket = await f.open()
  assert.equal(reads.length, 0)
  const owner = new LiveChannelOwner(f.runtime, new Map(), preparation), unmount = owner.mount()
  owner.confirmWorkspace(selected)
  const stop = owner.subscribe(selected, 'thread_list', selected, ['threads'], key => { reads.push(key) })
  assert.equal(f.calls.length, 1)
  assert.equal(f.watchers.size, 1)
  assert.equal(owner.keyConnected('threads'), true)
  stop(); unmount(); preparation.retire()
  assert.equal(socket.readyState, 3)
  assert.equal(f.watchers.size, 0)
  assert.equal(f.timers.size, 0)
})

test('different selected and home hints join their exact existing registry entries', async () => {
  const f = fixture(), preparation = new PreparedLiveChannels(f.runtime, { workspaceId: selected, homeWorkspaceId: home })
  const selectedSocket = await f.open(selected), homeSocket = await f.open(home)
  const owner = new LiveChannelOwner(f.runtime, new Map(), preparation), unmount = owner.mount()
  owner.confirmWorkspace(selected)
  const stopSelected = owner.subscribe(selected, 'workspace_settings', selected, ['settings'], () => {})
  const stopHome = owner.subscribe(home, 'thread_list', home, ['threads'], () => {})
  assert.deepEqual(f.calls.map(call => call.scope), [selected, home])
  assert.equal(owner.keyConnected('settings'), true)
  assert.equal(owner.keyConnected('threads'), true)
  stopHome(); assert.equal(homeSocket.readyState, 3)
  assert.equal(selectedSocket.readyState, 1)
  stopSelected(); unmount()
  assert.equal(f.watchers.size, 0)
})

test('confirming the selected hint before its first real subscriber preserves ready coverage', async () => {
  const f = fixture(), preparation = new PreparedLiveChannels(f.runtime, { workspaceId: selected })
  const socket = await f.open(), owner = new LiveChannelOwner(f.runtime, new Map(), preparation)
  const unmount = owner.mount()
  owner.confirmWorkspace(selected)
  assert.equal(socket.readyState, 1)
  const stop = owner.subscribe(selected, 'workspace_settings', selected, ['settings'], () => {})
  assert.equal(f.calls.length, 1)
  assert.equal(owner.keyConnected('settings'), true)
  stop(); unmount()
  assert.equal(socket.readyState, 3)
})

test('a stopped historical subscription cannot consume the selected reservation', async () => {
  const f = fixture(), preparation = new PreparedLiveChannels(f.runtime, { workspaceId: selected })
  const socket = await f.open(), owner = new LiveChannelOwner(f.runtime, new Map(), preparation), unmount = owner.mount()
  const previous = owner.subscribe(selected, 'workspace_settings', selected, ['previous'], () => {})
  previous()
  owner.confirmWorkspace(selected)
  assert.equal(socket.readyState, 1)
  const current = owner.subscribe(selected, 'workspace_settings', selected, ['current'], () => {})
  assert.equal(f.calls.length, 1)
  assert.equal(owner.keyConnected('current'), true)
  current(); unmount()
})

test('an invalid entity does not count as a consumer or consume preparation', async () => {
  const f = fixture(), preparation = new PreparedLiveChannels(f.runtime, { workspaceId: selected })
  const socket = await f.open(), owner = new LiveChannelOwner(f.runtime, new Map(), preparation), unmount = owner.mount()
  const invalid = owner.subscribe(selected, 'workspace_settings', 'not-an-id', ['invalid'], () => {})
  owner.confirmWorkspace(selected)
  assert.equal(owner.keyConnected('invalid'), undefined)
  assert.equal(socket.readyState, 1)
  const stop = owner.subscribe(selected, 'workspace_settings', selected, ['settings'], () => {})
  assert.equal(owner.keyConnected('settings'), true)
  assert.equal(f.calls.length, 1)
  invalid(); stop(); unmount()
})

test('fresh selected and home scopes retire unused hints without relabelling a subscription', async () => {
  const f = fixture(), preparation = new PreparedLiveChannels(f.runtime, { workspaceId: selected, homeWorkspaceId: home })
  const oldSelected = await f.open(selected), oldHome = await f.open(home)
  const owner = new LiveChannelOwner(f.runtime, new Map(), preparation), unmount = owner.mount()
  owner.confirmWorkspace(changed)
  assert.equal(oldSelected.readyState, 3)
  const stop = owner.subscribe(changed, 'thread_list', changed, ['threads'], () => {})
  assert.equal(oldHome.readyState, 3)
  const actual = await f.open(changed)
  assert.deepEqual(f.calls.map(call => call.scope), [selected, home, changed])
  assert.equal(owner.keyConnected('threads'), true)
  stop(); unmount(); assert.equal(actual.readyState, 3)
})

test('a read begun after readiness is reused by the real late subscriber', async () => {
  const f = fixture(), preparation = new PreparedLiveChannels(f.runtime, { workspaceId: selected })
  await f.open()
  const data = readFixture()
  await data.commit()
  const owner = new LiveChannelOwner(f.runtime, data.cache, preparation), unmount = owner.mount()
  owner.confirmWorkspace(selected)
  owner.subscribe(selected, 'bot_chat', changed, ['chat'], data.refresh)
  await f.advance(100)
  assert.equal(data.refreshCount(), 1, 'the original debounce must invoke the real refresh')
  assert.equal(data.count(), 1)
  assert.equal(f.calls.length, 1)
  unmount()
})

test('a read begun before readiness still catches up even when it finishes afterwards', async () => {
  const f = fixture(), preparation = new PreparedLiveChannels(f.runtime, { workspaceId: selected })
  const data = readFixture(), finish = deferred<void>()
  const original = data.commit(finish.promise)
  await settle()
  await f.open()
  finish.resolve(); await original
  const owner = new LiveChannelOwner(f.runtime, data.cache, preparation), unmount = owner.mount()
  owner.confirmWorkspace(selected)
  owner.subscribe(selected, 'bot_chat', changed, ['chat'], data.refresh)
  await f.advance(100)
  assert.equal(data.refreshCount(), 1, 'the original debounce must invoke the real refresh')
  assert.equal(data.count(), 2, 'late completion is not a fresh dispatch/read-begin proof')
  unmount()
})

test('an incoming push with no keys remains an obligation for a later matching subscriber', async () => {
  const f = fixture(), preparation = new PreparedLiveChannels(f.runtime, { workspaceId: selected })
  const socket = await f.open(), data = readFixture()
  await data.commit()
  socket.message({ kind: 'bot_chat', id: changed })
  const owner = new LiveChannelOwner(f.runtime, data.cache, preparation), unmount = owner.mount()
  owner.confirmWorkspace(selected)
  owner.subscribe(selected, 'bot_chat', changed, ['chat'], data.refresh)
  await f.advance(100)
  assert.equal(data.refreshCount(), 1, 'the original debounce must invoke the real refresh')
  assert.equal(data.count(), 2)
  assert.equal(f.calls.length, 1)
  unmount()
})

test('a different event kind does not discard continuous coverage for the late key', async () => {
  const f = fixture(), preparation = new PreparedLiveChannels(f.runtime, { workspaceId: selected })
  const socket = await f.open(), data = readFixture()
  await data.commit()
  socket.message({ kind: 'issue_list', id: changed })
  const owner = new LiveChannelOwner(f.runtime, data.cache, preparation), unmount = owner.mount()
  owner.confirmWorkspace(selected)
  owner.subscribe(selected, 'bot_chat', changed, ['chat'], data.refresh)
  await f.advance(100)
  assert.equal(data.refreshCount(), 1, 'the original debounce must invoke the real refresh')
  assert.equal(data.count(), 1)
  unmount()
})

test('abandoned render owners do not claim a prepared cache lifetime', async () => {
  const f = fixture(), preparation = new PreparedLiveChannels(f.runtime, { workspaceId: selected })
  await f.open()
  const abandoned = new LiveChannelOwner(f.runtime, new Map(), preparation)
  assert.equal(abandoned.keyConnected('key'), undefined)
  const actual = new LiveChannelOwner(f.runtime, new Map(), preparation), unmount = actual.mount()
  actual.confirmWorkspace(selected)
  actual.subscribe(selected, 'workspace_settings', selected, ['key'], () => {})
  assert.equal(f.calls.length, 1)
  assert.equal(actual.keyConnected('key'), true)
  unmount()
})

test('a second cache cannot borrow the first cache live history', async () => {
  const f = fixture(), preparation = new PreparedLiveChannels(f.runtime, { workspaceId: selected })
  await f.open()
  const first = new LiveChannelOwner(f.runtime, new Map(), preparation), stopFirst = first.mount()
  first.confirmWorkspace(selected)
  first.subscribe(selected, 'workspace_settings', selected, ['key'], () => {})
  const second = new LiveChannelOwner(f.runtime, new Map(), preparation), stopSecond = second.mount()
  second.subscribe(selected, 'workspace_settings', selected, ['key'], () => {})
  assert.equal(f.calls.length, 2)
  assert.equal(first.keyConnected('key'), true)
  assert.equal(second.keyConnected('key'), false)
  stopFirst()
  const fresh = await f.open()
  assert.equal(fresh.readyState, 1)
  assert.equal(second.keyConnected('key'), true)
  stopSecond()
})

test('StrictMode cleanup and setup use a new lifetime and old cleanup cannot close it', async () => {
  const f = fixture(), preparation = new PreparedLiveChannels(f.runtime, { workspaceId: selected })
  const warm = await f.open(), owner = new LiveChannelOwner(f.runtime, new Map(), preparation)
  const firstCleanup = owner.mount()
  owner.confirmWorkspace(selected)
  owner.subscribe(selected, 'workspace_settings', selected, ['key'], () => {})
  firstCleanup()
  assert.equal(warm.readyState, 3)
  const secondCleanup = owner.mount()
  owner.subscribe(selected, 'workspace_settings', selected, ['key'], () => {})
  const fresh = await f.open()
  firstCleanup()
  assert.equal(fresh.readyState, 1)
  assert.equal(f.calls.length, 2)
  preparation.retire()
  assert.equal(fresh.readyState, 3, 'parent authority retirement reaches the replay lifetime')
  owner.subscribe(changed, 'workspace_settings', changed, ['late'], () => {})
  assert.equal(f.calls.length, 2)
  secondCleanup()
  assert.equal(f.watchers.size, 0)
})

test('retirement before the first effect blocks old owners but not a new ordinary owner', async () => {
  const f = fixture(), preparation = new PreparedLiveChannels(f.runtime, { workspaceId: selected })
  const owner = new LiveChannelOwner(f.runtime, new Map(), preparation)
  preparation.retire()
  assert.equal(f.calls[0].signal.aborted, true)
  const oldCleanup = owner.mount()
  owner.subscribe(selected, 'workspace_settings', selected, ['late'], () => {})
  assert.equal(f.calls.length, 1)
  const freshOwner = new LiveChannelOwner(f.runtime, new Map()), cleanup = freshOwner.mount()
  freshOwner.subscribe(selected, 'workspace_settings', selected, ['current'], () => {})
  await f.open()
  assert.equal(f.calls.length, 2)
  assert.equal(freshOwner.keyConnected('current'), true)
  oldCleanup(); cleanup()
})

test('an authority retirement aborts an unfinished ticket and its result cannot revive a socket', async () => {
  const f = fixture(); f.mode('deferred')
  const preparation = new PreparedLiveChannels(f.runtime, { workspaceId: selected })
  const owner = new LiveChannelOwner(f.runtime, new Map(), preparation), unmount = owner.mount()
  owner.subscribe(selected, 'workspace_settings', selected, ['key'], () => {})
  preparation.retire()
  f.resolveTicket(); await settle()
  assert.equal(f.calls[0].signal.aborted, true)
  assert.equal(f.sockets.length, 0)
  owner.subscribe(changed, 'workspace_settings', changed, ['late'], () => {})
  assert.equal(f.calls.length, 1)
  unmount()
})

for (const failure of ['null', 'reject'] as const) test('a failed empty preparation does not retry on timers or repeated visible events: ' + failure, async () => {
  const f = fixture(); f.mode(failure)
  const channel = new LiveChannel(f.runtime(selected)), release = channel.retain()
  await settle()
  assert.equal(f.calls.length, 1)
  assert.equal(f.timers.size, 0)
  for (let i = 0; i < 3; i++) f.visibility(true)
  await f.advance(180_000)
  assert.equal(f.calls.length, 1)
  f.mode('ok')
  const stop = channel.subscribe('workspace_settings', selected, ['settings'], () => {})
  await f.open()
  assert.equal(f.calls.length, 2)
  assert.equal(channel.keyConnected('settings'), true)
  stop(); release()
  assert.equal(f.watchers.size, 0)
})

test('an empty prepared connection expires without a renewal loop; a real subscriber can reconnect', async () => {
  const f = fixture(); f.lifetime(100)
  const channel = new LiveChannel(f.runtime(selected)), release = channel.retain(), old = await f.open()
  await f.advance(100)
  assert.equal(old.readyState, 3)
  assert.equal(f.calls.length, 1)
  assert.equal(f.timers.size, 0)
  f.visibility(true); await f.advance(180_000)
  assert.equal(f.calls.length, 1)
  const stop = channel.subscribe('workspace_settings', selected, ['settings'], () => {})
  await f.open()
  assert.equal(f.calls.length, 2)
  stop(); release()
})

test('the last real subscriber cancels its scheduled retry while a preparation remains', async () => {
  const f = fixture(), channel = new LiveChannel(f.runtime(selected)), release = channel.retain()
  const socket = await f.open(), stop = channel.subscribe('workspace_settings', selected, ['settings'], () => {})
  await f.advance(0)
  socket.fail()
  assert.ok(f.timers.size > 0)
  stop()
  await f.advance(180_000)
  assert.equal(f.calls.length, 1)
  assert.equal(f.timers.size, 0)
  f.visibility(true); await settle()
  assert.equal(f.calls.length, 1)
  release()
})

test('a hidden preparation waits for a real subscriber instead of creating an idle visibility retry', async () => {
  const f = fixture(); f.visibility(false)
  const channel = new LiveChannel(f.runtime(selected)), release = channel.retain()
  assert.equal(f.calls.length, 0)
  f.visibility(true); await settle()
  assert.equal(f.calls.length, 0)
  const stop = channel.subscribe('workspace_settings', selected, ['settings'], () => {})
  await f.open()
  assert.equal(f.calls.length, 1)
  stop(); release()
})

test('a release from a disposed registry entry cannot remove its same-scope replacement', async () => {
  const f = fixture(), channels = new LiveChannels(f.runtime)
  const oldRelease = channels.retain(selected), old = await f.open()
  channels.dispose()
  assert.equal(old.readyState, 3)
  const newRelease = channels.retain(selected), fresh = await f.open()
  oldRelease(); oldRelease()
  const stop = channels.subscribe(selected, 'workspace_settings', selected, ['settings'], () => {})
  assert.equal(f.calls.length, 2)
  assert.equal(channels.keyConnected('settings'), true)
  assert.equal(fresh.readyState, 1)
  newRelease(); stop()
  assert.equal(f.watchers.size, 0)
  assert.equal(f.timers.size, 0)
})

test('malformed and nil routing hints never request a ticket or attach a visibility watcher', async () => {
  for (const value of ['', 'wrong', '00000000-0000-0000-0000-000000000000']) {
    const f = fixture(), preparation = new PreparedLiveChannels(f.runtime, { workspaceId: value, homeWorkspaceId: value })
    await settle()
    assert.equal(f.calls.length, 0)
    assert.equal(f.watchers.size, 0)
    preparation.retire()
  }
})
