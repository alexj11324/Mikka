import assert from 'node:assert/strict'
import test from 'node:test'
import { runToolStop } from './coordinator-tool-stop.mjs'
import { fakeSession, PRIVATE } from './fixture-support.mjs'

globalThis.fetch = () => { throw new Error('network_forbidden') }

function naturalFixture({ busy = false, mutateChat, publicError = false } = {}) {
  const f = fakeSession({ readyBots: true, stream: 'complete', noEof: true, afterActive: busy })
  const options = { ...f.options, env: { ...f.options.env, MIKKA_STOP_CASE: 'before_tool' },
    streamTimeoutMs: 100, stopTimeoutMs: 100,
    sessionProvider: (work, sessionOptions) => f.provider(session => work({ ...session,
      async request(path, input = {}) {
        const response = await session.request(path, input)
        if (publicError && path.startsWith('/api/coordinator/stream')) {
          let buffered = ''
          const decoder = new TextDecoder(), encoder = new TextEncoder()
          return new Response(response.body.pipeThrough(new TransformStream({
            transform(chunk, controller) {
              buffered += decoder.decode(chunk, { stream: true })
              let newline
              while ((newline = buffered.indexOf('\n')) !== -1) {
                const line = buffered.slice(0, newline); buffered = buffered.slice(newline + 1)
                if (!line.trim()) continue
                const frame = JSON.parse(line)
                controller.enqueue(encoder.encode(line + '\n'))
                if (frame.type === 'committed') controller.enqueue(encoder.encode(JSON.stringify({ type: 'error', sequence: frame.sequence + 1 }) + '\n'))
              }
            },
          })), { status: response.status, headers: response.headers })
        }
        if (mutateChat && f.state.sends && input.body?.action === 'coordinator.syncCoordinatorChat') {
          const value = await response.json(); mutateChat(value.result.chat)
          return Response.json(value)
        }
        return response
      },
    }), sessionOptions) }
  return { ...f, options }
}

test('a normal no-tool committed reply remains a failed boundary sample and performs no redundant Stop after authoritative idle', async () => {
  const f = naturalFixture()
  const report = await runToolStop(f.options)
  assert.equal(report.status, 'failed')
  assert.equal(report.error, 'tool_boundary_not_observed')
  assert.equal(report.sample.classification, 'tool_boundary_not_observed')
  assert.equal(report.sample.countedEvenIfBoundaryMissed, true)
  assert.equal(report.messageSendAttempts, 1); assert.equal(report.publicRunningCallCount, 0)
  assert.equal(report.stop.requested, false); assert.equal(report.stop.acknowledged, false)
  assert.equal(f.state.stops, 0)
  assert.equal(report.termination, 'client_cancel_after_natural_committed_idle')
  assert.equal(report.streamEof, false); assert.equal(f.state.clientCancelled, true)
  assert.equal(report.afterStop.committedPersisted, true); assert.equal(report.afterStop.stoppedMarker, false)
  assert.equal(report.afterStop.working, false); assert.equal(report.afterStop.activeStream, false)
  assert.equal(report.cleanup.stopSkippedBecause, 'natural_completion_confirmed_idle')
  assert.equal(report.cleanupChatReads, 0)
  assert.equal(report.cleanup.status, 'complete'); assert.equal(f.state.liveClosed, true); assert.equal(f.state.signouts, 1)
  assert.equal(JSON.stringify(report).includes(PRIVATE), false)
})

test('no-tool samples still stop for cleanup when authoritative chat remains active', async () => {
  const f = naturalFixture({ busy: true })
  const report = await runToolStop(f.options)
  assert.equal(report.status, 'failed')
  assert.notEqual(report.error, 'tool_boundary_not_observed')
  assert.equal(f.state.sends, 1); assert.equal(f.state.stops, 1)
  assert.equal(report.cleanup.status, 'needs_followup')
  assert.equal(report.cleanup.stopSkippedBecause, undefined)
  assert.equal(f.state.liveClosed, true); assert.equal(f.state.signouts, 1)
})

test('missing or wrong persisted scope cannot be reclassified as a natural no-tool completion', async () => {
  for (const mutateChat of [
    chat => { chat.cursor = 1 },
    chat => { chat.persistedStreamIds = ['wrun_foreign:0'] },
    chat => { chat.items[0].position = 0 },
    chat => { chat.items[0].pending = true },
  ]) {
    const f = naturalFixture({ mutateChat })
    const report = await runToolStop(f.options)
    assert.equal(report.status, 'failed')
    assert.equal(report.error, 'reply_not_persisted')
    assert.equal(f.state.sends, 1); assert.equal(f.state.stops, 1)
    assert.equal(report.cleanup.stopSkippedBecause, undefined)
    assert.equal(f.state.liveClosed, true); assert.equal(f.state.signouts, 1)
  }
})

test('a public stream error survives a concurrently durable idle no-tool reply', async () => {
  const f = naturalFixture({ publicError: true })
  const report = await runToolStop(f.options)
  assert.equal(report.status, 'failed'); assert.equal(report.error, 'stream_error')
  assert.equal(f.state.sends, 1); assert.equal(f.state.stops, 1)
  assert.equal(report.cleanup.stopSkippedBecause, undefined)
  assert.equal(f.state.liveClosed, true); assert.equal(f.state.signouts, 1)
  assert.equal(JSON.stringify(report).includes(PRIVATE), false)
})
