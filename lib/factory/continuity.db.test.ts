import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { Pool, type PoolClient } from 'pg'
import { dbUrl, seedAgent, seedIssue, seedRun, seedUser, seedWorkspace } from '../../tests/support/workspace-admin-db'
import { cleanAllowedModels, seedAllowedModel } from '../../tests/support/allowed-model'
import { createFactoryStore, type FactoryTask } from './store'
import { factoryBinding } from './dispatch'
import { FactoryError } from './contract'
import { advanceFactoryRequest, continueActiveFactoryRequest } from './request-epoch'
import { currentFactoryRequest } from './checks'
import { factoryRecoveryHandoff, persistFactoryHandoff } from './handoff'
import { sweepFactoryWatchdog, type WatchdogDependencies } from './watchdog'

process.env.MIKKA_BYOS_VALIDATED_MODEL_ROUTES = 'claude_cpa,codex_cpa'
process.env.MIKKA_BYOS_ENABLED = '1'

function handoffFixture() {
  const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
  const task: FactoryTask = {
    id: id(1), userId: 'handoff-owner', botId: null, issueId: id(2), scopeVersion: null,
    sourceEventId: id(3), stage: 'execute', status: 'pending', revision: 3, attemptId: id(4), candidateId: id(5), reason: 'Continue',
    route: { issueId: id(2), eventId: id(6), sourceEventId: id(3), rationale: 'Owner request', missingInformation: [], missingPermissions: [], needsSpec: false },
  }
  return { id, task }
}

test('handoff batches its bounded history without changing the existing Date and digest receipt', async () => {
  const { id, task } = handoffFixture()
  // These are the pg results before batching. PostgreSQL text retains both the
  // offset and sub-millisecond fraction; the existing pg Date does not.
  const timestamp = '2026-11-06 23:59:59.123456+05:30'
  const date = new Date('2026-11-06T18:29:59.123Z')
  const history = {
    source: [{ id: task.sourceEventId, createdAt: date, text: 'Retain the exact output', title: 'Task', content: { type: 'doc', content: [] } }],
    attempts: [{ id: id(7), stage: 'execute', status: 'passed', runId: id(8), reason: 'Done', candidateId: id(5), requestEpoch: id(9),
      finishedAt: date, runStatus: 'succeeded', stopReason: 'submitted', error: null, deviceId: id(10), sessionId: 'fixture-session',
      sha: 'a'.repeat(40), repository: 'fixture/repository', environment: 'test', candidateCreatedAt: date,
      checkpointCommit: 'b'.repeat(40), checkpointAt: date, checkpointFiles: 2, unavailableReason: null }],
    effects: [{ id: id(11), status: 'uncertain', action: 'merge', target: 'fixture-target',
      receipt: { updatedAt: timestamp, nested: { finishedAt: timestamp }, note: 'x'.repeat(10001) }, candidateId: id(5), finishedAt: null }],
    publications: [{ runId: id(8), status: 'processing', remoteKey: 'fixture/repository', branch: 'fixture-branch',
      pullRequest: { number: 1, updatedAt: timestamp }, errorCode: null, updatedAt: date }],
    operations: [{ operationId: id(12), status: 'uncertain', runId: id(8), action: 'fixture_observation', target: null, receipt: null, updatedAt: date }],
    dependencies: [{ id: id(13), status: 'open', originRunId: id(8), kind: 'context' }],
  }
  let reads = 0
  const writes: unknown[][] = []
  const query = async (sql: string, ...parameters: unknown[][]) => {
    const [values] = parameters
    if (sql.startsWith('INSERT INTO factory_events')) { writes.push(values); return { rows: [] } }
    assert.equal(parameters.length, 0, 'native multi-result queries must use the simple protocol')
    reads++
    return structuredClone(Object.values(history).map(rows => ({ command: 'SELECT', rows, rowCount: rows.length, fields: [] })))
  }
  const handoff = await persistFactoryHandoff({ query: query as PoolClient['query'] }, task)
  // Captured from the six-read implementation: field order, nulls, masking,
  // truncation, embedded JSON and timestamp precision all affect this digest.
  assert.equal(handoff.digest, '7ce1b343a988b179b4782da14fb9574426ea99213c0625ef041b8df9502bb6ad')
  assert.equal(handoff.goal.recordedAt, date.toISOString())
  assert.equal(handoff.checkpoint?.storedAt, date.toISOString())
  assert.equal(handoff.externalEffects.publications[0].updatedAt, date.toISOString())
  assert.equal(handoff.externalEffects.effects[0].finishedAt, null)
  assert.equal(handoff.externalEffects.effects[0].receipt.updatedAt, timestamp, 'receipt strings are not database Date columns')
  assert.equal(handoff.externalEffects.effects[0].receipt.note.length, 10000)
  assert.equal(writes.length, 1)
  assert.equal(JSON.parse(writes[0][2] as string).digest, handoff.digest)
  assert.equal(reads, 1, 'one database round trip returns the six original result sets')
})

test('handoff simple-query literals contain quotes, backslashes and SQL-like identifier text', async () => {
  const { task } = handoffFixture()
  Object.assign(task, {
    id: String.raw`task'\; SELECT 'injected' --`, userId: String.raw`owner'\tail`,
    issueId: String.raw`issue'\tail`, sourceEventId: String.raw`source'\tail`,
  })
  let reads = 0, writes = 0
  const query = async (sql: string, ...parameters: unknown[][]) => {
    if (sql.startsWith('INSERT INTO factory_events')) { writes++; return { rows: [] } }
    reads++
    assert.equal(parameters.length, 0)
    assert.ok(sql.includes(String.raw`WHERE a."taskId"= E'task''\\; SELECT ''injected'' --' ORDER BY`))
    assert.ok(sql.includes(String.raw`e."userId"= E'owner''\\tail'`))
    assert.ok(sql.includes(String.raw`i.id= E'issue''\\tail'`))
    assert.ok(sql.includes(String.raw`WHERE e.id= E'source''\\tail'`))
    return Array.from({ length: 6 }, () => ({ command: 'SELECT', rows: [], rowCount: 0, fields: [] }))
  }
  await persistFactoryHandoff({ query: query as PoolClient['query'] }, task)
  assert.equal(reads, 1)
  assert.equal(writes, 1)
})

test('handoff rejects malformed native result sets before recording evidence', async () => {
  const empty = { command: 'SELECT', rows: [], rowCount: 0, fields: [] }
  const valid = Array.from({ length: 6 }, () => empty)
  for (const response of [
    { rows: [] }, valid.slice(1), [...valid, empty],
    [{ ...empty, command: 'UPDATE' }, ...valid.slice(1)],
    [{ ...empty, rows: null }, ...valid.slice(1)],
    [{ ...empty, rows: [null] }, ...valid.slice(1)],
  ]) {
    let writes = 0
    const query = async (sql: string) => {
      if (sql.startsWith('INSERT INTO factory_events')) writes++
      return response
    }
    await assert.rejects(persistFactoryHandoff({ query: query as PoolClient['query'] }, handoffFixture().task), /Invalid Factory handoff history/)
    assert.equal(writes, 0)
  }
})

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
    const issueId = await seedIssue(pool, owner, workspace.id)
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

  await t.test('forwarding the accepted dispatch source preserves the live executor, event and attempt', async () => {
    const original = await fixture()
    await pool.query(`UPDATE factory_tasks SET status='running' WHERE id=$1`, [original.id])
    await pool.query(`UPDATE factory_attempts SET status='running',"finishedAt"=NULL WHERE id=$1`, [original.attemptId])
    await pool.query(`UPDATE agent_runs SET status='running',"startedAt"=now(),"leaseExpiresAt"=now()+interval '90 seconds' WHERE id=$1`, [original.runId])
    const snapshot = async () => (await pool.query(`SELECT t."sourceEventId",t."attemptId",t.status,r."stopRequestedAt",
      (SELECT count(*)::int FROM factory_attempts WHERE "taskId"=t.id) AS attempts,
      (SELECT count(*)::int FROM coordinator_events WHERE "userId"=t."userId" AND "issueId"=t."issueId" AND kind='user_message') AS messages
      FROM factory_tasks t JOIN agent_runs r ON r.id=$2 WHERE t.id=$1`, [original.id, original.runId])).rows[0]
    const before = await snapshot()
    assert.equal(await continueActiveFactoryRequest(pool, owner, original.runId,
      'Forward the already accepted task; this is not a new owner request.', original.sourceEventId), true)
    assert.deepEqual(await snapshot(), before)
    assert.equal(before.status, 'running')
    assert.equal(before.stopRequestedAt, null)
    assert.equal(before.attempts, 1)
    assert.equal(before.messages, 1)
    assert.equal(await continueActiveFactoryRequest(pool, 'not-the-owner', original.runId,
      'An event ID does not grant a different account authority.', original.sourceEventId), false)
    assert.deepEqual(await snapshot(), before)
  })

  await t.test('a genuinely new authenticated request still replaces the current execution', async () => {
    const original = await fixture()
    await pool.query(`UPDATE factory_tasks SET status='running' WHERE id=$1`, [original.id])
    await pool.query(`UPDATE factory_attempts SET status='running',"finishedAt"=NULL WHERE id=$1`, [original.attemptId])
    await pool.query(`UPDATE agent_runs SET status='running',"startedAt"=now(),"leaseExpiresAt"=now()+interval '90 seconds' WHERE id=$1`, [original.runId])
    const sourceEventId = await followup(original, 'The owner now requests a different exact artifact.')
    assert.equal(await continueActiveFactoryRequest(pool, owner, original.runId, 'Forward the new request.', sourceEventId), true)
    const current = (await pool.query(`SELECT t."sourceEventId",t."attemptId",r."stopRequestedAt"
      FROM factory_tasks t JOIN agent_runs r ON r.id=$2 WHERE t.id=$1`, [original.id, original.runId])).rows[0]
    assert.equal(current.sourceEventId, sourceEventId)
    assert.notEqual(current.attemptId, original.attemptId)
    assert.ok(current.stopRequestedAt)
  })

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
  await t.test('an older uncertain receipt survives a full handoff window and blocks lease recovery', async t => {
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
    // These newer unresolved rows would outrank the legitimate receipt if the
    // combined read lost either its owner or its task/run predicate.
    const foreign = await fixture()
    const excludedIds = [randomUUID(), randomUUID()]
    t.after(async () => { await pool.query('DELETE FROM operation_ledger WHERE "operationId"=ANY($1::uuid[])', [excludedIds]) })
    for (const [index, other] of [{ owner: `${owner}-other`, runId: task.runId }, { owner, runId: foreign.runId }].entries()) {
      await pool.query(`INSERT INTO operation_ledger("operationId","ownerId","workspaceId",binding,"idempotencyKey",status,"attemptToken","runId")
        VALUES($1,$2,$3,$4,$5,'uncertain',$6,$7)`, [excludedIds[index], other.owner, workspace.id,
        JSON.stringify({ executionRunId: other.runId, action: 'fixture_observation' }), `continuity:${excludedIds[index]}`, randomUUID(), other.runId])
    }
    const leaseRecovery = await factoryRecoveryHandoff(pool, { id: task.runId, userId: owner }, 'Resume the current request.')
    assert.match(leaseRecovery.blocked ?? '', /Reconcile its existing receipt/)
    await pool.query(`UPDATE factory_tasks SET "updatedAt"=now()-interval '2 minutes' WHERE id=$1`, [task.id])
    const count = dispatches
    await sweepFactoryWatchdog(pool, dependencies)
    assert.equal(dispatches, count)
    assert.equal((await pool.query('SELECT status FROM operation_ledger WHERE "operationId"=$1', [operationId])).rows[0].status, 'uncertain')
    assert.equal((await pool.query('SELECT status FROM factory_tasks WHERE id=$1', [task.id])).rows[0].status, 'blocked')
    let reads = 0
    const query = async (sql: string, values: unknown[]) => { if (sql.startsWith('SELECT')) reads++; return pool.query(sql, values) }
    const handoff = await persistFactoryHandoff({ query: query as PoolClient['query'] }, pending)
    assert.equal(reads, 1, 'real PostgreSQL returns the six bounded histories in one round trip')
    assert.equal(handoff.externalEffects.operations.length, 20, 'handoff remains bounded without hiding unresolved effects')
    assert.equal(handoff.externalEffects.operations[0].operationId, operationId)
    assert.equal(handoff.externalEffects.operations[0].status, 'uncertain')
    assert.ok(handoff.externalEffects.operations.every(row => !excludedIds.includes(row.operationId)))
    const { rows: [originalReceipt] } = await pool.query('SELECT "updatedAt" FROM operation_ledger WHERE "operationId"=$1', [operationId])
    assert.equal(handoff.externalEffects.operations[0].updatedAt, originalReceipt.updatedAt.toISOString())
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

  await t.test('membership revocation that wins the Workspace admission race prevents watchdog dispatch and all side effects', async () => {
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
    const beforeBindings = (await pool.query('SELECT * FROM byos_bindings WHERE "ownerId"=$1 ORDER BY id', [owner])).rows
    const { resolveAgentProfileDispatch } = await import('./agent-profile')
    let planned = 0, starts = 0, wakes = 0, reconciles = 0
    const callbacks: WatchdogDependencies = {
      runtime: () => ({ store, reconcile: { run: async () => { reconciles++ } } }),
      wake: async () => { wakes++ },
      dispatch: async (tx, currentStore, task) => {
        planned++
        assert.equal(task.id, pending.id)
        const selected = await resolveAgentProfileDispatch(pool, { ownerId: owner, workspaceId: workspace.id, botId: null },
          { issueId: task.issueId, location: 'local', agentId }, { transaction: tx })
        assert.equal(selected.target.kind, 'device')
        if (selected.target.kind !== 'device') assert.fail('the real subscription catalogue must select the fixture device')
        assert.equal(selected.agentProfile?.source, 'default')
        const bindingId = selected.target.subscriptionBindingId
        assert.ok(bindingId)
        assert.equal((await tx.query('SELECT id FROM byos_bindings WHERE id=$1 AND "consumerId"=$2', [bindingId, agentId])).rowCount, 1)
        assert.equal((await pool.query('SELECT id FROM byos_bindings WHERE id=$1', [bindingId])).rowCount, 0, 'binding is still uncommitted')
        // These writes make an accidental dispatch observable. The Workspace
        // admission below must refuse before this real planning path starts.
        await tx.query(`INSERT INTO agent_runs (id,"userId","workspaceId","agentId","deviceId","issueId",kind,status,prompt,"agentDefinition")
          VALUES ($1,$2,$3,$4,$5,$6,'implement','queued','Watchdog commit fixture',$7)`,
          [childId, owner, workspace.id, agentId, deviceId, task.issueId, JSON.stringify({ agentProfile: selected.agentProfile })])
        await currentStore.apply(owner, factoryBinding(task), randomUUID(), { action: 'bind_run', runId: childId }, tx)
        return async () => { starts++ }
      },
    }
    const revoker = await pool.connect()
    let sweeping: ReturnType<typeof sweepFactoryWatchdog> | undefined
    let settled = false, revocationOpen = false
    try {
      await revoker.query('BEGIN')
      revocationOpen = true
      const { rows: [{ pid }] } = await revoker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
      await revoker.query(`UPDATE mikka_workspace_members SET status='suspended' WHERE "workspaceId"=$1 AND "userId"=$2`, [workspace.id, owner])
      sweeping = sweepFactoryWatchdog(pool, callbacks)
      void sweeping.then(() => { settled = true }, () => { settled = true })
      // The revoker owns the member write lock first. Observe PostgreSQL's
      // actual wait, then commit; never synchronously revoke from inside a
      // callback whose outer transaction holds this same member FOR SHARE.
      const deadline = Date.now() + 5_000
      let blocked = false
      while (!blocked && Date.now() < deadline) {
        assert.equal(settled, false, 'watchdog must wait for the uncommitted member decision')
        blocked = (await pool.query(`SELECT 1 FROM pg_stat_activity
          WHERE datname=current_database() AND wait_event_type='Lock'
            AND $1::int=ANY(pg_blocking_pids(pid)) AND query ILIKE '%mikka_workspace_members%'`, [pid])).rowCount! > 0
        if (!blocked) await new Promise(resolve => setTimeout(resolve, 10))
      }
      assert.equal(blocked, true, 'the real Workspace admission waits on the revoker')
      assert.equal(planned, 0, 'dispatch cannot begin while Workspace membership is unresolved')
      await revoker.query('COMMIT')
      revocationOpen = false
      const result = await sweeping
      assert.equal(planned, 0, 'fresh inactive membership denies before child or subscription planning')
      assert.deepEqual(result, { scanned: 1, recovered: 0, blocked: 0, deferred: 0, failed: 0 })
      assert.deepEqual({ starts, wakes, reconciles }, { starts: 0, wakes: 0, reconciles: 0 })
      assert.equal((await pool.query('SELECT status FROM mikka_workspace_members WHERE "workspaceId"=$1 AND "userId"=$2', [workspace.id, owner])).rows[0].status, 'suspended')
      assert.equal((await pool.query('SELECT id FROM agent_runs WHERE id=$1', [childId])).rowCount, 0)
      assert.deepEqual((await pool.query('SELECT * FROM byos_bindings WHERE "ownerId"=$1 ORDER BY id', [owner])).rows, beforeBindings)
      assert.deepEqual((await pool.query('SELECT * FROM factory_tasks WHERE id=$1', [pending.id])).rows[0], beforeTask)
      assert.deepEqual((await pool.query('SELECT * FROM factory_attempts WHERE id=$1', [pending.attemptId])).rows[0], beforeAttempt)
      assert.deepEqual((await pool.query('SELECT * FROM factory_events WHERE "taskId"=$1 ORDER BY "eventId"', [pending.id])).rows, beforeEvents)
    } finally {
      // Release the blocker even when an assertion fails, then join the sweep
      // before cleanup deletes the same rows or waits for the pools to close.
      try { if (revocationOpen) await revoker.query('ROLLBACK') }
      finally { revoker.release() }
      if (sweeping) await Promise.allSettled([sweeping])
      await pool.query(`UPDATE mikka_workspace_members SET status='active' WHERE "workspaceId"=$1 AND "userId"=$2`, [workspace.id, owner])
    }
  })
})
