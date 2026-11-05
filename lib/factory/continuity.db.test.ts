import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { Pool, type PoolClient } from 'pg'
import { dbUrl, seedAgent, seedIssue, seedRun, seedUser, seedWorkspace } from '../../tests/support/workspace-admin-db'
import { cleanAllowedModels, seedAllowedModel } from '../../tests/support/allowed-model'
import { createFactoryStore, type FactoryTask } from './store'
import { factoryBinding } from './dispatch'
import { FactoryError } from './contract'
import { advanceFactoryRequest } from './request-epoch'
import { currentFactoryRequest } from './checks'
import { factoryRecoveryHandoff, persistFactoryHandoff } from './handoff'
import { sweepFactoryWatchdog, type WatchdogDependencies } from './watchdog'

process.env.MIKKA_BYOS_VALIDATED_MODEL_ROUTES = 'claude_cpa,codex_cpa'
process.env.MIKKA_BYOS_ENABLED = '1'

test('PG: request epochs, stale completion fences and unattended handoff are durable', { skip: !dbUrl, timeout: 120000 }, async t => {
  const pool = new Pool({ connectionString: dbUrl, max: 8 })
  const [{ pool: appPool }, { workspacePool }] = await Promise.all([import('../db'), import('../workspace-db')])
  const owner = await seedUser(pool, 'factory-continuity')
  const workspace = await seedWorkspace(pool, owner, [{ userId: owner, role: 'admin' }])
  const agentId = await seedAgent(pool, owner)
  const store = createFactoryStore(pool, async (user, issue, tx) => user === owner && Boolean((await tx.query('SELECT id FROM issues WHERE id=$1 AND "userId"=$2', [issue, user])).rowCount), null, {})
  const taskIds: string[] = []
  t.after(async () => {
    await pool.query('DELETE FROM operation_ledger WHERE "ownerId"=$1', [owner])
    await pool.query('DELETE FROM factory_tasks WHERE id=ANY($1::uuid[])', [taskIds])
    await pool.query('DELETE FROM coordinator_events WHERE "userId"=$1', [owner])
    await pool.query('DELETE FROM agent_runs WHERE "userId"=$1', [owner])
    await cleanAllowedModels(pool, [owner])
    await pool.query('DELETE FROM agents WHERE "userId"=$1', [owner])
    await pool.query('DELETE FROM devices WHERE "ownerId"=$1', [owner])
    await pool.query('DELETE FROM issues WHERE "userId"=$1', [owner])
    await pool.query('DELETE FROM mikka_workspace_members WHERE "workspaceId"=$1', [workspace.id])
    await pool.query('DELETE FROM mikka_workspaces WHERE id=$1', [workspace.id])
    await pool.query('DELETE FROM "user" WHERE id=$1', [owner])
    await Promise.all([pool.end(), appPool.end(), workspacePool.end()])
  })
  const transaction = async <T>(fn: (tx: PoolClient) => Promise<T>) => {
    const tx = await pool.connect()
    try { await tx.query('BEGIN'); const result = await fn(tx); await tx.query('COMMIT'); return result }
    catch (error) { await tx.query('ROLLBACK'); throw error } finally { tx.release() }
  }
  async function fixture() {
    const issueId = await seedIssue(pool, owner)
    const sourceEventId = randomUUID()
    await pool.query(`INSERT INTO coordinator_events(id,"userId","issueId",kind,"dedupeKey",payload)
      VALUES($1::uuid,$2,$3,'user_message',$1::text,$4)`, [sourceEventId, owner, issueId, JSON.stringify({ text: 'Write exactly 53 bytes and retain the null-input test.' })])
    const state = await store.route(owner, { issueId, sourceEventId, eventId: randomUUID(), rationale: 'Owner request' })
    taskIds.push(state.task.id)
    const runId = await seedRun(pool, { userId: owner, agentId, issueId, status: 'succeeded' })
    await pool.query(`UPDATE factory_attempts SET "runId"=$2,status='passed',"finishedAt"=now(),output=$3 WHERE id=$1`,
      [state.task.attemptId, runId, JSON.stringify({ requestEpoch: sourceEventId })])
    await pool.query(`UPDATE factory_tasks SET status='passed' WHERE id=$1`, [state.task.id])
    return { ...state.task, status: 'passed' as const, runId }
  }
  async function followup(task: FactoryTask & { runId: string }, text: string) {
    const id = randomUUID()
    await pool.query(`INSERT INTO coordinator_events(id,"userId","issueId",kind,"dedupeKey",payload,tier,"deliveredAt")
      VALUES($1::uuid,$2,$3,'user_message',$1::text,$4,'background',now())`, [id, owner, task.issueId, JSON.stringify({ source: 'thread_continuation', previousRunId: task.runId, text })])
    return id
  }
  const advance = (task: FactoryTask, id: string) => transaction(async tx => advanceFactoryRequest(tx, await store.lockTask(tx, owner, task.id), id))

  await t.test('concurrent resend keeps one Task/epoch/attempt; old callbacks cannot finish or repair it', async () => {
    const original = await fixture()
    const id = await followup(original, 'Change the exact artifact target to 74 bytes; retain all other constraints.')
    const [a, b] = await Promise.all([advance(original, id), advance(original, id)])
    assert.equal(a.id, original.id)
    assert.equal(a.attemptId, b.attemptId)
    assert.equal(a.sourceEventId, id)
    assert.equal(a.stage, 'execute')
    assert.equal(a.status, 'pending')
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM factory_tasks WHERE "userId"=$1 AND "issueId"=$2', [owner, original.issueId])).rows[0].n, 1)
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM factory_attempts WHERE "taskId"=$1', [a.id])).rows[0].n, 2)
    await assert.rejects(store.route(owner, { issueId: original.issueId, sourceEventId: original.sourceEventId,
      eventId: randomUUID(), rationale: 'Delayed delivery of the old owner event' }), (e: unknown) => e instanceof FactoryError && e.code === 'factoryStale')
    await assert.rejects(store.apply(owner, factoryBinding(original), randomUUID(), { action: 'finish', status: 'passed', reason: 'Late old report', evidence: [], output: {} }), (e: unknown) => e instanceof FactoryError && e.code === 'factoryStale')
    await assert.rejects(store.apply(owner, factoryBinding(original), randomUUID(), { action: 'repair', reason: 'Old review requested 53 bytes' }), (e: unknown) => e instanceof FactoryError && e.code === 'factoryStale')
    assert.equal((await pool.query('SELECT status FROM factory_attempts WHERE id=$1', [original.attemptId])).rows[0].status, 'passed', 'accepted history stays immutable')
    const prompt = await currentFactoryRequest(pool, a)
    assert.match(prompt, /74 bytes/)
    assert.match(prompt, /retain the null-input test/)
    assert.match(prompt, /supersedes/)
    const handoff = await persistFactoryHandoff(pool, a)
    assert.equal(handoff.requestEpoch, id)
    assert.equal(handoff.completed[0].requestEpoch, original.sourceEventId)
    assert.equal(handoff.digest, (await persistFactoryHandoff(pool, a)).digest)
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM factory_events WHERE "taskId"=$1 AND request->>'kind'='task_handoff'`, [a.id])).rows[0].n, 1)
    await store.apply(owner, factoryBinding(a), randomUUID(), { action: 'cancel', reason: 'Fixture complete' })
  })

  await t.test('the direct route entry advances the same Task for its authenticated continuation', async () => {
    const original = await fixture();
    const sourceEventId = await followup(original, 'Continue with an exact 77 byte artifact.');
    const input = { issueId: original.issueId, sourceEventId, eventId: randomUUID(), rationale: 'Owner continuation' };
    const next = await store.route(owner, input);
    assert.equal(next.task.id, original.id);
    assert.equal(next.task.sourceEventId, sourceEventId);
    assert.equal((await store.route(owner, input)).task.attemptId, next.task.attemptId);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM factory_tasks WHERE "userId"=$1 AND "issueId"=$2', [owner, original.issueId])).rows[0].n, 1);
    await store.apply(owner, factoryBinding(next.task), randomUUID(), { action: 'cancel', reason: 'Fixture complete' });
  });

  await t.test('a foreign parent, a replayed older epoch and cancelled authority cannot advance', async () => {
    const original = await fixture()
    const wrong = await fixture()
    const invalid = await followup({ ...original, runId: wrong.runId }, 'Use a foreign task as the source')
    await assert.rejects(advance(original, invalid), (e: unknown) => e instanceof FactoryError && e.code === 'factorySourceMismatch')
    const first = await followup(original, '74 bytes')
    const a = await advance(original, first)
    const second = await followup(original, '77 bytes')
    const b = await advance(a, second)
    await assert.rejects(advance(b, first), (e: unknown) => e instanceof FactoryError && e.code === 'factoryStale')
    const cancelled = await store.apply(owner, factoryBinding(b), randomUUID(), { action: 'cancel', reason: 'Owner stopped it' })
    await assert.rejects(advance(cancelled.task, await followup(original, 'Continue without authorization')), (e: unknown) => e instanceof FactoryError && e.code === 'factoryStopped')
  })

  let dispatches = 0, wakes = 0
  const dependencies: WatchdogDependencies = {
    runtime: () => ({ store, reconcile: { run: async () => undefined } }),
    dispatch: async () => { dispatches++; throw new FactoryError('factoryCheckHarnessUnavailable') },
    wake: async () => { wakes++ },
  }
  await t.test('online heartbeats do not count as progress; a stall emits one durable blocker', async () => {
    const task = await fixture()
    await pool.query(`UPDATE factory_tasks SET status='running',"updatedAt"='2000-01-01' WHERE id=$1`, [task.id])
    await pool.query(`UPDATE factory_attempts SET status='running',"createdAt"='2000-01-01',"finishedAt"=NULL WHERE id=$1`, [task.attemptId])
    await pool.query(`UPDATE agent_runs SET status='running',"updatedAt"=now(),"leaseExpiresAt"=now()+interval '1 hour' WHERE id=$1`, [task.runId])
    const first = await sweepFactoryWatchdog(pool, dependencies)
    assert.equal(first.failed, 0)
    assert.ok(first.blocked >= 1)
    const current = (await pool.query('SELECT status FROM factory_tasks WHERE id=$1', [task.id])).rows[0]
    assert.equal(current.status, 'blocked')
    await sweepFactoryWatchdog(pool, dependencies)
    await sweepFactoryWatchdog(pool, dependencies, new Date(Date.now() + 6 * 60_000))
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM coordinator_events WHERE "issueId"=$1 AND payload->>'source'='task_watchdog'`, [task.issueId])).rows[0].n, 1)
    assert.equal(wakes, 1)
    assert.equal(dispatches, 0)
  })
  await t.test('an older uncertain receipt survives a full handoff window and blocks lease recovery', async () => {
    const task = await fixture()
    const pending = await advance(task, await followup(task, 'Continue the same work'))
    const operationId = randomUUID()
    await pool.query(`INSERT INTO operation_ledger("operationId","ownerId","workspaceId",binding,"idempotencyKey",status,"attemptToken","runId")
      VALUES($1,$2,$3,$4,$5,'uncertain',$6,$7)`, [operationId, owner, workspace.id,
      JSON.stringify({ executionRunId: task.runId, action: 'send_email', target: 'fixture@example.invalid' }), `continuity:${operationId}`, randomUUID(), task.runId])
    await pool.query(`UPDATE operation_ledger SET "updatedAt"=now()-interval '1 hour' WHERE "operationId"=$1`, [operationId])
    for (let index = 0; index < 21; index++) {
      const completedId = randomUUID()
      await pool.query(`INSERT INTO operation_ledger("operationId","ownerId","workspaceId",binding,"idempotencyKey",status,"attemptToken","runId",receipt)
        VALUES($1,$2,$3,$4,$5,'succeeded',$6,$7,$8)`, [completedId, owner, workspace.id,
        JSON.stringify({ executionRunId: task.runId, action: 'fixture_observation' }), `continuity:${completedId}`, randomUUID(), task.runId, JSON.stringify({ reference: `synthetic-receipt-${index}` })])
    }
    const leaseRecovery = await factoryRecoveryHandoff(pool, { id: task.runId, userId: owner }, 'Resume the current request.')
    assert.match(leaseRecovery.blocked ?? '', /Reconcile its existing receipt/)
    await pool.query(`UPDATE factory_tasks SET "updatedAt"=now()-interval '2 minutes' WHERE id=$1`, [task.id])
    const count = dispatches
    await sweepFactoryWatchdog(pool, dependencies)
    assert.equal(dispatches, count)
    assert.equal((await pool.query('SELECT status FROM operation_ledger WHERE "operationId"=$1', [operationId])).rows[0].status, 'uncertain')
    assert.equal((await pool.query('SELECT status FROM factory_tasks WHERE id=$1', [task.id])).rows[0].status, 'blocked')
    const handoff = await persistFactoryHandoff(pool, pending)
    assert.equal(handoff.externalEffects.operations.length, 20, 'handoff remains bounded without hiding unresolved effects')
    assert.equal(handoff.externalEffects.operations[0].operationId, operationId)
    assert.equal(handoff.externalEffects.operations[0].status, 'uncertain')
  })
  await t.test('missing executor admission has bounded, backoff-protected recovery', async () => {
    const task = await fixture()
    const pending = await advance(task, await followup(task, 'Continue on an authorized device'))
    const now = new Date()
    await pool.query(`UPDATE factory_tasks SET "updatedAt"=$2::timestamptz-interval '2 minutes' WHERE id=$1`, [pending.id, now])
    for (const minutes of [0, 0, 3, 8, 17]) await sweepFactoryWatchdog(pool, dependencies, new Date(now.getTime() + minutes * 60_000))
    assert.equal(dispatches, 3)
    assert.equal((await pool.query('SELECT status FROM factory_tasks WHERE id=$1', [pending.id])).rows[0].status, 'blocked')
  })

  await t.test('commit-time membership revocation rolls back watchdog dispatch without launching or reporting recovery', async () => {
    const original = await fixture()
    const pending = await advance(original, await followup(original, 'Continue only while this workspace membership remains active'))
    const deviceId = randomUUID(), childId = randomUUID()
    await pool.query(`INSERT INTO devices (id,"ownerId",name,kind,enabled,"lastSeenAt") VALUES ($1,$2,'Watchdog commit fixture','local',true,now())`, [deviceId, owner])
    await pool.query('UPDATE agents SET "deviceId"=$2 WHERE id=$1', [agentId, deviceId])
    await seedAllowedModel(pool, owner, { workspaceId: workspace.id, deviceIds: [deviceId] })
    await pool.query(`UPDATE factory_tasks SET "updatedAt"=now()-interval '2 minutes' WHERE id=$1`, [pending.id])
    const beforeTask = (await pool.query('SELECT * FROM factory_tasks WHERE id=$1', [pending.id])).rows[0]
    const beforeAttempt = (await pool.query('SELECT * FROM factory_attempts WHERE id=$1', [pending.attemptId])).rows[0]
    const beforeEvents = (await pool.query('SELECT * FROM factory_events WHERE "taskId"=$1 ORDER BY "eventId"', [pending.id])).rows
    const { resolveAgentProfileDispatch } = await import('./agent-profile')
    let planned = 0, revoked = false, starts = 0, wakes = 0, reconciles = 0
    let bindingId: string | undefined
    const callbacks: WatchdogDependencies = {
      runtime: () => ({ store, reconcile: { run: async () => { reconciles++ } } }),
      wake: async () => { wakes++ },
      dispatch: async (tx, currentStore, task) => {
        assert.equal(task.id, pending.id)
        const selected = await resolveAgentProfileDispatch(pool, { ownerId: owner, workspaceId: workspace.id, botId: null },
          { issueId: task.issueId, location: 'local', agentId }, { transaction: tx })
        assert.equal(selected.target.kind, 'device')
        if (selected.target.kind !== 'device') assert.fail('the real subscription catalogue must select the fixture device')
        assert.equal(selected.agentProfile?.source, 'default')
        bindingId = selected.target.subscriptionBindingId
        assert.ok(bindingId)
        assert.equal((await tx.query('SELECT id FROM byos_bindings WHERE id=$1 AND "consumerId"=$2', [bindingId, agentId])).rowCount, 1)
        assert.equal((await pool.query('SELECT id FROM byos_bindings WHERE id=$1', [bindingId])).rowCount, 0, 'binding is still uncommitted')
        // This synthetic queue write isolates the real watchdog owner's commit
        // boundary; model selection, source binding and membership are real.
        await tx.query(`INSERT INTO agent_runs (id,"userId","agentId","deviceId","issueId",kind,status,prompt,"agentDefinition")
          VALUES ($1,$2,$3,$4,$5,'implement','queued','Watchdog commit fixture',$6)`,
          [childId, owner, agentId, deviceId, task.issueId, JSON.stringify({ agentProfile: selected.agentProfile })])
        await currentStore.apply(owner, factoryBinding(task), randomUUID(), { action: 'bind_run', runId: childId }, tx)
        planned++
        await pool.query(`UPDATE mikka_workspace_members SET status='suspended' WHERE "workspaceId"=$1 AND "userId"=$2`, [workspace.id, owner])
        revoked = true
        return async () => { starts++ }
      },
    }
    try {
      const result = await sweepFactoryWatchdog(pool, callbacks)
      assert.equal(planned, 1, 'the child and exact subscription binding reached the owning transaction')
      assert.equal(revoked, true, 'authority changes after planning and before the real COMMIT')
      assert.deepEqual(result, { scanned: 1, recovered: 0, blocked: 0, deferred: 0, failed: 1 })
      assert.deepEqual({ starts, wakes, reconciles }, { starts: 0, wakes: 0, reconciles: 0 })
      assert.equal((await pool.query('SELECT id FROM agent_runs WHERE id=$1', [childId])).rowCount, 0)
      assert.equal((await pool.query('SELECT id FROM byos_bindings WHERE id=$1', [bindingId])).rowCount, 0)
      assert.deepEqual((await pool.query('SELECT * FROM factory_tasks WHERE id=$1', [pending.id])).rows[0], beforeTask)
      assert.deepEqual((await pool.query('SELECT * FROM factory_attempts WHERE id=$1', [pending.attemptId])).rows[0], beforeAttempt)
      assert.deepEqual((await pool.query('SELECT * FROM factory_events WHERE "taskId"=$1 ORDER BY "eventId"', [pending.id])).rows, beforeEvents)
    } finally {
      await pool.query(`UPDATE mikka_workspace_members SET status='active' WHERE "workspaceId"=$1 AND "userId"=$2`, [workspace.id, owner])
    }
  })
})
