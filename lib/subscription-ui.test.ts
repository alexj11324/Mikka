import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { parseSubscriptionStart } from './subscription-ui'

test('subscription consent opens only the fixed provider page for its own flow', () => {
  const state = 'a'.repeat(43)
  const base = { connectionId: randomUUID(), state, revision: 1, expiresAt: new Date(Date.now() + 60000).toISOString() }
  const codex = { ...base, flow: 'device', authorizationUrl: 'https://auth.openai.com/codex/device', userCode: 'ABCD-EFGH', interval: 5 }
  assert.equal(parseSubscriptionStart(codex, 'codex').userCode, 'ABCD-EFGH')
  assert.throws(() => parseSubscriptionStart({ ...codex, authorizationUrl: 'https://auth.openai.com.evil.test/codex/device' }, 'codex'))
  assert.throws(() => parseSubscriptionStart({ ...codex, authorizationUrl: 'https://auth.openai.com/codex/device?next=https://evil.test' }, 'codex'))
  const claude = { ...base, flow: 'callback_handoff', authorizationUrl: `https://claude.ai/oauth/authorize?state=${state}&redirect_uri=http%3A%2F%2Flocalhost%3A54545%2Fcallback&code_challenge_method=S256` }
  assert.equal(parseSubscriptionStart(claude, 'claude').flow, 'callback_handoff')
  assert.throws(() => parseSubscriptionStart({ ...claude, state: 'b'.repeat(43) }, 'claude'))
})
