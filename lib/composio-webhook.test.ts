import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { test } from 'node:test'
import { verifyComposioWebhook } from './composio-webhook'

const secret = 'composio-webhook-test-secret'
const apiKey = 'composio-test-key'
const payload = JSON.stringify({
  id: 'evt_test',
  timestamp: new Date().toISOString(),
  type: 'composio.trigger.message',
  metadata: {},
  data: {},
})

function request(signature: 'valid' | 'invalid' = 'valid') {
  const id = 'msg_test'
  const timestamp = String(Math.floor(Date.now() / 1000))
  const digest = createHmac('sha256', secret).update(`${id}.${timestamp}.${payload}`).digest('base64')
  return new Request('https://app.example/mikka/api/webhooks/composio', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'webhook-id': id,
      'webhook-timestamp': timestamp,
      'webhook-signature': signature === 'valid' ? `v1,${digest}` : 'v1,invalid',
    },
    body: payload,
  })
}

test('verifies a valid Composio HMAC event', async () => {
  const result = await verifyComposioWebhook(request(), apiKey, secret)
  assert.equal(result.payload.triggerSlug, 'composio.trigger.message')
})

test('rejects an invalid Composio HMAC event', async () => {
  await assert.rejects(verifyComposioWebhook(request('invalid'), apiKey, secret))
})
