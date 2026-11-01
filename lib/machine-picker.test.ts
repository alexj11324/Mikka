import assert from 'node:assert/strict'
import { test } from 'node:test'
import { defaultMachine, machineDot } from './machine-picker'

const cloud = (usable: boolean) => ({ value: 'cloud', cloud: true, usable })
const laptop = (usable: boolean) => ({ value: 'laptop', usable })
const server = (usable: boolean) => ({ value: 'server', usable })

test('without an E2B key the default is the first online device, never Mikka Cloud', () => {
  assert.equal(defaultMachine([cloud(false), laptop(false), server(true)])?.value, 'server')
  assert.equal(defaultMachine([cloud(false), laptop(true), server(true)])?.value, 'laptop')
})

test('with a key Mikka Cloud stays first and is the default', () => {
  assert.equal(defaultMachine([cloud(true), laptop(true)])?.value, 'cloud')
})

test('when nothing can run, the first machine stays selected', () => {
  assert.equal(defaultMachine([cloud(false), laptop(false)])?.value, 'cloud')
  assert.equal(defaultMachine([]), undefined)
})

test('Mikka Cloud is green only while running', () => {
  assert.equal(machineDot(cloud(false)), 'offline')
  assert.equal(machineDot(cloud(false), { machine: 'running' }), 'offline')
  assert.equal(machineDot(cloud(true)), 'offline')
  assert.equal(machineDot(cloud(true), { machine: 'sleeping' }), 'offline')
  assert.equal(machineDot(cloud(true), { machine: 'waking' }), 'offline')
  assert.equal(machineDot(cloud(true), { machine: 'running' }), 'online')
  assert.equal(machineDot(cloud(true), { machine: 'error' }), 'error')
})

test('a device is green only while online', () => {
  assert.equal(machineDot(laptop(true)), 'online')
  assert.equal(machineDot(laptop(false)), 'offline')
})
