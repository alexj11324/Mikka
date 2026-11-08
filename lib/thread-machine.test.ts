import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cloudMachineState, cloudShortId, deviceMachineKind, machineDot, machineStateWord, systemLabel } from './thread-machine'
import { readThreadMachine } from './thread-machine-view'
import type { Pool } from 'pg'

test('a cloud machine is named by the first six characters of its sandbox ID', () => {
  assert.equal(cloudShortId('i8k2m3n4p5q6r7s8t9u0'), 'i8k2m3')
})

test('a device is a server when its daemon says so, a laptop on macOS or Windows', () => {
  assert.equal(deviceMachineKind({ kind: 'cloud', deviceType: 'laptop', platform: 'linux' }), 'cloud')
  assert.equal(deviceMachineKind({ kind: 'local', deviceType: 'server', platform: 'darwin' }), 'server')
  assert.equal(deviceMachineKind({ kind: 'local', deviceType: 'laptop', platform: 'darwin' }), 'laptop')
  assert.equal(deviceMachineKind({ kind: 'local', deviceType: 'laptop', platform: 'linux' }), 'server')
  assert.equal(deviceMachineKind({ kind: 'local', deviceType: 'laptop', platform: null }), 'laptop')
})

test('the dot is green while the machine can work, red on error, grey otherwise', () => {
  assert.equal(machineDot('online'), 'running')
  assert.equal(machineDot('running'), 'running')
  assert.equal(machineDot('paused'), 'idle')
  assert.equal(machineDot('ended'), 'idle')
  assert.equal(machineDot('offline'), 'idle')
  assert.equal(machineDot('error'), 'failed')
  assert.equal(cloudMachineState('surprise'), 'error')
})

test('the system line reads as the OS and its architecture', () => {
  assert.equal(systemLabel('darwin', 'arm64'), 'macOS · arm64')
  assert.equal(systemLabel('linux', 'x64'), 'Linux · x64')
  assert.equal(systemLabel(null, null), null)
})

test('an ended write is not a confirmed retirement while its sandbox or provisioning receipt remains', () => {
  assert.equal(cloudMachineState('ended', { sandboxId: 'pending-vm' }), 'error')
  assert.equal(cloudMachineState('ended', { workerLeaseId: 'pending-create' }), 'error')
  assert.equal(cloudMachineState('ended', { workerLeaseUntil: new Date(0) }), 'error', 'expiry cannot acknowledge a provider operation')
  assert.equal(cloudMachineState('ended', { sandboxId: null, workerLeaseId: null, workerLeaseUntil: null }), 'ended')
  assert.equal(cloudMachineState('starting', { workerLeaseUntil: new Date(Date.now() + 60_000) }), 'starting')
})

const machineRow = (patch: Record<string, unknown> = {}) => ({
  runId: 'run', kind: 'cloud', deviceType: null, name: null, platform: null, arch: null, hostname: null,
  deviceId: 'device', lastSeenAt: null, sandboxId: 'vm', template: 'template', machineState: 'ended',
  machineCreatedAt: new Date('2026-11-07T00:00:00Z'), endedAt: new Date('2026-11-07T01:00:00Z'),
  workerLeaseId: null, workerLeaseUntil: null, ...patch,
})
const readMachines = (rows: ReturnType<typeof machineRow>[]) => ({ query: async () => ({ rows }) }) as unknown as Pool

test('the owner read shows unresolved cleanup as error and does not present its intent timestamp as retirement', async () => {
  const machine = await readThreadMachine(readMachines([machineRow()]), 'owner', ['run'])
  assert.equal(machine?.state, 'error')
  assert.equal(machine?.cloud?.sandboxId, 'vm')
  assert.equal(machine?.cloud?.endedAt, null)
})

test('a latest run with pending creation cleanup is visible before a cloud device or sandbox ID exists', async () => {
  const machine = await readThreadMachine(readMachines([
    machineRow({ runId: 'previous', machineState: 'paused' }),
    machineRow({ runId: 'current', kind: null, deviceId: null, sandboxId: null, workerLeaseUntil: new Date(0) }),
  ]), 'owner', ['previous', 'current'])
  assert.equal(machine?.kind, 'cloud')
  assert.equal(machine?.state, 'error')
  assert.equal(machine?.cloud, null)
})

test('a new cloud machine without a registered device displays its existing starting state', async () => {
  const machine = await readThreadMachine(readMachines([machineRow({ kind: null, deviceId: null, sandboxId: null, machineState: 'starting' })]), 'owner', ['run'])
  assert.equal(machine?.kind, 'cloud')
  assert.equal(machine?.state, 'starting')
})

test('confirmed retirement with cleared resource references displays ended', async () => {
  const machine = await readThreadMachine(readMachines([machineRow({ sandboxId: null, workerLeaseId: null, workerLeaseUntil: null })]), 'owner', ['run'])
  assert.equal(machine?.state, 'ended')
  assert.equal(machine?.cloud, null)
})

test('a computer whose daemon never reported in is never online, not offline', () => {
  assert.equal(machineStateWord({ kind: 'laptop', state: 'offline', lastSeenAt: null }), 'never')
  assert.equal(machineStateWord({ kind: 'server', state: 'offline', lastSeenAt: '2026-11-08T07:00:00.000Z' }), 'offline')
  assert.equal(machineStateWord({ kind: 'laptop', state: 'online', lastSeenAt: null }), 'online')
  assert.equal(machineStateWord({ kind: 'cloud', state: 'ended', lastSeenAt: null }), 'ended')
})
