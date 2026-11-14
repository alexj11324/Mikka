import assert from 'node:assert/strict'
import { wireKeys } from './wire-keys.test-support'
import { randomUUID } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import test, { mock } from 'node:test'
import { Pool } from 'pg'
import { disposableDatabase } from '../../tests/helpers/e2e-target.mjs'
import { createTestDatabase, dropTestDatabase } from '../../tests/support/drop-test-database'
import { orderMigrations } from '../../scripts/migration-order.mjs'
import { observePoolCommits } from '../db/commit-effects'
import { artifactTargets } from './artifacts'
import type { LiveInvalidation } from './events'
import { liveChannelId, type LiveScope } from './scope'

const url = process.env.E2E_DATABASE_URL
if (process.env.REQUIRE_DB === '1') assert.ok(url, 'REQUIRE_DB=1 needs PostgreSQL')
if (url) assert.ok(disposableDatabase(process.env, url), 'loopback *_e2e only')

test('an artifact key reaches only its owner home, after the real artifact writers commit', { skip: !url, timeout: 180_000 }, async t => {
  const wakes: string[] = []
  const receive = async (userId: string) => { wakes.push(userId) }
  const { coordinatorWakeTransport } = await import('../coordinator/wake-after-commit')
  const previousWake = coordinatorWakeTransport.wake
  coordinatorWakeTransport.wake = receive
  t.after(() => { coordinatorWakeTransport.wake = previousWake })
  t.mock.module(new URL('../coordinator/wake.ts', import.meta.url).href, { namedExports: { wakeCoordinator: receive } })
  const pending: (() => Promise<void>)[] = []
  const sent: { scope: LiveScope; events: LiveInvalidation[] }[] = []
  const next = await import('next/server')
  mock.module('next/server', { namedExports: { ...next, after: (work: () => Promise<void>) => { pending.push(work) } } })
  const channelScopes = new Map<string, LiveScope>(), unexpected: string[] = []
  const previous = { url: process.env.DEVICE_GATEWAY_URL, secret: process.env.DEVICE_GATEWAY_PUSH_SECRET }
  process.env.DEVICE_GATEWAY_URL = 'https://gateway.example.invalid'
  process.env.DEVICE_GATEWAY_PUSH_SECRET = 'isolated-artifact-secret'
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, options?: RequestInit) => {
    const target = new URL(String(input))
    assert.equal(target.hostname, 'gateway.example.invalid', 'no provider or production request is allowed')
    const scope = channelScopes.get(target.pathname)
    if (!scope) unexpected.push(target.pathname)
    const events: LiveInvalidation[] = wireKeys(JSON.parse(String(options?.body)), 'a key carries a kind and an id only')
    // The submission's Coordinator event refreshes chat lists; lists.db.test.ts covers those keys.
    const artifacts = events.filter(event => event.kind === 'artifact')
    if (artifacts.length) sent.push({ scope: scope ?? { ownerId: 'unexpected', workspaceId: target.pathname }, events: artifacts })
    return new Response(null, { status: 204 })
  })
  const admin = new Pool({ connectionString: url, max: 1 })
  const name = `artifact_live_${randomUUID().replaceAll('-', '')}_e2e`
  await createTestDatabase(admin, name, 'template0')
  const target = new URL(url!); target.pathname = `/${name}`
  const database = new Pool({ connectionString: target.toString(), max: 6 })
  observePoolCommits(database)
  const globalDb = globalThis as unknown as { workspacePool?: Pool }
  const previousWorkspace = globalDb.workspacePool
  globalDb.workspacePool = database
  const { db, createRequestDatabaseScope, withDatabaseTransaction } = await import('../db/request-scope')
  const scope = createRequestDatabaseScope(target.toString())
  const drain = async () => { while (pending.length) await Promise.all(pending.splice(0).map(work => work())) }
  const deliveries = async () => { await drain(); return sent.splice(0) }
  try {
    const dir = new URL('../../drizzle/', import.meta.url)
    for (const file of orderMigrations((await readdir(dir)).filter(file => file.endsWith('.sql')))) await database.query(await readFile(new URL(file, dir), 'utf8'))
    for (const userId of ['owner', 'peer']) {
      await database.query(`INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES ($1,$1,$1||'@artifact.example.invalid',true,now(),now())`, [userId])
    }
    const home = randomUUID(), team = randomUUID(), peerHome = randomUUID()
    for (const ownerId of ['owner', 'peer']) for (const workspaceId of [home, team, peerHome]) {
      const value = { ownerId, workspaceId }; channelScopes.set(`/v1/live/${liveChannelId(value)}/push`, value)
    }
    for (const [id, owner, kind] of [[home, 'owner', 'personal'], [team, 'owner', 'team'], [peerHome, 'peer', 'personal']]) {
      await database.query(`INSERT INTO mikka_workspaces(id,"userId",name,kind) VALUES ($1,$2,'Fixture',$3)`, [id, owner, kind])
    }
    for (const [workspace, userId] of [[home, 'owner'], [team, 'owner'], [team, 'peer'], [peerHome, 'peer']]) {
      await database.query(`INSERT INTO mikka_workspace_members("workspaceId","userId",name,email,role,status) VALUES($1,$2,$2,$2,'member','active')`, [workspace, userId])
    }
    const { submitArtifact, createShare, revokeShares } = await import('../artifacts/store')
    const { deleteOwnArtifact } = await import('../artifacts/delete')
    const submit = (artifactId?: string) => submitArtifact({ userId: 'owner', workspaceId: home, runId: null, issueId: null, authorName: 'Fixture' },
      { title: 'Release notes', kind: 'markdown', content: `# Notes ${randomUUID()}`, ...(artifactId ? { artifactId } : {}) })
    const ownerHome = (id: string) => [{ scope: { ownerId: 'owner', workspaceId: home }, events: [{ kind: 'artifact', id }] }]

    const created = await scope.run(() => submit())
    assert.ok(!('error' in created), JSON.stringify(created))
    const artifactId = created.artifactId

    await t.test('the key goes to the owner home only; another owner cannot route it', async () => {
      assert.deepEqual(await artifactTargets(database, database, 'owner', artifactId), ownerHome(artifactId), 'the team and a peer sharing the home get nothing')
      assert.deepEqual(await artifactTargets(database, database, 'peer', artifactId), [])
      assert.deepEqual(await deliveries(), ownerHome(artifactId), 'creating it was one push')
      assert.deepEqual(wakes.splice(0), ['owner'], 'one committed version wakes its owner once')
    })

    await t.test('a new version publishes after COMMIT, and nothing inside a rolled-back transaction', async () => {
      await assert.rejects(scope.run(() => db.transaction(outer => withDatabaseTransaction(outer, async () => {
        assert.ok(!('error' in await submit(artifactId)))
        await drain()
        assert.deepEqual(wakes, [], 'submitting a nested version cannot wake before its outer transaction commits')
        throw new Error('version rollback')
      }))), /version rollback/)
      assert.deepEqual(await deliveries(), [])
      assert.deepEqual(wakes, [], 'a rolled-back version cannot wake the consumer')
      assert.equal((await database.query('SELECT "latestVersion" FROM artifacts WHERE id=$1', [artifactId])).rows[0].latestVersion, 1)
      assert.ok(!('error' in await scope.run(() => submit(artifactId))))
      assert.deepEqual(await deliveries(), ownerHome(artifactId))
      assert.deepEqual(wakes.splice(0), ['owner'])
      const events = await database.query(`SELECT "dedupeKey" FROM coordinator_events WHERE "userId"='owner' AND kind='artifact_submitted' ORDER BY "dedupeKey"`)
      assert.deepEqual(events.rows.map(row => row.dedupeKey), [1, 2].map(version => `artifact_submitted:${artifactId}:${version}`))
    })

    await t.test('share links and deletion publish once; a no-op revoke and a foreign owner publish nothing', async () => {
      assert.equal(await scope.run(() => createShare('peer', artifactId)), null)
      assert.equal(await scope.run(() => revokeShares('peer', artifactId)), 0)
      assert.deepEqual(await deliveries(), [])
      assert.ok(await scope.run(() => createShare('owner', artifactId)))
      assert.deepEqual(await deliveries(), ownerHome(artifactId))
      assert.equal(await scope.run(() => revokeShares('owner', artifactId)), 1)
      assert.deepEqual(await deliveries(), ownerHome(artifactId))
      assert.equal(await scope.run(() => revokeShares('owner', artifactId)), 0)
      assert.deepEqual(await deliveries(), [], 'nothing left to revoke is not a change')
      assert.equal(await scope.run(() => deleteOwnArtifact('peer', artifactId)), false)
      assert.deepEqual(await deliveries(), [])
      assert.equal(await scope.run(() => deleteOwnArtifact('owner', artifactId)), true)
      await database.query(`UPDATE mikka_workspace_members SET status='suspended' WHERE "workspaceId"=$1 AND "userId"='owner'`, [home])
      assert.deepEqual(await deliveries(), [], 'a home lost between COMMIT and delivery receives nothing')
      await database.query(`UPDATE mikka_workspace_members SET status='active' WHERE "workspaceId"=$1 AND "userId"='owner'`, [home])
      assert.deepEqual(await artifactTargets(database, database, 'owner', artifactId), [], 'a missing row is not evidence of a tenant')
      assert.deepEqual(await artifactTargets(database, database, 'owner', artifactId, home), ownerHome(artifactId), 'a deletion retains its previously authorized tenant for the open reader')
      assert.deepEqual(unexpected, [])
    })
  } finally {
    await drain().catch(() => {})
    if (previous.url === undefined) delete process.env.DEVICE_GATEWAY_URL; else process.env.DEVICE_GATEWAY_URL = previous.url
    if (previous.secret === undefined) delete process.env.DEVICE_GATEWAY_PUSH_SECRET; else process.env.DEVICE_GATEWAY_PUSH_SECRET = previous.secret
    globalDb.workspacePool = previousWorkspace
    await scope.close(); await database.end()
    await dropTestDatabase(admin, name); await admin.end()
    mock.restoreAll()
  }
})
