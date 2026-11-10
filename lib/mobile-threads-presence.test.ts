import assert from 'node:assert/strict'
import test, { after, before, beforeEach, mock } from 'node:test'
import { drizzle } from 'drizzle-orm/pg-proxy'
import { resourceAccessPredicate } from './resource-access/predicate'
import { agentRuns } from './db/schema'
import { homeScopeProof } from './live/home-scope-proof'
import { readDevicePresenceGrant } from './device-presence-grant'
import { liveChannelId } from './live/scope'

const start = 1_800_000_000_000, secret = 'local-mobile-presence-test'
const scope = { ownerId: 'owner', workspaceId: '19df8afd-0f8c-4c6b-bc9c-20df0b046a72' }
const device = '20000000-0000-4000-8000-000000000001'
type Machine = { id: string; name: string; lastSeenAt: Date | null }
let now = start, machines: Machine[] = [], online = false, statusDelay = 0
const queries: { sql: string; values: unknown[] }[] = [], statusReads: string[] = []
let read: typeof import('./mobile-threads').mobileThreads
const previous = { url: process.env.DEVICE_GATEWAY_URL, secret: process.env.DEVICE_GATEWAY_PUSH_SECRET }

before(async () => {
  process.env.DEVICE_GATEWAY_URL = 'https://gateway.test'
  process.env.DEVICE_GATEWAY_PUSH_SECRET = secret
  mock.method(Date, 'now', () => now)
  mock.method(globalThis, 'fetch', async (url: string | URL | Request) => {
    statusReads.push(String(url instanceof Request ? url.url : url)); now += statusDelay
    return Response.json({ online, lastSeenAt: new Date(now).toISOString() })
  })
  const db = drizzle(async (sql, values) => {
    queries.push({ sql, values })
    if (sql.includes('from "agent_runs"')) { assert.equal(values[0], 'owner'); return { rows: [] } }
    assert.ok(sql.startsWith('select "id", "name", "platform", "kind", "lastSeenAt" from "devices"'))
    assert.match(sql, /"devices"\."ownerId" = \$1/)
    assert.match(sql, /"devices"\."removedAt" is null/)
    assert.match(sql, /NOT EXISTS \(SELECT 1 FROM thread_machines/)
    assert.deepEqual(values, ['owner'])
    return { rows: machines.map(row => [row.id, row.name, 'darwin', 'local', row.lastSeenAt?.toISOString() ?? null]) }
  })
  mock.module(new URL('./db/index.ts', import.meta.url).href, { namedExports: { db, pool: { query: () => assert.fail('no extra app query') } } })
  mock.module(new URL('./workspace-db.ts', import.meta.url).href, { namedExports: { workspacePool: { query: () => assert.fail('the split workspace DB must not be read') } } })
  // This fixture measures presentation/presence after admission. Actual tenant
  // and ACL revocation are covered by the required PostgreSQL suites.
  mock.module(new URL('./task-workspace.ts', import.meta.url).href, { namedExports: { taskReaderScope: (reader: string) => {
    assert.equal(reader, 'owner'); return { userId: reader }
  } } })
  mock.module(new URL('./resource-access/thread.ts', import.meta.url).href, { namedExports: { threadReadAccess: async (reader: string) => {
    assert.equal(reader, 'owner')
    return resourceAccessPredicate(reader, agentRuns.workspaceId, 'thread', agentRuns.id)
  } } })
  mock.module(new URL('./coordinator/store.ts', import.meta.url).href, { namedExports: { citationSources: () => assert.fail('no runs need citation reads') } })
  mock.module(new URL('./chat-preferences.ts', import.meta.url).href, { namedExports: { pinnedByDefault: () => assert.fail('threads do not read chat preferences') } })
  read = (await import('./mobile-threads')).mobileThreads
})
beforeEach(() => { now = start; machines = [{ id: device, name: 'Owned fixture', lastSeenAt: null }]; online = false; statusDelay = 0; queries.length = 0; statusReads.length = 0 })
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

test('the actual reader reuses exactly its owned-device/run reads and existing status request', async () => {
  online = true
  const result = await read('owner', 60, token())
  assert.equal(queries.length, 2)
  assert.deepEqual(statusReads, [`https://gateway.test/v1/devices/${device}/status`])
  assert.deepEqual(result.devices, [{ id: device, name: 'Owned fixture', kind: 'laptop', online: true }])
  assert.deepEqual(decoded(result).devices, [[device, true, 0]])
  assert.equal(decoded(result).expiresAt, start + 120_000)
  machines = []
  const next = await read('owner', 60, token())
  assert.equal(queries.length, 4, 'each read executes the existing ownership query afresh')
  assert.equal(statusReads.length, 1, 'no additional status lookup was introduced')
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
  assert.equal(statusReads.length, 3)
})

test('offline reconnects stay observed and a fresh legacy heartbeat is capped at the ticket expiry', async () => {
  const offline = await read('owner', 60, token())
  assert.deepEqual(decoded(offline).devices, [[device, false, 0]])
  machines[0].lastSeenAt = new Date(now)
  const bounded = await read('owner', 60, token(start + 20_000))
  assert.deepEqual(decoded(bounded).devices, [[device, true, start + 20_000]])
  assert.equal(decoded(bounded).expiresAt, start + 20_000)
  assert.equal(statusReads.length, 1, 'the existing fresh heartbeat avoids the gateway')
})

test('a proof expiring during an existing status read is not extended and oversized coverage stays unavailable', async () => {
  statusDelay = 20_001
  const expired = await read('owner', 60, token(start + 20_000))
  assert.equal(expired.live.workspaceId, null)
  assert.equal(expired.live.presence, null)
  now = start; statusDelay = 0
  machines = Array.from({ length: 17 }, (_, i) => ({ id: `20000000-0000-4000-8000-${i.toString().padStart(12, '0')}`, name: 'Owned fixture', lastSeenAt: new Date(now) }))
  const oversized = await read('owner', 60, token())
  assert.equal(oversized.devices.length, 17)
  assert.equal(oversized.live.presence, null)
  assert.equal(queries.length, 4)
  assert.equal(statusReads.length, 1)
})
