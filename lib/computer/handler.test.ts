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
test('accepts a duplicate wake while provisioning without starting another worker', async () => {
  const f = fixture()
  f.store.operate = async () => { throw new ComputerError(409, 'Computer provisioning in progress') }
  const handle = createComputerHandler(f.store, async () => actor, async () => { assert.fail('provisioning has not committed a desktop') })
  const response = await handle(request(), botId, 'wake')
  assert.equal(response.status, 202)
  assert.deepEqual(await response.json(), null)
  assert.equal(response.headers.get('cache-control'), 'private, no-store')
})
test('keeps provisioning conflicts for other actions and all other wake conflicts', async () => {
  const f = fixture()
  f.store.operate = async () => { throw new ComputerError(409, 'Computer provisioning in progress') }
  for (const action of ['viewer', 'takeover', 'handback'] as const) {
    const response = await f.handle(request('POST', { mode: 'view' }), botId, action)
    assert.equal(response.status, 409)
    assert.deepEqual(await response.json(), { error: 'Computer provisioning in progress' })
  }
  for (const message of ['Computer allocation changed', 'Desktop limit reached', 'Computer is already controlled']) {
    f.store.operate = async () => { throw new ComputerError(409, message) }
    const response = await f.handle(request(), botId, 'wake')
    assert.equal(response.status, 409)
    assert.deepEqual(await response.json(), { error: message })
  }
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

test('a failed worker start logs its code and sandbox, and the response stays generic', async () => {
  const f = fixture()
  const { CloudWorkerError } = await import('./worker-error')
  const handle = createComputerHandler(f.store, async () => actor, async () => { throw new CloudWorkerError('worker_version_mismatch', 'i1rjvc1rlh2lx188keavy') })
  const provider = Object.assign(new Error('GET https://api.e2b.app/sandboxes/x?key=secret failed'), { name: 'SandboxError' })
  const failing = createComputerHandler({ ...f.store, operate: async () => { throw provider } }, async () => actor)
  const logged: string[] = []
  const original = console.error
  console.error = (line: string) => { logged.push(line) }
  try {
    const r = await handle(request('POST', {}), botId, 'wake')
    assert.equal(r.status, 503)
    assert.deepEqual(await r.json(), { error: 'Cloud computer is unavailable' })
    const p = await failing(request('POST', {}), botId, 'wake')
    assert.deepEqual(await p.json(), { error: 'Cloud computer is unavailable' })
  } finally { console.error = original }
  assert.deepEqual(logged.map(line => JSON.parse(line)), [
    { event: 'cloud_computer_failed', action: 'wake', botId, code: 'worker_version_mismatch', sandboxId: 'i1rjvc1rlh2lx188keavy' },
    { event: 'cloud_computer_failed', action: 'wake', botId, code: 'SandboxError' },
  ])
  assert.ok(!logged.join('').includes('secret'))
})
