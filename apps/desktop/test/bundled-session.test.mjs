import test from 'node:test'
import assert from 'node:assert/strict'
import { waitForBundledSession } from './bundled-session.mjs'

test('native session wait retries resolved null/false and another account, returning the matching value', async () => {
  const expected = { user: { id: 'owner' }, session: { id: 'public-session' } }
  const results = [null, false, { user: { id: 'peer' }, session: { id: 'other' } }, expected]
  let calls = 0
  const page = { isClosed: () => false, evaluate: async () => results[calls++] }
  assert.equal(await waitForBundledSession(page, 'owner', { interval: 1 }), expected)
  assert.equal(calls, 4)
})

test('native session wait tolerates the actual callback navigation but preserves IPC failures', async () => {
  const expected = { user: { id: 'owner' }, session: { id: 'public-session' } }
  let calls = 0
  const page = { isClosed: () => false, evaluate: async () => { if (++calls === 1) throw new Error('Execution context was destroyed, most likely because of a navigation'); return expected } }
  assert.equal(await waitForBundledSession(page, 'owner', { interval: 1 }), expected)
  page.evaluate = async () => { throw new Error('Invalid renderer frame') }
  await assert.rejects(waitForBundledSession(page, 'owner'), /Invalid renderer frame/)
})

test('native session wait fails with a bounded safe diagnostic instead of accepting a Promise', async () => {
  const page = { isClosed: () => false, evaluate: async () => null }
  await assert.rejects(waitForBundledSession(page, 'owner', { timeout: 10, interval: 1 }), /NATIVE_SESSION_WAIT_TIMEOUT/)
  page.evaluate = () => new Promise(() => {})
  await assert.rejects(waitForBundledSession(page, 'owner', { timeout: 10, interval: 1 }), /NATIVE_SESSION_WAIT_TIMEOUT/)
  page.isClosed = () => true
  await assert.rejects(waitForBundledSession(page, 'owner'), /NATIVE_SESSION_PAGE_CLOSED/)
})
