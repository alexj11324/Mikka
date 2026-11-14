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
  // Keep the unrelated model consumer offline; submission, PostgreSQL commit
  // observation and delivery to the actual local HTTP receiver stay real.
  const coordinator = mock.module(new URL('../coordinator/wake.ts', import.meta.url).href, {
    namedExports: { wakeCoordinator: async () => {} },
  })
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
  const { taskActivityChanged } = await import('../factory/activity-live')
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
    const taskDeliveries = (from: number) => sent.slice(from).filter(delivery => Array.isArray(delivery.events)
      && delivery.events.some(event => event.kind === 'factory_task'))

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

    await t.test('activity invalidation waits for a real commit, deduplicates the run, and retains its database', async () => {
      const tx = await requestPool.connect(), runId = randomUUID(), agentId = randomUUID()
      let task: Awaited<ReturnType<typeof route>>
      try { await tx.query('BEGIN'); task = await route(tx); await tx.query('COMMIT') }
      finally { await tx.query('ROLLBACK'); tx.release() }
      await drain()
      await requestPool.query('INSERT INTO agents(id,"userId",harness,name) VALUES($1,$2,\'codex\',$3)', [agentId,owner,agentId])
      const writer = await requestPool.connect(), before = sent.length
      try {
        await writer.query('BEGIN')
        await writer.query('INSERT INTO agent_runs(id,"userId","issueId","agentId") VALUES($1,$2,$3,$4)', [runId,owner,task.issueId,agentId])
        await writer.query('UPDATE factory_attempts SET "runId"=$2 WHERE id=$1 AND "taskId"=$3', [task.attemptId,runId,task.id])
        await requestScope.run(() => app.withDatabaseClient(writer, () => {
          taskActivityChanged(app.db, runId)
          taskActivityChanged(app.db, runId)
        }))
        assert.equal(queued.length, 0)
        assert.equal((await requestPool.query('SELECT id FROM agent_runs WHERE id=$1', [runId])).rowCount, 0)
        await writer.query('COMMIT') // Deliberately outside the originating request context.
        assert.equal(queued.length, 1)
        await drain() // Resolve the run's persisted task, then use the normal Factory sender.
        await drain()
        assert.deepEqual(sent.slice(before), [expected(task)])

        for (const savepoint of [false, true]) {
          await writer.query('BEGIN')
          if (savepoint) await writer.query('SAVEPOINT activity_reverted')
          await writer.query('UPDATE agent_runs SET prompt=\'rolled back activity\' WHERE id=$1', [runId])
          await requestScope.run(() => app.withDatabaseClient(writer, () => taskActivityChanged(app.db, runId)))
          if (savepoint) { await writer.query('ROLLBACK TO SAVEPOINT activity_reverted'); await writer.query('COMMIT') }
          else await writer.query('ROLLBACK')
          assert.equal(queued.length, 0)
          assert.equal((await requestPool.query('SELECT prompt FROM agent_runs WHERE id=$1', [runId])).rows[0].prompt, '')
        }
        assert.deepEqual(sent.slice(before), [expected(task)])
        for (const runOwner of [`${owner}-other`, owner]) {
          const issueId = randomUUID(), otherAgent = randomUUID(), otherRun = randomUUID()
          if (runOwner !== owner) await requestPool.query('INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,\'Activity fixture\',$2,true,now(),now())', [runOwner,`${runOwner}@example.invalid`])
          await requestPool.query(`INSERT INTO issues(id,"userId","workspaceId",title,content,status,priority) VALUES($1,$2,$3,'Other activity fixture','{"type":"doc","content":[]}','todo','normal')`, [issueId,runOwner,intended])
          await requestPool.query('INSERT INTO agents(id,"userId",harness,name) VALUES($1,$2,\'codex\',$3)', [otherAgent,runOwner,otherAgent])
          await requestPool.query('INSERT INTO agent_runs(id,"userId","issueId","agentId") VALUES($1,$2,$3,$4)', [otherRun,runOwner,issueId,otherAgent])
          // Each run obeys the real issue/owner constraints. Only the task's
          // attempt link is mismatched, which this reader must reject.
          await requestPool.query('UPDATE factory_attempts SET "runId"=$2 WHERE id=$1', [task.attemptId,otherRun])
          await requestScope.run(() => taskActivityChanged(app.pool, otherRun))
          await drain(); await drain()
          assert.deepEqual(sent.slice(before), [expected(task)], 'mismatched run owner or issue cannot invalidate a task')
        }
        await requestPool.query('UPDATE factory_attempts SET "runId"=$2 WHERE id=$1', [task.attemptId,runId])
      } finally { await writer.query('ROLLBACK'); writer.release() }
    })

    await t.test('ordinary Artifact submissions refresh their task only after the outer commit and never after rollback', async () => {
      const tx = await requestPool.connect(), runId = randomUUID(), agentId = randomUUID()
      let task: Awaited<ReturnType<typeof route>>
      try { await tx.query('BEGIN'); task = await route(tx); await tx.query('COMMIT') }
      finally { await tx.query('ROLLBACK'); tx.release() }
      await drain()
      await requestPool.query('INSERT INTO agents(id,"userId",harness,name) VALUES($1,$2,\'codex\',$3)', [agentId,owner,agentId])
      await requestPool.query('INSERT INTO agent_runs(id,"userId","issueId","agentId","botId") VALUES($1,$2,$3,$4,$5)',
        [runId,owner,task.issueId,agentId,task.botId])
      await requestPool.query('UPDATE factory_attempts SET "runId"=$2 WHERE id=$1 AND "taskId"=$3', [task.attemptId,runId,task.id])
      const { submitArtifact } = await import('../artifacts/store')
      const { withTaskWorkspace } = await import('../task-workspace')
      const { artifactStorage } = await import('../artifacts/storage')
      assert.equal(artifactStorage(), 'inline', 'the notification fixture never uploads external objects')
      const submit = (artifactId?: string) => submitArtifact({ userId: owner, runId, issueId: task.issueId, botId: task.botId, authorName: 'Fixture' },
        { title: 'Running task document', kind: 'markdown', content: '# Committed task document', ...(artifactId ? { artifactId } : {}) })
      let artifactId = '', before = sent.length
      await requestScope.run(() => withTaskWorkspace(owner,intended,() => app.db.transaction(outer => app.withDatabaseTransaction(outer, async () => {
        const result = await submit()
        assert.ok(!('error' in result)); artifactId = result.artifactId
        assert.equal((await requestPool.query('SELECT id FROM artifacts WHERE id=$1', [artifactId])).rowCount, 0)
        // Draining while the transaction is open would expose an eager notification.
        await drain(); await drain()
        assert.deepEqual(taskDeliveries(before), [])
      }))))
      assert.equal((await requestPool.query('SELECT id FROM artifacts WHERE id=$1', [artifactId])).rowCount, 1)
      await drain(); await drain()
      assert.deepEqual(taskDeliveries(before), [expected(task)])
      before = sent.length
      await assert.rejects(requestScope.run(() => withTaskWorkspace(owner,intended,() => app.db.transaction(outer => app.withDatabaseTransaction(outer, async () => {
        const result = await submit(artifactId)
        assert.ok(!('error' in result)); assert.equal(result.version, 2)
        await drain(); await drain()
        assert.deepEqual(taskDeliveries(before), [])
        throw new Error('artifact activity rollback')
      })))), /artifact activity rollback/)
      await drain(); await drain()
      assert.deepEqual(taskDeliveries(before), [])
      assert.equal((await requestPool.query('SELECT "latestVersion" FROM artifacts WHERE id=$1', [artifactId])).rows[0].latestVersion, 1)
      assert.equal((await requestPool.query('SELECT count(*)::int AS n FROM artifact_versions WHERE "artifactId"=$1', [artifactId])).rows[0].n, 1)
    })

    await t.test('claim, first running batch and late completion refresh the task only after real commits', async () => {
      const tx = await requestPool.connect(), runId = randomUUID(), agentId = randomUUID(), deviceId = randomUUID()
      let task: Awaited<ReturnType<typeof route>>
      try { await tx.query('BEGIN'); task = await route(tx); await tx.query('COMMIT') }
      finally { await tx.query('ROLLBACK'); tx.release() }
      await drain()
      await requestPool.query('INSERT INTO devices(id,"ownerId",name) VALUES($1,$2,\'Activity worker\')', [deviceId,owner])
      await requestPool.query('INSERT INTO agents(id,"userId",harness,name,"deviceId") VALUES($1,$2,\'codex\',$3,$4)', [agentId,owner,agentId,deviceId])
      await requestPool.query('INSERT INTO agent_runs(id,"userId","issueId","agentId","botId","deviceId") VALUES($1,$2,$3,$4,$5,$6)',
        [runId,owner,task.issueId,agentId,task.botId,deviceId])
      await requestPool.query('UPDATE factory_attempts SET "runId"=$2 WHERE id=$1 AND "taskId"=$3', [task.attemptId,runId,task.id])
      const { claimLocalRun } = await import('../computer/claim')
      const { persistRunEventBatch } = await import('../secrets/run-events')
      const { identityMasker } = await import('../secrets/mask')
      const { persistRunCompletion } = await import('../run-publications')
      const state = async () => (await requestPool.query('SELECT status,"startedAt","finishedAt" FROM agent_runs WHERE id=$1', [runId])).rows[0]
      const claim = (afterClaim?: (client: PoolClient) => Promise<void>) => requestScope.run(() => claimLocalRun(app.pool, runId, deviceId,
        new Date(Date.now() + 60_000), undefined, undefined, afterClaim))
      let before = sent.length
      await assert.rejects(claim(async () => {
        assert.equal((await state()).status, 'queued', 'another connection cannot see the uncommitted claim')
        await drain(); await drain()
        assert.deepEqual(taskDeliveries(before), [])
        throw new Error('claim activity rollback')
      }), /claim activity rollback/)
      await drain(); await drain()
      assert.deepEqual(await state(), { status: 'queued', startedAt: null, finishedAt: null })
      assert.deepEqual(taskDeliveries(before), [])
      assert.equal(await claim(), 'claimed')
      assert.equal((await state()).status, 'preparing')
      assert.ok((await state()).startedAt)
      await drain(); await drain()
      assert.deepEqual(taskDeliveries(before), [expected(task)])
      before = sent.length
      assert.equal(await claim(), 'unavailable')
      await drain(); await drain()
      assert.deepEqual(taskDeliveries(before), [], 'a claim replay does not refresh a task')

      const chunks = [{ type: 'text-start', id: 'reply' }, { type: 'text-delta', id: 'reply', delta: 'Working' }]
      await assert.rejects(requestScope.run(() => app.db.transaction(outer => app.withDatabaseTransaction(outer, async () => {
        await persistRunEventBatch(runId, 0, chunks, identityMasker)
        assert.equal((await state()).status, 'preparing')
        await drain(); await drain()
        assert.deepEqual(taskDeliveries(before), [])
        throw new Error('running activity rollback')
      }))), /running activity rollback/)
      await drain(); await drain()
      assert.equal((await state()).status, 'preparing')
      assert.equal((await requestPool.query('SELECT count(*)::int AS n FROM run_chunks WHERE "runId"=$1', [runId])).rows[0].n, 0)
      assert.deepEqual(taskDeliveries(before), [])
      await requestScope.run(() => persistRunEventBatch(runId, 0, chunks, identityMasker))
      assert.equal((await state()).status, 'running')
      await drain(); await drain()
      assert.deepEqual(taskDeliveries(before), [expected(task)])
      before = sent.length
      await requestScope.run(() => persistRunEventBatch(runId, 0, chunks, identityMasker))
      await requestScope.run(() => persistRunEventBatch(runId, 2, [{ type: 'text-delta', id: 'reply', delta: ' still' }], identityMasker))
      await drain(); await drain()
      assert.deepEqual(taskDeliveries(before), [], 'replays and subsequent text tokens do not refresh the task')

      // A cancelled task will not reconcile again. Its late worker completion
      // must still update the Agents/timeline rows through the real writer.
      await requestPool.query('UPDATE factory_tasks SET status=\'cancelled\' WHERE id=$1', [task.id])
      const flags = { routing: process.env.MIKKA_FACTORY_ROUTING_ENABLED, lifecycle: process.env.MIKKA_FACTORY_LIFECYCLE_ENABLED }
      process.env.MIKKA_FACTORY_ROUTING_ENABLED = '0'; process.env.MIKKA_FACTORY_LIFECYCLE_ENABLED = '0'
      try {
        // A real deferred constraint fails COMMIT after all completion effects
        // have registered, exercising the observed executor's failed-commit path.
        await requestPool.query(`CREATE FUNCTION activity_completion_rollback() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN RAISE EXCEPTION 'completion activity rollback'; END $$`)
        await requestPool.query(`CREATE CONSTRAINT TRIGGER activity_completion_rollback AFTER UPDATE ON agent_runs
          DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.id='${runId}'::uuid AND NEW.status='cancelled')
          EXECUTE FUNCTION activity_completion_rollback()`)
        await assert.rejects(requestScope.run(() => persistRunCompletion(owner, runId, { stopReason: 'cancelled' })),
          (error: unknown) => {
            const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error
            return cause instanceof Error && cause.message.includes('completion activity rollback')
          })
        await drain(); await drain()
        assert.equal((await state()).status, 'running')
        assert.equal((await state()).finishedAt, null)
        assert.deepEqual(taskDeliveries(before), [])
        await requestPool.query('DROP TRIGGER activity_completion_rollback ON agent_runs')
        await requestPool.query('DROP FUNCTION activity_completion_rollback()')
        assert.ok(await requestScope.run(() => persistRunCompletion(owner, runId, { stopReason: 'cancelled' })))
        const ended = await state()
        assert.equal(ended.status, 'cancelled'); assert.ok(ended.finishedAt)
        await drain(); await drain()
        assert.deepEqual(taskDeliveries(before), [expected(task)])
        before = sent.length
        assert.ok(await requestScope.run(() => persistRunCompletion(owner, runId, { stopReason: 'cancelled' })))
        assert.deepEqual(await state(), ended)
        await drain(); await drain()
        assert.deepEqual(taskDeliveries(before), [], 'the immutable completion replay sends no duplicate activity')
      } finally {
        await requestPool.query('DROP TRIGGER IF EXISTS activity_completion_rollback ON agent_runs')
        await requestPool.query('DROP FUNCTION IF EXISTS activity_completion_rollback()')
        if (flags.routing === undefined) delete process.env.MIKKA_FACTORY_ROUTING_ENABLED; else process.env.MIKKA_FACTORY_ROUTING_ENABLED = flags.routing
        if (flags.lifecycle === undefined) delete process.env.MIKKA_FACTORY_LIFECYCLE_ENABLED; else process.env.MIKKA_FACTORY_LIFECYCLE_ENABLED = flags.lifecycle
      }
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
    coordinator.restore()
    if (previous.url === undefined) delete process.env.DEVICE_GATEWAY_URL; else process.env.DEVICE_GATEWAY_URL = previous.url
    if (previous.secret === undefined) delete process.env.DEVICE_GATEWAY_PUSH_SECRET; else process.env.DEVICE_GATEWAY_PUSH_SECRET = previous.secret
    receiver.close(); await once(receiver, 'close')
  }
})
