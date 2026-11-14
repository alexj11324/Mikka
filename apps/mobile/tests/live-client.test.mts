import assert from 'node:assert/strict'
import test from 'node:test'
import { createLiveClient, LIVE_FALLBACK_MS, pendingActionsDeadline, UNRESOLVED_LIVE_ID, validTicket, type AppStateLike } from '../lib/live-client.ts'
import { botPageLive, groupChatLive, listRef, tasksLive, threadLive, threadsLive } from '../lib/live-keys.ts'
import { LIVE_KINDS, type LiveKind } from '../../../lib/live/events.ts'

const home = '19df8afd-0f8c-4c6b-bc9c-20df0b046a72'
const team = 'e4ec7f73-0a59-4ad4-8b3c-41f8cd510c6d'
const bot = '6a1d9f07-3b7e-4c55-9d2f-0f8e3e6c1a42'
const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve() }

class Socket {
  onopen: ((event: unknown) => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: ((event: unknown) => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  readyState = 0
  closed = false
  constructor(readonly url: string, readonly protocol: string, private kinds: readonly LiveKind[]) {}
  open() { this.readyState = 1; this.onopen?.({}); this.message(JSON.stringify({ type: 'live_ready', version: 1, kinds: this.kinds })) }
  message(data: string) { this.onmessage?.({ data }) }
  drop() { this.readyState = 3; this.onclose?.({}) }
  send(data: string) { if (data === 'ping') this.message('pong') }
  close() { this.closed = true; this.readyState = 3 }
}

/** The app with a fake AppState, ticket route, gateway and clock. */
function app() {
  let now = 1_800_000_000_000, next = 0, ticketsAvailable = true
  let kinds: readonly LiveKind[] = LIVE_KINDS
  const timers = new Map<number, { at: number; callback: () => void }>()
  const listeners = new Set<(state: string) => void>()
  const appState: AppStateLike = { currentState: 'active', addEventListener: (_type, listener) => { listeners.add(listener); return { remove: () => { listeners.delete(listener) } } } }
  const sockets: Socket[] = [], tickets: string[] = []
  const client = createLiveClient({
    appState,
    ticket: async workspaceId => { tickets.push(workspaceId); return ticketsAvailable ? { url: `wss://gateway.test/v1/live/${workspaceId}/socket`, protocol: 'mikka.ticket', expiresAt: now + 3_600_000 } : null },
    socket: (url, protocol) => { const socket = new Socket(url, protocol, kinds); sockets.push(socket); return socket },
    now: () => now,
    later: (callback, milliseconds) => { const id = ++next; timers.set(id, { at: now + milliseconds, callback }); return id },
    cancel: timer => { timers.delete(timer as number) },
  })
  return {
    client, sockets, tickets, timers,
    kinds: (value: readonly LiveKind[]) => { kinds = value },
    tickets_: (value: boolean) => { ticketsAvailable = value },
    async state(value: string) { appState.currentState = value; for (const listener of [...listeners]) listener(value); await settle() },
    async advance(milliseconds: number) {
      const until = now + milliseconds
      for (;;) {
        const due = [...timers].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0]
        if (!due) break
        timers.delete(due[0]); now = due[1].at; due[1].callback(); await settle()
      }
      now = until; await settle()
    },
  }
}

const listen = (fixture: ReturnType<typeof app>, kind: LiveKind = 'thread_list', id = home, scope: string | null = home) => {
  const reads: number[] = []
  const stop = fixture.client.subscribe([{ kind, id, scope }], `key:${kind}:${id}`, () => { reads.push(Date.now()) })
  return { reads, stop }
}

test('a pushed key reads its screen once; nothing reads while connected and idle', async () => {
  const fixture = app()
  const { reads } = listen(fixture)
  await settle()
  assert.deepEqual(fixture.tickets, [home], 'the ticket names the channel the screen listens on')
  fixture.sockets[0].open()
  await fixture.advance(200)
  const afterOpen = reads.length
  assert.equal(afterOpen, 1, 'one catch-up read for changes committed while connecting')
  await fixture.advance(10 * 60_000)
  assert.equal(reads.length, afterOpen, 'connected and idle: no reads at all for ten minutes')
  fixture.sockets[0].message(JSON.stringify({ kind: 'thread_list', id: home }))
  fixture.sockets[0].message(JSON.stringify({ kind: 'thread_list', id: home }))
  await fixture.advance(200)
  assert.equal(reads.length, afterOpen + 1, 'a burst of the same key reads once')
  fixture.sockets[0].message(JSON.stringify({ kind: 'bot_chat', id: bot }))
  fixture.sockets[0].message(JSON.stringify({ kind: 'thread_list', id: team }))
  await fixture.advance(200)
  assert.equal(reads.length, afterOpen + 1, 'another key or another id reads nothing')
})

test('a dropped socket reconnects with growing backoff and reads once a minute only while it is down', async () => {
  const fixture = app()
  const { reads } = listen(fixture)
  await settle()
  fixture.sockets[0].open()
  await fixture.advance(200)
  const connectedReads = reads.length
  fixture.tickets_(true)
  fixture.sockets[0].drop()
  await fixture.advance(999)
  assert.equal(fixture.sockets.length, 1, 'waits before reconnecting')
  await fixture.advance(1)
  assert.equal(fixture.sockets.length, 2, 'first retry after 1 s')
  fixture.sockets[1].drop()
  await fixture.advance(1_999)
  assert.equal(fixture.sockets.length, 2)
  await fixture.advance(1)
  assert.equal(fixture.sockets.length, 3, 'second retry after 2 s')
  // Keep it down: refused tickets back off to the fallback cadence.
  fixture.tickets_(false)
  fixture.sockets[2].drop()
  const downAt = reads.length
  await fixture.advance(LIVE_FALLBACK_MS * 3)
  const fallbackReads = reads.length - downAt
  assert.ok(fallbackReads >= 2 && fallbackReads <= 3, `about one read a minute while disconnected, got ${fallbackReads}`)
  assert.ok(reads.length > connectedReads)
  fixture.tickets_(true)
  const count = fixture.sockets.length
  for (let waited = 0; fixture.sockets.length === count && waited < 2 * LIVE_FALLBACK_MS; waited += 1_000) await fixture.advance(1_000)
  assert.equal(fixture.sockets.length, count + 1, 'the next retry, at most a minute later, connects again')
  const socket = fixture.sockets.at(-1)!
  socket.open()
  await fixture.advance(200)
  const reconnected = reads.length
  await fixture.advance(LIVE_FALLBACK_MS * 5)
  assert.equal(reads.length, reconnected, 'reconnected: the minute fallback stops')
})

test('the background closes the socket and stops every timer; the foreground reads once and reconnects', async () => {
  const fixture = app()
  const { reads } = listen(fixture)
  await settle()
  fixture.sockets[0].open()
  await fixture.advance(200)
  const before = reads.length
  await fixture.state('inactive')
  assert.equal(fixture.sockets[0].closed, false, 'the brief inactive state of an app switch keeps the socket')
  await fixture.state('background')
  assert.equal(fixture.sockets[0].closed, true, 'no socket stays open in the background')
  assert.equal(fixture.timers.size, 0, 'no timer runs in the background (no fallback, no heartbeat)')
  await fixture.advance(30 * 60_000)
  assert.equal(reads.length, before, 'nothing reads in the background')
  await fixture.state('active')
  await fixture.advance(200)
  assert.equal(reads.length, before + 1, 'coming back reads once')
  assert.equal(fixture.sockets.length, 2, 'and reconnects')
  fixture.sockets[1].open()
  await fixture.advance(200)
  assert.ok(reads.length <= before + 2, 'at most one more read when the new socket opens')
})

test('a kind the deployed gateway does not list, or a key with no channel, keeps the minute fallback', async () => {
  const fixture = app()
  fixture.kinds(LIVE_KINDS.filter(kind => kind !== 'device_list'))
  const devices = listen(fixture, 'device_list')
  const threads = listen(fixture, 'thread_list')
  await settle()
  fixture.sockets[0].open()
  await fixture.advance(200)
  const [d, t] = [devices.reads.length, threads.reads.length]
  await fixture.advance(LIVE_FALLBACK_MS * 2)
  assert.equal(devices.reads.length - d, 2, 'unlisted kind: one read a minute')
  assert.equal(threads.reads.length, t, 'listed kind on the same socket: none')

  const unresolved = app()
  const fallback = listen(unresolved, 'thread_list', UNRESOLVED_LIVE_ID, null)
  await settle()
  assert.deepEqual(unresolved.tickets, [], 'no channel known: no ticket is asked for')
  await unresolved.advance(LIVE_FALLBACK_MS * 2 + 200)
  assert.equal(fallback.reads.length, 2)
  fallback.stop()
  await unresolved.advance(LIVE_FALLBACK_MS * 2)
  assert.equal(fallback.reads.length, 2, 'a stopped key reads nothing')
  assert.equal(unresolved.timers.size, 0)
})

test('reset closes every socket and tells mounted screens to subscribe again', async () => {
  const fixture = app()
  listen(fixture)
  await settle()
  fixture.sockets[0].open()
  let told = 0
  fixture.client.watch(() => { told++ })
  const generation = fixture.client.generation()
  fixture.client.reset()
  assert.equal(fixture.sockets[0].closed, true)
  assert.equal(told, 1)
  assert.equal(fixture.client.generation(), generation + 1)
})

test('only a well-formed ticket opens a socket', () => {
  assert.equal(validTicket(null), null)
  assert.equal(validTicket({ url: null, protocol: null, expiresAt: null }), null, 'a server with no gateway configured')
  assert.equal(validTicket({ url: 'https://gateway.test', protocol: 'p', expiresAt: 1 }), null)
  assert.ok(validTicket({ url: 'wss://gateway.test/v1/live/x/socket', protocol: 'p', expiresAt: 1 }))
})

test('screens listen to the keys the web uses, on the right channel', () => {
  assert.deepEqual(listRef('group_list', team), { kind: 'group_list', id: team, scope: team })
  assert.deepEqual(listRef('thread_list', null), { kind: 'thread_list', id: UNRESOLVED_LIVE_ID, scope: null })
  // 受阻 follows the person's runs too, on their home channel (lib/task-blocked.ts).
  assert.deepEqual(tasksLive(home, team).refs.map(ref => `${ref.kind}:${ref.id}`), [`issue_list:${team}`, `issue_list:${home}`, `task_run_list:${home}`])
  assert.deepEqual(tasksLive(home, home).refs.map(ref => `${ref.kind}:${ref.id}`), [`issue_list:${home}`, `task_run_list:${home}`], 'one issue key when the open workspace is the home')
  assert.deepEqual(tasksLive(home, team, [bot]).refs.at(-1), { kind: 'factory_issue', id: bot, scope: team })
  const offline = threadsLive({ threads: [], devices: [{ id: bot, name: 'Mac', kind: 'laptop', online: false }] }, home)
  assert.deepEqual(offline.refs.map(ref => `${ref.kind}:${ref.scope}`), [`thread_list:${home}`, `device_list:${home}`])
  assert.equal(offline.presence, undefined)
  const online = threadsLive({ threads: [], devices: [{ id: bot, name: 'Mac', kind: 'laptop', online: true }] }, home)
  assert.deepEqual(online.refs, offline.refs, 'presence metadata does not replace the home subscription')
  assert.equal(online.presence, null, 'an online machine keeps the channel\'s existing minute fallback until covered')
  assert.deepEqual(botPageLive(null, bot, home, team).refs, [
    { kind: 'thread_list', id: team, scope: team }, { kind: 'bot_chat', id: bot, scope: home }, { kind: 'bot_list', id: team, scope: team },
  ])
  const thread = threadLive({ live: { runs: [{ id: bot, workspaceId: team }] } } as never, bot)
  assert.deepEqual(thread.refs, [{ kind: 'thread', id: bot, scope: team }, { kind: 'run', id: bot, scope: team }])
  assert.deepEqual(groupChatLive(bot, team).refs, [{ kind: 'group_chat', id: bot, scope: team }], 'a group page listens on its workspace channel')
  assert.deepEqual(groupChatLive(bot, undefined).refs, [{ kind: 'group_chat', id: UNRESOLVED_LIVE_ID, scope: null }], 'an unknown workspace reads once a minute')
})

test('a short-lived proposal reads again when it expires', () => {
  const now = Date.parse('2026-11-05T10:00:00Z')
  assert.equal(pendingActionsDeadline([], now), null)
  const deadline = pendingActionsDeadline([
    { action: 'send_email', createdAt: '2026-11-05T09:59:00Z' },
    { action: 'browser_operation', createdAt: '2026-11-05T09:58:00Z' },
  ], now)
  assert.deepEqual(deadline, { at: '2026-11-05T10:03:00.000Z', afterMs: 180_000 })
})

test('new thread responses negotiate presence on the home refs rather than a permanent minute ref', () => {
  const proof = { token: `fixture.${'a'.repeat(64)}`, expiresAt: 1_800_000_300_000 }
  const read = { threads: [], devices: [{ id: bot, name: 'Fixture', kind: 'laptop', online: true }], live: { ownerId: 'owner', workspaceId: home, presence: proof } }
  const current = threadsLive(read as never, home, 'owner')
  assert.deepEqual(current.refs, [listRef('thread_list', home), listRef('device_list', home)])
  assert.deepEqual(current.presence, proof)
  assert.equal(threadsLive({ ...read, live: { ...read.live, presence: null } } as never, home, 'owner').presence, null)
  assert.equal(threadsLive(read as never, home, 'another-owner').presence, null)
  assert.equal(threadsLive(read as never, team, 'owner').presence, null)
})
