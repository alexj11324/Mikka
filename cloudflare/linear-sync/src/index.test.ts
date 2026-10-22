import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { test } from 'node:test'
import { handleRequest, type Env } from './index'

const webhookSecret = 'worker-test-webhook-secret'
const ctx = { waitUntil: (_promise: Promise<unknown>) => {} }

test('exposes only webhook intake and the protected sync cron route', async () => {
  const response = await handleRequest(new Request('https://sync.example.test/mikka/api/integrations/linear/callback'), {}, ctx)
  assert.equal(response.status, 404)
})

test('returns 503 before accepting webhooks when the secret is missing', async () => {
  const response = await handleRequest(new Request('https://sync.example.test/mikka/api/webhooks/linear', { method: 'POST' }), {}, ctx)
  assert.equal(response.status, 503)
})

test('rejects unauthorized cron requests before accessing the database', async () => {
  const env: Env = { CRON_SECRET: 'worker-test-cron-secret' }
  const response = await handleRequest(new Request('https://sync.example.test/mikka/api/cron/linear-sync', {
    headers: { authorization: 'Bearer wrong' },
  }), env, ctx)
  assert.equal(response.status, 401)
})

test('acknowledges valid but unsupported Linear event types without database access', async () => {
  const payload = {
    action: 'update',
    type: 'AgentSession',
    organizationId: 'org-test',
    webhookTimestamp: Date.now(),
    data: { id: 'ignored-test' },
  }
  const body = JSON.stringify(payload)
  const signature = createHmac('sha256', webhookSecret).update(body).digest('hex')
  const response = await handleRequest(new Request('https://sync.example.test/mikka/api/webhooks/linear', {
    method: 'POST',
    headers: {
      'linear-delivery': 'delivery-test',
      'linear-event': 'AgentSession',
      'linear-signature': signature,
    },
    body,
  }), { LINEAR_WEBHOOK_SECRET: webhookSecret }, ctx)
  assert.equal(response.status, 200)
})
