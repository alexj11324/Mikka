import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

import { CHECK_TIMEOUT_MS, UpdateGate, failureReason, gateCopy, gateView, type GateState, type GateUpdater } from './launch-update'

class FakeUpdater extends EventEmitter {
  checks = 0
  installs = 0
  next: (updater: FakeUpdater) => void = () => {}
  rejectWith: Error | null = null
  checkForUpdates(): Promise<unknown> {
    this.checks += 1
    this.next(this)
    return this.rejectWith ? Promise.reject(this.rejectWith) : Promise.resolve(null)
  }
  quitAndInstall(): void { this.installs += 1 }
}

function setup() {
  const updater = new FakeUpdater()
  const states: GateState[] = []
  const earlyRetries: boolean[] = []
  let fire: (() => void) | null = null
  let delay = 0
  let cleared = 0
  const gate = new UpdateGate(updater as unknown as GateUpdater, {
    onState: state => states.push(state),
    onProceed: retryCheck => { earlyRetries.push(retryCheck) },
    setTimer: (run, ms) => { fire = run; delay = ms; return 'timer' },
    clearTimer: () => { cleared += 1 },
  })
  return { updater, gate, states, earlyRetries, proceeded: () => earlyRetries.length, timeout: () => fire?.(), delay: () => delay, cleared: () => cleared }
}

const flush = () => new Promise(resolve => setImmediate(resolve))

test('no update: the app opens and the gate stops listening', async () => {
  const t = setup()
  t.updater.next = u => { u.emit('update-not-available') }
  t.gate.start()
  await flush()
  assert.equal(t.proceeded(), 1)
  assert.deepEqual(t.states, [{ kind: 'checking' }])
  assert.deepEqual(t.earlyRetries, [false])
  assert.equal(t.delay(), CHECK_TIMEOUT_MS)
  assert.equal(t.updater.listenerCount('update-downloaded'), 0)
})

test('offline or a failed check: the app opens; a failed check never locks anyone out', async () => {
  const t = setup()
  t.updater.rejectWith = new Error('net::ERR_INTERNET_DISCONNECTED')
  t.gate.start()
  await flush()
  assert.equal(t.proceeded(), 1)

  assert.deepEqual(t.earlyRetries, [true])
  const e = setup()
  e.updater.next = u => { u.emit('error', new Error('getaddrinfo ENOTFOUND')) }
  e.gate.start()
  await flush()
  assert.equal(e.proceeded(), 1)
  assert.deepEqual(e.earlyRetries, [true])
})

test('no answer within five seconds: the app opens, and a late answer is ignored', async () => {
  const t = setup()
  t.gate.start()
  t.timeout()
  assert.deepEqual(t.earlyRetries, [true])
  assert.equal(t.proceeded(), 1)
  t.updater.emit('update-available', { version: '2.0.0' })
  t.updater.emit('update-downloaded', { version: '2.0.0' })
  assert.equal(t.updater.installs, 0)
  assert.deepEqual(t.states, [{ kind: 'checking' }])
})

test('a new version: progress, then install and restart; no way in on the old version', async () => {
  const t = setup()
  t.updater.next = u => { u.emit('update-available', { version: '2.0.0' }) }
  t.gate.start()
  await flush()
  assert.equal(t.cleared(), 1, 'the check timeout stops once an update is found')
  t.timeout()
  assert.equal(t.proceeded(), 0)
  t.updater.emit('download-progress', { percent: 41.7 })
  t.updater.emit('download-progress', { percent: 41.9 })
  t.updater.emit('download-progress', { percent: 100 })
  t.updater.emit('update-downloaded', { version: '2.0.0' })
  assert.deepEqual(t.states, [
    { kind: 'checking' },
    { kind: 'downloading', version: '2.0.0', percent: 0 },
    { kind: 'downloading', version: '2.0.0', percent: 41 },
    { kind: 'downloading', version: '2.0.0', percent: 100 },
    { kind: 'installing', version: '2.0.0' },
  ])
  assert.equal(t.updater.installs, 1)
  assert.equal(t.proceeded(), 0)
})

test('a failed download shows why and offers 重试; 重试 downloads again', async () => {
  const t = setup()
  t.updater.next = u => { u.emit('update-available', { version: '2.0.0' }) }
  t.gate.start()
  await flush()
  t.updater.emit('error', new Error('Error: sha512 checksum mismatch\n    at verify (updater.js:1:1)'))
  assert.deepEqual(t.states.at(-1), { kind: 'failed', version: '2.0.0', reason: 'Error: sha512 checksum mismatch' })
  assert.equal(t.proceeded(), 0, 'a known update that will not download keeps the door shut')

  // 重试 while still offline fails again rather than letting the old version in.
  t.updater.next = () => {}
  t.updater.rejectWith = new Error('net::ERR_INTERNET_DISCONNECTED')
  t.gate.retry()
  await flush()
  assert.deepEqual(t.states.at(-2), { kind: 'downloading', version: '2.0.0', percent: 0 })
  assert.equal(t.states.at(-1)?.kind, 'failed')
  assert.equal(t.proceeded(), 0)

  t.updater.rejectWith = null
  t.updater.next = u => { u.emit('update-available', { version: '2.0.0' }); u.emit('update-downloaded', { version: '2.0.0' }) }
  t.gate.retry()
  await flush()
  assert.equal(t.updater.installs, 1)
  assert.equal(t.updater.checks, 3)
})

test('an update downloaded on an earlier run installs at once', async () => {
  const t = setup()
  t.updater.next = u => { u.emit('update-downloaded', { version: '2.0.0' }) }
  t.gate.start()
  await flush()
  assert.equal(t.updater.installs, 1)
  assert.deepEqual(t.states.at(-1), { kind: 'installing', version: '2.0.0' })
})

test('the window shows a heading, progress and 重试 only when it can help', () => {
  const zh = gateCopy('zh-CN')
  assert.deepEqual(gateView({ kind: 'checking' }, zh), { heading: '正在检查更新', detail: '', percent: null, retry: null, busy: true })
  assert.deepEqual(gateView({ kind: 'downloading', version: '2026.10000.301', percent: 42 }, zh), { heading: '正在更新到 v2026.10000.301', detail: '42%', percent: 42, retry: null, busy: true })
  assert.deepEqual(gateView({ kind: 'failed', version: '2.0.0', reason: 'net::ERR_TIMED_OUT' }, zh), { heading: '无法更新到 v2.0.0', detail: 'net::ERR_TIMED_OUT', percent: null, retry: '重试', busy: false })
  assert.equal(gateCopy('en-US').retry, 'Retry')
  assert.equal(failureReason('x'.repeat(500)).length, 200)
})
