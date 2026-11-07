import assert from 'node:assert/strict'
import { mock, test } from 'node:test'

const BOT = '6b0f2c8e-2d5c-4a1e-9a7b-0d6f3c1e2a4b'
let signedIn: { id: string } | null = { id: 'fixture-owner' }
let enabled = true, queued = false, working = false, allowed = true
const wakes: (() => unknown)[] = []
let retried = 0
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
mock.module('next/server', { namedExports: { after: (callback: () => unknown) => wakes.push(callback) } })
mock.module(new URL('../lib/mobile-api.ts', import.meta.url).href, { namedExports: {
  json, mobileUser: async () => signedIn, writeAllowed: () => true,
  unauthorized: () => json({ error: 'authRequired' }, 401), forbiddenOrigin: () => json({ error: 'originNotAllowed' }, 403),
} })
mock.module(new URL('../lib/request-log.ts', import.meta.url).href, { namedExports: { noteLogRpcAction: () => {}, withRequestLog: (_: string, handler: unknown) => handler, noteLogUser: () => {} } })
mock.module(new URL('../lib/db/index.ts', import.meta.url).href, { namedExports: { db: { select: () => ({ from: () => ({ where: () => ({ limit: async () => allowed ? [{ id: BOT }] : [] }) }) }) } } })
mock.module(new URL('../lib/coordinator/coordinator-bot.ts', import.meta.url).href, { namedExports: { openChatBotId: async () => BOT } })
mock.module(new URL('../lib/coordinator/store.ts', import.meta.url).href, { namedExports: {
  retryFailedTurn: async () => { retried++; return queued }, chatView: async () => ({ working }),
} })
mock.module(new URL('../lib/coordinator/wake.ts', import.meta.url).href, { namedExports: { coordinatorEnabled: () => enabled, wakeCoordinator: async () => {} } })
const route = import('../app/api/mobile/chat/retry/route')
async function post() {
  const { POST } = await route
  const response = await POST(new Request('https://fixture.example/api/mobile/chat/retry', { method: 'POST', body: JSON.stringify({ botId: BOT }) }))
  return { status: response.status, body: await response.json() }
}

test('mobile retry distinguishes unavailable, already processing, no failed turn and queued', async () => {
  enabled = false
  assert.deepEqual((await post()).body, { queued: false, reason: 'unavailable' })
  enabled = true; working = true
  assert.deepEqual((await post()).body, { queued: false, reason: 'working' })
  working = false
  assert.deepEqual((await post()).body, { queued: false, reason: 'nothingToRetry' })
  assert.equal(wakes.length, 0)
  queued = true
  assert.deepEqual((await post()).body, { queued: true })
  assert.equal(wakes.length, 1)
})

test('a signed out person or another owner never reaches retry', async () => {
  const before = retried
  signedIn = null
  assert.equal((await post()).status, 401)
  signedIn = { id: 'fixture-owner' }; allowed = false
  assert.equal((await post()).status, 404)
  assert.equal(retried, before)
})
