import test from 'node:test'
import assert from 'node:assert/strict'

import { AppLoadState, offlineRetryDelay } from './offline'

test('offline reconnects back off and keep going', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 50].map(offlineRetryDelay), [2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000])
})

const APP = 'http://localhost:3100/mikka'
const OFFLINE = 'file:///app/dist/offline.html?app=http%3A%2F%2Flocalhost%3A3100%2Fmikka'

test("the failed URL's error page does not count as an app load", () => {
  const state = new AppLoadState('http://localhost:3100')
  // Order Electron reported with the server down: start app, fail, start offline page,
  // finish the app URL (its error page), finish the offline page.
  state.started(APP)
  state.failedLoad()
  state.started(OFFLINE)
  assert.equal(state.finished(APP), false)
  assert.equal(state.finished(OFFLINE), false)
})

test('a retry that fails again keeps the offline page retrying; one that succeeds stops it', () => {
  const state = new AppLoadState('http://localhost:3100')
  state.started(APP)
  state.failedLoad()
  state.started(APP)
  state.failedLoad()
  assert.equal(state.finished(APP), false)
  state.started(APP)
  assert.equal(state.finished(APP), true)
})
