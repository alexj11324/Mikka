import assert from 'node:assert/strict'
import { test } from 'node:test'
import { detectedSubscription } from './use-agent-logins'

test('only a subscription login counts as detected, with its plan capitalised', () => {
  const logins = { claudeCode: { login: 'subscription' as const, plan: 'max' }, codex: { login: 'api-key' as const, plan: null } }
  assert.deepEqual(detectedSubscription(logins, 'claude'), { plan: 'Max' })
  assert.equal(detectedSubscription(logins, 'codex'), null)
  assert.equal(detectedSubscription(null, 'claude'), null)
  assert.deepEqual(detectedSubscription({ ...logins, codex: { login: 'subscription', plan: null } }, 'codex'), { plan: null })
})
