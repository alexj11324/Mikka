import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { test } from 'node:test'
import { parseLinearWebhookRequest, verifyBearer } from './webhook'

const secret = 'test-webhook-secret'
const event = {
  action: 'update',
  type: 'Issue',
  organizationId: 'org-test',
  webhookTimestamp: Date.now(),
  data: { id: 'issue-test' },
}

function request(payload: unknown, options: { signature?: string; body?: string; eventType?: string } = {}) {
  const body = options.body ?? JSON.stringify(payload)
  const signature = options.signature ?? createHmac('sha256', secret).update(body).digest('hex')
  return new Request('https://sync.example.test/mikka/api/webhooks/linear', {
    method: 'POST',
    headers: {
      'linear-delivery': 'delivery-test',
      'linear-event': options.eventType ?? 'Issue',
      'linear-signature': signature,
    },
    body,
  })
}

test('accepts a signed Linear event and returns the validated payload', async () => {
  const result = await parseLinearWebhookRequest(request(event), secret)
  assert.deepEqual(result, {
    ok: true,
    deliveryId: 'delivery-test',
    eventType: 'Issue',
    organizationId: 'org-test',
    payload: event,
  })
})

test('rejects invalid signatures, stale events, and oversized bodies', async () => {
  const invalid = await parseLinearWebhookRequest(request(event, { signature: '0'.repeat(64) }), secret)
  assert.deepEqual(invalid, { ok: false, status: 401, error: 'Invalid Linear webhook signature' })

  const stale = await parseLinearWebhookRequest(request({ ...event, webhookTimestamp: Date.now() - 61_000 }), secret)
  assert.deepEqual(stale, { ok: false, status: 401, error: 'Invalid or expired Linear webhook' })

  const oversized = await parseLinearWebhookRequest(new Request('https://sync.example.test', {
    method: 'POST',
    headers: {
      'content-length': '1000001',
      'linear-delivery': 'delivery-test',
      'linear-event': 'Issue',
      'linear-signature': '0'.repeat(64),
    },
    body: '',
  }), secret)
  assert.deepEqual(oversized, { ok: false, status: 413, error: 'Webhook payload is too large' })
})

test('verifies cron bearer tokens without accepting missing configuration', async () => {
  assert.equal(await verifyBearer('Bearer cron-secret', 'cron-secret'), true)
  assert.equal(await verifyBearer('Bearer wrong', 'cron-secret'), false)
  assert.equal(await verifyBearer(null, 'cron-secret'), false)
})
