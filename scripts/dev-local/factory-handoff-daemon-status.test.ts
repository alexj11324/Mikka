import assert from 'node:assert/strict'
import test from 'node:test'
import { daemonStatusSchema } from '../../packages/protocol/src/daemon'
import { assertOnlineDaemonStatus, waitForOnlineDaemonStatus } from './factory-handoff-acceptance.mjs'

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

test('readiness waits for registered RPC and the same approved owner device to become online', async () => {
  const boundary = daemonStatusSchema.pick({ server: true, signedIn: true, dataDir: true, deviceId: true })
  const expected = { dataDir: '/tmp/owned-daemon-a', deviceId: 'approved-a' }
  const values = [
    { server: 'unregistered', signedIn: false },
    { server: 'unregistered', signedIn: true },
    { server: 'offline', signedIn: true },
    { server: 'online', signedIn: true },
    { server: 'online', signedIn: true },
  ].map(value => boundary.parse({ ...expected, ...value }))
  let reads = 0, ownerReads = 0
  const result = await waitForOnlineDaemonStatus({ ...expected, root: '/tmp/acceptance-source',
    readStatus: () => values[reads++],
    devices: async () => [{ id: expected.deviceId, online: ++ownerReads > 1 }],
    until: async (predicate: () => Promise<unknown>) => { for (let i = 0; i < 5; i++) { const value = await predicate(); if (value) return value } throw new Error('Did not become ready') },
  })
  assert.equal(result, values.at(-1))
  assert.equal(reads, 5)
  assert.equal(ownerReads, 2)
})

test('unregistered or offline readiness is bounded and never accepted as ready', async () => {
  for (const server of ['unregistered', 'offline']) {
    let clock = 0
    await assert.rejects(waitForOnlineDaemonStatus({ root: '/tmp/acceptance-source', dataDir: '/tmp/owned-daemon-a', deviceId: 'approved-a',
      readStatus: () => ({ server, signedIn: true, dataDir: '/tmp/owned-daemon-a', deviceId: 'approved-a' }),
      devices: async () => { throw new Error('Must not accept owner heartbeat as daemon RPC readiness') },
      now: () => clock, timeoutMs: 2,
      until: async (predicate: () => Promise<unknown>) => { for (;;) { const value = await predicate(); if (value) return value; clock++ } },
    }), new RegExp(`Daemon readiness timed out.*server=${server}`))
  }
})

test('only the CLI missing-daemon response is a startup transition; RPC and owner API errors fail', async () => {
  const dataDir = '/tmp/owned-daemon-b'
  const online = { server: 'online', signedIn: true, dataDir, deviceId: 'approved-b' }
  let reads = 0
  const base = { root: '/tmp/acceptance-source', dataDir, deviceId: undefined, devices: async () => [{ id: 'approved-b', online: true }],
    until: async (predicate: () => Promise<unknown>) => { for (let i = 0; i < 3; i++) { const value = await predicate(); if (value) return value } throw new Error('Did not become ready') },
  }
  assert.equal(await waitForOnlineDaemonStatus({ ...base, readStatus: () => {
    if (!reads++) throw Object.assign(new Error('CLI not listening yet'), { status: 1, stderr: `No daemon running for ${dataDir}\n` })
    return online
  } }), online)
  const rpcError = Object.assign(new Error('RPC authentication rejected'), { status: 1, stderr: 'Wrong daemon secret' })
  await assert.rejects(waitForOnlineDaemonStatus({ ...base, readStatus: () => { throw rpcError } }), error => error === rpcError)
  const apiError = new Error('Owner device API unavailable')
  await assert.rejects(waitForOnlineDaemonStatus({ ...base, readStatus: () => online, devices: async () => { throw apiError } }), error => error === apiError)
  await assert.rejects(waitForOnlineDaemonStatus({ ...base, readStatus: () => ({ ...online, dataDir: '/tmp/foreign' }) }), /another data directory/)
})
