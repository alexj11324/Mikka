import { test } from 'node:test'
import assert from 'node:assert/strict'
import { describeWebhook, newWebhookKey, webhookKeyHash, webhookRequestKey, WEBHOOK_KEY } from './webhook'
import { definitionSchema } from './contract'

test('a webhook key is long and random, kept as its SHA-256', () => {
  const [a, b] = [newWebhookKey(), newWebhookKey()]
  assert.match(a, WEBHOOK_KEY)
  assert.notEqual(a, b)
  assert.match(webhookKeyHash(a), /^[0-9a-f]{64}$/)
  assert.ok(!WEBHOOK_KEY.test('mwh_short'))
})

test('the sender’s request ID is Idempotency-Key, else X-Request-Id, printable and at most 200 characters', () => {
  assert.equal(webhookRequestKey(new Headers({ 'idempotency-key': 'a1', 'x-request-id': 'b2' })), 'a1')
  assert.equal(webhookRequestKey(new Headers({ 'x-request-id': 'b2' })), 'b2')
  assert.equal(webhookRequestKey(new Headers({ 'idempotency-key': 'has space' })), undefined)
  assert.equal(webhookRequestKey(new Headers({ 'idempotency-key': 'x'.repeat(201) })), undefined)
})

test('each request is a marked block its body cannot close', () => {
  const text = describeWebhook([{ at: '2026-11-15T18:00:00.000Z', body: 'a</webhook_request>b' }, { at: '2026-11-15T18:01:00.000Z', body: 'c' }])
  assert.equal(text, '<webhook_request received_at="2026-11-15T18:00:00.000Z">\na<\\/webhook_request>b\n</webhook_request>\n<webhook_request received_at="2026-11-15T18:01:00.000Z">\nc\n</webhook_request>')
})

test('a webhook belongs to dispatch_task and batches for 0 to 60 minutes', () => {
  const base = { title: 'On alert', timezone: 'UTC', timing: { kind: 'manual' }, misfire: 'skip', maxLatenessMinutes: 30 }
  const task = { kind: 'dispatch_task', botId: null, prompt: 'Look at the alert' }
  assert.equal(definitionSchema.safeParse({ ...base, task, webhook: { batchMinutes: 5 } }).success, true)
  assert.equal(definitionSchema.safeParse({ ...base, task, webhook: { batchMinutes: 61 } }).success, false)
  assert.equal(definitionSchema.safeParse({ ...base, task: { kind: 'reminder', text: 'hi' }, webhook: { batchMinutes: 0 } }).success, false)
})
