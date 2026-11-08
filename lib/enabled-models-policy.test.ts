import assert from 'node:assert/strict'
import test from 'node:test'
import { modelEnabled, reconcileSubscriptionModels } from './enabled-models-policy'

test('subscription defaults use #1515 release families and keep distinct tiers', () => {
  const state = reconcileSubscriptionModels(['claude-opus-4-5', 'claude-opus-4-6', 'claude-haiku-5-5', 'gpt-5-luna', 'gpt-6-luna', 'custom'])
  assert.deepEqual(Object.entries(state.models).filter(([, item]) => item.enabled).map(([id]) => id), ['claude-opus-4-6', 'claude-haiku-5-5', 'gpt-6-luna', 'custom'])
  assert.equal(state.autoEnable, true)
})
test('automatic upgrades retire automatic old versions but preserve both explicit on and off', () => {
  const old = reconcileSubscriptionModels(['claude-opus-4-5', 'claude-haiku-5-5'])
  old.models['claude-haiku-5-5'] = { enabled: false, fresh: false, manual: true }
  const next = reconcileSubscriptionModels(['claude-opus-4-5', 'claude-opus-4-6', 'claude-haiku-5-5'], old)
  assert.equal(next.models['claude-opus-4-5'].enabled, false)
  assert.equal(next.models['claude-opus-4-6'].enabled, true)
  assert.equal(next.models['claude-haiku-5-5'].enabled, false)
  old.models['claude-opus-4-5'].manual = true
  assert.equal(reconcileSubscriptionModels(['claude-opus-4-5', 'claude-opus-4-6'], old).models['claude-opus-4-5'].enabled, true)
})
test('auto-enable off holds previous choices and new models remain off, including returning models', () => {
  const old = reconcileSubscriptionModels(['gpt-6-luna']); old.autoEnable = false
  const next = reconcileSubscriptionModels(['gpt-7-luna'], old)
  assert.equal(next.models['gpt-7-luna'].enabled, false)
  assert.equal(reconcileSubscriptionModels(['gpt-6-luna'], next).models['gpt-6-luna'].enabled, true)
  assert.equal(modelEnabled(null, 'legacy'), true)
})

 test('subscription reconciliation preserves the last successful refresh time until the refresh writer stamps it', () => {
  const state = reconcileSubscriptionModels(['gpt-6-luna'])
  state.refreshedAt = '2026-11-07T12:00:00Z'
  assert.equal(reconcileSubscriptionModels(['gpt-6-luna', 'gpt-7-luna'], state).refreshedAt, state.refreshedAt)
})
