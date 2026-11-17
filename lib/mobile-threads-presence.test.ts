import assert from 'node:assert/strict'
import test, { after, before, beforeEach, mock } from 'node:test'
import { drizzle } from 'drizzle-orm/pg-proxy'
import { homeScopeProof } from './live/home-scope-proof'
import { readDevicePresenceGrant } from './device-presence-grant'
import { liveChannelId } from './live/scope'

const start = 1_800_000_000_000, secret = 'local-mobile-presence-test'
const scope = { ownerId: 'owner', workspaceId: '19df8afd-0f8c-4c6b-bc9c-20df0b046a72' }
const device = '20000000-0000-4000-8000-000000000001'
type Machine = { id: string; name: string; sessionOpenedAt: Date | null; sessionClosedAt: Date | null }
let now = start, machines: Machine[] = []
const queries: { sql: string; values: unknown[] }[] = [], statusReads: string[] = []
let read: typeof import('./mobile-threads').mobileThreads
const previous = { url: process.env.DEVICE_GATEWAY_URL, secret: process.env.DEVICE_GATEWAY_PUSH_SECRET }

before(async () => {
  process.env.DEVICE_GATEWAY_URL = 'https://gateway.test'
  process.env.DEVICE_GATEWAY_PUSH_SECRET = secret
  mock.method(Date, 'now', () => now)
  mock.method(globalThis, 'fetch', async (url: string | URL | Request) => {
    statusReads.push(String(url instanceof Request ? url.url : url))
    return Response.json({ online: true })
  })
  const db = drizzle(async (sql, values) => {
    queries.push({ sql, values })
    if (sql.includes('from "agent_runs"')) { assert.equal(values[0], 'owner'); return { rows: [] } }
    assert.ok(sql.startsWith('select "id", "name", "platform", "kind", "sessionOpenedAt", "sessionClosedAt" from "devices"'))
    assert.match(sql, /"devices"\."ownerId" = \$1/)
    assert.match(sql, /"devices"\."removedAt" is null/)
    assert.match(sql, /NOT EXISTS \(SELECT 1 FROM thread_machines/)
    assert.deepEqual(values, ['owner'])
    return { rows: machines.map(row => [row.id, row.name, 'darwin', 'local', row.sessionOpenedAt?.toISOString() ?? null, row.sessionClosedAt?.toISOString() ?? null]) }
  })
  mock.module(new URL('./db/index.ts', import.meta.url).href, { namedExports: { db, pool: { query: () => assert.fail('no extra app query') } } })
  mock.module(new URL('./workspace-db.ts', import.meta.url).href, { namedExports: { workspacePool: { query: () => assert.fail('the split workspace DB must not be read') } } })
  mock.module(new URL('./coordinator/store.ts', import.meta.url).href, { namedExports: { citationSources: () => assert.fail('no runs need citation reads') } })
  mock.module(new URL('./chat-preferences.ts', import.meta.url).href, { namedExports: { pinnedByDefault: () => assert.fail('threads do not read chat preferences') } })
  read = (await import('./mobile-threads')).mobileThreads
})
beforeEach(() => { now = start; machines = [{ id: device, name: 'Owned fixture', sessionOpenedAt: null, sessionClosedAt: null }]; queries.length = 0; statusReads.length = 0 })
after(() => {
  mock.restoreAll()
  if (previous.url === undefined) delete process.env.DEVICE_GATEWAY_URL; else process.env.DEVICE_GATEWAY_URL = previous.url
  if (previous.secret === undefined) delete process.env.DEVICE_GATEWAY_PUSH_SECRET; else process.env.DEVICE_GATEWAY_PUSH_SECRET = previous.secret
})

const token = (expiresAt = start + 120_000, ownerId = 'owner') => homeScopeProof({ ...scope, ownerId }, expiresAt, secret, start)!.token
const decoded = (result: Awaited<ReturnType<typeof read>>) => {
  assert.ok(result.live.presence)
  return readDevicePresenceGrant(result.live.presence.token, liveChannelId(scope), secret, now)!
}

test('the reader takes presence from the owned-device read itself, with no gateway status request', async () => {
  machines[0].sessionOpenedAt = new Date(start - 3_600_000)
  const result = await read('owner', 60, token())
  assert.equal(queries.length, 2)
  assert.deepEqual(statusReads, [], 'presence is the session columns')
  assert.deepEqual(result.devices, [{ id: device, name: 'Owned fixture', kind: 'laptop', online: true }])
  assert.deepEqual(decoded(result).devices, [[device, true, 0]])
  assert.equal(decoded(result).expiresAt, start + 120_000)
  machines = []
  const next = await read('owner', 60, token())
  assert.equal(queries.length, 4, 'each read executes the existing ownership query afresh')
  assert.deepEqual(next.devices, [])
  assert.equal(Object.hasOwn(next.live, 'presence'), false, 'no devices means no presence dependency')
})

test('invalid routing metadata leaves the ordinary fresh data result and request count unchanged', async () => {
  for (const proof of [undefined, 'malformed', token(start + 120_000, 'foreign-owner')]) {
    const result = await read('owner', 60, proof)
    assert.equal(result.live.workspaceId, null)
    assert.equal(result.live.presence, null)
    assert.deepEqual(result.devices, [{ id: device, name: 'Owned fixture', kind: 'laptop', online: false }])
  }
  assert.equal(queries.length, 6)
  assert.equal(statusReads.length, 0)
})

test('a closed session is offline and no grant carries a heartbeat deadline', async () => {
  machines[0] = { ...machines[0], sessionOpenedAt: new Date(start - 60_000), sessionClosedAt: new Date(start - 1_000) }
  const offline = await read('owner', 60, token())
  assert.deepEqual(decoded(offline).devices, [[device, false, 0]])
  machines[0].sessionOpenedAt = new Date(start)
  const reconnected = await read('owner', 60, token(start + 20_000))
  assert.deepEqual(decoded(reconnected).devices, [[device, true, 0]])
  assert.equal(decoded(reconnected).expiresAt, start + 20_000)
})

test('oversized coverage stays unavailable', async () => {
  machines = Array.from({ length: 17 }, (_, i) => ({ id: `20000000-0000-4000-8000-${i.toString().padStart(12, '0')}`, name: 'Owned fixture', sessionOpenedAt: new Date(now), sessionClosedAt: null }))
  const oversized = await read('owner', 60, token())
  assert.equal(oversized.devices.length, 17)
  assert.equal(oversized.live.presence, null)
  assert.equal(queries.length, 2)
})
