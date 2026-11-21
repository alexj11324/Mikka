import assert from 'node:assert/strict'
import test from 'node:test'
import type { ThreadMachine } from '../../../lib/thread-machine.ts'
import { mobileMessages } from '../lib/messages.ts'
import { machineLines } from '../lib/thread-machine.ts'

const machine: ThreadMachine = {
  kind: 'cloud', state: 'restore', name: null, platform: null, arch: null, hostname: null, lastSeenAt: null, cloud: null,
}

test('mobile presents a restoring cloud machine and a never-connected device using the shared states', () => {
  const restoring = machineLines(machine)
  assert.equal(restoring.state, mobileMessages.ThreadRunPlace.states.restore)
  assert.equal(restoring.live, true)
  const local: ThreadMachine = { ...machine, kind: 'laptop', state: 'offline' }
  assert.equal(machineLines(local).state, mobileMessages.ThreadRunPlace.states.never)
  assert.equal(machineLines({ ...local, lastSeenAt: '2026-11-15T09:00:00.000Z' }).state, mobileMessages.ThreadRunPlace.states.offline)
})
