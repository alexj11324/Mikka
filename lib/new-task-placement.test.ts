import assert from 'node:assert/strict'
import test from 'node:test'
import { defaultTaskMachine, pickedTaskDestination, taskMachineUsable } from './new-task-placement'

const machines = [{ value: 'cloud', cloud: true, usable: true }, { value: 'laptop', usable: true }, { value: 'server', usable: true }]

test('a new task inherits 会先用: the cloud, a server or a computer, whatever 运行位置 is', () => {
  assert.equal(defaultTaskMachine(machines, { first: { kind: 'device', id: 'server' } })?.value, 'server')
  assert.equal(defaultTaskMachine(machines, { first: { kind: 'cloud' } })?.value, 'cloud')
  assert.equal(defaultTaskMachine(machines, undefined), undefined, 'do not guess a different place while settings load')
  assert.equal(defaultTaskMachine(machines, { first: null }), undefined, 'nowhere to run does not guess a particular computer')
  assert.equal(defaultTaskMachine([machines[0]], { first: null }), undefined, 'nowhere to run does not silently choose cloud')
})

test('online devices also need scheduling enabled and the dispatch planner to accept their Agent and credential', () => {
  const device = { id: 'device', enabled: true, online: true }
  assert.equal(taskMachineUsable(device, ['device']), true)
  assert.equal(taskMachineUsable({ ...device, enabled: false }, ['device']), false)
  assert.equal(taskMachineUsable({ ...device, online: false }, ['device']), false)
  assert.equal(taskMachineUsable(device, []), false, 'missing Agent, broker or usable credential is not ready')
})

test('only an explicit destination overrides the workspace default', () => {
  assert.equal(pickedTaskDestination(null), undefined)
  assert.deepEqual(pickedTaskDestination('cloud'), { kind: 'cloud' })
  assert.deepEqual(pickedTaskDestination('cloudflare'), { kind:'cloud',provider:'cloudflare' })
  assert.deepEqual(pickedTaskDestination('device'), { kind: 'device', deviceId: 'device' })
})
