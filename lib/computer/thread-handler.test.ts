import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createThreadComputerHandler } from './thread-handler'
import type { ThreadDesktopStore } from './thread-desktop'

const runId = '8fe7d6f8-7af0-4d84-96f6-f88bb27b45aa'
const actor = { userId: 'owner', workspaceId: '153bd012-55b3-44c0-8ff3-f78528775392' }
const req = (method: string, body?: unknown, origin = 'https://mikka.example') => new Request(`https://mikka.example/api/threads/${runId}/computer`, {
  method, headers: { origin, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
})

test('thread computer routes require a session, same origin and a strict viewer mode', async () => {
  const calls: unknown[] = []
  const store = {
    async state(a: unknown, id: string) { calls.push({ a, id }); return { machine: 'running', control: 'agent' } },
    async operate(a: unknown, id: string, action: string, mode: string) { calls.push({ a, id, action, mode }); return { url: 'wss://example.test/view', expiresAt: '2026-10-27T00:00:00.000Z' } },
  } as unknown as ThreadDesktopStore
  const handler = createThreadComputerHandler(store, async () => actor)
  const anonymous = createThreadComputerHandler(store, async () => null)
  assert.equal((await anonymous(req('GET'), runId)).status, 401)
  assert.equal((await handler(req('POST', { mode: 'view' }, 'https://other.example'), runId, 'viewer')).status, 403)
  assert.equal((await handler(req('POST', { mode: 'control', userId: 'injected' }), runId, 'viewer')).status, 400)
  assert.equal((await handler(req('POST', { mode: 'view' }), 'invalid', 'viewer')).status, 400)
  assert.equal(calls.length, 0)
  assert.equal((await handler(req('GET'), runId)).status, 200)
  assert.equal((await handler(req('POST', { mode: 'view' }), runId, 'viewer')).status, 200)
  assert.deepEqual(calls[1], { a: actor, id: runId, action: 'viewer', mode: 'view' })
})
