import test from 'node:test'
import assert from 'node:assert/strict'

import type { DaemonStatus } from '@mikka/protocol/daemon'

import { OFFLINE_DEVICE, toLocalDevice } from './daemon-map'

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
