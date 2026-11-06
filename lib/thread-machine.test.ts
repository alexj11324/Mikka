import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cloudMachineState, cloudShortId, deviceMachineKind, machineDot, systemLabel } from './thread-machine'

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
