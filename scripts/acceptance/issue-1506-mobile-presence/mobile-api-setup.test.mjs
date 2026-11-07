import assert from 'node:assert/strict'
import test, { after, before } from 'node:test'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { checkMobilePresenceSetup } from './mobile-api-setup.mjs'
import { prepareMobilePresenceSource } from './source.mjs'

const sourceRoot = process.env.MIKKA_MOBILE_PRESENCE_SOURCE_ROOT
assert.ok(sourceRoot, 'the offline test needs the exact frozen product checkout')
const SHA = '1'.repeat(40), ownerId = 'offline-owner', home = '19df8afd-0f8c-4c6b-bc9c-20df0b046a72'
const deviceId = '20000000-0000-4000-8000-000000000001', secret = 'offline-mobile-api-secret'
const fixture = { deviceId, marker: 'presence-1212-offline' }
const initialRead = { devices: [{ id: deviceId, name: fixture.marker, online: true, enabled: false, harnesses: [] }], live: { ownerId, workspaceId: home } }
let source, helpers
before(async () => {
  source = await prepareMobilePresenceSource(sourceRoot)
  const load = path => import(pathToFileURL(source.directory + '/' + path).href)
  const [scope, homeProof, presence] = await Promise.all([load('lib/live/scope.mjs'), load('lib/live/home-scope-proof.mjs'), load('lib/device-presence-grant.mjs')])
  helpers = { ...scope, ...homeProof, ...presence }
})
after(() => source?.close())

function setup({ fixtureOnline = true, badGrant = false } = {}) {
  const scope = { ownerId, workspaceId: home }, issued = helpers.liveTicket(scope, { url: 'https://gateway.test', secret })
  const ticket = { ...issued, homeScope: helpers.homeScopeProof(scope, issued.expiresAt, secret) }, calls = []
  const session = { identity: { userId: ownerId }, version: { build: SHA }, request: async (path, init) => {
    calls.push({ path, init })
    assert.equal(path, '/api/mobile/threads'); assert.equal(init.method, 'GET')
    assert.equal(init.body, undefined)
    const proof = init.headers['x-mikka-presence-scope']
    const valid = proof ? helpers.readHomeScopeProof(proof, ownerId, secret) : null
    const presence = valid ? helpers.devicePresenceGrant(valid, [[badGrant ? '20000000-0000-4000-8000-000000000099' : deviceId, true, 0]], secret, Date.now(), valid.expiresAt) : null
    return Response.json({ threads: [{ id: 'not-evidence', name: 'private thread content must stay in memory' }],
      devices: [{ id: deviceId, name: 'private device name', online: fixtureOnline }],
      live: { ownerId, workspaceId: valid?.workspaceId ?? null, presence } })
  } }
  const options = { expectedSha: SHA, sourceRoot, ticket, initialRead, fixture, gatewayOrigin: 'wss://gateway.test', phase: 'setup-before-idle' }
  return { session, options, calls, ticket }
}

test('actual client proof holder and real signed server helpers validate exactly three ordinary setup reads', async () => {
  const fixture = setup()
  const report = await checkMobilePresenceSetup(fixture.session, fixture.options)
  assert.equal(report.status, 'passed')
  assert.equal(report.setupThreadReads, 3)
  assert.equal(report.addedTicketReads, 0); assert.equal(report.addedHomeReads, 0)
  assert.equal(report.mutations, 0); assert.equal(report.modelCalls, 0)
  assert.equal(report.phoneRendered, false); assert.equal(report.workerAcknowledgementChecked, false)
  assert.equal(report.signatureVerifiedLocally, false)
  assert.deepEqual(report.cases.map(row => [row.name, row.uncovered ?? false]), [['valid', false], ['absent', true], ['tampered-scope', true]])
  assert.equal(fixture.calls.length, 3)
  assert.equal(fixture.calls[0].init.headers['x-mikka-presence-scope'], fixture.ticket.homeScope.token)
  assert.deepEqual(fixture.calls[1].init.headers, {})
  assert.notEqual(fixture.calls[2].init.headers['x-mikka-presence-scope'], fixture.ticket.homeScope.token)
  const serialized = JSON.stringify(report)
  for (const sensitive of [secret, fixture.ticket.homeScope.token, fixture.ticket.protocol, ownerId, home, deviceId,
    'private thread content must stay in memory', 'private device name']) assert.equal(serialized.includes(sensitive), false)
})

test('wrong build, phase, owner and home are rejected before the first API read', async () => {
  for (const change of [
    options => { options.expectedSha = '2'.repeat(40) },
    options => { options.phase = 'healthy-idle' },
    options => { options.initialRead = { ...initialRead, live: { ...initialRead.live, ownerId: 'foreign' } } },
    options => { options.ticket = { ...options.ticket, homeScope: { ...options.ticket.homeScope, workspaceId: '20000000-0000-4000-8000-000000000099' } } },
  ]) {
    const fixture = setup(); change(fixture.options)
    await assert.rejects(checkMobilePresenceSetup(fixture.session, fixture.options), /presence_mobile_/)
    assert.equal(fixture.calls.length, 0)
  }
})

test('missing or expired home attestation does not trigger a ticket/home retry', async () => {
  for (const change of [
    options => { options.ticket = { ...options.ticket, homeScope: undefined } },
    options => { options.ticket = { ...options.ticket, expiresAt: Date.now() + 59_000 } },
  ]) {
    const fixture = setup(); change(fixture.options)
    await assert.rejects(checkMobilePresenceSetup(fixture.session, fixture.options), /presence_mobile_/)
    assert.equal(fixture.calls.length, 0)
  }
})

test('a mismatched returned device grant or offline fixture fails without retries or mutations', async () => {
  for (const fixture of [setup({ badGrant: true }), setup({ fixtureOnline: false })]) {
    await assert.rejects(checkMobilePresenceSetup(fixture.session, fixture.options), /presence_mobile_/)
    assert.equal(fixture.calls.length, 1)
  }
})

test('source pin failure occurs before transport, and only exact reviewed product modules are loaded', async () => {
  const fixture = setup()
  fixture.options.sourceRoot = '/nonexistent-mobile-source-fixture'
  await assert.rejects(checkMobilePresenceSetup(fixture.session, fixture.options), /presence_mobile_source_missing/)
  assert.equal(fixture.calls.length, 0)
  const pins = JSON.parse(readFileSync(new URL('./source-hashes.json', import.meta.url)))
  assert.equal(pins.hashes['apps/mobile/lib/presence-scope.ts'], source.hashes['apps/mobile/lib/presence-scope.ts'])
})
