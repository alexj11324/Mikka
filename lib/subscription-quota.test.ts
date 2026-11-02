import assert from 'node:assert/strict'
import { test } from 'node:test'
import { subscriptionAvailability } from './subscription-quota'

const now = Date.parse('2026-11-02T18:00:00Z')
const quota = (windows: unknown[], fields = {}) => ({ vendor: 'claude_code', source: 'official', status: 'ok', plan: null, observedAt: new Date(now).toISOString(), windows, ...fields })
const account = { kind: 'weekly', used: 0.3, resetsAt: null }

test('availability distinguishes fresh allowance from unknown and stale observations', () => {
  assert.equal(subscriptionAvailability(null, 'claude-haiku-5-5', 'claude', now).status, 'checking')
  assert.equal(subscriptionAvailability(quota([account], { observedAt: new Date(now - 60_001).toISOString() }), 'claude-haiku-5-5', 'claude', now).status, 'checking')
  assert.equal(subscriptionAvailability(quota([account]), 'claude-haiku-5-5', 'claude', now).status, 'available')
  assert.equal(subscriptionAvailability(quota([account]), 'gpt-6.1-sol', 'codex', now).status, 'checking')
})

test('an exhausted Opus allowance does not exhaust Haiku or Sonnet', () => {
  const value = quota([account, { ...account, model: 'Opus', used: 1 }])
  assert.equal(subscriptionAvailability(value, 'claude-haiku-5-5', 'claude', now).status, 'available')
  assert.equal(subscriptionAvailability(value, 'claude-sonnet-5-5', 'claude', now).status, 'available')
  assert.equal(subscriptionAvailability(value, 'claude-opus-5-5', 'claude', now).status, 'exhausted')
  assert.equal(subscriptionAvailability(quota([{ ...account, used: 1 }]), 'claude-haiku-5-5', 'claude', now).status, 'exhausted')
})

test('unknown exhausted scope is checking, and a clock crossing a reset cannot manufacture capacity', () => {
  assert.equal(subscriptionAvailability(quota([account, { ...account, model: 'Scoped 2', used: 1 }]), 'claude-haiku-5-5', 'claude', now).status, 'checking')
  assert.equal(subscriptionAvailability(quota([account, { ...account, model: 'Claude Opus 4.6', used: 1 }]), 'claude-opus-latest', 'claude', now).status, 'checking')
  assert.equal(subscriptionAvailability(quota([account, { ...account, model: 'Claude Opus 4.6', used: 1 }]), 'claude-opus-4-6-20261101', 'claude', now).status, 'exhausted')
  const reset = new Date(now - 1000).toISOString()
  const value = quota([{ ...account, used: 1, resetsAt: reset }], { observedAt: new Date(now - 2000).toISOString() })
  assert.equal(subscriptionAvailability(value, 'claude-haiku-5-5', 'claude', now).status, 'checking')
  assert.equal(subscriptionAvailability(quota([{ ...account, used: 1, resetsAt: reset }]), 'claude-haiku-5-5', 'claude', now).status, 'exhausted')
})

test('recovery waits for every exhausted applicable window and stays unnamed if one has no reset', () => {
  const first = new Date(now + 3_600_000).toISOString()
  const last = new Date(now + 7_200_000).toISOString()
  const windows = [{ ...account, used: 1, resetsAt: first }, { ...account, used: 1, resetsAt: last }]
  assert.equal(subscriptionAvailability(quota(windows), 'claude-haiku-5-5', 'claude', now).resetsAt, last)
  assert.equal(subscriptionAvailability(quota([...windows, { ...account, used: 1 }]), 'claude-haiku-5-5', 'claude', now).resetsAt, null)
})
