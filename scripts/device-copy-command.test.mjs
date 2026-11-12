import assert from 'node:assert/strict'
import test from 'node:test'
import { writeDeviceCommand } from '../lib/devices/copy-command.mjs'

test('a missing clipboard API cannot be reported as copied', async () => {
  assert.equal(await writeDeviceCommand('npm install -g agent', undefined), 'unavailable')
  assert.equal(await writeDeviceCommand('npm install -g agent', {}), 'unavailable')
})

test('clipboard denial reports failure and permits a later confirmed retry', async () => {
  const sent = []
  const clipboard = { writeText: async command => {
    sent.push(command)
    if (sent.length === 1) throw new Error('NotAllowedError')
  } }
  assert.equal(await writeDeviceCommand('sudo setup', clipboard), 'denied')
  assert.equal(await writeDeviceCommand('sudo setup', clipboard), 'copied')
  assert.deepEqual(sent, ['sudo setup', 'sudo setup'])
})

test('copy waits for the browser ACK before reporting success', async () => {
  let confirm
  const writes = []
  const clipboard = { writeText: command => {
    writes.push(command)
    return new Promise(resolve => { confirm = resolve })
  } }
  let settled = false
  const operation = writeDeviceCommand('curl install', clipboard).then(result => { settled = true; return result })
  await Promise.resolve()
  assert.equal(settled, false)
  assert.deepEqual(writes, ['curl install'])
  confirm()
  assert.equal(await operation, 'copied')
  assert.equal(settled, true)
})
