import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { test } from 'node:test'
import { handleRequest, runScheduled, type Env } from './index'

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

test('disabled Worker webhook, protected cron and scheduler never read Hyperdrive or create background DB work', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ errorsWhileComputingFlags: false, flags: { 'mikka-linear-sync': { enabled: false } } }))
  let background = 0
  const env: Env = {
    NEXT_PUBLIC_POSTHOG_KEY: 'test-worker-disabled',
    LINEAR_WEBHOOK_SECRET: webhookSecret,
    CRON_SECRET: 'test-worker-cron',
    get HYPERDRIVE() { throw new Error('Disabled worker must not initialize or inspect its database') },
  }
  const body = JSON.stringify({ action: 'update', type: 'Issue', organizationId: 'org', webhookTimestamp: Date.now(), data: { id: 'issue' } })
  const response = await handleRequest(new Request('https://sync.example.test/mikka/api/webhooks/linear', {
    method: 'POST', body, headers: { 'linear-event': 'Issue', 'linear-delivery': 'paused-delivery', 'linear-signature': createHmac('sha256', webhookSecret).update(body).digest('hex') },
  }), env, { waitUntil: () => { background++ } })
  assert.equal(response.status, 503)
  assert.equal(response.headers.get('retry-after'), '60')
  const cron = await handleRequest(new Request('https://sync.example.test/mikka/api/cron/linear-sync', { headers: { authorization: 'Bearer test-worker-cron' } }), env, ctx)
  assert.deepEqual(await cron.json(), { inbox: 0, outbox: 0, disabled: true })
  await runScheduled(env)
  assert.equal(background, 0)
})

test('Worker requires an explicit true from its own configured PostHog project before loading sync', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ errorsWhileComputingFlags: false, flags: { 'mikka-linear-sync': { enabled: true } } }))
  const env: Env = { NEXT_PUBLIC_POSTHOG_KEY: 'test-worker-enabled', CRON_SECRET: 'test-worker-cron' }
  const request = () => new Request('https://sync.example.test/mikka/api/cron/linear-sync', { headers: { authorization: 'Bearer test-worker-cron' } })
  const enabled = await handleRequest(request(), env, ctx)
  assert.equal(enabled.status, 503)
  assert.deepEqual(await enabled.json(), { error: 'Linear sync is not configured' })
  // No project token stays off even when another project's flag was true.
  const unconfigured = await handleRequest(request(), { CRON_SECRET: env.CRON_SECRET }, ctx)
  assert.deepEqual(await unconfigured.json(), { inbox: 0, outbox: 0, disabled: true })
})
