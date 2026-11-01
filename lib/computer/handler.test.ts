import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createComputerHandler } from './handler'
import { ComputerError } from './store'

const botId = 'b9b30c54-8354-4e86-9dfd-bfcf2d437fca'
const actor = { userId: 'owner', workspaceId: 'workspace' }
function fixture(signedIn = true) {
  const calls: unknown[][] = []
  const store = {
    listBots: async (...args: unknown[]) => { calls.push(args); return [] },
    createBot: async (...args: unknown[]) => { calls.push(args); return { id: botId, name: 'Bot', ownerId: actor.userId, workspaceId: actor.workspaceId } },
    state: async (...args: unknown[]) => { calls.push(args); return { machine: 'sleeping', control: 'idle' } as const },
    operate: async (...args: unknown[]) => { calls.push(args); return null },
  }
  return { calls, store, handle: createComputerHandler(store, async () => signedIn ? actor : null) }
}
function request(method = 'POST', body?: unknown, origin: string | null = 'https://mikka.example') {
  const headers: Record<string, string> = {}
  if (origin !== null) headers.origin = origin
  return new Request('https://mikka.example/api/bots', { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
}

test('unauthenticated requests never reach the store and responses cannot be cached', async () => {
  const f = fixture(false)
  const r = await f.handle(request('GET'))
  assert.equal(r.status, 401)
  assert.equal(r.headers.get('cache-control'), 'private, no-store')
  assert.equal(f.calls.length, 0)
})
test('cross-origin and missing-origin mutations never provision compute', async () => {
  for (const origin of [null, 'https://other.example', 'null']) {
    const f = fixture()
    assert.equal((await f.handle(request('POST', undefined, origin), botId, 'wake')).status, 403)
    assert.equal(f.calls.length, 0)
  }
})
test('rejects malformed identities, modes and client-supplied ownership', async () => {
  const f = fixture()
  assert.equal((await f.handle(request('POST'), 'not-a-bot', 'wake')).status, 400)
  assert.equal((await f.handle(request('POST', { mode: 'admin' }), botId, 'viewer')).status, 400)
  assert.equal((await f.handle(request('POST', { mode: 'view', userId: 'other' }), botId, 'viewer')).status, 400)
  assert.equal((await f.handle(request('POST', { name: 'Bot', ownerId: 'other' }))).status, 400)
  assert.equal(f.calls.length, 0)
})
test('uses server-derived ownership and the shared request contract', async () => {
  const f = fixture()
  assert.equal((await f.handle(request('POST', { name: ' Bot ' }))).status, 201)
  assert.deepEqual(f.calls.pop(), [actor, 'Bot'])
  assert.equal((await f.handle(request('POST', { mode: 'view' }), botId, 'viewer')).status, 200)
  assert.deepEqual(f.calls.pop(), [actor, botId, 'viewer', 'view'])
  assert.equal((await f.handle(request(), botId, 'wake')).status, 202)
})
test('keeps ownership errors but never serializes provider credentials', async () => {
  const f = fixture()
  f.store.operate = async () => { throw new ComputerError(404, 'Computer not found') }
  assert.equal((await f.handle(request(), botId, 'wake')).status, 404)
  f.store.operate = async () => { throw new Error('provider-secret-in-error') }
  const response = await f.handle(request(), botId, 'wake')
  assert.equal(response.status, 503)
  assert.deepEqual(await response.json(), { error: 'Cloud computer is unavailable' })
})
test('waking starts the trusted worker after desktop provisioning and fails closed on worker errors', async () => {
  const f = fixture()
  let attempts = 0
  const handle = createComputerHandler(f.store, async () => actor, async (owner, bot) => {
    assert.deepEqual(f.calls.at(-1), [actor, botId, 'wake', 'view'])
    assert.deepEqual(owner, actor)
    assert.equal(bot, botId)
    attempts++
    if (attempts === 2) throw new Error('private provider details')
  })
  assert.equal((await handle(request(), botId, 'wake')).status, 202)
  const failure = await handle(request(), botId, 'wake')
  assert.equal(failure.status, 503)
  assert.deepEqual(await failure.json(), { error: 'Cloud computer is unavailable' })
  assert.equal((await handle(request('POST', { mode: 'view' }), botId, 'viewer')).status, 200)
  assert.equal(attempts, 2)
})
test('the actor is chosen with the requested bot, so a bot shown in every workspace is read where it lives', async () => {
  const f = fixture()
  const asked: (string | undefined)[] = []
  const coordinatorActor = { userId: actor.userId, workspaceId: 'coordinator-workspace' }
  const handle = createComputerHandler(f.store, async (_request, bot) => { asked.push(bot); return bot === botId ? coordinatorActor : actor })
  assert.equal((await handle(request('GET'), botId)).status, 200)
  assert.deepEqual(f.calls.at(-1), [coordinatorActor, botId])
  assert.equal((await handle(request('GET'))).status, 200)
  assert.deepEqual(asked, [botId, undefined])
})
