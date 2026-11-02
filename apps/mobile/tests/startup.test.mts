// Launch checks for updates, but never longer than its limit and never locking the person out.
import assert from 'node:assert/strict'
import test from 'node:test'
import { buildTooOld, within } from '../lib/startup.ts'

test('a build older than the minimum is stopped; an unknown one is let in', () => {
  assert.equal(buildTooOld('6', 7), true)
  assert.equal(buildTooOld('7', 7), false)
  assert.equal(buildTooOld('12', 7), false)
  assert.equal(buildTooOld(null, 7), false)
  assert.equal(buildTooOld('6', undefined), false)
  assert.equal(buildTooOld('6', '9'), false)
  assert.equal(buildTooOld('abc', 7), false)
})

test('a check that answers in time gives its answer', async () => {
  assert.equal(await within(Promise.resolve('new'), 50, 'skip'), 'new')
})

test('a check that hangs or fails gives the fallback', async () => {
  assert.equal(await within(new Promise<string>(() => {}), 20, 'skip'), 'skip')
  assert.equal(await within(Promise.reject(new Error('offline')), 50, 'skip'), 'skip')
})
