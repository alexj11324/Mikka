import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHmac } from 'node:crypto'
import { validSlackSignature } from './webhook'

const timestamp = '1792700000'
const secret = 'test-only-signing-secret'
const body = JSON.stringify({ type: 'url_verification', challenge: 'challenge' })
const signature = 'v0=' + createHmac('sha256', secret).update(`v0:${timestamp}:${body}`).digest('hex')
const now = Number(timestamp) * 1000

test('accepts a signed challenge, rejects changed bytes, wrong secret and malformed signatures', () => {
  assert.equal(validSlackSignature(body, timestamp, signature, secret, now), true)
  assert.equal(validSlackSignature(body + ' ', timestamp, signature, secret, now), false)
  assert.equal(validSlackSignature(body, timestamp, signature, 'other', now), false)
  for (const value of [null, '', 'v0=short', 'v0=' + 'z'.repeat(64)]) {
    assert.equal(validSlackSignature(body, timestamp, value, secret, now), false)
  }
})

test('rejects replayed and future requests outside the Slack five-minute window', () => {
  assert.equal(validSlackSignature(body, timestamp, signature, secret, now + 301_000), false)
  assert.equal(validSlackSignature(body, timestamp, signature, secret, now - 301_000), false)
  assert.equal(validSlackSignature(body, null, signature, secret, now), false)
  assert.equal(validSlackSignature(body, 'NaN', signature, secret, now), false)
})
