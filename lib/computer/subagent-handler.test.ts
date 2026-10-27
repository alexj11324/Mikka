import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSubagentHandler } from './subagent-handler'
import type { SubagentStore } from './subagent-store'

const botId = '8fe7d6f8-7af0-4d84-96f6-f88bb27b45aa'
const id = '153bd012-55b3-44c0-8ff3-f78528775392'
const actor = { userId: 'owner', workspaceId: id }
const request = (body?: unknown, origin = 'https://mikka.example') => new Request('https://mikka.example/api/test', {
  method: 'POST', headers: { origin, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
})

test('subagent routes enforce identity, origin, UUIDs and strict viewer grants', async () => {
  const calls: unknown[] = []
  const store = { async operate(...args: unknown[]) { calls.push(args); return { url: 'wss://example.test/view' } } } as unknown as SubagentStore
  const handler = createSubagentHandler(store, async () => actor)
  const anonymous = createSubagentHandler(store, async () => null)
  assert.equal((await anonymous(request(), botId, id, 'stop')).status, 401)
  assert.equal((await handler(request(undefined, 'https://other.example'), botId, id, 'stop')).status, 403)
  assert.equal((await handler(request({ mode: 'control', userId: 'injected' }), botId, id, 'viewer')).status, 400)
  assert.equal((await handler(request({ mode: 'view' }), 'invalid', id, 'viewer')).status, 400)
  assert.equal(calls.length, 0)
  assert.equal((await handler(request({ mode: 'view' }), botId, id, 'viewer')).status, 200)
  assert.deepEqual(calls[0], [actor, botId, id, 'viewer', 'view'])
})
