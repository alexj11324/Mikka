import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { ACCEPTANCE_REPLAY_MARKER, acceptanceReplayOptIn, installReplayReadiness } from '../lib/replay-readiness.ts'
import { sanitizeAnalyticsEvent, redactReplayRequest } from '../lib/analytics-policy.ts'

const A = '77777777-7777-4777-8777-777777777777'
const B = '88888888-8888-4888-8888-888888888888'
const CANARY = 'PRIVATE_REPLAY_PAYLOAD_CANARY'
function fixture(initial = A) {
  const target = {}, callbacks = new Set()
  let started = false, calls = 0
  const client = {
    onSessionId(callback) { callbacks.add(callback); if (initial) callback(initial); return () => callbacks.delete(callback) },
    sessionRecordingStarted() { calls++; return started },
    get_session_id() { throw new Error('must not allocate a session') },
    startSessionRecording() { throw new Error('must not start recording') },
    opt_in_capturing() { throw new Error('must not opt in') },
    capture() { throw new Error('must not capture') },
    reset() { throw new Error('must not reset') },
  }
  const observer = installReplayReadiness(target, () => 1_800_000_000_000)
  return { target, callbacks, client, observer, started: value => { started = value },
    change: value => { for (const cb of callbacks) cb(value) }, calls: () => calls }
}
const snapshot = id => ({ event: '$snapshot', properties: { $session_id: id } })

test('only a natural session, live SDK state and same-session snapshot form readiness', () => {
  const f = fixture()
  assert.equal(f.target.__mikkaReplayReadiness().sdkLoaded, false)
  f.observer.bind(f.client)
  f.started(true)
  f.observer.observe({ event: '$pageview', properties: { $session_id: A } })
  assert.equal(f.target.__mikkaReplayReadiness().snapshotObserved, false)
  f.observer.observe(snapshot(B))
  assert.equal(f.target.__mikkaReplayReadiness().snapshotObserved, false)
  f.observer.observe(snapshot(A))
  const ready = f.target.__mikkaReplayReadiness()
  assert.equal(ready.sessionId, A)
  assert.equal(ready.recordingStarted, true)
  assert.equal(ready.snapshotObserved, true)
  f.started(false)
  assert.equal(f.target.__mikkaReplayReadiness().recordingStarted, false)
  assert.equal(f.calls() > 1, true)
})

test('snapshot-before-loaded ordering works and natural session changes invalidate old evidence', () => {
  const f = fixture()
  f.observer.observe(snapshot(A))
  f.observer.bind(f.client)
  f.started(true)
  assert.equal(f.target.__mikkaReplayReadiness().snapshotObserved, true)
  f.change(B)
  assert.equal(f.target.__mikkaReplayReadiness().snapshotObserved, false)
  f.observer.observe(snapshot(B))
  assert.equal(f.target.__mikkaReplayReadiness().snapshotObserved, true)
  f.change(null)
  assert.equal(f.target.__mikkaReplayReadiness().sessionId, null)
  f.change(B)
  assert.equal(f.target.__mikkaReplayReadiness().snapshotObserved, false)
})

test('observer never reads snapshot payload and exposes only frozen metadata', () => {
  const f = fixture()
  f.observer.bind(f.client)
  const event = snapshot(A)
  Object.defineProperty(event.properties, '$snapshot_data', { get() { throw new Error(CANARY) } })
  Object.defineProperty(event, 'message', { get() { throw new Error(CANARY) } })
  f.observer.observe(event)
  const state = f.target.__mikkaReplayReadiness()
  assert.equal(state.snapshotObserved, true)
  assert.equal(Object.isFrozen(state), true)
  assert.deepEqual(Object.keys(state).sort(), ['version', 'sdkLoaded', 'sessionId', 'recordingStarted',
    'snapshotObserved', 'sessionObservedAt', 'snapshotObservedAt', 'observedAt'].sort())
  assert.equal(JSON.stringify(state).includes(CANARY), false)
  assert.equal(Object.keys(f.target).length, 0)
  assert.throws(() => { f.target.__mikkaReplayReadiness = () => CANARY }, TypeError)
})

test('duplicate entry replaces subscriptions; unavailable or failing SDK remains unknown without throwing', () => {
  const f = fixture()
  f.observer.bind(f.client)
  const again = installReplayReadiness(f.target)
  assert.equal(again, f.observer)
  again.bind(f.client)
  assert.equal(f.callbacks.size, 1)
  f.client.sessionRecordingStarted = () => { throw new Error(CANARY) }
  assert.equal(f.target.__mikkaReplayReadiness().recordingStarted, null)
  again.bind({ onSessionId() { throw new Error(CANARY) }, sessionRecordingStarted() { return true } })
  assert.equal(f.target.__mikkaReplayReadiness().sdkLoaded, false)
  assert.equal(f.target.__mikkaReplayReadiness().sessionId, null)
  assert.doesNotThrow(() => installReplayReadiness(Object.freeze({})))
})

for (const optedIn of [false, true]) test(`real bootstrap keeps masking and natural readiness with acceptance opt-in ${optedIn}`, () => {
  const source = readFileSync(new URL('../instrumentation-client.ts', import.meta.url), 'utf8')
    .replace(/^import .*\n/gm, '')
  const f = fixture()
  let config
  const client = { ...f.client, register() {}, capture() {} }
  const target = { location: { hostname: 'example.invalid' } }
  if (optedIn) Object.defineProperty(target, ACCEPTANCE_REPLAY_MARKER, { value: Date.now() + 60_000 })
  runInNewContext(source, { window: target, process: { env: { NODE_ENV: 'test' } },
    posthogConfig: { token: 'SYNTHETIC_PUBLIC_PROJECT_TOKEN', apiHost: 'https://example.invalid', uiHost: 'https://example.invalid' },
    posthog: { init(_token, value) { config = value } }, watchRemovedActions() {},
    setLiveTelemetrySink() {}, acceptanceReplayOptIn, installReplayReadiness, sanitizeAnalyticsEvent, redactReplayRequest })
  assert.equal(config.opt_out_useragent_filter, optedIn)
  assert.equal(typeof target.__mikkaReplayReadiness, 'function')
  assert.equal(config.before_send({ event: 'unknown', properties: { message: CANARY } }), null)
  const input = { event: '$snapshot', properties: { $session_id: A, $snapshot_data: [{ type: 2 }], prompt: CANARY } }
  const sanitized = config.before_send(input)
  assert.deepEqual(sanitized, sanitizeAnalyticsEvent(input))
  assert.equal(sanitized.properties.$snapshot_data, input.properties.$snapshot_data)
  config.loaded(client)
  f.started(true)
  assert.equal(target.__mikkaReplayReadiness().snapshotObserved, true)
  assert.equal(config.session_recording.maskAllInputs, true)
  assert.equal(config.session_recording.maskTextSelector, '*')
  assert.equal(config.session_recording.recordBody, false)
  assert.equal(config.session_recording.recordHeaders, false)
})

test('acceptance opt-in requires an unexpired bounded own data marker without reading accessors', () => {
  const now = 1_800_000_000_000
  const marked = value => Object.defineProperty({}, ACCEPTANCE_REPLAY_MARKER, { value })
  assert.equal(acceptanceReplayOptIn({}, now), false)
  for (const value of [now + 1, now + 600_000]) assert.equal(acceptanceReplayOptIn(marked(value), now), true)
  for (const value of [undefined, null, true, 'true', String(now + 1), CANARY, NaN, Infinity, now - 1, now, now + 0.5, now + 600_001])
    assert.equal(acceptanceReplayOptIn(marked(value), now), false)
  let reads = 0
  const accessor = Object.defineProperty({}, ACCEPTANCE_REPLAY_MARKER, { get() { reads++; throw new Error(CANARY) } })
  assert.equal(acceptanceReplayOptIn(accessor, now), false)
  assert.equal(reads, 0)
  assert.equal(acceptanceReplayOptIn(Object.create(marked(now + 1)), now), false)
  assert.equal(acceptanceReplayOptIn(marked(now + 1), now + 1), false)
  assert.equal(acceptanceReplayOptIn(new Proxy({}, { getOwnPropertyDescriptor() { throw new Error(CANARY) } }), now), false)
})
