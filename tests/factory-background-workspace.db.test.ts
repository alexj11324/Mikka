import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomBytes, randomUUID } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import test, { mock } from 'node:test'
import { setTimeout as pause } from 'node:timers/promises'
import { Pool } from 'pg'
import { disposableDatabase } from './helpers/e2e-target.mjs'
import { orderMigrations } from '../scripts/migration-order.mjs'
import { createTestDatabase, dropTestDatabase } from './support/drop-test-database'

const target = process.env.E2E_DATABASE_URL
const allowed = !!target && disposableDatabase(process.env, target)
if (process.env.REQUIRE_DB === '1' && !allowed) throw new Error('Factory background tests require isolated loopback *_e2e targets')
const code = (error: unknown): string | undefined => error && typeof error === 'object'
  ? 'code' in error && typeof error.code === 'string' ? error.code : 'cause' in error ? code(error.cause) : undefined : undefined

test('background Factory transactions use persisted tenants before the APP pool and preserve native device authority', { skip: !allowed, timeout: 180_000 }, async t => {
  const admin = new Pool({ connectionString: target, max: 1 })
  const database = 'factory_background_' + randomUUID().replaceAll('-', '') + '_e2e'
  await createTestDatabase(admin, database, 'template0')
  const isolated = new URL(target!); isolated.pathname = '/' + database
  const url = isolated.toString()
  // Independent control transactions orchestrate two real blocking writers and
  // inspect pg_stat_activity. Both application pools remain exactly one.
  const controls = new Pool({ connectionString: url, max: 3, application_name: 'factory_background_control' })
  const app = new Pool({ connectionString: url, max: 1, application_name: 'factory_background_app',
    connectionTimeoutMillis: 3000, options: '-c statement_timeout=10000 -c lock_timeout=5000' })
  const workspace = new Pool({ connectionString: url, max: 1, application_name: 'factory_background_workspace',
    connectionTimeoutMillis: 3000, options: '-c statement_timeout=10000 -c lock_timeout=5000' })
  const globals = globalThis as unknown as { mikkaPool?: Pool; workspacePool?: Pool }
  const oldPools = { app: globals.mikkaPool, workspace: globals.workspacePool }
  const envNames = ['E2E_DATABASE_URL', 'MIKKA_DATABASE_URL', 'DATABASE_URL', 'ORVILO_DATABASE_URL', 'VERCEL_ENV', 'MIKKA_EDITION',
    'MIKKA_BYOS_ENABLED', 'BETTER_AUTH_URL', 'BETTER_AUTH_SECRET', 'WORKSPACE_SECRETS_KEY', 'NEXT_PUBLIC_POSTHOG_KEY'] as const
  const prior = Object.fromEntries(envNames.map(key => [key, process.env[key]]))
  Object.assign(process.env, { E2E_DATABASE_URL: url, MIKKA_DATABASE_URL: url, DATABASE_URL: url, ORVILO_DATABASE_URL: url,
    MIKKA_EDITION: 'cloud', MIKKA_BYOS_ENABLED: '1', BETTER_AUTH_URL: 'http://localhost:3100', NEXT_PUBLIC_POSTHOG_KEY: '',
    BETTER_AUTH_SECRET: randomBytes(32).toString('hex'), WORKSPACE_SECRETS_KEY: randomBytes(32).toString('hex') })
  delete process.env.VERCEL_ENV
  globals.mikkaPool = app; globals.workspacePool = workspace
  let flushWakes: (() => Promise<void>) | undefined
  let clearSwitches: (() => void) | undefined
  t.after(async () => {
    await flushWakes?.()
    clearSwitches?.(); mock.restoreAll()
    globals.mikkaPool = oldPools.app; globals.workspacePool = oldPools.workspace
    await dropTestDatabase(admin, database, app, workspace, controls)
    await admin.end()
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
  assert.equal(Math.floor(Number((await controls.query('SHOW server_version_num')).rows[0].server_version_num) / 10000), 17)
  const directory = new URL('../drizzle/', import.meta.url)
  for (const name of orderMigrations((await readdir(directory)).filter(name => name.endsWith('.sql'))))
    await controls.query(await readFile(new URL(name, directory), 'utf8'))
  const { isolateCoordinatorWakes } = await import('./support/coordinator-wake')
  const wakes = await isolateCoordinatorWakes(t); flushWakes = wakes.flush
  const { overrideDeploymentSwitch } = await import('../lib/deployment-switches')
  for (const name of ['factoryRouting', 'factoryLifecycle', 'issueTools', 'byos'] as const) overrideDeploymentSwitch(name, true)
  clearSwitches = () => { for (const name of ['factoryRouting', 'factoryLifecycle', 'issueTools', 'byos'] as const) overrideDeploymentSwitch(name, undefined) }
  const { seedUser, seedWorkspace, seedBot, seedAgent } = await import('./support/workspace-admin-db')
  const owner = await seedUser(controls, 'factory-background'), stranger = await seedUser(controls, 'factory-stranger')
  const alpha = (await seedWorkspace(controls, owner, [{ userId: owner, role: 'admin' }, { userId: stranger, role: 'member' }])).id
  const beta = (await seedWorkspace(controls, owner, [{ userId: owner, role: 'admin' }])).id
  const alphaBot = await seedBot(controls, alpha, owner), betaBot = await seedBot(controls, beta, owner)
  const agentId = await seedAgent(controls, owner)
  const { pool } = await import('../lib/db')
  const { withTaskWorkspace, borrowTaskWorkspaceMembership } = await import('../lib/task-workspace')
  const { withProjectResourceLease } = await import('../lib/project-resources/store')
  const { workspacePool } = await import('../lib/workspace-db')
  const { actAs } = await import('../lib/acting-user')
  const { tokenWorkspace } = await import('../lib/tokens/principal')
  const { factoryForBot, factoryStore } = await import('../lib/factory/server')
  const { factoryRuntimeForBot, guardFactoryClaim } = await import('../lib/factory/runtime')
  const { factoryBinding } = await import('../lib/factory/dispatch')
  const { factoryTaskWorkspaceBoundary } = await import('../lib/factory/background-workspace')
  const { beginFactoryTransaction, commitFactoryTransaction, rollbackFactoryTransaction, forgetFactoryTransaction, registerFactoryProfile } = await import('../lib/factory/transaction')
  const { createFactoryReconciler } = await import('../lib/factory/reconcile')
  const { claimLocalRun } = await import('../lib/computer/claim')
  const { withDeviceDatabaseAuthority, withDeviceUnitFence, isDeviceAuthorityRevoked } = await import('../lib/db/device-scope')
  const runtime = factoryRuntimeForBot(alphaBot)
  let number = 0

  async function fixture(workspaceId: string, botId: string | null = null) {
    const issueId = randomUUID(), sourceEventId = randomUUID(), eventId = randomUUID()
    await controls.query('INSERT INTO issues(id,"userId","workspaceId","ownershipState",scope,title,content,status,priority) VALUES($1,$2,$3,\'bound\',\'workspace\',\'Background fixture\',$4,\'todo\',\'normal\')',
      [issueId, owner, workspaceId, JSON.stringify({ type: 'doc', attrs: { mikka: { number: ++number } }, content: [] })])
    await controls.query('INSERT INTO coordinator_events(id,"userId","botId","issueId",kind,"dedupeKey",payload) VALUES($1::uuid,$2,$3,$4,\'user_message\',$1::text,\'{"text":"Bounded background fixture"}\')',
      [sourceEventId, owner, botId, issueId])
    const input = { issueId, eventId, sourceEventId, rationale: 'Verify the persisted Factory tenant', needsSpec: false }
    const result = await factoryForBot(botId).route(owner, input)
    assert.equal(result.task.workspaceId, workspaceId)
    return { issueId, sourceEventId, input, task: result.task }
  }
  const a = await fixture(alpha, alphaBot), b = await fixture(beta, betaBot)

  const state = async () => (await controls.query(`SELECT
    (SELECT coalesce(jsonb_agg(jsonb_build_array(id,"workspaceId",revision,status,"attemptId") ORDER BY id),'[]') FROM factory_tasks WHERE "userId"=$1) AS tasks,
    (SELECT count(*)::int FROM factory_events e JOIN factory_tasks t ON t.id=e."taskId" WHERE t."userId"=$1) AS events,
    (SELECT coalesce(jsonb_agg(jsonb_build_array(id,"workspaceId",status,"stopRequestedAt") ORDER BY id),'[]') FROM agent_runs WHERE "userId"=$1) AS runs,
    (SELECT count(*)::int FROM issue_versions WHERE "userId"=$1) AS history`, [owner])).rows[0]
  const waitFor = async (predicate: () => Promise<boolean>, label: string) => {
    const deadline = Date.now() + 2500
    while (!await predicate()) {
      assert.ok(Date.now() < deadline, label)
      await pause(10)
    }
  }

  // The observer calls the actual Pool.connect without changing its result,
  // allocation, SQL or authorization. It only identifies the queued operation.
  async function behindWorkspaceWriter<T>(work: () => Promise<T>) {
    const marker = new AsyncLocalStorage<boolean>()
    const acquired = Promise.withResolvers<void>(), proceed = Promise.withResolvers<void>(), queued = Promise.withResolvers<void>()
    const connect = workspace.connect.bind(workspace) as (...args: unknown[]) => unknown
    const observation = mock.method(workspace, 'connect', ((...args: unknown[]) => {
      if (marker.getStore()) queued.resolve()
      return connect(...args)
    }) as Pool['connect'])
    const writer = withTaskWorkspace(owner, alpha, async () => {
      acquired.resolve(); await proceed.promise
      await pool.query('UPDATE issues SET title=\'Writer completed before background checkout\' WHERE id=$1', [a.issueId])
    })
    await acquired.promise
    const reading = marker.run(true, work)
    try {
      await Promise.race([queued.promise, reading.then(() => { throw new Error('Background operation completed before Workspace admission') })])
      proceed.resolve()
      const [, result] = await Promise.all([writer, reading])
      assert.equal(app.totalCount, 1); assert.equal(workspace.totalCount, 1)
      return result
    } finally {
      proceed.resolve(); await Promise.allSettled([writer, reading]); observation.mock.restore()
    }
  }

  await t.test('named-Bot route and list use their real tenant and preserve source replay', async () => {
    const replay = await factoryForBot(alphaBot).route(owner, a.input)
    assert.equal(replay.task.id, a.task.id)
    assert.equal((await factoryForBot(alphaBot).listPublicForIssue(owner, a.issueId)).tasks[0].id, a.task.id)
    const before = await state()
    await assert.rejects(runtime.store.apply(owner, null as unknown as Parameters<typeof runtime.store.apply>[1], randomUUID(), { action: 'cancel', reason: 'Malformed input' }),
      error => code(error) === 'factoryInvalid')
    await assert.rejects(factoryForBot(betaBot).route(owner, a.input), error => code(error) === 'factoryNotFound')
    await assert.rejects(runtime.store.read(stranger, a.task.id), error => code(error) === 'factoryNotFound')
    await assert.rejects(actAs({ id: owner, [tokenWorkspace]: beta }, () => runtime.store.read(owner, a.task.id)), error => code(error) === 'factoryNotFound')
    assert.deepEqual(await state(), before)
  })

  await t.test('actual background question read leaves APP free while awaiting the only Workspace connection', async () => {
    assert.deepEqual(await behindWorkspaceWriter(() => runtime.questions.list(owner, a.task.id)), [])
    assert.equal((await controls.query('SELECT title FROM issues WHERE id=$1', [a.issueId])).rows[0].title, 'Writer completed before background checkout')
  })

  await t.test('existing APP work needs its exact live lease and Profile COMMIT borrows it without another checkout', async () => {
    const before = await state(), tx = await pool.connect()
    try {
      await beginFactoryTransaction(tx)
      await assert.rejects(runtime.store.apply(owner, factoryBinding(a.task), randomUUID(), { action: 'cancel', reason: 'Must not commit without the outer tenant lease' }, tx),
        error => code(error) === 'factoryNotFound')
      await rollbackFactoryTransaction(tx)
    } finally { forgetFactoryTransaction(tx); tx.release() }
    assert.deepEqual(await state(), before)
    await withTaskWorkspace(owner, alpha, async () => {
      const tx = await pool.connect()
      try {
        await beginFactoryTransaction(tx)
        await assert.rejects(runtime.store.route(owner, a.input, tx), error => code(error) === 'projectEnvironmentUnavailable')
      } finally { await rollbackFactoryTransaction(tx); forgetFactoryTransaction(tx); tx.release() }
    })
    assert.deepEqual(await state(), before, 'an existing APP transaction cannot repair a missing resource lease')
    let expired: ReturnType<typeof borrowTaskWorkspaceMembership>
    await withProjectResourceLease(owner, alpha, async () => {
      const tx = await pool.connect()
      try {
        await beginFactoryTransaction(tx)
        const same = await runtime.store.route(owner, a.input, tx)
        assert.equal(same.task.id, a.task.id)
        registerFactoryProfile(tx, { ownerId: owner, workspaceId: alpha })
        await commitFactoryTransaction(tx)
      } catch (error) { await rollbackFactoryTransaction(tx); throw error }
      finally { forgetFactoryTransaction(tx); tx.release() }
      const borrowed = borrowTaskWorkspaceMembership(owner, alpha)
      assert.ok(borrowed); await borrowed.check()
      const heldPid = (await workspacePool.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
      assert.equal((await borrowed.workspaceClient.query('SELECT pg_backend_pid() AS pid')).rows[0].pid, heldPid,
        'borrowed policy reads use the sole held Workspace backend')
      expired = borrowTaskWorkspaceMembership(owner, alpha)
      await borrowed.close()
      await assert.rejects(async () => borrowed.workspaceClient.query('SELECT 1'), error => code(error) === 'workspaceAccessDenied')
      await assert.rejects(borrowed.check(), error => code(error) === 'workspaceAccessDenied')
      await assert.rejects(factoryRuntimeForBot(betaBot).store.read(owner, b.task.id), error => code(error) === 'factoryNotFound')
    })
    assert.ok(expired!)
    await assert.rejects(async () => expired!.workspaceClient.query('SELECT 1'), error => code(error) === 'workspaceAccessDenied')
    await assert.rejects(expired!.check(), error => code(error) === 'workspaceAccessDenied')
    assert.equal(app.totalCount, 1); assert.equal(workspace.totalCount, 1)
  })

  await t.test('an existing Factory APP transaction rechecks current Enterprise policy without another checkout', async () => {
    const organizationId = randomUUID(), sessionId = randomUUID()
    const { enterprisePrincipal } = await import('../lib/enterprise/principal')
    const reader = { id: owner, [tokenWorkspace]: alpha, [enterprisePrincipal]: { kind: 'session' as const, sessionId } }
    await controls.query('INSERT INTO mikka_organizations(id,name,"createdBy") VALUES($1,\'Background borrow fixture\',$2)', [organizationId, owner])
    await controls.query('INSERT INTO mikka_organization_workspaces("organizationId","workspaceId") VALUES($1,$2)', [organizationId, alpha])
    await controls.query('INSERT INTO enterprise_org_policy("organizationId","enforceSso","allowMachineCredentials") VALUES($1,false,false)', [organizationId])
    await controls.query('INSERT INTO session(id,token,"userId","expiresAt","createdAt","updatedAt") VALUES($1,$2,$3,now()+interval \'1 hour\',now(),now())', [sessionId, randomUUID(), owner])
    const before = await state()
    try {
      await actAs(reader, () => withProjectResourceLease(reader, alpha, async () => {
        const tx = await pool.connect()
        try {
          await beginFactoryTransaction(tx)
          assert.equal((await runtime.store.route(owner, a.input, tx)).task.id, a.task.id)
          await controls.query('UPDATE enterprise_org_policy SET "enforceSso"=true WHERE "organizationId"=$1', [organizationId])
          await assert.rejects(runtime.store.route(owner, a.input, tx), error => code(error) === 'factoryNotFound')
          registerFactoryProfile(tx, { ownerId: owner, workspaceId: alpha })
          await assert.rejects(commitFactoryTransaction(tx), error => code(error) === 'agentProfileScopeNotFound'
            && !!error && typeof error === 'object' && 'cause' in error && code(error.cause) === 'workspaceAccessDenied')
        } finally { await rollbackFactoryTransaction(tx); forgetFactoryTransaction(tx); tx.release() }
      }))
      assert.deepEqual(await state(), before, 'denied continuation and COMMIT leave no Factory effects')
      assert.equal(app.totalCount, 1); assert.equal(workspace.totalCount, 1)
      assert.equal(app.waitingCount, 0)
    } finally {
      await controls.query('DELETE FROM session WHERE id=$1', [sessionId])
      await controls.query('DELETE FROM enterprise_org_policy WHERE "organizationId"=$1', [organizationId])
      await controls.query('DELETE FROM mikka_organization_workspaces WHERE "organizationId"=$1', [organizationId])
      await controls.query('DELETE FROM mikka_organizations WHERE id=$1', [organizationId])
    }
  })

  await t.test('membership suspension waits for a background write commit and later operations have no side effects', async () => {
    const f = await fixture(alpha, alphaBot)
    const blocker = await controls.connect()
    let writing: Promise<unknown> | undefined, revoking: Promise<unknown> | undefined
    try {
      await blocker.query('BEGIN')
      await blocker.query('SELECT id FROM issues WHERE id=$1 FOR UPDATE', [f.issueId])
      writing = runtime.store.apply(owner, factoryBinding(f.task), randomUUID(), { action: 'cancel', reason: 'Serialize the real background transition' })
      await Promise.race([
        waitFor(async () => (await controls.query(`SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
          AND application_name='factory_background_app' AND wait_event_type='Lock' AND query LIKE '%FROM issues%'`)).rowCount! > 0, 'background writer must hold WS and wait for the real issue row'),
        writing.then(() => { throw new Error('Background write escaped the held issue lock') }),
      ])
      revoking = (async () => {
        const revoker = await controls.connect()
        try {
          await revoker.query('BEGIN')
          await revoker.query('UPDATE mikka_workspace_members SET status=\'suspended\' WHERE "workspaceId"=$1 AND "userId"=$2', [alpha, owner])
          assert.equal((await revoker.query('SELECT status FROM factory_tasks WHERE id=$1', [f.task.id])).rows[0].status, 'cancelled')
          await revoker.query('COMMIT')
        } catch (error) { await revoker.query('ROLLBACK'); throw error }
        finally { revoker.release() }
      })()
      await Promise.race([
        waitFor(async () => (await controls.query(`SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
          AND application_name='factory_background_control' AND wait_event_type='Lock' AND query LIKE 'UPDATE mikka_workspace_members%'`)).rowCount! > 0, 'suspension must wait for the held membership lease'),
        revoking.then(() => { throw new Error('Suspension escaped the background membership lease') }),
      ])
      await blocker.query('COMMIT')
      await Promise.all([writing, revoking])
      const before = await state()
      await assert.rejects(runtime.store.read(owner, f.task.id), error => code(error) === 'factoryNotFound')
      await assert.rejects(runtime.questions.list(owner, a.task.id), error => code(error) === 'factoryNotFound')
      assert.deepEqual(await state(), before)
      assert.equal((await factoryRuntimeForBot(betaBot).store.read(owner, b.task.id)).task.id, b.task.id)
    } finally {
      await blocker.query('ROLLBACK').catch(() => undefined); blocker.release()
      await Promise.allSettled([writing, revoking].filter((p): p is Promise<unknown> => !!p))
      await controls.query('UPDATE mikka_workspace_members SET status=\'active\' WHERE "workspaceId"=$1 AND "userId"=$2', [alpha, owner])
    }
  })

  await t.test('botless reconciliation borrows each persisted task tenant independently', async () => {
    const one = await fixture(alpha), two = await fixture(beta)
    for (const f of [one, two]) await controls.query('INSERT INTO factory_events("taskId","eventId",request,result) VALUES($1,$2,$3,\'{}\')',
      [f.task.id, randomUUID(), JSON.stringify({ kind: 'request_epoch', sourceEventId: f.sourceEventId })])
    const visited: string[] = []
    const reconcile = createFactoryReconciler(pool, factoryStore, undefined, {}, null, async (tx, store, task) => {
      const lease = borrowTaskWorkspaceMembership(owner, task.workspaceId!)
      assert.ok(lease); await lease.check(); await lease.close()
      registerFactoryProfile(tx, { ownerId: owner, workspaceId: task.workspaceId! })
      await store.apply(owner, factoryBinding(task), randomUUID(), { action: 'cancel', reason: 'Host consumer completed this synthetic pending epoch' }, tx)
      visited.push(task.workspaceId!)
      return async () => {
        assert.equal(borrowTaskWorkspaceMembership(owner, task.workspaceId!), null, 'post-commit launch must not inherit an expired lease')
        const saved = await pool.query('SELECT status FROM factory_tasks WHERE id=$1', [task.id])
        assert.equal(saved.rows[0].status, 'cancelled')
      }
    }, factoryTaskWorkspaceBoundary(pool, null))
    assert.equal((await behindWorkspaceWriter(() => reconcile(owner))).recovered, 2)
    assert.deepEqual(visited.sort(), [alpha, beta].sort())
    assert.equal((await controls.query('SELECT count(*)::int AS count FROM factory_tasks WHERE id=ANY($1::uuid[]) AND status=\'cancelled\'', [[one.task.id, two.task.id]])).rows[0].count, 2)
    assert.equal(app.totalCount, 1); assert.equal(workspace.totalCount, 1)
  })

  const deviceId = randomUUID()
  await controls.query('INSERT INTO devices(id,"ownerId",name,kind,enabled,"protocolVersion","lastSeenAt") VALUES($1,$2,\'Background local fixture\',\'local\',true,3,now())', [deviceId, owner])
  const run = async (workspaceId: string | null) => {
    const id = randomUUID()
    await controls.query('INSERT INTO agent_runs(id,"userId","workspaceId","agentId","deviceId",status,prompt) VALUES($1,$2,$3,$4,$5,\'queued\',\'Synthetic claim; no executor\')', [id, owner, workspaceId, agentId, deviceId])
    return id
  }

  await t.test('real local claim waits for Workspace before APP and retains the original transaction hook', async () => {
    const id = await run(alpha)
    let guarded = false
    const result = await behindWorkspaceWriter(() => claimLocalRun(pool, id, deviceId, new Date(Date.now() + 60000), undefined, async tx => {
      await guardFactoryClaim(tx, owner, deviceId, id, new Date(Date.now() + 60000).toISOString())
      guarded = true
    }))
    assert.equal(result, 'claimed'); assert.equal(guarded, true)
    const saved = (await controls.query('SELECT status,"workspaceId" FROM agent_runs WHERE id=$1', [id])).rows[0]
    assert.equal(saved.status, 'preparing'); assert.equal(saved.workspaceId, alpha)
  })

  await t.test('both native device fences reject a revoked credential before any background claim mutation', async () => {
    for (const mode of ['statement', 'unit'] as const) {
      const id = await run(alpha), tokenId = randomUUID()
      await controls.query('INSERT INTO device_tokens(id,"userId","tokenHash","revokedAt","boundDeviceId","boundWorkspaceId","expiresAt") VALUES($1,$2,$3,now(),$4,$5,now()+interval \'1 hour\')',
        [tokenId, owner, randomBytes(32).toString('hex'), deviceId, alpha])
      const before = await state()
      const work = () => claimLocalRun(pool, id, deviceId, new Date(Date.now() + 60000))
      const claim = mode === 'statement' ? withDeviceDatabaseAuthority({ tokenId, userId: owner }, work)
        : withDeviceUnitFence({ tokenId, userId: owner }, work)
      await assert.rejects(claim, isDeviceAuthorityRevoked)
      assert.deepEqual(await state(), before)
    }
  })

  await t.test('unassigned task-free runs cannot acquire an owner-home fallback claim', async () => {
    const id = await run(null), before = await state()
    assert.equal(await claimLocalRun(pool, id, deviceId, new Date(Date.now() + 60000)), 'unavailable')
    assert.deepEqual(await state(), before)
  })

  await t.test('retained Factory history of a deleted author never re-enters monitor or watchdog batches', async () => {
    const retired = await seedUser(controls, 'factory-retired')
    const shared = (await seedWorkspace(controls, retired, [{ userId: retired, role: 'admin' }, { userId: stranger, role: 'member' }])).id
    const retainedAgent = await seedAgent(controls, retired)
    const retained: Array<{ taskId: string; runId: string }> = []
    for (const status of ['passed', 'blocked'] as const) {
      const issueId = randomUUID(), sourceEventId = randomUUID(), runId = randomUUID(), candidateId = randomUUID()
      const stage = status === 'passed' ? 'monitor' : 'execute'
      await controls.query('INSERT INTO issues(id,"userId","workspaceId","ownershipState",scope,title,content,status,priority) VALUES($1,$2,$3,\'bound\',\'workspace\',\'Retained Factory fixture\',\'{"type":"doc"}\',\'todo\',\'normal\')',
        [issueId, retired, shared])
      await controls.query('INSERT INTO coordinator_events(id,"userId","issueId",kind,"dedupeKey",payload) VALUES($1::uuid,$2,$3,\'user_message\',$1::text,\'{"text":"Retained source"}\')',
        [sourceEventId, retired, issueId])
      const { task } = await factoryForBot(null).route(retired, { issueId, sourceEventId, eventId: randomUUID(), rationale: 'Retained history after account deletion', needsSpec: false })
      await controls.query('INSERT INTO agent_runs(id,"userId","workspaceId","agentId","issueId",status,kind,prompt) VALUES($1,$2,$3,$4,$5,\'succeeded\',\'acceptance\',\'Retained result\')',
        [runId, retired, shared, retainedAgent, issueId])
      await controls.query('INSERT INTO factory_candidates(id,"taskId",sha,repository,environment,scope,"runId") VALUES($1,$2,$3,\'fixture/repository\',\'test\',\'fixture\',$4)',
        [candidateId, task.id, 'd'.repeat(40), runId])
      await controls.query('UPDATE factory_attempts SET stage=$2,status=$3,"runId"=$4,"candidateId"=$5,output=$6::jsonb,"finishedAt"=now() WHERE id=$1',
        [task.attemptId, stage, status, runId, candidateId, JSON.stringify(status === 'blocked'
          ? { watchdog: { reasonCode: 'task_stalled', requestEpoch: sourceEventId } } : { monitorOutcome: 'healthy' })])
      await controls.query('UPDATE factory_tasks SET stage=$2,status=$3,"candidateId"=$4,"updatedAt"=now()-interval \'2 minutes\' WHERE id=$1',
        [task.id, stage, status, candidateId])
      if (status === 'passed') await controls.query('INSERT INTO coordinator_events(id,"userId","issueId","runId",kind,"dedupeKey",payload) VALUES($1::uuid,$2,$3,$4,\'run_finished\',$1::text,\'{}\')',
        [randomUUID(), retired, issueId, runId])
      retained.push({ taskId: task.id, runId })
    }
    const ids = retained.map(row => row.taskId)
    const history = async () => Promise.all([
      controls.query('SELECT * FROM factory_tasks WHERE id=ANY($1::uuid[]) ORDER BY id', [ids]).then(result => result.rows),
      controls.query('SELECT * FROM factory_attempts WHERE "taskId"=ANY($1::uuid[]) ORDER BY id', [ids]).then(result => result.rows),
      controls.query('SELECT * FROM factory_candidates WHERE "taskId"=ANY($1::uuid[]) ORDER BY id', [ids]).then(result => result.rows),
      controls.query('SELECT * FROM factory_events WHERE "taskId"=ANY($1::uuid[]) ORDER BY "taskId","eventId"', [ids]).then(result => result.rows),
    ])
    const before = await history()
    await wakes.flush()
    const priorWakes = [...wakes.calls]
    // The account suite exercises the full deletion job. Here its retained
    // state reaches the real background readers with the author row gone.
    await controls.query('DELETE FROM mikka_workspace_members WHERE "userId"=$1', [retired])
    await controls.query('DELETE FROM "user" WHERE id=$1', [retired])
    assert.deepEqual(await history(), before, 'passed and blocked results remain historical facts')

    const [{ sweepFactoryMonitor }, { createFactoryMonitor }, { sweepFactoryWatchdog }, { factoryMonitorWorkspaceKey }] = await Promise.all([
      import('../lib/factory/monitor-sweep'), import('../lib/factory/monitor'), import('../lib/factory/watchdog'),
      import('../lib/factory/server'),
    ])
    let monitorScopes = 0, admissions = 0, authorizations = 0, runtimeReads = 0, dispatches = 0, watchdogWakes = 0
    assert.deepEqual(await sweepFactoryMonitor(pool, () => {
      monitorScopes++
      return { reconcile: async () => ({ observed: 0 }) }
    }, { deadline: Date.now() + 5000 }), { enabled: true, scopes: 0, observed: 0, failed: 0, deferred: 0 })
    const boundary: import('../lib/factory/background-workspace').FactoryWorkspaceBoundary = async (userId, taskId, work, existing) => {
      admissions++
      return factoryTaskWorkspaceBoundary(pool, null)(userId, taskId, work, existing)
    }
    const monitor = createFactoryMonitor(pool, factoryRuntimeForBot(null).store, async () => {
      authorizations++
      throw new Error('Deleted authors must be excluded before execution authorization')
    }, factoryMonitorWorkspaceKey, undefined, [], null, boundary)
    assert.deepEqual(await monitor.reconcile(retired), { observed: 0 })
    assert.deepEqual(await sweepFactoryWatchdog(pool, {
      runtime: botId => { runtimeReads++; return factoryRuntimeForBot(botId) },
      dispatch: async () => { dispatches++ },
      wake: async () => { watchdogWakes++ },
    }, new Date(), Date.now() + 5000, { userId: retired, runId: retained[1].runId }),
    { scanned: 0, recovered: 0, blocked: 0, deferred: 0, failed: 0 })
    assert.deepEqual({ monitorScopes, admissions, authorizations, runtimeReads, dispatches, watchdogWakes },
      { monitorScopes: 0, admissions: 0, authorizations: 0, runtimeReads: 0, dispatches: 0, watchdogWakes: 0 })
    await wakes.flush()
    assert.deepEqual(wakes.calls, priorWakes, 'historical reads schedule no Coordinator wake')
    assert.deepEqual(await history(), before, 'background scans do not rewrite completed or blocked history')
  })
})
