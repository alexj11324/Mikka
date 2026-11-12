import assert from 'node:assert/strict'
import test from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { isSessionControlWake, withSessionControlDelivery } from './session-control-delivery.mjs'

test('only the authorized native Session and hook wake in each concurrent request receive control delivery', async () => {
  const route = {method:'POST', path:'/eve/v1/session/:sessionId/cancel'}
  const wake = runId => ({runId, hookResumeTiming:{}})
  await Promise.all(['first','second'].map(sessionId => withSessionControlDelivery(route, sessionId, async () => {
    await setImmediate()
    assert.equal(isSessionControlWake(wake(sessionId)),true)
    assert.equal(isSessionControlWake(wake(sessionId === 'first' ? 'second' : 'first')),false)
    assert.equal(isSessionControlWake({runId:sessionId}),false)
  })))
  assert.equal(isSessionControlWake(wake('first')),false)
  for (const path of ['/eve/v1/session/:sessionId','/eve/v1/session/:sessionId/approval']) {
    withSessionControlDelivery({method:'POST', path}, 'first', () => assert.equal(isSessionControlWake(wake('first')),false))
  }
})
