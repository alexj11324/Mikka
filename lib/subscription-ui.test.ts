import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { InvalidAuthorization, parseSubscriptionStart, planName } from './subscription-ui'

test('subscription consent opens only the fixed provider page for its own flow', () => {
  const state = 'a'.repeat(43)
  const base = { connectionId: randomUUID(), state, revision: 1, expiresAt: new Date(Date.now() + 60000).toISOString() }
  // The worker's startDevice result, as JSON-encoded by Go (RFC 3339 nanoseconds).
  const codex = { ...base, expiresAt: '2026-10-31T18:15:00.123456789Z', flow: 'device', authorizationUrl: 'https://auth.openai.com/codex/device', userCode: 'ABCD-EFGH', interval: 5 }
  assert.equal(parseSubscriptionStart(codex, 'codex').userCode, 'ABCD-EFGH')
  for (const authorizationUrl of ['https://auth.openai.com.evil.test/codex/device', 'https://evil.test/codex/device', 'http://auth.openai.com/codex/device', 'https://user:pass@auth.openai.com/codex/device', 'https://auth.openai.com/codex/device#x', 'https://auth.openai.com/codex/device?next=https://evil.test', 'https://auth.openai.com/oauth/authorize'])
    assert.throws(() => parseSubscriptionStart({ ...codex, authorizationUrl }, 'codex'), InvalidAuthorization, authorizationUrl)
  assert.throws(() => parseSubscriptionStart({ ...codex, userCode: undefined }, 'codex'), InvalidAuthorization)
  assert.throws(() => parseSubscriptionStart({ ...codex, flow: 'callback_handoff' }, 'codex'), InvalidAuthorization)
  assert.throws(() => parseSubscriptionStart({ error: 'subscription_unavailable' }, 'codex'), InvalidAuthorization)
  const claude = { ...base, flow: 'callback_handoff', authorizationUrl: `https://claude.ai/oauth/authorize?code=true&client_id=x&response_type=code&redirect_uri=http%3A%2F%2Flocalhost%3A54545%2Fcallback&scope=user%3Aprofile&code_challenge=y&code_challenge_method=S256&state=${state}` }
  assert.equal(parseSubscriptionStart(claude, 'claude').flow, 'callback_handoff')
  assert.throws(() => parseSubscriptionStart({ ...claude, state: 'b'.repeat(43) }, 'claude'), InvalidAuthorization)
  assert.throws(() => parseSubscriptionStart({ ...claude, authorizationUrl: claude.authorizationUrl.replace('claude.ai', 'claude.ai.evil.test') }, 'claude'), InvalidAuthorization)
})

test('plan names read as the providers write them', () => {
  assert.equal(planName('pro'), 'Pro')
  assert.equal(planName('plus'), 'Plus')
  assert.equal(planName('Max'), 'Max')
})
