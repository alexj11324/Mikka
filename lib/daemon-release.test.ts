import assert from 'node:assert/strict'
import test from 'node:test'
import { MIN_DAEMON_VERSION, SOURCE_DAEMON_VERSION } from '@mikka/protocol/device'
import { daemonTooOld, daemonVersions, readLatestDaemonVersion, resetDaemonVersionCacheForTest } from './daemon-release'
import daemonPackage from '../packages/daemon/package.json' with { type: 'json' }

const registry = (body: unknown, status = 200) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch

test('only a plain release at or above the minimum is passed on from npm', async () => {
  assert.equal(await readLatestDaemonVersion(registry({ version: '0.0.331' })), '0.0.331')
  for (const body of [{ version: '0.0.332-beta.1' }, { version: '0.0.1' }, { version: '01.0.0' }, { version: 331 }, {}, null])
    assert.equal(await readLatestDaemonVersion(registry(body)), undefined, JSON.stringify(body))
  assert.equal(await readLatestDaemonVersion(registry({ version: '0.0.331' }, 503)), undefined)
  assert.equal(await readLatestDaemonVersion((async () => { throw new TypeError('offline') }) as unknown as typeof fetch), undefined)
})

test('the registry is read once per five minutes; no answer still sends the minimum', async () => {
  resetDaemonVersionCacheForTest()
  let reads = 0
  const read = async () => { reads++; return reads === 1 ? '0.0.331' : undefined }
  assert.deepEqual(await daemonVersions(0, read), { min: MIN_DAEMON_VERSION, latest: '0.0.331' })
  assert.deepEqual(await daemonVersions(299_999, read), { min: MIN_DAEMON_VERSION, latest: '0.0.331' })
  assert.equal(reads, 1)
  assert.deepEqual(await daemonVersions(300_000, read), { min: MIN_DAEMON_VERSION })
  assert.equal(reads, 2)
  resetDaemonVersionCacheForTest()
})

test('only released local daemons below the minimum are too old', () => {
  assert.equal(daemonTooOld({ kind: 'local', daemonVersion: '0.0.298' }), true)
  assert.equal(daemonTooOld({ kind: 'local', daemonVersion: 'garbage' }), true)
  assert.equal(daemonTooOld({ kind: 'local', daemonVersion: MIN_DAEMON_VERSION }), false)
  assert.equal(daemonTooOld({ kind: 'local', daemonVersion: '0.0.331' }), false)
  assert.equal(daemonTooOld({ kind: 'local', daemonVersion: SOURCE_DAEMON_VERSION }), false, 'run from source')
  assert.equal(daemonTooOld({ kind: 'local', daemonVersion: null }), false)
  assert.equal(daemonTooOld({ kind: 'cloud', daemonVersion: '0.0.1' }), false)
})

test('the source version is the daemon package\'s own', () => {
  assert.equal(daemonPackage.version, SOURCE_DAEMON_VERSION)
})
