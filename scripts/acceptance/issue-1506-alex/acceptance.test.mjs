import assert from 'node:assert/strict'
import test from 'node:test'
import { setupWorkspace, validateWorkspaceReceipt } from './workspace-setup.mjs'
import { runFixtureSetup, validateFixtureReceipt } from './coordinator-fixtures.mjs'
import { runBaseline } from './coordinator-baseline.mjs'
import { runOrdinaryStop } from './coordinator-ordinary-stop.mjs'
import { stoppedSession } from './stop-fixture-support.mjs'
import { runCacheTurns } from './coordinator-cache-turns.mjs'
import { runToolStop } from './coordinator-tool-stop.mjs'
import { observeCacheCompletion, openCacheLive } from './coordinator-cache-completion.mjs'
import { fakeSession, fixtureReceipt, workspaceReceipt, PRIVATE, SHA, BOT_IDS } from './fixture-support.mjs'

globalThis.fetch = () => { throw new Error('network_forbidden') }

test('workspace setup creates only a new owned single-member team and shares existing resources without model calls', async () => {
  const f = fakeSession({ readyWorkspace: false })
  const report = await setupWorkspace({ env: f.options.env, sessionProvider: f.provider, checkpoint: false })
  assert.equal(report.status, 'ready', JSON.stringify(report)); assert.equal(f.state.creates, 1)
  assert.equal(f.state.subWrites, 1); assert.equal(f.state.creditWrites, 1); assert.equal(f.state.sends, 0)
  assert.equal(report.balanceWrites, 0); assert.equal(report.shares.allowOthers, false); assert.equal(report.signedOut, true)
  assert.equal(JSON.stringify(report).includes(PRIVATE), false)
  assert.equal(validateWorkspaceReceipt(report), report)
})

test('a lost workspace create acknowledgement is discovered once, never created twice', async () => {
  const f = fakeSession({ readyWorkspace: false, lostWorkspaceAck: true })
  const report = await setupWorkspace({ env: f.options.env, sessionProvider: f.provider, checkpoint: false })
  assert.equal(report.status, 'ready'); assert.equal(f.state.creates, 1)
  assert.equal(report.creationOutcome, 'recovered_after_unknown_no_retry')
})

test('workspace extra members or an incorrect account cannot acquire test shares', async () => {
  for (const flags of [{ extraMember: true }, { wrongOwner: true }]) {
    const f = fakeSession(flags)
    const report = await setupWorkspace({ env: f.options.env, sessionProvider: f.provider, checkpoint: false })
    assert.equal(report.status, 'failed'); assert.equal(f.state.subWrites, 0); assert.equal(f.state.creditWrites, 0)
    assert.equal(f.state.sends, 0); assert.equal(f.state.signouts, 1)
  }
})

test('exactly two new bots receive independent owned Haiku and Luna menu choices', async () => {
  const f = fakeSession()
  const report = await runFixtureSetup({ env: f.options.env, workspaceReceipt: workspaceReceipt(), sessionProvider: f.provider, checkpoint: false })
  assert.equal(report.status, 'ready', JSON.stringify(report)); assert.equal(f.state.botCreates, 2); assert.equal(f.state.choices, 2)
  assert.deepEqual(report.fixtures.map(row => row.model), ['claude-haiku-5-5', 'gpt-6-luna'])
  assert.equal(new Set(report.fixtures.map(row => row.botId)).size, 2); assert.equal(f.state.sends, 0)
  assert.equal(f.state.subWrites, 0); assert.equal(f.state.creditWrites, 0)
  assert.equal(JSON.stringify(report).includes(PRIVATE), false)
  validateFixtureReceipt(report, { ready: true })
})

test('lost bot and selection acknowledgements use discovery, with no repeated writes', async () => {
  const f = fakeSession({ lostBotAck: true, lostSelectionAck: true })
  const report = await runFixtureSetup({ env: f.options.env, workspaceReceipt: workspaceReceipt(), sessionProvider: f.provider, checkpoint: false })
  assert.equal(report.status, 'ready', JSON.stringify(report)); assert.equal(f.state.botCreates, 2); assert.equal(f.state.choices, 2)
  assert.equal(report.fixtures.every(row => row.creationOutcome === 'recovered_after_unknown'), true)
})

test('all message drivers reject owner, membership, bot ownership, fallback and a busy chat without sending', async () => {
  for (const driver of [runBaseline, runOrdinaryStop, runCacheTurns, runToolStop]) for (const flags of [
    { wrongOwner: true }, { extraMember: true }, { wrongBotOwner: true }, { fallback: true }, { busy: true },
  ]) {
    const f = fakeSession({ readyBots: true, ...flags })
    const report = await driver(f.options)
    assert.equal(report.status, 'failed'); assert.equal(f.state.sends, 0); assert.equal(f.state.stops, 0)
    assert.equal(f.state.signouts, 1)
  }
})

for (const key of ['haiku', 'luna']) test(key + ' model-stream baseline keeps the selected fixture and stops once at first text', async () => {
  const f = fakeSession({ readyBots: true })
  const report = await runBaseline({ ...f.options, env: { ...f.options.env, MIKKA_FIXTURE_KIND: key } })
  assert.equal(report.status, 'observed', JSON.stringify(report)); assert.equal(report.fixture.key, key)
  assert.equal(f.state.sends, 1); assert.equal(f.state.stops, 1); assert.equal(report.postStopChatReads, 1)
  assert.equal(report.menu.chosen, true); assert.equal(report.menu.listedAsOwnOption, true)
  assert.equal(report.runtimeEvidence.confirmed, false); assert.equal(JSON.stringify(report).includes(PRIVATE), false)
})

test('complete cache turns cancel a durable stream only after committed persistence and authoritative idle', async () => {
  const f = fakeSession({ readyBots: true, stream: 'complete', noEof: true })
  const report = await runCacheTurns({ ...f.options, env: { ...f.options.env, MIKKA_CACHE_TURNS: '3' } })
  assert.equal(report.status, 'observed', JSON.stringify(report)); assert.equal(f.state.sends, 3); assert.equal(f.state.stops, 0)
  assert.equal(report.turns.every(row => row.termination === 'client_cancel_after_committed_idle' && row.committedObserved && row.postTurnChatReads === 1), true)
  assert.equal(report.turns.every(row => row.committed?.id === row.workflowRunId + ':0' && row.committed.through > 0 && row.confirmedIdle), true)
  assert.equal(f.state.clientCancelled, true)
  assert.equal(report.runtimeEvidence.cacheReadTokens, 'not_observed'); assert.equal(f.state.syncs, 4)
  assert.equal(JSON.stringify(report).includes(PRIVATE), false)
})

test('cache timeout or lost send acknowledgement cannot repeat a message and uses one scoped stop', async () => {
  for (const flags of [{ stream: 'text', noEof: true }, { sendLost: true }]) {
    const f = fakeSession({ readyBots: true, ...flags })
    const report = await runCacheTurns(f.options)
    assert.equal(report.status, 'failed'); assert.equal(f.state.sends, 1); assert.equal(f.state.stops, 1)
    assert.equal(report.turns[0].postTurnChatReads, 0); assert.equal(report.turns[0].cleanupChatReads, 1); assert.equal(f.state.signouts, 1)
  }
})

const barrier = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
function completionFixture({ cancelDelay } = {}) {
  const botId = BOT_IDS[0], runId = 'wrun_completion', key = 'bot_chat:' + botId
  const abort = new AbortController(), subscribers = new Set()
  let socketRevision = 10, controller, sequence = 0, cancelled = 0
  const body = new ReadableStream({ start(value) { controller = value }, cancel() { cancelled++; return cancelDelay?.() } })
  const chat = (rounds = [], { rev = socketRevision, active = false, ...extra } = {}) => ({
    botId, enabled: true, working: active, error: null, ...(active ? { streamRunId: runId } : {}),
    cursor: rounds.at(-1)?.through ?? 10, persistedStreamIds: rounds.map(round => `${runId}:${round.index}`),
    items: rounds.map(round => ({ from: 'coordinator', streamId: `${runId}:${round.index}`, position: round.through, text: '42' })),
    live: { ownerId: 'offline-owner', workspaceId: '99999999-9999-4999-8999-999999999999', revisions: { [key]: rev } }, ...extra,
  })
  const live = { get revision() { return socketRevision }, subscribe(change, error) {
    const listener = { change, error }; subscribers.add(listener); return () => subscribers.delete(listener)
  } }
  const emit = frames => controller.enqueue(new TextEncoder().encode(frames.map(frame => JSON.stringify({ ...frame, sequence: ++sequence })).join('\n') + '\n'))
  const round = (index = 0, through = 12, extra = {}) => emit([
    { type: 'start', id: `${runId}:${index}` }, { type: 'text', id: `${runId}:${index}`, delta: '42' },
    { type: 'committed', id: `${runId}:${index}`, through, quiet: false, ...extra },
  ])
  return { chat, round, emit, abort, get cancelled() { return cancelled }, get subscriptions() { return subscribers.size },
    push(rev) { if (rev > socketRevision) { socketRevision = rev; for (const item of subscribers) item.change() } },
    lose() { for (const item of subscribers) item.error(new Error('live_connection_failed')) },
    eof() { controller.close() },
    observe(readChat, onRead = () => {}, initialChat = chat(), onEvent = () => {}) { return observeCacheCompletion({ body, runId, botId, initialChat, live, signal: abort.signal, readChat, onRead, onEvent }) },
  }
}

test('cache completion retains a release revision that arrives before committed', { timeout: 1000 }, async () => {
  const f = completionFixture(); let reads = 0
  const pending = f.observe(async () => { reads++; return f.chat([{ index: 0, through: 12 }]) })
  f.push(12); f.round()
  const result = await pending
  assert.equal(reads, 1); assert.equal(result.termination, 'client_cancel_after_committed_idle')
  assert.deepEqual(result.committed, { id: 'wrun_completion:0', through: 12, quiet: false })
  assert.equal(f.cancelled, 1); assert.equal(f.subscriptions, 0)
})

test('cache completion coalesces but never loses a newer release key during an in-flight busy read', { timeout: 1000 }, async () => {
  const f = completionFixture(), began = barrier(), release = barrier(); let reads = 0
  const evidence = []
  const pending = f.observe(async () => {
    if (++reads === 1) { began.resolve(); await release.promise; return f.chat([{ index: 0, through: 12 }], { active: true, rev: 11 }) }
    return f.chat([{ index: 0, through: 12 }], { rev: 12 })
  }, row => evidence.push(row))
  f.push(11); f.round(); await began.promise
  f.push(12); f.push(12); release.resolve()
  const result = await pending
  assert.equal(reads, 2); assert.deepEqual(evidence.map(row => row.trigger), ['committed', 'live_revision'])
  assert.deepEqual(evidence.map(row => row.requiredRevision), [11, 12])
  assert.equal(result.chat.streamRunId, undefined); assert.equal(f.cancelled, 1); assert.equal(f.subscriptions, 0)
})

test('an idle snapshot containing a later durable round cannot complete an earlier committed frame', { timeout: 1000 }, async () => {
  const f = completionFixture(), firstRead = barrier(); let reads = 0, settled = false
  const pending = f.observe(async () => { reads++; return f.chat([{ index: 0, through: 12 }, { index: 1, through: 14 }]) }, () => firstRead.resolve())
  void pending.then(() => { settled = true })
  f.round(); await firstRead.promise; await Promise.resolve()
  assert.equal(settled, false); assert.equal(f.cancelled, 0)
  f.round(1, 14)
  const result = await pending
  assert.equal(reads, 2); assert.equal(result.rounds.length, 2); assert.equal(result.committed.id, 'wrun_completion:1')
  assert.equal(f.cancelled, 1); assert.equal(f.subscriptions, 0)
})

test('cache completion rejects quiet, stale cursor, missing persistence, public failure and stopped replies', { timeout: 1000 }, async () => {
  for (const [change, frames, expected] of [
    [chat => chat, { quiet: true }, 'committed_invalid'],
    [chat => ({ ...chat, cursor: 11 }), {}, 'reply_not_persisted'],
    [chat => ({ ...chat, persistedStreamIds: [] }), {}, 'reply_not_persisted'],
    [chat => ({ ...chat, error: PRIVATE }), {}, 'chat_completion_error'],
    [chat => ({ ...chat, items: chat.items.map(item => ({ ...item, stopped: true })) }), {}, 'reply_failed_or_stopped'],
    [chat => ({ ...chat, items: chat.items.map(item => ({ ...item, failure: { code: PRIVATE } })) }), {}, 'reply_failed_or_stopped'],
    [chat => ({ ...chat, streamRunId: 'wrun_other' }), {}, 'stream_turn_mismatch'],
  ]) {
    const f = completionFixture(); const pending = f.observe(async () => change(f.chat([{ index: 0, through: 12 }])))
    f.round(0, 12, frames)
    await assert.rejects(pending, new RegExp(expected))
    assert.equal(f.cancelled, 1); assert.equal(f.subscriptions, 0)
  }
})

test('a live disconnect aborts a pending read and keeps its real failure; no success from an earlier commit', { timeout: 1000 }, async () => {
  const f = completionFixture(), reading = barrier(); let reads = 0
  const pending = f.observe(signal => { reads++; reading.resolve(); return new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new DOMException('offline fixture', 'AbortError')), { once: true })
  }) })
  f.round(); await reading.promise; f.lose()
  await assert.rejects(pending, /live_connection_failed/)
  assert.equal(reads, 1); assert.equal(f.cancelled, 1); assert.equal(f.subscriptions, 0)
})

test('a stream error following committed and an early EOF without committed both fail closed', { timeout: 1000 }, async () => {
  for (const afterCommit of [true, false]) {
    const f = completionFixture(); let reads = 0
    const pending = f.observe(async () => { reads++; return f.chat([{ index: 0, through: 12 }]) })
    if (afterCommit) { f.round(); f.emit([{ type: 'error' }]) } else f.eof()
    await assert.rejects(pending, afterCommit ? /stream_error/ : /stream_incomplete/)
    if (!afterCommit) assert.equal(reads, 0)
    assert.equal(f.subscriptions, 0)
  }
})

test('a decoder error already entering delayed reader cleanup cannot be swallowed by successful idle cancellation', { timeout: 1000 }, async () => {
  const cancelling = barrier(), releaseCancel = barrier(), releaseRead = barrier()
  const f = completionFixture({ cancelDelay: () => { cancelling.resolve(); return releaseCancel.promise } })
  const pending = f.observe(async () => { await releaseRead.promise; return f.chat([{ index: 0, through: 12 }]) })
  f.round(); f.emit([{ type: 'error' }]); await cancelling.promise
  releaseRead.resolve(); await Promise.resolve(); releaseCancel.resolve()
  await assert.rejects(pending, /stream_error/)
  assert.equal(f.subscriptions, 0)
})

test('same-run replay is verified against the initial persisted prefix and never counts as this message first text', { timeout: 1000 }, async () => {
  const f = completionFixture(), observed = []
  const initial = f.chat([{ index: 0, through: 12 }])
  const pending = f.observe(async () => f.chat([{ index: 0, through: 12 }, { index: 1, through: 14 }]), () => {}, initial,
    event => observed.push({ type: event.type, id: event.id }))
  f.round(0, 12); f.round(1, 14)
  const result = await pending
  assert.equal(result.rounds.length, 1); assert.equal(result.rounds[0].id, 'wrun_completion:1')
  assert.deepEqual(result.replayedRounds, [{ id: 'wrun_completion:0', through: 12 }])
  assert.equal(observed.length, 3); assert.equal(observed.every(event => event.id === 'wrun_completion:1'), true)
})

test('an old persisted prefix alone cannot supply a new reply, first text, or completion read', { timeout: 1000 }, async () => {
  const f = completionFixture(), initial = f.chat([{ index: 0, through: 12 }]); let reads = 0, events = 0
  const pending = f.observe(async () => { reads++; return initial }, () => {}, initial, () => { events++ })
  f.round(0, 12); f.eof()
  await assert.rejects(pending, /stream_incomplete/)
  assert.equal(reads, 0); assert.equal(events, 0); assert.equal(f.subscriptions, 0)
})

test('a version change after a completed turn prevents the next send without stopping an already-idle reply', async () => {
  const f = fakeSession({ readyBots: true, stream: 'complete', noEof: true })
  const provider = (work, options) => f.provider(session => work({ ...session, request(path, input) {
    if (path === '/api/version' && f.state.sends === 1) return Promise.resolve(Response.json({ build: 'b'.repeat(40) }))
    return session.request(path, input)
  } }), options)
  const report = await runCacheTurns({ ...f.options, sessionProvider: provider })
  assert.equal(report.status, 'failed'); assert.equal(report.error, 'acceptance_version_changed')
  assert.equal(f.state.sends, 1); assert.equal(f.state.stops, 0); assert.equal(f.state.signouts, 1)
})

test('cache live adapter taps one real-shaped socket and only matching newer scalar/batched revisions', { timeout: 1000 }, async () => {
  let socket, sockets = 0, tickets = 0, changes = 0
  class Socket extends EventTarget {
    readyState = 0
    constructor() { super(); socket = this; sockets++; queueMicrotask(() => {
      this.readyState = 1; this.dispatchEvent(new Event('open'))
      this.frame({ type: 'live_ready', version: 2, kinds: ['bot_chat'], revisions: ['bot_chat'] })
    }) }
    frame(data) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(data) })) }
    send(value) { assert.equal(value, 'ping') }
    close() { this.readyState = 3; this.dispatchEvent(new Event('close')) }
  }
  const initial = completionFixture().chat()
  const live = await openCacheLive({ identity: { userId: 'offline-owner' }, async request(path) {
    tickets++; assert.equal(path, '/api/live/ticket?workspace=' + initial.live.workspaceId)
    return Response.json({ url: 'wss://live.example/v1/live/' + 'a'.repeat(64) + '/socket', protocol: PRIVATE, expiresAt: Date.now() + 60_000 })
  } }, initial, { WebSocketClass: Socket })
  live.begin(performance.now()); const unsubscribe = live.subscribe(() => { changes++ }, () => assert.fail('unexpected disconnect'))
  socket.frame({ kind: 'bot_chat', id: BOT_IDS[1], rev: 500 })
  socket.frame({ kind: 'bot_chat', id: BOT_IDS[0], rev: 11 })
  socket.frame([{ kind: 'bot_chat', id: BOT_IDS[0], rev: 12 }, { kind: 'bot_chat', id: BOT_IDS[0], rev: 12 }])
  socket.frame({ kind: 'bot_chat', id: BOT_IDS[0], rev: 13, extra: PRIVATE })
  assert.equal(sockets, 1); assert.equal(tickets, 1); assert.equal(changes, 2); assert.equal(live.revision, 12)
  assert.equal(live.summary.matchingPushes, 3)
  unsubscribe(); assert.equal(await live.close(), true)
})

test('real-shaped tool-running frame triggers one stop but cannot claim execute-enter or before/during classification', async () => {
  const f = stoppedSession({ kind: 'tool' })
  const report = await runToolStop(f.options)
  assert.equal(report.status, 'observed', JSON.stringify(report)); assert.equal(f.state.sends, 1); assert.equal(f.state.stops, 1)
  assert.equal(report.runtimeBoundary.classification, 'unverified'); assert.equal(report.runtimeBoundary.executeEntered, 'not_observed')
  assert.equal(JSON.stringify(report).includes(PRIVATE), false)
})

test('independent cleanup only hides the two exact receipt bots and needs no current deployment match', async () => {
  const f = fakeSession({ readyBots: true })
  const report = await runFixtureSetup({ mode: 'cleanup', receipt: fixtureReceipt(), env: { MIKKA_ACCEPTANCE_SHA: 'b'.repeat(40) }, sessionProvider: f.provider, checkpoint: false })
  assert.equal(report.status, 'cleanup_complete', JSON.stringify(report)); assert.deepEqual(f.state.hidden, BOT_IDS)
  assert.equal(f.state.sends, 0); assert.equal(f.state.choices, 0); assert.equal(f.state.stops, 0)
  const malicious = fixtureReceipt(); malicious.workspace.id = '4ae2a643-b09e-43eb-816c-1e5557bef170'
  assert.throws(() => validateFixtureReceipt(malicious), /fixture_receipt_invalid/)
  assert.equal(SHA.length, 40)
})
