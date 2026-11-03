import assert from 'node:assert/strict'
import test from 'node:test'
import { daemonStatusSchema } from '../../packages/protocol/src/daemon'
import { assertOnlineDaemonStatus } from './factory-handoff-acceptance.mjs'

test('handoff uses the actual protocol connectivity enum and binds the owned RPC directory/device', () => {
  const boundary = daemonStatusSchema.pick({ server: true, signedIn: true, dataDir: true, deviceId: true })
  const status = boundary.parse({ server: 'online', signedIn: true, dataDir: '/tmp/owned-daemon-b', deviceId: 'approved-b' })
  const expected = { dataDir: '/tmp/owned-daemon-b', deviceId: 'approved-b' }
  assertOnlineDaemonStatus(status, expected)
  assert.equal(boundary.safeParse({ ...status, server: 'http://localhost:3110/mikka' }).success, false)
  for (const change of [{ server: 'offline' }, { server: 'unregistered' }, { signedIn: false }, { deviceId: 'foreign' }, { dataDir: '/tmp/foreign-daemon' }]) {
    assert.throws(() => assertOnlineDaemonStatus(boundary.parse({ ...status, ...change }), expected))
  }
})
