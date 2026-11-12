import assert from 'node:assert/strict'
import test from 'node:test'
import { mayRestart, restartPlan, stoppedHost } from '../runtime/restarts.mjs'

test('crash events schedule a bounded sequence instead of an unbounded restart loop', () => {
  let state
  for (const [index, seconds] of [1, 5, 30].entries()) {
    state = restartPlan(state, 'release-1', 10_000)
    assert.equal(state.attempt, index + 1)
    assert.equal(state.dueAt, 10_000 + seconds * 1000)
    assert.equal(mayRestart(state, { releaseId: 'release-1', attempt: index + 1 }), true)
  }
  assert.equal(restartPlan(state, 'release-1', 20_000), null)
})

test('operator cleanup survives restoration and prevents a scheduled restart', () => {
  const pending = restartPlan(undefined, 'release-1', 10_000)
  const stopped = structuredClone(stoppedHost(pending, 'release-1'))
  assert.equal(restartPlan(stopped, 'release-1', 20_000), null)
  assert.equal(mayRestart(stopped, pending), false)
})

test('old release or old attempt callbacks cannot resurrect a retired service', () => {
  const first = restartPlan(undefined, 'release-1', 10_000)
  const second = restartPlan(first, 'release-1', 20_000)
  assert.equal(mayRestart(second, first), false)
  assert.equal(mayRestart(second, { ...second, releaseId: 'release-2' }), false)
  assert.equal(restartPlan(first, 'release-2', 20_000), null)
  assert.equal(restartPlan({ attempt: -1 }, 'release-1', 20_000), null)
})

test('a stable running service gets a fresh incident budget after ten minutes', () => {
  const state = { releaseId: 'release-1', attempt: 3, startedAt: 10_000 }
  assert.equal(restartPlan(state, 'release-1', 11_000), null)
  assert.equal(restartPlan(state, 'release-1', 610_000).attempt, 1)
  assert.equal(restartPlan({ ...state, stopped: true }, 'release-1', 610_000), null)
})
