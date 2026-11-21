import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import type { SQL } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import { tokenWorkspace } from '../lib/tokens/principal'

const BOT = '6b0f2c8e-2d5c-4a1e-9a7b-0d6f3c1e2a4b'
const WORKSPACE = '638f1703-d835-4d0f-936d-631b96784e37'
let signedIn: { id: string; [tokenWorkspace]?: string } | null = { id: 'fixture-owner' }
let enabled = true, allowed = true, writable = true
let outcome: { queued: boolean; reason?: string } = { queued: false, reason: 'nothingToRetry' }
const retries: { ownerId: string; botId: string; headers: Headers }[] = []
const predicates: unknown[][] = []
const dialect = new PgDialect()
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
mock.module(new URL('../lib/mobile-api.ts', import.meta.url).href, { namedExports: {
  json, mobileUser: async () => signedIn, writeAllowed: () => writable,
  unauthorized: () => json({ error: 'authRequired' }, 401), forbiddenOrigin: () => json({ error: 'originNotAllowed' }, 403),
} })
mock.module(new URL('../lib/request-log.ts', import.meta.url).href, { namedExports: { withRequestLog: (_: string, handler: unknown) => handler, noteLogUser: () => {} } })
mock.module(new URL('../lib/db/index.ts', import.meta.url).href, { namedExports: { db: { select: () => ({ from: () => ({ where: (condition: SQL) => {
  predicates.push(dialect.sqlToQuery(condition).params)
  return { limit: async () => allowed ? [{ id: BOT }] : [] }
} }) }) } } })
mock.module(new URL('../lib/coordinator/coordinator-bot.ts', import.meta.url).href, { namedExports: { openChatBotId: async () => BOT } })
mock.module(new URL('../lib/coordinator/wake.ts', import.meta.url).href, { namedExports: { coordinatorEnabled: () => enabled } })
mock.module(new URL('../lib/eve/retry.ts', import.meta.url).href, { namedExports: {
  retryEveTurn: async (ownerId: string, botId: string, headers: Headers) => {
    retries.push({ ownerId, botId, headers: new Headers(headers) })
    return outcome
  },
} })
const route = import('../app/api/mobile/chat/retry/route')
async function post(headers: HeadersInit = {}, body: unknown = { botId: BOT }) {
  const { POST } = await route
  const response = await POST(new Request('https://fixture.example/api/mobile/chat/retry', { method: 'POST', headers, body: JSON.stringify(body) }))
  return { status: response.status, body: await response.json() }
}

test('mobile retry returns the native adapter outcome without scheduling a legacy wake', async () => {
  retries.length = 0
  enabled = false
  assert.deepEqual((await post()).body, { queued: false, reason: 'unavailable' })
  assert.equal(retries.length, 0)
  enabled = true
  outcome = { queued: false, reason: 'working' }
  assert.deepEqual((await post()).body, outcome)
  outcome = { queued: false, reason: 'nothingToRetry' }
  assert.deepEqual((await post()).body, outcome)
  outcome = { queued: true }
  assert.deepEqual((await post()).body, outcome)
  assert.equal(retries.length, 3)
})

test('the verified owner and Bot scope reach the native adapter with caller credentials and Origin', async () => {
  retries.length = 0; predicates.length = 0
  signedIn = { id: 'fixture-owner', [tokenWorkspace]: WORKSPACE }
  const headers = { authorization: 'Bearer current-caller', origin: 'https://fixture.example', 'x-mikka-workspace-id': WORKSPACE, 'x-mikka-locale': 'zh' }
  assert.deepEqual(await post(headers), { status: 200, body: { queued: true } })
  assert.deepEqual(predicates, [[BOT, 'fixture-owner', WORKSPACE]])
  assert.deepEqual(retries.map(({ ownerId, botId }) => ({ ownerId, botId })), [{ ownerId: 'fixture-owner', botId: BOT }])
  for (const [key, value] of Object.entries(headers)) assert.equal(retries[0].headers.get(key), value)
  signedIn = { id: 'fixture-owner' }
  await post({ cookie: 'mobile=current-session' }, {})
  assert.equal(retries[1].ownerId, 'fixture-owner')
  assert.equal(retries[1].botId, BOT)
  assert.equal(retries[1].headers.get('cookie'), 'mobile=current-session')
  assert.equal(retries[1].headers.get('origin'), null, 'the authenticated server adapter supplies a missing native-mobile Origin')
})

test('signed out, forbidden Origin, invalid Bot and another owner never reach retry', async () => {
  const before = retries.length
  signedIn = null
  assert.equal((await post()).status, 401)
  signedIn = { id: 'fixture-owner' }; writable = false
  assert.equal((await post()).status, 403)
  writable = true
  assert.equal((await post({}, { botId: 'not-a-bot' })).status, 400)
  allowed = false
  assert.equal((await post()).status, 404)
  allowed = true
  assert.equal(retries.length, before)
})
