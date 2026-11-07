import assert from 'node:assert/strict'
import test from 'node:test'
import { runOrdinaryStop } from './coordinator-ordinary-stop.mjs'
import { runToolStop } from './coordinator-tool-stop.mjs'
import { barrier, stoppedCompletion, stoppedSession } from './stop-fixture-support.mjs'
import { PRIVATE } from './fixture-support.mjs'

globalThis.fetch = () => { throw new Error('network_forbidden') }

for (const kind of ['ordinary', 'tool']) test(kind + ' Stop observes committed persistence and lease idle without requiring EOF', { timeout: 3000 }, async () => {
  const f = stoppedSession({ kind, releaseDuringRead: true })
  const report = await (kind === 'ordinary' ? runOrdinaryStop : runToolStop)(f.options)
  assert.equal(report.status, 'observed', JSON.stringify(report))
  assert.equal(report.stop.acknowledged, true)
  assert.equal(report.termination ?? report.stop.termination, 'client_cancel_after_stopped_committed_idle')
  assert.equal(report.streamEof, false); assert.equal(f.state.eof, false); assert.equal(f.state.clientCancelled, true)
  assert.equal(report.committed?.id, 'wrun_fixture1:0'); assert.equal(report.committed?.through, 2)
  assert.equal(report.initialCursor, 0); assert.equal(report.afterStop.stoppedPosition, 2)
  assert.equal(report.afterStop.cursor, 2); assert.equal(report.afterStop.committedPersisted, true)
  assert.equal(report.afterStop.stoppedMarker, true); assert.equal(report.afterStop.working, false); assert.equal(report.afterStop.activeStream, false)
  assert.equal(report.completionChatReads, 2); assert.equal(report.cleanupChatReads, 0)
  assert.deepEqual(report.chatReads.map(row => row.trigger), ['committed', 'live_revision'])
  assert.equal(f.state.sends, 1); assert.equal(f.state.stops, 1); assert.equal(f.state.signouts, 1)
  assert.equal(f.state.liveClosed, true); assert.equal(f.listeners.size, 0)
  assert.equal(JSON.stringify(report).includes(PRIVATE), false)
})

test('each driver still requires this invocation Stop ACK and its own new persisted stopped marker', async () => {
  for (const kind of ['ordinary', 'tool']) for (const options of [{ stopAcknowledged: false }, { stoppedMarker: false }]) {
    const f = stoppedSession({ kind, ...options })
    const report = await (kind === 'ordinary' ? runOrdinaryStop : runToolStop)(f.options)
    assert.equal(report.status, 'failed', JSON.stringify(report))
    assert.equal(report.error, options.stoppedMarker === false ? 'reply_not_persisted' : kind === 'ordinary' ? 'stop_boundary_missed' : 'stop_not_acknowledged')
    assert.equal(f.state.stops, 1); assert.equal(f.state.sends, 1); assert.equal(f.state.signouts, 1)
    assert.equal(f.listeners.size, 0); assert.equal(f.state.liveClosed, true)
    assert.equal(JSON.stringify(report).includes(PRIVATE), false)
  }
})

test('an initial stopped prefix and replayed committed cannot supply this Stop or a first-text boundary', { timeout: 1000 }, async () => {
  const f = stoppedCompletion(), initial = f.chat([{ index: 0, through: 12 }]); let reads = 0, events = 0
  const pending = f.observe(async () => { reads++; return initial }, initial, () => { events++ })
  f.round(0, 12); f.eof()
  await assert.rejects(pending, /stream_incomplete/)
  assert.equal(reads, 0); assert.equal(events, 0); assert.equal(f.subscriptions, 0)
})

test('a proved old stopped prefix is excluded when a distinct new round commits a new stopped marker', { timeout: 1000 }, async () => {
  const f = stoppedCompletion(), observed = [], initial = f.chat([{ index: 0, through: 12 }])
  const pending = f.observe(async () => f.chat([{ index: 0, through: 12 }, { index: 1, through: 14 }]), initial,
    event => observed.push(event.id))
  f.push(11); f.round(0, 12); f.round(1, 14)
  const result = await pending
  assert.deepEqual(result.replayedRounds, [{ id: 'wrun_stopped:0', through: 12 }])
  assert.equal(result.committed.id, 'wrun_stopped:1'); assert.equal(result.committed.through, 14)
  assert.deepEqual(observed, ['wrun_stopped:1', 'wrun_stopped:1'])
  assert.equal(result.termination, 'client_cancel_after_stopped_committed_idle'); assert.equal(f.cancelled, 1); assert.equal(f.subscriptions, 0)
})

test('Stop completion rejects quiet, old position, wrong stream, chat failure and another new round', { timeout: 1000 }, async () => {
  for (const [change, frames, expected] of [
    [chat => chat, { quiet: true }, 'committed_invalid'],
    [chat => ({ ...chat, cursor: 11 }), {}, 'reply_not_persisted'],
    [chat => ({ ...chat, items: chat.items.map(item => ({ ...item, position: 10 })) }), {}, 'reply_not_persisted'],
    [chat => ({ ...chat, items: chat.items.map(item => ({ ...item, streamId: 'wrun_other:0' })) }), {}, 'reply_not_persisted'],
    [chat => ({ ...chat, error: PRIVATE }), {}, 'chat_completion_error'],
    [chat => ({ ...chat, items: chat.items.map(item => ({ ...item, failure: { code: PRIVATE } })) }), {}, 'reply_failed_or_stopped'],
  ]) {
    const f = stoppedCompletion(), pending = f.observe(async () => change(f.chat([{ index: 0, through: 12 }])))
    f.round(0, 12, frames); await assert.rejects(pending, new RegExp(expected)); assert.equal(f.subscriptions, 0)
  }
  const f = stoppedCompletion(), pending = f.observe(async () => f.chat([{ index: 0, through: 12 }, { index: 1, through: 14 }]))
  f.round(0, 12); f.round(1, 14); await assert.rejects(pending, /stream_turn_mismatch/); assert.equal(f.subscriptions, 0)
})

test('a true decoder error in delayed reader cancellation survives a concurrent persisted stopped idle result', { timeout: 1000 }, async () => {
  const cancelling = barrier(), releaseCancel = barrier(), releaseRead = barrier()
  const f = stoppedCompletion({ cancelDelay: () => { cancelling.resolve(); return releaseCancel.promise } })
  const pending = f.observe(async () => { await releaseRead.promise; return f.chat([{ index: 0, through: 12 }]) })
  f.round(); f.emit([{ type: 'error' }]); await cancelling.promise
  releaseRead.resolve(); await Promise.resolve(); releaseCancel.resolve()
  await assert.rejects(pending, /stream_error/); assert.equal(f.subscriptions, 0)
})


// Recovery regression: preserve the real driver/decoder and vary only offline I/O.
function withOrdinaryFrames(f, { persistedText, beforeCommitted = [] } = {}) {
  return { ...f.options, sessionProvider: (work, options) => f.provider(session => work({ ...session,
    async request(path, input = {}) {
      const response = await session.request(path, input)
      if (path.startsWith('/api/coordinator/stream')) {
        let buffered = '', sequence = 0
        const decoder = new TextDecoder(), encoder = new TextEncoder()
        return new Response(response.body.pipeThrough(new TransformStream({
          transform(chunk, controller) {
            buffered += decoder.decode(chunk, { stream: true })
            let newline
            while ((newline = buffered.indexOf('\n')) !== -1) {
              const line = buffered.slice(0, newline); buffered = buffered.slice(newline + 1)
              if (!line.trim()) continue
              const frame = JSON.parse(line)
              const frames = frame.type === 'committed'
                ? [...beforeCommitted.map(event => ({ ...event, id: frame.id })), frame] : [frame]
              for (const event of frames) controller.enqueue(encoder.encode(JSON.stringify({ ...event, sequence: ++sequence }) + '\n'))
            }
          },
        })), { status: response.status, headers: response.headers })
      }
      if (persistedText !== undefined && input.body?.action === 'coordinator.syncCoordinatorChat' && f.state.sends) {
        const value = await response.json()
        for (const item of value.result.chat.items) item.text = persistedText
        return Response.json(value)
      }
      return response
    },
  }), options) }
}

test('ordinary Stop compares the final visible stream with its own persisted stopped reply without logging text', async () => {
  const f = stoppedSession({ kind: 'ordinary', releaseDuringRead: true })
  const report = await runOrdinaryStop(withOrdinaryFrames(f, { persistedText: '42 tail',
    beforeCommitted: [{ type: 'text', delta: ' tail' }] }))
  assert.equal(report.status, 'observed', JSON.stringify(report))
  assert.equal(report.textConsistency.matches, true)
  assert.equal(report.textConsistency.liveCharacters, 7)
  assert.equal(report.textConsistency.persistedCharacters, 7)
  assert.equal(report.streamEvents.textCharactersAfterStop, 5)
  assert.equal(f.state.stops, 1); assert.equal(f.state.clientCancelled, true)
  assert.equal(report.cleanup.status, 'complete'); assert.equal(f.state.signouts, 1)
  assert.equal(JSON.stringify(report).includes('42 tail'), false)
})

test('ordinary Stop retains a failed slot when persisted stopped text differs from the visible stream', async () => {
  const f = stoppedSession({ kind: 'ordinary' })
  const report = await runOrdinaryStop(withOrdinaryFrames(f, { persistedText: PRIVATE }))
  assert.equal(report.status, 'failed')
  assert.equal(report.error, 'stopped_text_mismatch')
  assert.equal(report.textConsistency.matches, false)
  assert.equal(f.state.stops, 1); assert.equal(f.state.signouts, 1)
  assert.equal(report.cleanup.status, 'complete'); assert.equal(f.state.clientCancelled, true)
  assert.equal(JSON.stringify(report).includes(PRIVATE), false)
})

test('ordinary Stop uses reset replacement when comparing persisted text', async () => {
  const f = stoppedSession({ kind: 'ordinary' })
  const report = await runOrdinaryStop(withOrdinaryFrames(f, { persistedText: 'final',
    beforeCommitted: [{ type: 'reset', text: 'final' }] }))
  assert.equal(report.status, 'observed', JSON.stringify(report))
  assert.equal(report.textConsistency.matches, true)
  assert.equal(report.textConsistency.liveCharacters, 5)
  assert.equal(report.textConsistency.persistedCharacters, 5)
  assert.equal(f.state.stops, 1); assert.equal(f.state.clientCancelled, true)
})
