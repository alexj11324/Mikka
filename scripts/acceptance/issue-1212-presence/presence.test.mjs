import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { createHash } from 'node:crypto'
import { Worker } from 'node:worker_threads'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { ALEX_OWNER_ID } from '../issue-1506-readonly/alex-session.mjs'
import { newCredential, parseRetainedReceipt, retainedFixture, runPresenceProof, validateDeviceTicket } from './presence-production.mjs'
import { openPresenceConsumers } from './presence-consumer.mjs'
import { preparePresenceSource } from './presence-source.mjs'
import { prepareBaselineSource } from './presence-baseline-source.mjs'
import { openBaselineConsumers } from './presence-baseline-consumer.mjs'
import { prepareMobilePresenceSource } from '../issue-1506-mobile-presence/source.mjs'

const home = '10000000-0000-4000-8000-000000000001'
const deviceId = '20000000-0000-4000-8000-000000000001'
const originalId = '20000000-0000-4000-8000-000000000002'
const tokenId = '30000000-0000-4000-8000-000000000001'
const originalToken = '30000000-0000-4000-8000-000000000002'
const sha = 'a'.repeat(40), credential = 'orv_' + 'a'.repeat(43), grant = 'orv_' + 'b'.repeat(43)
const protocol = `mikka-ticket-${Math.floor(Date.now() / 1000) + 300}-${'a'.repeat(64)}`
const tokenRow = id => ({ id, name: 'SSH', createdAt: new Date().toISOString(), expiresAt: null, revokedAt: null, revokedBy: null, boundDeviceId: null })
const sourceRoot = process.env.MIKKA_PRESENCE_SOURCE_ROOT ?? fileURLToPath(new URL('../../../', import.meta.url))
const mobileSecret = 'offline-after-integration-secret'
let mobileSource, mobileHelpers
before(async () => {
  mobileSource = await prepareMobilePresenceSource(sourceRoot)
  const load = path => import(pathToFileURL(mobileSource.directory + '/' + path).href)
  const [scope, homeProof, presence] = await Promise.all([
    load('lib/live/scope.mjs'), load('lib/live/home-scope-proof.mjs'), load('lib/device-presence-grant.mjs'),
  ])
  mobileHelpers = { ...scope, ...homeProof, ...presence }
})
after(() => mobileSource?.close())

test('credential identity refuses concurrent additions and pre-existing changes', () => {
  const before = [tokenRow(originalToken)], added = tokenRow(tokenId)
  assert.equal(newCredential(before, [...before, added]), tokenId)
  assert.throws(() => newCredential(before, [...before, added, tokenRow(deviceId)]), /presence_credential_ambiguous/)
  assert.throws(() => newCredential(before, [{ ...before[0], revokedAt: new Date().toISOString() }, added]), /presence_credential_ambiguous/)
})

test('a retained fixture receipt is bound to its exact externally supplied digest before parsing', () => {
  const bytes = Buffer.from('{"fixture":{"deviceId":"synthetic"}}'), digest = createHash('sha256').update(bytes).digest('hex')
  assert.equal(parseRetainedReceipt(bytes, digest).fixture.deviceId, 'synthetic')
  assert.throws(() => parseRetainedReceipt(bytes, '0'.repeat(64)), /presence_retained_receipt_hash_invalid/)
  assert.throws(() => parseRetainedReceipt(bytes), /presence_retained_receipt_hash_invalid/)
})

test('a device ticket names only the fixture over wss with a protocol credential', () => {
  const ticket = { url: `wss://fixture.invalid/v1/devices/${deviceId}/socket`, protocol }
  assert.equal(validateDeviceTicket(ticket, deviceId).origin, 'wss://fixture.invalid')
  assert.throws(() => validateDeviceTicket(ticket, originalId), /presence_device_ticket_invalid/)
  assert.throws(() => validateDeviceTicket({ ...ticket, url: ticket.url + '?token=not-allowed' }, deviceId), /presence_device_ticket_invalid/)
  assert.throws(() => validateDeviceTicket({ ...ticket, url: ticket.url.replace('wss:', 'https:') }, deviceId), /presence_device_ticket_invalid/)
})

function fixture({ failAfterEnroll = false, lostRegistration = false, ambiguous = false, mode = 'after', resumeReceipt = null,
  missingHomeProof = false, failThirdMobileRead = false, malformedClone = false, oldTicket = false, realConsumers = false } = {}) {
  let now = Date.now(), fixtureRow, issued = false, revoked = false
  const original = { id: originalId, name: 'existing', platform: 'darwin', arch: 'arm64', hostname: 'existing',
    enabled: true, online: false, harnesses: [], lastSeenAt: new Date(now - 1_000_000).toISOString() }
  const createdTokenId = resumeReceipt ? '30000000-0000-4000-8000-000000000004' : tokenId
  const originalCredential = tokenRow(originalToken), issuedRow = tokenRow(createdTokenId)
  const baselineToken = resumeReceipt ? { ...tokenRow(resumeReceipt.fixture.tokenId), revokedAt: new Date(now - 600_000).toISOString(), revokedBy: ALEX_OWNER_ID } : null
  if (resumeReceipt) fixtureRow = { id: deviceId, name: resumeReceipt.fixture.marker, hostname: resumeReceipt.fixture.marker,
    platform: 'linux', arch: 'x64', enabled: false, harnesses: [], lastSeenAt: new Date(now - 600_000).toISOString() }
  const calls = [], sockets = []
  const observed = { ticketClones: 0, ticketBodiesConsumed: 0, mobileReads: 0, quietCalls: 0 }
  const rows = () => [original, ...fixtureRow ? [{ ...fixtureRow, online: sockets.some(socket => socket.readyState === 1 && now - socket.lastPingAt < 90_000)
    || now - Date.parse(fixtureRow.lastSeenAt) <= 60_000 }] : []]
  const snapshot = () => ({ devices: rows(), presenceFallback: true, live: { ownerId: ALEX_OWNER_ID, workspaceId: home,
    presence: { token: `fixture.${'a'.repeat(64)}`, expiresAt: Date.now() + 300_000 } } })
  class FakeSocket {
    readyState = 0; listeners = new Map(); lastPingAt = now
    constructor() { sockets.push(this); queueMicrotask(() => { this.readyState = 1; this.emit('open', {}) }) }
    addEventListener(type, callback) { const values = this.listeners.get(type) ?? []; values.push(callback); this.listeners.set(type, values) }
    emit(type, value) { for (const listener of this.listeners.get(type) ?? []) listener(value) }
    send(value) { assert.equal(value, 'ping'); this.lastPingAt = now; queueMicrotask(() => this.emit('message', { data: 'pong' })) }
    close() { this.readyState = 3; queueMicrotask(() => this.emit('close', {})) }
  }
  const session = { identity: { userId: ALEX_OWNER_ID }, version: { build: sha }, requests: [],
    async request(path, options = {}) {
      calls.push({ path, body: options.body })
      if (path === '/api/live/ticket?workspace=' + home) {
        const scope = { ownerId: ALEX_OWNER_ID, workspaceId: home }
        const ticket = mobileHelpers.liveTicket(scope, { url: 'https://fixture.invalid', secret: mobileSecret }, now)
        if (oldTicket) ticket.expiresAt = now + 59_000
        if (!missingHomeProof) ticket.homeScope = mobileHelpers.homeScopeProof(scope, ticket.expiresAt, mobileSecret, now)
        const response = Response.json(ticket), clone = response.clone.bind(response)
        response.clone = () => { observed.ticketClones++; return malformedClone ? new Response('invalid-json') : clone() }
        return response
      }
      if (path === '/api/mobile/threads') {
        observed.mobileReads++
        assert.equal(options.method, 'GET'); assert.equal(options.body, undefined)
        const token = options.headers['x-mikka-presence-scope']
        const valid = token ? mobileHelpers.readHomeScopeProof(token, ALEX_OWNER_ID, mobileSecret, now) : null
        const presence = valid ? mobileHelpers.devicePresenceGrant(valid, rows().map(row => [row.id, row.online, 0]), mobileSecret, now, valid.expiresAt) : null
        if (failThirdMobileRead && observed.mobileReads === 3) return new Response(null, { status: 503 })
        return Response.json({ threads: [{ id: 'private-thread', name: 'not-for-report' }], devices: rows(),
          live: { ownerId: ALEX_OWNER_ID, workspaceId: valid?.workspaceId ?? null, presence } })
      }
      assert.equal(path, '/api/rpc'); assert.equal(options.body.action, 'agents.pollDevices')
      return Response.json({ version: 1, ok: true, result: snapshot() })
    },
    async json(path, body) {
      calls.push({ path, body })
      if (path === '/api/version') return { build: sha }
      if (path === '/api/device-tokens') return { tokens: [originalCredential, ...baselineToken ? [baselineToken] : [], ...issued ? [{ ...issuedRow,
        revokedAt: revoked ? new Date(now).toISOString() : null, revokedBy: revoked ? ALEX_OWNER_ID : null }] : [],
        ...ambiguous && issued ? [tokenRow('30000000-0000-4000-8000-000000000003')] : []] }
      if (path === '/api/devices/enrollment') return { token: grant }
      if (path === `/api/device-tokens/${createdTokenId}/revoke`) { revoked = true; return { tokenId: createdTokenId, revokedAt: new Date(now).toISOString(), revokedBy: ALEX_OWNER_ID } }
      throw new Error('unexpected_owner_path')
    },
    async rpc(action, args) {
      calls.push({ action, args })
      assert.equal(args[0]?.deviceId ?? args[0], deviceId)
      if (action === 'agents.setDeviceEnabled') { fixtureRow.enabled = args[0].enabled; return { success: true } }
      assert.equal(action, 'agents.removeDevice'); assert.equal(rows()[1].online, false)
      fixtureRow = undefined; return { id: deviceId, uninstall: 'not_possible', revokedTokens: 0 }
    },
  }
  const fetchImpl = async (url, options) => {
    const path = new URL(url).pathname.replace('/mikka', '')
    calls.push({ path, body: options.body ? JSON.parse(options.body) : undefined })
    assert.ok(!Object.hasOwn(options.headers, 'cookie'))
    assert.equal(options.headers.authorization, 'Bearer ' + (path === '/v1/devices/enroll' ? grant : credential))
    if (path === '/v1/devices/enroll') { issued = true; return Response.json({ credential }) }
    if (path.endsWith('/repos')) return new Response(null, { status: revoked ? 401 : 200 })
    if (path === '/v1/devices/register') {
      if (failAfterEnroll) throw new Error('registration_transport_failure')
      const body = JSON.parse(options.body)
      assert.deepEqual(body.harnesses, []); assert.equal(body.deviceId, resumeReceipt ? deviceId : undefined)
      fixtureRow = { ...body, id: deviceId, enabled: true, lastSeenAt: new Date(now).toISOString() }
      if (lostRegistration) throw new Error('registration_reply_lost')
      return Response.json({ deviceId, workspaceId: home })
    }
    if (path.endsWith('/heartbeat')) {
      assert.equal(fixtureRow.enabled, false); fixtureRow.lastSeenAt = new Date(now).toISOString()
      return Response.json({ leases: {}, revoked: [], deviceCommands: [] })
    }
    assert.equal(path, `/v1/devices/${deviceId}/gateway`)
    return Response.json({ url: `wss://fixture.invalid/v1/devices/${deviceId}/socket`, protocol })
  }
  const advance = async ms => { now += ms; for (const socket of sockets) if (socket.readyState === 1) socket.send('ping'); await Promise.resolve() }
  const openConsumers = async (consumerSession, initial, options) => {
    assert.equal(initial.devices[1].online, true)
    if (realConsumers) {
      class OfflineWorker extends Worker {
        constructor(_url, args) { super(new URL('./presence-worker-offline.mjs', import.meta.url), args) }
      }
      return openPresenceConsumers(consumerSession, initial, { ...options, WorkerClass: OfflineWorker })
    }
    if (mode === 'after') await Promise.all([1, 2, 3].map(async () => {
      const response = await consumerSession.request('/api/live/ticket?workspace=' + home)
      assert.equal(response.bodyUsed, false, 'capture must clone rather than consume the consumer response')
      const ticket = await response.json(); observed.ticketBodiesConsumed++
      assert.ok(ticket.url.startsWith('wss://fixture.invalid/v1/live/'))
    }))
    const report = { closed: false, tabs: [1, 2, 3].map(tabId => ({ tabId, closed: false, unwatches: 0 })) }
    options.checkpoint(report)
    return { begin: name => ({ name }), async settle() {}, async quiet(ms) { observed.quietCalls++; await advance(ms); return { elapsedMs: ms, actualReads: mode === 'baseline' ? 3 : 0, allOldFallbacksActive: mode === 'baseline' } },
      async waitState(marker, online) { if (marker.name === 'natural-expiry') now += 90_001; assert.equal(rows()[1].online, online); return { actualReads: 1, adopted: 2, allTabsReceivedBothKeys: true } },
      async close() { report.closed = true; report.tabs.forEach(row => { row.closed = true; row.unwatches++ }); return report } }
  }
  let setupBoundaryObserved = false
  const wait = async ms => {
    if (realConsumers && observed.mobileReads === 3 && !setupBoundaryObserved) {
      setupBoundaryObserved = true
      throw Object.assign(new Error('presence_offline_setup_complete'), { code: 'presence_offline_setup_complete' })
    }
    return advance(ms)
  }
  return { calls, original, observed, run: () => runPresenceProof({ mode, resumeReceipt, sourceRoot, expectedSha: sha, runKey: 'offline-test', env: {},
    sourceLoader: realConsumers ? preparePresenceSource : () => ({ sourceBase: sha, hashes: {}, clientPatchSha256: 'b'.repeat(64), version: '0.0.1', protocolVersion: 3, heartbeatWindowMs: 60_000, close() {} }),
    sessionRunner: async work => { try { return await work(session) } finally { session.requests.push({ path: '/mikka/api/auth/sign-out', status: 200 }) } },
    fetchImpl, WebSocketClass: FakeSocket, openConsumers, now: () => now, wait }) }
}

test('finite driver touches only a fresh disabled fixture, then revokes/removes it and signs out', async () => {
  const f = fixture(), report = await f.run()
  assert.equal(report.status, 'passed', JSON.stringify(report.errors))
  assert.equal(report.checks.naturalExpiryPushReadsBounded, true)
  assert.equal(report.cleanup.originalDevicesPreserved, true)
  assert.equal(report.cleanup.originalCredentialsPreserved, true)
  assert.equal(f.original.enabled, true)
  assert.equal(f.calls.filter(call => call.path?.endsWith('/heartbeat')).length, 1)
  assert.ok(!f.calls.some(call => /runs|claim|factory|model/.test(call.path ?? '')))
  assert.ok(!JSON.stringify(report).includes(credential)); assert.ok(!JSON.stringify(report).includes(grant))
})

test('after setup reuses one of three original ticket responses and runs exactly three mobile reads before idle', async () => {
  const f = fixture(), report = await f.run()
  assert.equal(report.status, 'passed', JSON.stringify(report.errors))
  assert.equal(report.mobileAPISetup?.status, 'passed')
  assert.equal(report.mobileAPISetup.setupThreadReads, 3)
  assert.equal(report.mobileAPISetup.addedTicketReads, 0); assert.equal(report.mobileAPISetup.addedHomeReads, 0)
  assert.equal(report.mobileAPISetup.phoneRendered, false)
  assert.equal(report.mobileAPISetup.workerAcknowledgementChecked, false)
  assert.equal(f.observed.ticketClones, 1); assert.equal(f.observed.ticketBodiesConsumed, 3)
  assert.equal(f.observed.mobileReads, 3); assert.equal(f.observed.quietCalls, 1)
  assert.equal(f.calls.filter(row => row.path === '/api/live/ticket?workspace=' + home).length, 3)
  assert.equal(f.calls.filter(row => row.path === '/api/mobile/threads').length, 3)
  assert.ok(!f.calls.some(row => row.path === '/api/mobile/home'))
  const metadata = JSON.stringify(report.mobileAPISetup)
  for (const sensitive of [mobileSecret, ALEX_OWNER_ID, home, deviceId, 'private-thread', 'not-for-report', 'homeScope'])
    assert.equal(metadata.includes(sensitive), false)
})

test('missing or malformed cloned proof and insufficient ticket budget fail before mobile reads without retrying tickets', async () => {
  for (const options of [{ missingHomeProof: true }, { malformedClone: true }, { oldTicket: true }]) {
    const f = fixture(options), report = await f.run()
    assert.equal(report.status, 'failed')
    assert.equal(report.errors[0].phase, 'mobile-api-setup')
    assert.equal(f.observed.mobileReads, 0); assert.equal(f.observed.quietCalls, 0)
    assert.equal(f.observed.ticketBodiesConsumed, 3); assert.equal(f.observed.ticketClones, 1)
    assert.equal(f.calls.filter(row => row.path === '/api/live/ticket?workspace=' + home).length, 3)
    assert.equal(report.cleanup.observersClosed, true); assert.equal(report.cleanup.deviceSocketClosed, true)
    assert.equal(report.cleanup.credentialRevoked, true); assert.equal(report.cleanup.oldCredentialRejected, true)
    assert.equal(report.cleanup.deviceRemoved, true); assert.equal(report.cleanup.signOut200, true)
    assert.equal(report.cleanup.verified, true)
    assert.equal(report.idle, undefined)
  }
})

test('third mobile setup read failure keeps the original full cleanup and cannot be called a zero-read idle result', async () => {
  const f = fixture({ failThirdMobileRead: true }), report = await f.run()
  assert.equal(report.status, 'failed')
  assert.equal(report.errors[0].phase, 'mobile-api-setup')
  assert.equal(report.errors[0].code, 'presence_mobile_read_failed')
  assert.equal(f.observed.mobileReads, 3); assert.equal(f.observed.quietCalls, 0)
  assert.equal(report.idle, undefined)
  for (const key of ['observersClosed', 'deviceSocketClosed', 'credentialRevoked', 'oldCredentialRejected',
    'deviceRemoved', 'signOut200', 'verified', 'originalDevicesPreserved', 'originalCredentialsPreserved'])
    assert.equal(report.cleanup[key], true, key)
})

test('actual three-worker after adapter passes its existing ticket clone into the real mobile setup before the idle boundary', { timeout: 15_000 }, async () => {
  const f = fixture({ realConsumers: true }), report = await f.run()
  assert.equal(report.status, 'failed', 'the test deliberately ends at the pre-idle boundary')
  assert.deepEqual(report.errors, [{ phase: 'observe', code: 'presence_offline_setup_complete' }])
  assert.equal(report.mobileAPISetup.status, 'passed')
  assert.equal(report.checks.threeExactAcknowledgements, true)
  assert.equal(report.checks.mobileAPISetupPassed, true)
  assert.equal(report.live.tabs.length, 3)
  assert.ok(report.live.tabs.every(row => row.acknowledgements >= 1 && row.unwatches >= 1 && row.closed))
  assert.equal(report.live.network.filter(row => row.method === 'ticket').length, 3)
  assert.equal(f.calls.filter(row => row.path === '/api/live/ticket?workspace=' + home).length, 3)
  assert.equal(f.calls.filter(row => row.path === '/api/mobile/threads').length, 3)
  assert.equal(f.observed.ticketClones, 1)
  assert.equal(report.idle, undefined)
  for (const key of ['observersClosed', 'deviceSocketClosed', 'credentialRevoked', 'oldCredentialRejected',
    'deviceRemoved', 'signOut200', 'verified', 'originalDevicesPreserved', 'originalCredentialsPreserved'])
    assert.equal(report.cleanup[key], true, key)
})

test('a lost registration reply reconciles only this nonce and still cleans up', async () => {
  const f = fixture({ lostRegistration: true }), report = await f.run()
  assert.equal(report.status, 'failed')
  assert.equal(report.cleanup.credentialRevoked, true)
  assert.equal(report.cleanup.deviceRemoved, true)
  assert.equal(f.calls.filter(call => call.path === '/v1/devices/register').length, 1)
})

test('an uncertain registration or ambiguous new credential never claims successful cleanup or revokes an arbitrary token', async () => {
  const uncertain = await fixture({ failAfterEnroll: true }).run()
  assert.equal(uncertain.status, 'failed')
  assert.equal(uncertain.cleanup.credentialRevoked, true)
  assert.notEqual(uncertain.cleanup.deviceRemoved, true)
  const f = fixture({ ambiguous: true }), report = await f.run()
  assert.equal(report.status, 'failed')
  assert.ok(!f.calls.some(call => call.path?.endsWith('/revoke')))
  assert.ok(!f.calls.some(call => call.path === '/v1/devices/register'))
})

test('baseline revokes its short credential and retains only the disabled nonce device; after rebinds exactly that receipt and removes it', async () => {
  const before = fixture({ mode: 'baseline' }), receipt = await before.run()
  assert.equal(receipt.status, 'baseline_captured', JSON.stringify(receipt.errors))
  assert.equal(receipt.mobileAPISetup, undefined)
  assert.equal(before.observed.ticketClones, 0); assert.equal(before.observed.mobileReads, 0)
  assert.equal(before.observed.quietCalls, 1)
  assert.ok(!before.calls.some(call => call.path === '/api/mobile/threads' || call.path === '/api/mobile/home'))
  assert.equal(receipt.cleanup.deviceRetained, true); assert.equal(receipt.cleanup.credentialRevoked, true)
  assert.ok(!before.calls.some(call => call.action === 'agents.removeDevice'))
  assert.equal(retainedFixture(receipt, 'offline-test').deviceId, deviceId)
  assert.throws(() => retainedFixture(receipt, 'another-run'), /presence_retained_receipt_invalid/)
  assert.throws(() => retainedFixture({ ...receipt, cleanup: { ...receipt.cleanup, credentialRevoked: false } }, 'offline-test'), /presence_retained_receipt_invalid/)
  const after = fixture({ resumeReceipt: receipt }), report = await after.run()
  assert.equal(report.status, 'passed', JSON.stringify(report.errors))
  assert.equal(report.fixture.deviceId, receipt.fixture.deviceId)
  assert.notEqual(report.fixture.tokenId, receipt.fixture.tokenId)
  assert.equal(report.cleanup.deviceRemoved, true)
  assert.equal(report.cleanup.originalDevicesPreserved, true)
  assert.equal(report.cleanup.originalCredentialsPreserved, true)
})

for (const idleMs of [50, 2_100]) test(`three actual core workers preserve state and count real reads after ${idleMs}ms idle`, { timeout: 15_000 }, async () => {
  const source = preparePresenceSource(sourceRoot), workers = []
  let online = true, reads = 0
  const expiresAt = Date.now() + 300_000, fixture = { deviceId, marker: 'offline-core' }
  const snapshot = () => ({ devices: [{ id: deviceId, name: fixture.marker, enabled: false, harnesses: [], online }],
    live: { ownerId: ALEX_OWNER_ID, workspaceId: home, presence: { token: `fixture-${online}.${'a'.repeat(64)}`, expiresAt } } })
  class OfflineWorker extends Worker {
    constructor(_url, options) { super(new URL('./presence-worker-offline.mjs', import.meta.url), options); workers.push(this) }
  }
  const channel = createHash('sha256').update(JSON.stringify([ALEX_OWNER_ID, home])).digest('hex')
  const session = { identity: { userId: ALEX_OWNER_ID }, version: { build: sha },
    async request(path) {
      if (path.startsWith('/api/live/ticket?')) return Response.json({ url: `wss://fixture.invalid/v1/live/${channel}/socket`, protocol: 'fixture', expiresAt })
      assert.equal(path, '/api/rpc'); reads++
      return Response.json({ version: 1, ok: true, result: snapshot() })
    } }
  let consumers
  try {
    consumers = await openPresenceConsumers(session, snapshot(), { source, fixture, expectedSha: sha,
      gatewayOrigin: 'wss://fixture.invalid', WorkerClass: OfflineWorker })
    await consumers.quiet(idleMs)
    const before = reads, marker = consumers.begin('disconnect')
    online = false; workers.forEach(worker => worker.postMessage({ type: 'test-push' }))
    const result = await consumers.waitState(marker, false, 5_000).catch(error => {
      error.message += ' ' + JSON.stringify({ phases: consumers.report.phases, network: consumers.report.network, tabs: consumers.report.tabs })
      throw error
    })
    assert.equal(reads, before + result.actualReads)
    assert.ok(result.actualReads >= 1 && result.actualReads <= 3)
    assert.equal(result.adopted + result.actualReads, 3)
    if (idleMs >= 2_000) { assert.equal(result.actualReads, 1); assert.equal(result.adopted, 2) }
    const report = await consumers.close()
    assert.ok(report.tabs.every(tab => tab.closed && tab.unwatches >= 1))
    assert.ok(!JSON.stringify(report).includes(snapshot().live.presence.token))
  } finally { await consumers?.close(); source.close() }
})

test('actual core worker readiness cannot be satisfied by presence support without an acknowledgement', { timeout: 10_000 }, async () => {
  const source = preparePresenceSource(sourceRoot), expiresAt = Date.now() + 300_000
  const initial = { devices: [{ id: deviceId, name: 'no-ack', enabled: false, harnesses: [], online: true }],
    live: { ownerId: ALEX_OWNER_ID, workspaceId: home, presence: { token: `fixture.${'a'.repeat(64)}`, expiresAt } } }
  class NoAckWorker extends Worker { constructor(_url, options) { super(new URL('./presence-worker-offline.mjs', import.meta.url), { ...options, workerData: { ...options.workerData, suppressAck: true } }) } }
  const channel = createHash('sha256').update(JSON.stringify([ALEX_OWNER_ID, home])).digest('hex')
  const session = { identity: { userId: ALEX_OWNER_ID }, version: { build: sha }, async request(path) {
    return path.startsWith('/api/live/ticket?') ? Response.json({ url: `wss://fixture.invalid/v1/live/${channel}/socket`, protocol: 'fixture', expiresAt })
      : Response.json({ version: 1, ok: true, result: initial })
  } }
  try {
    await assert.rejects(openPresenceConsumers(session, initial, { source, fixture: { deviceId, marker: 'no-ack' },
      expectedSha: sha, gatewayOrigin: 'wss://fixture.invalid', WorkerClass: NoAckWorker, readyTimeoutMs: 500 }), /presence_ready_failed/)
  } finally { source.close() }
})

test('three exact old consumers keep null-scope fallback and each read once on a virtual minute', { timeout: 15_000 }, async () => {
  const baselineRoot = process.env.MIKKA_PRESENCE_BASELINE_SOURCE_ROOT ?? resolve(sourceRoot, '../Mikka-presence-baseline')
  const source = prepareBaselineSource(baselineRoot), workers = [], expiresAt = Date.now() + 300_000
  let reads = 0
  const fixture = { deviceId, marker: 'old-core' }
  const value = { devices: [{ id: deviceId, name: fixture.marker, enabled: false, harnesses: [], online: true }],
    live: { ownerId: ALEX_OWNER_ID, workspaceId: home }, presenceFallback: true }
  class OldWorker extends Worker {
    constructor(_url, options) {
      super(new URL('./presence-baseline-worker-offline.mjs', import.meta.url), options); workers.push(this)
      this.on('message', message => { if (message?.type === 'offline-clock-ready') this.postMessage({ type: 'test-advance', ms: 300, id: 'initial' }) })
    }
  }
  const channel = createHash('sha256').update(JSON.stringify([ALEX_OWNER_ID, home])).digest('hex')
  const session = { identity: { userId: ALEX_OWNER_ID }, version: { build: sha }, async request(path) {
    if (path.startsWith('/api/live/ticket?')) return Response.json({ url: `wss://fixture.invalid/v1/live/${channel}/socket`, protocol: 'fixture', expiresAt })
    assert.equal(path, '/api/rpc'); reads++
    return Response.json({ version: 1, ok: true, result: value })
  } }
  let consumers
  try {
    consumers = await openBaselineConsumers(session, value, { fixture, source, expectedSha: sha,
      gatewayOrigin: 'wss://fixture.invalid', WorkerClass: OldWorker })
    await consumers.settle()
    const before = reads
    await Promise.all(workers.map(worker => new Promise(resolve => {
      const listener = message => { if (message?.type === 'offline-clock-advanced' && message.id === 'minute') { worker.off('message', listener); resolve() } }
      worker.on('message', listener); worker.postMessage({ type: 'test-advance', ms: 60_100, id: 'minute' })
    })))
    await consumers.settle()
    assert.equal(reads, before + 3, 'the old adapter has no cross-tab sharing')
    assert.ok(consumers.report.tabs.every(row => row.fallbackActive && row.nullTicketAttempts >= 2 && row.socketCount === 1))
  } finally { await consumers?.close(); source.close() }
})
