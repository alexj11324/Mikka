import assert from 'node:assert/strict'
import test from 'node:test'
import { DEVICE_SESSION_HEADER, DEVICE_SESSION_VERSION, MIN_DAEMON_VERSION, SOURCE_DAEMON_VERSION } from '@mikka/protocol/device'
import { daemonRequestTooOld, daemonUpgradeResponse, daemonTooOld, daemonVersions, deviceSessionSupported, readLatestDaemonVersion, resetDaemonVersionCacheForTest } from './daemon-release'
import daemonPackage from '../packages/daemon/package.json' with { type: 'json' }

const registry = (body: unknown, status = 200) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch

test('only a plain release at or above the minimum is passed on from npm', async () => {
  assert.equal(await readLatestDaemonVersion(registry({ version: '0.0.460' })), '0.0.460')
  for (const body of [{ version: '0.0.461-beta.1' }, { version: '0.0.1' }, { version: '01.0.0' }, { version: 331 }, {}, null])
    assert.equal(await readLatestDaemonVersion(registry(body)), undefined, JSON.stringify(body))
  assert.equal(await readLatestDaemonVersion(registry({ version: '0.0.460' }, 503)), undefined)
  assert.equal(await readLatestDaemonVersion((async () => { throw new TypeError('offline') }) as unknown as typeof fetch), undefined)
})

test('the registry is read once per five minutes; no answer still sends the minimum', async () => {
  resetDaemonVersionCacheForTest()
  let reads = 0
  const read = async () => { reads++; return reads === 1 ? '0.0.460' : undefined }
  assert.deepEqual(await daemonVersions(0, read), { min: MIN_DAEMON_VERSION, latest: '0.0.460' })
  assert.deepEqual(await daemonVersions(299_999, read), { min: MIN_DAEMON_VERSION, latest: '0.0.460' })
  assert.equal(reads, 1)
  assert.deepEqual(await daemonVersions(300_000, read), { min: MIN_DAEMON_VERSION })
  assert.equal(reads, 2)
  resetDaemonVersionCacheForTest()
})

test('only released local daemons below the minimum are too old', () => {
  assert.equal(daemonTooOld({ kind: 'local', daemonVersion: '0.0.298' }), true)
  assert.equal(daemonTooOld({ kind: 'local', daemonVersion: 'garbage' }), true)
  assert.equal(daemonTooOld({ kind: 'local', daemonVersion: MIN_DAEMON_VERSION }), false)
  assert.equal(daemonTooOld({ kind: 'local', daemonVersion: '0.0.460' }), false)
  assert.equal(daemonTooOld({ kind: 'local', daemonVersion: SOURCE_DAEMON_VERSION }), false, 'run from source')
  assert.equal(daemonTooOld({ kind: 'local', daemonVersion: null }), false)
  assert.equal(daemonTooOld({ kind: 'cloud', daemonVersion: '0.0.1' }), false)
})

test('the source version is the daemon package\'s own', () => {
  assert.equal(daemonPackage.version, SOURCE_DAEMON_VERSION)
})

test('device admission requires a fixed binary independently of the login credential', async () => {
  for (const version of ['0.0.329', '0.0.455', 'garbage', null]) assert.equal(daemonRequestTooOld(version), true)
  assert.equal(daemonRequestTooOld(MIN_DAEMON_VERSION), false)
  assert.equal(daemonRequestTooOld('0.0.460'), false)
  assert.equal(daemonRequestTooOld(SOURCE_DAEMON_VERSION), false)
  assert.equal(daemonRequestTooOld(null, true), false, 'authenticated scoped cloud worker')
  const response = daemonUpgradeResponse()
  assert.equal(response.status, 426)
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store')
  assert.equal((await response.json()).minVersion, MIN_DAEMON_VERSION)
})


test('only a daemon that holds a device session is admitted; there is no update channel or run grace', () => {
  const request = (method: string, path: string, session?: string) => new Request(`https://app.example/mikka${path}`,
    { method, headers: session === undefined ? {} : { [DEVICE_SESSION_HEADER]: session } })
  for (const [method, path] of [['POST', '/v1/devices/fixture/report'], ['GET', '/v1/devices/fixture/commands'], ['GET', '/v1/devices/fixture/gateway'],
    ['POST', '/v1/devices/register'], ['POST', '/v1/runs/00000000-0000-4000-8000-000000000001/events']]) {
    assert.equal(deviceSessionSupported(request(method, path)), false, `${path} without the header`)
    assert.equal(deviceSessionSupported(request(method, path, String(DEVICE_SESSION_VERSION))), true, path)
  }
  for (const value of ['0', '', 'yes', '1.5', '-1', '9999999']) assert.equal(deviceSessionSupported(request('GET', '/v1/devices/fixture/commands', value)), false, value)
  assert.equal(deviceSessionSupported(request('GET', '/v1/devices/fixture/commands', String(DEVICE_SESSION_VERSION + 1))), true, 'a newer daemon')
})

test('the 426 body names the latest release this instance already knows, and never calls out', async () => {
  resetDaemonVersionCacheForTest()
  let reads = 0
  const read = async () => { reads++; return '0.0.900' }
  const first = await daemonUpgradeResponse(0).json()
  assert.deepEqual([first.code, first.daemonVersions], ['daemonUpgradeRequired', { min: MIN_DAEMON_VERSION }], 'nothing known yet: answered at once')
  assert.equal(reads, 0, 'a refusal never starts a read')
  // A report or commands answer learns the release; the next refusal names it.
  await daemonVersions(1, read)
  const next = await daemonUpgradeResponse(2).json()
  assert.deepEqual(next.daemonVersions, { min: MIN_DAEMON_VERSION, latest: '0.0.900' })
  assert.equal(reads, 1)
  assert.equal(next.code, 'daemonUpgradeRequired')
  resetDaemonVersionCacheForTest()
})
