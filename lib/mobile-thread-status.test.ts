import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mobileThreadStatus } from './mobile-thread-status'

test('a run paused on its quota is 已暂停, not 运行中', () => {
  assert.equal(mobileThreadStatus('paused'), 'paused')
})

test('other run states keep their app state', () => {
  assert.equal(mobileThreadStatus('waiting_input'), 'waiting')
  assert.equal(mobileThreadStatus('failed'), 'failed')
  assert.equal(mobileThreadStatus('succeeded'), 'done')
  assert.equal(mobileThreadStatus('cancelled'), 'stopped')
  assert.equal(mobileThreadStatus('queued'), 'running')
  assert.equal(mobileThreadStatus('finishing'), 'running')
})
