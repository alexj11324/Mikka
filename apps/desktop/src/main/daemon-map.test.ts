import test from 'node:test'
import assert from 'node:assert/strict'

import type { DaemonStatus } from '@mikka/protocol/daemon'

import { OFFLINE_DEVICE, toLocalDevice } from './daemon-map'
import { localSetupController, readLocalDeviceAccount, readLocalDeviceOwner } from './local-setup'
import { SshInstaller, type SshInstallState } from './ssh-install'
import { localSetupAction } from '../../../../lib/local-device-setup'

const status = (overrides: Partial<DaemonStatus> = {}): DaemonStatus => ({
  daemonVersion: '0.0.1',
  protocolVersion: 3,
  pid: 1,
  dataDir: '/tmp/mikka',
  deviceId: 'device-1',
  workspaceId: 'workspace-1',
  signedIn: true,
  server: 'online',
  harnesses: [],
  runs: [],
  worktreeDiskBytes: 0,
  pendingUploads: 0,
  draining: false,
  quotas: [],
  ...overrides,
})

test('maps a running daemon to the local device the UI shows', () => {
  assert.deepEqual(toLocalDevice(status()), {
    status: 'online',
    deviceId: 'device-1',
    workspaceId: 'workspace-1',
    signedIn: true,
    server: 'online',
  })
})

test('keeps an unregistered daemon online but without an identity', () => {
  assert.deepEqual(toLocalDevice(status({ deviceId: null, workspaceId: null, signedIn: false, server: 'unregistered' })), {
    status: 'online',
    deviceId: null,
    workspaceId: null,
    signedIn: false,
    server: 'unregistered',
  })
})

test('the offline device carries no identity at all', () => {
  assert.deepEqual(OFFLINE_DEVICE, {
    status: 'offline',
    deviceId: null,
    workspaceId: null,
    signedIn: false,
    server: null,
  })
})

test('main reads the current authenticated device account without caching or following a redirect', async () => {
  let owner = 'a', signedIn = true
  const read = () => readLocalDeviceAccount(async (url, init) => {
    assert.equal(url, 'https://example.com/mikka/api/devices/enrollment')
    assert.equal(init.cache, 'no-store')
    assert.equal(init.redirect, 'error')
    return signedIn ? Response.json({ ownerId: owner, deviceIds: [`device-${owner}`] }) : new Response(null, { status: 401 })
  }, 'https://example.com/mikka')
  assert.equal((await read()).ownerId, 'a')
  owner = 'b'
  assert.equal((await read()).ownerId, 'b')
  signedIn = false
  await assert.rejects(read(), /Sign in/)
})

test('setup admission reads only the fresh owner while daemon verification still reads devices', async () => {
  let owner: string | null = 'owner-a'
  const requests: string[] = []
  const fetcher = async (url: string, init: RequestInit) => {
    requests.push(new URL(url).search)
    assert.equal(init.cache, 'no-store')
    assert.equal(init.redirect, 'error')
    if (owner === null) return new Response(null, { status: 401 })
    return Response.json(new URL(url).search === '?view=owner' ? { ownerId: owner } : { ownerId: owner, deviceIds: ['owned-device'] })
  }
  const app = 'https://example.com/mikka/'
  assert.deepEqual(await readLocalDeviceOwner(fetcher, app), { ownerId: 'owner-a' })
  owner = 'owner-b'
  assert.deepEqual(await readLocalDeviceOwner(fetcher, app), { ownerId: 'owner-b' })
  assert.deepEqual(await readLocalDeviceAccount(fetcher, app), { ownerId: 'owner-b', deviceIds: ['owned-device'] })
  owner = null
  await assert.rejects(readLocalDeviceOwner(fetcher, app), /Sign in/)
  assert.deepEqual(requests, ['?view=owner', '?view=owner', '', '?view=owner'])
  await assert.rejects(readLocalDeviceOwner(async () => Response.json({ deviceIds: [] }), app))
})

test('the bridge setup follows A→B→A in one process, preserves a workspace switch, and only reports owned devices online', async () => {
  let owner = 'a', daemonDevice = 'device-a', minted = 0
  const devices = new Map([['a', ['device-a']], ['b', [] as string[]]])
  const events: SshInstallState[] = [], scripts: string[] = []
  const account = async () => ({ ownerId: owner, deviceIds: devices.get(owner)! })
  const local = () => toLocalDevice(status({ deviceId: daemonDevice }))
  let finish!: () => void
  let done = new Promise<void>(resolve => { finish = resolve })
  const installer = new SshInstaller('https://example.com/mikka', async () => { minted++; return `private-${owner}` }, state => {
    events.push(state)
    if (state.status === 'online' || state.status === 'failed') finish()
  }, async (_command, args) => {
    await Promise.resolve()
    const script = args[1]
    scripts.push(script)
    if (script.startsWith('mikka daemon login')) { daemonDevice = `device-${owner}`; devices.set(owner, [daemonDevice]) }
    if (script.startsWith('mikka daemon status')) return JSON.stringify({ server: 'online', deviceId: daemonDevice })
    return ''
  }, '/home/nobody', undefined, undefined, 'prod', { command: '/bin/sh', args: script => ['-lc', script] }, async (id, expectedOwner) => {
    const current = await account()
    return current.ownerId === expectedOwner && current.deviceIds.includes(id)
  })
  const bridge = localSetupController(installer, account)
  await bridge.automatic('repair')
  await done
  assert.equal(installer.state()?.deviceId, 'device-a')
  assert.equal(minted, 0, 'repairing this account does not register it twice')
  const beforeWorkspaceSwitch = scripts.length
  await Promise.all([bridge.automatic('repair'), bridge.automatic('repair')])
  assert.equal(scripts.length, beforeWorkspaceSwitch, 'the same account in another workspace is deduplicated')
  owner = 'b'
  assert.equal(localSetupAction(local(), devices.get(owner)!), 'install')
  done = new Promise<void>(resolve => { finish = resolve })
  const from = events.length
  // The daemon had been unreachable at the renderer check; restarting it
  // uncovers A's live identity. Main must verify it before declaring success.
  await bridge.automatic('repair')
  await done
  assert.equal(installer.state()?.deviceId, 'device-b')
  assert.ok(events.slice(from).every(state => state.status !== 'online' || state.deviceId === 'device-b'))
  assert.equal(minted, 1)
  assert.equal(localSetupAction(local(), devices.get(owner)!), 'none')
  owner = 'a'
  done = new Promise<void>(resolve => { finish = resolve })
  await bridge.automatic('install')
  await done
  assert.equal(installer.state()?.deviceId, 'device-a')
  assert.equal(minted, 2, 'returning to A is a new account context, not the first launch latch')
})
