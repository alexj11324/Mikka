import assert from 'node:assert/strict'
import test from 'node:test'
import { taskRequestEventId } from './task-request-event'

test('only one host inbox user event selects a device request', () => {
  const selected = { id: 'trusted-event', kind: 'user_message', payload: { taskDestination: { kind: 'device', deviceId: 'device' } } }
  assert.equal(taskRequestEventId([selected]), 'trusted-event')
  assert.equal(taskRequestEventId([selected, { id: 'second', kind: 'user_message', payload: {} }]), null)
  assert.equal(taskRequestEventId([{ id: 'peer', kind: 'run_finished', payload: selected.payload }]), undefined)
  assert.equal(taskRequestEventId([{ ...selected, payload: { taskDestination: { kind: 'cloud' } } }]), undefined)
})
