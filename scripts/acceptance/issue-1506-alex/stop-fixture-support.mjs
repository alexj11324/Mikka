// Offline-only durable-stream fixture. No production entry point imports this file.
import assert from 'node:assert/strict'
import { fakeSession, BOT_IDS, PRIVATE } from './fixture-support.mjs'
import { observeStoppedCompletion } from './coordinator-cache-completion.mjs'

export const barrier = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }

export function stoppedCompletion({ cancelDelay } = {}) {
  const botId = BOT_IDS[0], runId = 'wrun_stopped', key = 'bot_chat:' + botId
  const abort = new AbortController(), subscribers = new Set()
  let latest = 10, controller, sequence = 0, cancelled = 0
  const body = new ReadableStream({ start(value) { controller = value }, cancel() { cancelled++; return cancelDelay?.() } })
  const chat = (rounds = [], extra = {}) => ({ botId, enabled: true, working: false, error: null,
    cursor: rounds.at(-1)?.through ?? 10, persistedStreamIds: rounds.map(round => runId + ':' + round.index),
    items: rounds.map(round => ({ from: 'coordinator', streamId: runId + ':' + round.index, position: round.through, stopped: true, text: '' })),
    live: { ownerId: 'offline-owner', workspaceId: '99999999-9999-4999-8999-999999999999', revisions: { [key]: latest } }, ...extra })
  const live = { get revision() { return latest }, subscribe(change, error) {
    const listener = { change, error }; subscribers.add(listener); return () => subscribers.delete(listener)
  } }
  const emit = frames => controller.enqueue(new TextEncoder().encode(frames.map(frame => JSON.stringify({ ...frame, sequence: ++sequence })).join('\n') + '\n'))
  const round = (index = 0, through = 12, extra = {}) => emit([
    { type: 'start', id: runId + ':' + index },
    { type: 'committed', id: runId + ':' + index, through, quiet: false, ...extra },
  ])
  return { chat, round, emit, abort, get cancelled() { return cancelled }, get subscriptions() { return subscribers.size },
    push(rev) { if (rev > latest) { latest = rev; for (const listener of subscribers) listener.change() } },
    eof() { controller.close() },
    observe(readChat, initialChat = chat(), onEvent = () => {}) {
      return observeStoppedCompletion({ body, runId, botId, initialChat, live, signal: abort.signal, readChat, onEvent })
    } }
}

export function stoppedSession({ kind = 'ordinary', releaseDuringRead = false,
  stoppedMarker = true, stopAcknowledged = true, publicError = false, oldPrefixOnly = false } = {}) {
  const f = fakeSession({ readyBots: true, noEof: true })
  const listeners = new Set(), encoder = new TextEncoder()
  let controller, nextSequence = 0, latest = 10, active = false, committed = false, released = false
  const run = 'wrun_fixture1', streamId = run + ':0'
  const summary = { ready: true, revisionCapable: true, baselineRevision: 10, matchingPushes: 0,
    versionedPushes: 0, newerPushes: 0, maxRevision: 10, closed: false }
  const push = value => {
    if (value <= latest) return
    latest = value; summary.maxRevision = value; summary.matchingPushes++; summary.versionedPushes++; summary.newerPushes++
    for (const listener of [...listeners]) listener.change()
  }
  const emit = event => controller.enqueue(encoder.encode(JSON.stringify({ ...event, sequence: ++nextSequence }) + '\n'))
  const openLive = async () => ({ summary, get revision() { return latest }, begin() {},
    subscribe(change, error) { const listener = { change, error }; listeners.add(listener); return () => listeners.delete(listener) },
    async close() { listeners.clear(); summary.closed = true; f.state.liveClosed = true; return true } })
  const provider = (work, options) => f.provider(session => work({ ...session,
    async request(path, input = {}) {
      if (path.startsWith('/api/coordinator/stream')) {
        const original = await session.request(path, input)
        await original.body.cancel(); f.state.clientCancelled = false
        return new Response(new ReadableStream({ start(value) {
          controller = value
          emit({ type: 'start', id: streamId })
          if (kind === 'tool') emit({ type: 'tool', id: streamId, name: 'web_search', call: PRIVATE, state: 'running', input: PRIVATE })
          else emit({ type: 'text', id: streamId, delta: '42' })
          if (oldPrefixOnly) { emit({ type: 'committed', id: streamId, through: 2, quiet: false }); controller.close(); f.state.eof = true }
        }, cancel() { f.state.clientCancelled = true } }), { headers: original.headers })
      }
      const response = await session.request(path, input)
      if (input.body?.action === 'coordinator.stopCoordinatorTurn') {
        assert.equal(f.state.stops, 1, 'only one Stop attempt for this sample')
        if (!oldPrefixOnly && controller && !committed) {
          active = releaseDuringRead; committed = true
          emit({ type: 'committed', id: streamId, through: 2, quiet: false })
          if (publicError) emit({ type: 'error' })
          push(11)
        }
        return Response.json({ ok: true, result: { stopped: stopAcknowledged } })
      }
      if (input.body?.action !== 'coordinator.syncCoordinatorChat') return response
      const value = await response.json(), chat = value.result.chat
      chat.live.revisions['bot_chat:' + input.body.args[0]] = latest
      if (!f.state.sends && oldPrefixOnly) {
        chat.cursor = 2; chat.persistedStreamIds = [streamId]
        chat.items = [{ streamId, position: 2, from: 'coordinator', stopped: true, text: 'old reply' }]
      }
      if (f.state.sends) {
        chat.working = active
        if (active) chat.streamRunId = run
        else delete chat.streamRunId
        for (const item of chat.items) item.stopped = stoppedMarker
        if (active && !released) {
          released = true
          // A real-shaped matching revision is delivered during the first busy
          // RPC's resolution, before completion can install a new event wait.
          queueMicrotask(() => { active = false; push(12) })
        }
      }
      return Response.json(value)
    },
  }), options)
  return { ...f, provider, openLive, listeners,
    options: { ...f.options, sessionProvider: provider, openLive, streamTimeoutMs: 1000, stopTimeoutMs: 100,
      env: { ...f.options.env, MIKKA_STOP_CASE: 'before_tool' } } }
}
