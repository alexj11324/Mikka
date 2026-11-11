import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { before, beforeEach, mock, test } from 'node:test'
import { CloudServiceError } from './cloud-services/errors'
import { openSecret, type Sealed } from './secrets/crypto'

let hosted = false, content: 'full' | 'reminder' = 'reminder', startFails = false
const queries: { sql: string; params: unknown[] }[] = [], calls: { path: string; body: unknown }[] = [], starts: unknown[][] = []
let reply: Record<string, unknown> = {}
const stub = (path: string, namedExports: Record<string, unknown>) => mock.module(new URL(path, import.meta.url).href, { namedExports })
stub('./db/index.ts', { pool: { query: async (sql: string, params: unknown[] = []) => { queries.push({ sql, params }); return { rows: [], rowCount: 1 } } } })
stub('./edition.ts', { isCloudEdition: () => hosted })
stub('./cloud-services/runtime.ts', { cloudClient: { pushContent: async () => content }, cloudRequest: async (_user: string, scope: string, path: string, init: RequestInit) => { assert.equal(scope, 'push'); calls.push({ path, body: JSON.parse(String(init.body)) }); return Response.json(reply) } })
mock.module('workflow/api', { namedExports: { start: async (_workflow: unknown, args: unknown[]) => { starts.push(args); if (startFails) throw new Error('fixture workflow start unavailable') } } })
stub('../workflows/phone-push-receipts/workflow.ts', { phonePushReceipts: async () => {} })
let delivery: typeof import('./mobile-push-delivery')
before(async () => { process.env.WORKSPACE_SECRETS_KEY = randomBytes(32).toString('base64'); delivery = await import('./mobile-push-delivery') })
beforeEach(() => { hosted = false; content = 'reminder'; startFails = false; queries.length = 0; calls.length = 0; starts.length = 0; reply = {} })
const notification = { to: ['ExpoPushToken[fixture]'], title: 'Private customer name', body: 'Private message', data: { serverUrl: 'https://self.example/mikka', userId: 'local-owner', botId: 'fixture-bot', workspaceId: '11111111-1111-4111-8111-111111111111', issueId: '22222222-2222-4222-8222-222222222222', runId: '33333333-3333-4333-8333-333333333333', message: 'Private extra data' }, collapseId: 'fixture-bot' }
const proof = `1900000000.${'a'.repeat(64)}`

test('reminder mode sends only fixed visible text and routing identifiers', () => {
  const result = delivery.phonePushPayload(notification, 'reminder', 'en')
  assert.equal(result.title, 'Mikka'); assert.equal(result.body, 'New message')
  assert.deepEqual(result.data, { serverUrl: notification.data.serverUrl, userId: 'local-owner', botId: 'fixture-bot' })
  assert.equal(result.collapseId, notification.collapseId)
  assert.equal(JSON.stringify(result).includes('Private'), false)
  assert.equal(delivery.phonePushPayload(notification, 'reminder', 'zh-CN').body, '新消息')
  assert.deepEqual(delivery.phonePushPayload(notification, 'full', 'en'), notification)
})

test('partial rejection preserves accepted tickets before reporting a closed provider failure', async () => {
  const second = 'ExpoPushToken[rejected]'
  reply = { accepted: 1, invalidTokens: [], tickets: [{ id: 'accepted', token: notification.to[0], proof }], failures: [{ token: second, code: 'provider_credentials' }] }
  await assert.rejects(delivery.deliverPhonePush('local-owner', { ...notification, to: [...notification.to, second] }, 'en'), (error: unknown) => error instanceof CloudServiceError && error.code === 'cloud_unavailable')
  assert.equal(calls.length, 1); assert.equal(starts.length, 1)
  const row = queries.find(query => query.sql.startsWith('INSERT INTO mobile_push_receipts'))!
  assert.deepEqual(JSON.parse(openSecret(row.params[3] as Sealed, `mobile_push_receipts\0${row.params[0]}`)), [{ id: 'accepted', token: notification.to[0], proof }])
  assert.equal(JSON.stringify(row.params[3]).includes('accepted'), false)
})

test('a failed Workflow start keeps its durable receipt and does not resend an accepted notification', async () => {
  startFails = true
  reply = { accepted: 1, invalidTokens: [], tickets: [{ id: 'accepted', token: notification.to[0], proof }], failures: [] }
  await delivery.deliverPhonePush('local-owner', notification, 'en')
  assert.equal(calls.length, 1); assert.equal(starts.length, 1)
  assert.equal(queries.filter(query => query.sql.startsWith('INSERT INTO mobile_push_receipts')).length, 1)
})
