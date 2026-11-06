import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { Worker } from 'node:worker_threads'
import { resolve } from 'node:path'
import { prepareBaselineSource } from './presence-baseline-source.mjs'
import { openBaselineConsumers } from './presence-baseline-consumer.mjs'

const ownerId = 'offline-owner', home = '10000000-0000-4000-8000-000000000001'
const deviceId = '20000000-0000-4000-8000-000000000001', sha = 'a'.repeat(40)
const sensitive = 'never-report-wss://private.invalid/?token=raw-secret'
const once = (worker, type, id) => new Promise(resolve => {
  const listener = message => { if (message?.type === type && (id === undefined || message.id === id)) { worker.off('message', listener); resolve(message) } }
  worker.on('message', listener)
})
async function open({ suppressPongs = false, lifetimeMs = 300_000 } = {}) {
  const source = prepareBaselineSource(process.env.MIKKA_PRESENCE_BASELINE_SOURCE_ROOT ?? resolve('Mikka-presence-baseline'))
  const fixture = { deviceId, marker: 'old-core-diagnostic' }, workers = []
  const initial = { devices: [{ id: deviceId, name: fixture.marker, enabled: false, harnesses: [], online: true }],
    live: { ownerId, workspaceId: home }, presenceFallback: true }
  const expiresAt = Date.now() + lifetimeMs
  const channel = createHash('sha256').update(JSON.stringify([ownerId, home])).digest('hex')
  class OldWorker extends Worker {
    constructor(_url, options) {
      super(new URL('./presence-baseline-worker-offline.mjs', import.meta.url), { ...options, workerData: { ...options.workerData, suppressPongs } }); workers.push(this)
      this.on('message', message => { if (message?.type === 'offline-clock-ready') this.postMessage({ type: 'test-advance', ms: 300, id: 'initial' }) })
    }
  }
  const session = { identity: { userId: ownerId }, version: { build: sha }, async request(path) {
    if (path.startsWith('/api/live/ticket?')) return Response.json({ url: `wss://fixture.invalid/v1/live/${channel}/socket`, protocol: 'fixture', expiresAt })
    assert.equal(path, '/api/rpc'); return Response.json({ version: 1, ok: true, result: initial })
  } }
  let consumers
  try {
    consumers = await openBaselineConsumers(session, initial, { fixture, source, expectedSha: sha,
      gatewayOrigin: 'wss://fixture.invalid', WorkerClass: OldWorker })
    await consumers.settle()
  } catch (error) { source.close(); throw error }
  return { workers, consumers,
    async advance(ms) { await Promise.all(workers.map(async worker => { const done = once(worker, 'offline-clock-advanced', 'advance'); worker.postMessage({ type: 'test-advance', ms, id: 'advance' }); await done })) },
    async inject(type) { const done = once(workers[0], 'offline-fault-injected'); workers[0].postMessage({ type, sensitive }); await done },
    async close() { const report = await consumers.close(); source.close(); return report } }
}

test('old core remains healthy for 180 seconds and cleanup close is distinguished', { timeout: 10_000 }, async () => {
  const f = await open()
  try {
    await f.advance(180_000); await f.consumers.settle()
    const report = await f.close()
    assert.equal(report.fault, null); assert.deepEqual(report.failures, [])
    for (const tab of report.tabs) {
      assert.equal(tab.transport.pings, 6); assert.equal(tab.transport.pongs, 6)
      assert.equal(tab.transport.coreCloseAtMs, null)
      assert.ok(tab.transport.cleanupCloseAtMs >= 180_000)
    }
  } finally { await f.close() }
})

test('a missing pong records the core close and remains a failed healthy case', { timeout: 10_000 }, async () => {
  const f = await open({ suppressPongs: true })
  try {
    await f.advance(61_000)
    await assert.rejects(f.consumers.settle(), /presence_baseline_not_gateway_fallback/)
    const report = await f.close()
    assert.equal(report.fault, 'presence_baseline_worker_failed')
    assert.ok(report.failures.every(row => row.cause === 'socket_close'))
    for (const tab of report.tabs) {
      assert.equal(tab.transport.pings, 1); assert.equal(tab.transport.pongs, 0)
      assert.ok(tab.transport.coreCloseAtMs - tab.transport.lastPingAtMs >= 30_000)
      assert.ok(tab.transport.ticketRemainingAtCloseMs > 200_000)
      assert.equal(tab.transport.closeCode, 1000)
    }
  } finally { await f.close() }
})

test('remote close retains the three completed idle reads but does not pass the window', { timeout: 10_000 }, async () => {
  const f = await open()
  try {
    const result = assert.rejects(f.consumers.quiet(1_000), /presence_baseline_read_failed/)
    await f.advance(60_100); await f.consumers.settle(); await f.inject('test-socket-close'); await result
    const report = await f.close(), failed = report.failures.find(row => row.tabId === 1)
    assert.equal(failed.cause, 'socket_close')
    const tab = report.tabs.find(row => row.tabId === 1)
    assert.equal(tab.transport.closeCode, 1011); assert.equal(tab.transport.closeWasClean, true)
    assert.equal(tab.transport.coreCloseAtMs, null)
    assert.equal(report.phases[0].actualReads, 3)
    assert.equal(report.phases[0].allReadsSucceeded, true)
    assert.equal(report.phases[0].healthVerified, false)
    assert.equal(report.phases[0].completed, false)
    assert.ok(!JSON.stringify(report).includes(sensitive))
  } finally { await f.close() }
})

test('socket errors retain only a fixed cause and numeric transport evidence', { timeout: 10_000 }, async () => {
  const f = await open()
  try {
    await f.inject('test-socket-error')
    await assert.rejects(f.consumers.settle(), /presence_baseline_not_gateway_fallback/)
    const report = await f.close(), failed = report.failures.find(row => row.tabId === 1)
    assert.equal(failed.cause, 'socket_error')
    assert.ok(report.tabs.find(row => row.tabId === 1).transport.errorAtMs >= 0)
    assert.ok(!JSON.stringify(report).includes(sensitive))
  } finally { await f.close() }
})

test('normal ticket renewal remains outside the continuous-health case and is identifiable', { timeout: 10_000 }, async () => {
  const f = await open({ lifetimeMs: 45_000 })
  try {
    await f.advance(46_000)
    await assert.rejects(f.consumers.settle(), /presence_baseline_not_gateway_fallback/)
    const report = await f.close()
    assert.ok(['presence_baseline_worker_failed', 'presence_baseline_proxy_failed'].includes(report.fault))
    for (const tab of report.tabs) {
      assert.equal(tab.transport.pings, tab.transport.pongs)
      assert.ok(tab.transport.coreCloseAtMs >= 44_000)
      assert.equal(tab.transport.ticketRemainingAtCloseMs, 0)
    }
  } finally { await f.close() }
})
