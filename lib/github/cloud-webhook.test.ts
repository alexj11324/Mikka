import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { test } from 'node:test'
import { verifyCloudGitHubSignature } from './cloud-webhook'

const now = Date.parse('2026-11-07T12:00:00Z'), body = '{"installation":{"id":99}}', secret = 'fixture-server-secret'
const sign = (at = now, payload = body) => { const t = Math.floor(at / 1000); return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex')}` }

test('cloud webhook authenticates the exact body and timestamp, at most five minutes away', () => {
  assert.equal(verifyCloudGitHubSignature(body, sign(), secret, now), true)
  assert.equal(verifyCloudGitHubSignature(body, sign(now - 300_000), secret, now), true)
  assert.equal(verifyCloudGitHubSignature(body, sign(now - 301_000), secret, now), false)
  assert.equal(verifyCloudGitHubSignature(body, sign(now + 301_000), secret, now), false)
  assert.equal(verifyCloudGitHubSignature(body + ' ', sign(), secret, now), false)
  assert.equal(verifyCloudGitHubSignature(body, sign(), 'other-server', now), false)
  for (const signature of [null, '', sign() + ',v1=other', 't=1,v1=00', sign().toUpperCase()]) assert.equal(verifyCloudGitHubSignature(body, signature, secret, now), false)
})
