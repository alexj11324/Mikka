import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { createServer } from 'node:http'
import { once } from 'node:events'
import test, { mock } from 'node:test'
import { Pool, type PoolClient } from 'pg'
import { disposableDatabase } from '../../tests/helpers/e2e-target.mjs'
import { dropTestDatabase } from '../../tests/support/drop-test-database'
import { orderMigrations } from '../../scripts/migration-order.mjs'
import { observePoolCommits } from '../db/commit-effects'
import { liveChannelId } from './scope'

const url = process.env.E2E_DATABASE_URL
if (process.env.REQUIRE_DB === '1') assert.ok(url, 'REQUIRE_DB=1 needs PostgreSQL')
if (url) assert.ok(disposableDatabase(process.env, url), 'loopback *_e2e only')

test('real Factory notifications retain their database across COMMIT and delayed Next after callbacks', { skip: !url, timeout: 180_000 }, async t => {
  const queued: (() => Promise<void>)[] = []
  const nextServer = await import('next/server')
  const scheduler = mock.module('next/server', { namedExports: { ...nextServer,
    after: (work: () => Promise<void>) => { queued.push(work) },
  } })
  const sent: { path: string; events: unknown }[] = []
  const receiver = createServer(async (request, response) => {
    let body = ''
    for await (const part of request) body += part
    sent.push({ path: request.url!, events: JSON.parse(body) })
    response.writeHead(204); response.end()
  })
  receiver.listen(0, '127.0.0.1'); await once(receiver, 'listening')
  const address = receiver.address()
  assert.ok(address && typeof address !== 'string')
  const previous = { url: process.env.DEVICE_GATEWAY_URL, secret: process.env.DEVICE_GATEWAY_PUSH_SECRET }
  process.env.DEVICE_GATEWAY_URL = `http://127.0.0.1:${address.port}`
  process.env.DEVICE_GATEWAY_PUSH_SECRET = 'isolated-notification-context-fixture'
  const admin = new Pool({ connectionString: url, max: 1 })
  const databaseNames = ['default', 'request'].map(name => `live_context_${name}_${randomUUID().replaceAll('-', '')}_e2e`)
  const pools: Pool[] = []
  for (const name of databaseNames) {
    await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`)
    const target = new URL(url!); target.pathname = `/${name}`
    const pool = new Pool({ connectionString: target.toString(), max: 4 })
    observePoolCommits(pool); pools.push(pool)
    const dir = new URL('../../drizzle/', import.meta.url)
    for (const file of orderMigrations((await readdir(dir)).filter(file => file.endsWith('.sql')))) await pool.query(await readFile(new URL(file, dir), 'utf8'))
  }
  const [defaultPool, requestPool] = pools
  const globals = globalThis as unknown as { mikkaPool?: Pool; workspacePool?: Pool }
  const previousPools = { mikka: globals.mikkaPool, workspace: globals.workspacePool }
  globals.mikkaPool = defaultPool; globals.workspacePool = defaultPool
  const app = await import('../db/request-scope')
  const target = new URL(url!); target.pathname = `/${databaseNames[1]}`
  const requestScope = app.createRequestDatabaseScope(target.toString())
  const { createFactoryStore } = await import('../factory/store')
  const { factoryCommitted } = await import('./factory')
  const owner = `factory-context-${randomUUID()}`, intended = randomUUID(), wrong = randomUUID()
  try {
    for (const pool of pools) await pool.query('INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES ($1,\'Context fixture\',$2,true,now(),now())', [owner, `${owner}@example.invalid`])
    for (const [id, kind] of [[intended, 'personal'], [wrong, 'team']]) {
      await defaultPool.query('INSERT INTO mikka_workspaces(id,"userId",name,kind) VALUES($1,$2,\'Context fixture\',$3)', [id, owner, kind])
      await defaultPool.query('INSERT INTO mikka_workspace_members("workspaceId","userId",name,email,role,status) VALUES($1,$2,\'Context fixture\',$3,\'admin\',\'active\')', [id, owner, `${owner}@example.invalid`])
    }
    const drain = async () => { await Promise.all(queued.splice(0).map(work => work())) }
    async function route(tx: PoolClient) {
      const issueId = randomUUID(), sourceEventId = randomUUID(), botId = randomUUID()
      for (const [index, pool] of pools.entries()) {
        await pool.query('INSERT INTO bots(id,"ownerId","workspaceId",name) VALUES($1,$2,$3,$4)', [botId, owner, index ? intended : wrong, `Context fixture ${botId}`])
        await pool.query(`INSERT INTO issues(id,"userId","workspaceId","ownershipState",scope,title,content,status,priority) VALUES($1,$2,$3,'bound',$4,'Context fixture','{"type":"doc","content":[]}','todo','normal')`, [issueId, owner, index ? intended : wrong, index ? 'personal' : 'workspace'])
        await pool.query('INSERT INTO coordinator_events(id,"userId","botId",kind,"dedupeKey",payload) VALUES($1,$2,$3,\'user_message\',$4,\'{"text":"Isolated fixture"}\')', [sourceEventId, owner, botId, sourceEventId])
      }
      const store = createFactoryStore(requestPool, async (user, issue, client) => (await client.query('SELECT id FROM issues WHERE id=$1 AND "userId"=$2', [issue, user])).rowCount === 1, botId)
      const result = await requestScope.run(() => app.withDatabaseClient(tx, () => store.route(owner, {
        issueId, sourceEventId, eventId: randomUUID(), rationale: 'Context fixture', missingInformation: [], missingPermissions: [], needsSpec: false,
      }, tx)))
      // The default database deliberately has the same task, issue, Bot and
      // owner IDs. Its persisted task/issue/Bot tenant differs, so falling back
      // to it would still address a valid but unauthorized notification key.
      const clone = await defaultPool.connect()
      try {
        await clone.query('BEGIN')
        const task = (await tx.query('SELECT to_jsonb(t) AS value FROM factory_tasks t WHERE id=$1', [result.task.id])).rows[0].value
        task.workspaceId = wrong
        await clone.query('INSERT INTO factory_tasks SELECT * FROM jsonb_populate_record(NULL::factory_tasks,$1)', [task])
        const attempts = (await tx.query('SELECT to_jsonb(a) AS value FROM factory_attempts a WHERE "taskId"=$1', [result.task.id])).rows
        for (const attempt of attempts) await clone.query('INSERT INTO factory_attempts SELECT * FROM jsonb_populate_record(NULL::factory_attempts,$1)', [attempt.value])
        await clone.query('COMMIT')
      } catch (error) { await clone.query('ROLLBACK'); throw error }
      finally { clone.release() }
      return result.task
    }
    const expected = (task: { id: string; issueId: string }) => ({
      path: `/v1/live/${liveChannelId({ ownerId: owner, workspaceId: intended })}/push`,
      events: [{ kind: 'factory_task', id: task.id }, { kind: 'factory_issue', id: task.issueId }],
    })

    await t.test('a real store COMMIT in the request and later scheduler invocation outside it retain the originating database', async () => {
      const tx = await requestPool.connect(), before = sent.length
      try {
        await tx.query('BEGIN'); const task = await route(tx)
        assert.equal(queued.length, 0)
        await requestScope.run(() => tx.query('COMMIT'))
        assert.equal(queued.length, 2, 'Factory and project-map invalidations each retain the originating database')
        assert.equal(sent.length, before)
        await drain()
        assert.deepEqual(sent.slice(before), [expected(task)])
      } finally { await tx.query('ROLLBACK'); tx.release() }
    })

    await t.test('registration in the request survives COMMIT and scheduling in a different context, after visibility to another connection', async () => {
      const tx = await requestPool.connect(), before = sent.length
      try {
        await tx.query('BEGIN'); const task = await route(tx)
        assert.equal((await requestPool.query('SELECT id FROM factory_tasks WHERE id=$1', [task.id])).rowCount, 0)
        assert.equal(queued.length, 0)
        await tx.query('COMMIT') // Deliberately outside requestScope.run.
        assert.equal((await requestPool.query('SELECT id FROM factory_tasks WHERE id=$1', [task.id])).rowCount, 1)
        assert.equal(queued.length, 2, 'Factory and project-map invalidations each retain the originating database')
        await drain()
        assert.deepEqual(sent.slice(before), [expected(task)])
      } finally { await tx.query('ROLLBACK'); tx.release() }
    })

    await t.test('an already committed Factory update uses the same public scheduling boundary', async () => {
      const tx = await requestPool.connect()
      let task: Awaited<ReturnType<typeof route>>
      try { await tx.query('BEGIN'); task = await route(tx); await requestScope.run(() => tx.query('COMMIT')) }
      finally { await tx.query('ROLLBACK'); tx.release() }
      await drain(); const before = sent.length
      await requestScope.run(async () => {
        await app.pool.query('UPDATE factory_tasks SET reason=\'Committed context fixture\' WHERE id=$1', [task.id])
        await factoryCommitted(task.id)
      })
      assert.equal(queued.length, 2, 'Factory and project-map invalidations each retain the originating database'); await drain()
      assert.deepEqual(sent.slice(before), [expected(task)])
    })

    await t.test('permission is read after scheduling, so suspended membership suppresses delivery even while the other database is still active', async () => {
      const tx = await requestPool.connect(), before = sent.length
      try {
        await tx.query('BEGIN'); await route(tx); await requestScope.run(() => tx.query('COMMIT'))
        assert.equal(queued.length, 2, 'Factory and project-map invalidations each retain the originating database')
        await defaultPool.query('UPDATE mikka_workspace_members SET status=\'suspended\' WHERE "workspaceId"=$1 AND "userId"=$2', [intended, owner])
        await drain()
        assert.equal(sent.length, before)
      } finally {
        await defaultPool.query('UPDATE mikka_workspace_members SET status=\'active\' WHERE "workspaceId"=$1 AND "userId"=$2', [intended, owner])
        await tx.query('ROLLBACK'); tx.release()
      }
    })

    await t.test('actual outer and savepoint rollbacks schedule no notification', async () => {
      const before = sent.length
      for (const savepoint of [false, true]) {
        const tx = await requestPool.connect()
        try {
          await tx.query('BEGIN')
          if (savepoint) await tx.query('SAVEPOINT reverted')
          const task = await route(tx)
          if (savepoint) { await tx.query('ROLLBACK TO SAVEPOINT reverted'); await tx.query('COMMIT') }
          else await tx.query('ROLLBACK')
          assert.equal(queued.length, 0)
          assert.equal((await requestPool.query('SELECT id FROM factory_tasks WHERE id=$1', [task.id])).rowCount, 0)
        } finally { await tx.query('ROLLBACK'); tx.release() }
      }
      assert.equal(sent.length, before)
    })
  } finally {
    queued.splice(0)
    await requestScope.close()
    globals.mikkaPool = previousPools.mikka; globals.workspacePool = previousPools.workspace
    for (let i = 0; i < pools.length; i++) await dropTestDatabase(admin, databaseNames[i], pools[i])
    await admin.end()
    scheduler.restore()
    if (previous.url === undefined) delete process.env.DEVICE_GATEWAY_URL; else process.env.DEVICE_GATEWAY_URL = previous.url
    if (previous.secret === undefined) delete process.env.DEVICE_GATEWAY_PUSH_SECRET; else process.env.DEVICE_GATEWAY_PUSH_SECRET = previous.secret
    receiver.close(); await once(receiver, 'close')
  }
})
