import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { Pool } from 'pg'
import { disposableDatabase, E2E_DB_RULE } from '../../tests/helpers/e2e-target.mjs'
import { createOperationLedger, type OperationIntent, type OperationReceipt } from './ledger'
import { withOperationSession } from './session-authorization'

const url = process.env.E2E_DATABASE_URL
if (url) assert.ok(disposableDatabase(process.env, url), E2E_DB_RULE)
else if (process.env.REQUIRE_DB === '1') assert.fail('REQUIRE_DB=1 needs an isolated E2E_DATABASE_URL')

/** The ledger, session locks and invocation gate use actual PostgreSQL. The
 * effect callback is a controlled boundary; this suite never writes to GitHub. */
test('session-owned operation claims and once-only effects on PostgreSQL 17', { skip: !url, timeout: 60_000 }, async t => {
  const schema = 'operation_session_' + randomUUID().replaceAll('-', '')
  const admin = new Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 5000 })
  let created = false, database: Pool | undefined
  t.after(async () => {
    try {
      await database?.end()
      if (created) await admin.query(`DROP SCHEMA "${schema}" CASCADE`)
    } finally { await admin.end() }
  })
  const version = Number((await admin.query('SHOW server_version_num')).rows[0].server_version_num)
  assert.ok(version >= 170000 && version < 180000, 'operation ledger acceptance requires PostgreSQL 17')
  await admin.query(`CREATE SCHEMA "${schema}"`)
  created = true
  const pool = database = new Pool({ connectionString: url, max: 8, connectionTimeoutMillis: 5000,
    options: `-c search_path=${schema},pg_catalog -c statement_timeout=5000 -c lock_timeout=2000` })
  await pool.query('CREATE TABLE "session" (id text PRIMARY KEY,"userId" text NOT NULL,"expiresAt" timestamptz NOT NULL)')
  for (const name of ['20261025043000_pending_actions.sql', '20261028143920_operation_ledger.sql', '20261028143921_approved_write_binding.sql'])
    await pool.query(await readFile(new URL('../../drizzle/' + name, import.meta.url), 'utf8'))
  await pool.query(`CREATE TABLE fixture_review_projection (
    "operationId" uuid PRIMARY KEY REFERENCES operation_ledger("operationId"),
    state text NOT NULL DEFAULT 'prepared' CHECK (state IN ('prepared','accepted','rejected','uncertain')),
    receipt jsonb,
    revision integer NOT NULL DEFAULT 0,
    "acceptedWrites" integer NOT NULL DEFAULT 0,
    CHECK ((state='accepted') = (receipt IS NOT NULL))
  )`)

  async function operation(executionRunId?: string) {
    const id = randomUUID(), ownerId = 'ledger-session-' + randomUUID(), sessionId = randomUUID()
    const actor = { userId: ownerId, sessionId }
    await pool.query('INSERT INTO "session" VALUES($1,$2,clock_timestamp()+interval \'1 hour\')', [sessionId, ownerId])
    const binding: OperationIntent = {
      operationId: id, ownerId, workspaceId: randomUUID(), provider: 'fixture-github', accountId: 'github-user:42',
      action: 'github-review', target: 'repository:91/pull:7', approvalId: 'review-batch:' + id,
      proposalDigest: 'a'.repeat(64), payloadDigest: 'b'.repeat(64),
      ...(executionRunId ? { executionRunId } : {}),
    }
    const key = { operationId: id, ownerId, workspaceId: binding.workspaceId }
    const authorize = withOperationSession(actor, async (_tx, current) => { assert.deepEqual(current, binding) })
    const ledger = createOperationLedger(pool, authorize)
    const stored = async () => (await pool.query<{
      status: string; runId: string | null; attemptToken: string | null; invokedAt: Date | null;
      receipt: OperationReceipt | null; binding: OperationIntent; idempotencyKey: string;
    }>('SELECT status,"runId","attemptToken","invokedAt",receipt,binding,"idempotencyKey" FROM operation_ledger WHERE "operationId"=$1', [id])).rows[0]!
    return { actor, binding, key, authorize, ledger, stored }
  }

  await t.test('concurrent human claims retain one attempt and a SQL NULL Run through success', async () => {
    const f = await operation()
    const reserved = await f.ledger.reserve(f.binding)
    const claims = await Promise.allSettled(Array.from({ length: 8 }, () => f.ledger.claim(f.key, null)))
    const accepted = claims.filter((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof f.ledger.claim>>> => result.status === 'fulfilled')
    assert.equal(accepted.length, 1)
    for (const result of claims) if (result.status === 'rejected') assert.match(String(result.reason), /operationAlreadyClaimed/)
    const claimed = accepted[0]!.value
    assert.equal(claimed.runId, null)
    assert.ok(claimed.attemptToken)
    assert.equal(claimed.idempotencyKey, reserved.idempotencyKey)
    assert.equal(Object.hasOwn(claimed.binding, 'executionRunId'), false)
    assert.equal((await f.stored()).runId, null, 'the database must not store a synthetic execution Run')

    let effects = 0
    const receipt: OperationReceipt = { providerObjectId: 'review-91', evidenceDigest: 'c'.repeat(64) }
    const done = await f.ledger.invoke(f.key, claimed.attemptToken!, async (record, beforeSend, signal) => {
      assert.equal(record.runId, null)
      await beforeSend()
      signal.throwIfAborted()
      effects++
      return receipt
    })
    assert.equal(done.status, 'succeeded')
    assert.equal(done.runId, null)
    assert.deepEqual(done.receipt, receipt)
    const row = await f.stored()
    assert.equal(row.runId, null)
    assert.ok(row.invokedAt instanceof Date)
    assert.equal(row.attemptToken, claimed.attemptToken)
    assert.deepEqual(row.binding, f.binding)
    const replay = await f.ledger.reserve(f.binding)
    assert.equal(replay.status, 'succeeded')
    assert.equal(replay.idempotencyKey, reserved.idempotencyKey)
    await assert.rejects(f.ledger.claim(f.key, null), /operationAlreadyClaimed/)
    assert.equal(effects, 1)
  })

  await t.test('execution-bound operations reject a null or foreign Run without consuming the claim', async () => {
    const executionRunId = randomUUID(), f = await operation(executionRunId)
    await f.ledger.reserve(f.binding)
    await assert.rejects(f.ledger.claim(f.key, null), /operationRunMismatch/)
    await assert.rejects(f.ledger.claim(f.key, randomUUID()), /operationRunMismatch/)
    const unchanged = await f.stored()
    assert.equal(unchanged.status, 'reserved')
    assert.equal(unchanged.runId, null)
    assert.equal(unchanged.attemptToken, null)
    assert.equal(unchanged.invokedAt, null)
    const claimed = await f.ledger.claim(f.key, executionRunId)
    assert.equal(claimed.runId, executionRunId)
    assert.notEqual(claimed.attemptToken, executionRunId)
    assert.equal((await f.stored()).runId, executionRunId)
    await f.ledger.settle(f.key, claimed.attemptToken!, { status: 'failed' })
  })

  await t.test('a null Run does not weaken the current human session requirement', async () => {
    const f = await operation()
    await f.ledger.reserve(f.binding)
    await pool.query('UPDATE "session" SET "expiresAt"=clock_timestamp()-interval \'1 second\' WHERE id=$1', [f.actor.sessionId])
    await assert.rejects(f.ledger.claim(f.key, null), /operationSessionUnavailable/)
    const row = await f.stored()
    assert.equal(row.status, 'reserved')
    assert.equal(row.attemptToken, null)
    assert.equal(row.invokedAt, null)
    assert.equal(row.runId, null)
  })

  await t.test('an unknown human effect keeps its durable invoke gate and reconciles without another effect', async () => {
    const f = await operation()
    await f.ledger.reserve(f.binding)
    const claimed = await f.ledger.claim(f.key, null)
    let effects = 0, lookups = 0
    const lostResponse = new Error('controlled effect completed before its response was lost')
    await assert.rejects(f.ledger.invoke(f.key, claimed.attemptToken!, async (_record, beforeSend) => {
      await beforeSend()
      effects++
      throw lostResponse
    }), error => error === lostResponse)
    const invoked = await f.stored()
    assert.equal(invoked.status, 'executing', 'only the effect transaction rolls back; the invocation gate already committed')
    assert.ok(invoked.invokedAt instanceof Date)
    assert.equal(invoked.receipt, null)
    assert.equal(invoked.runId, null)

    const restarted = createOperationLedger(pool, f.authorize)
    await assert.rejects(restarted.invoke(f.key, claimed.attemptToken!, async () => {
      effects++
      return { providerObjectId: 'duplicate', evidenceDigest: 'd'.repeat(64) }
    }), /operationAlreadyInvoked/)
    const absent = await restarted.reconcile(f.key, async record => {
      lookups++
      assert.equal(record.runId, null)
      return null
    })
    assert.equal(absent.status, 'executing', 'absence cannot authorize another provider call')
    assert.equal(effects, 1)
    await restarted.settle(f.key, claimed.attemptToken!, { status: 'uncertain' })
    const unresolved = await restarted.reconcile(f.key, async () => { lookups++; return null })
    assert.equal(unresolved.status, 'uncertain')
    await assert.rejects(restarted.claim(f.key, null), /operationAlreadyClaimed/)

    const receipt: OperationReceipt = { providerObjectId: 'review-existing', evidenceDigest: 'e'.repeat(64) }
    const recovered = await restarted.reconcile(f.key, async record => {
      lookups++
      assert.equal(record.attemptToken, claimed.attemptToken)
      assert.equal(record.idempotencyKey, invoked.idempotencyKey)
      return receipt
    })
    assert.equal(recovered.status, 'succeeded')
    assert.equal(recovered.runId, null)
    assert.deepEqual(recovered.receipt, receipt)
    assert.equal((await restarted.reconcile(f.key, async () => { throw new Error('a completed receipt must not query the provider again') })).status, 'succeeded')
    const final = await f.stored()
    assert.equal(final.invokedAt?.getTime(), invoked.invokedAt.getTime())
    assert.equal(final.attemptToken, invoked.attemptToken)
    assert.equal(final.idempotencyKey, invoked.idempotencyKey)
    assert.equal(final.runId, null)
    assert.deepEqual(final.binding, f.binding)
    assert.deepEqual({ effects, lookups }, { effects: 1, lookups: 3 })
  })

  await t.test('a failed local projection rolls back success but preserves the once-only gate until atomic readback', async () => {
    const f = await operation()
    const receipt: OperationReceipt = { providerObjectId: 'review-projected', evidenceDigest: 'f'.repeat(64) }
    const projectionFailure = new Error('controlled failure after the projection SQL write')
    let effects = 0, lookups = 0, projections = 0, failAccepted = true
    const projected = createOperationLedger(pool, f.authorize, { project: async (tx, record) => {
      projections++
      assert.equal(record.operationId, f.key.operationId)
      const current = (await tx.query('SELECT status,receipt FROM operation_ledger WHERE "operationId"=$1', [record.operationId])).rows[0]
      assert.equal(current.status, record.status, 'the outcome UPDATE must be visible inside its projection transaction')
      assert.deepEqual(current.receipt, record.receipt)
      assert.ok(record.status === 'succeeded' || record.status === 'uncertain')
      const changed = await tx.query(`UPDATE fixture_review_projection
        SET state=$2,receipt=$3,revision=revision+1,"acceptedWrites"="acceptedWrites"+$4 WHERE "operationId"=$1`,
      [record.operationId, record.status === 'succeeded' ? 'accepted' : 'uncertain', record.receipt, record.status === 'succeeded' ? 1 : 0])
      assert.equal(changed.rowCount, 1)
      if (record.status === 'succeeded' && failAccepted) throw projectionFailure
    } })
    const local = async () => (await pool.query<{ state: string; receipt: OperationReceipt | null; revision: number; acceptedWrites: number }>(
      'SELECT state,receipt,revision,"acceptedWrites" FROM fixture_review_projection WHERE "operationId"=$1', [f.key.operationId])).rows[0]!
    await projected.reserve(f.binding)
    await pool.query('INSERT INTO fixture_review_projection("operationId") VALUES($1)', [f.key.operationId])
    const claimed = await projected.claim(f.key, null)
    assert.equal(projections, 0, 'reserving and claiming cannot project a completed outcome')

    await assert.rejects(projected.invoke(f.key, claimed.attemptToken!, async (_record, beforeSend) => {
      await beforeSend()
      effects++
      return receipt
    }), error => error === projectionFailure)
    const invoked = await f.stored()
    assert.equal(invoked.status, 'executing')
    assert.ok(invoked.invokedAt instanceof Date)
    assert.equal(invoked.receipt, null)
    assert.deepEqual(await local(), { state: 'prepared', receipt: null, revision: 0, acceptedWrites: 0 },
      'a projection which wrote accepted and then failed must roll its write back with the ledger outcome')
    assert.deepEqual({ effects, projections }, { effects: 1, projections: 1 })
    await assert.rejects(projected.invoke(f.key, claimed.attemptToken!, async () => { effects++; return receipt }), /operationAlreadyInvoked/)
    assert.equal(projections, 1)

    assert.equal((await projected.reconcile(f.key, async () => { lookups++; return null })).status, 'executing')
    assert.equal(projections, 1, 'an empty readback must not invoke the local projection')
    await projected.settle(f.key, claimed.attemptToken!, { status: 'uncertain' })
    const uncertain = { state: 'uncertain', receipt: null, revision: 1, acceptedWrites: 0 }
    assert.deepEqual(await local(), uncertain)
    assert.equal(projections, 2)

    await assert.rejects(projected.reconcile(f.key, async () => { lookups++; return receipt }), error => error === projectionFailure)
    assert.equal((await f.stored()).status, 'uncertain', 'failed positive readback projection must retain the uncertain ledger state')
    assert.deepEqual(await local(), uncertain)
    assert.equal(projections, 3)
    assert.equal((await projected.reconcile(f.key, async () => { lookups++; return null })).status, 'uncertain')
    assert.equal(projections, 3, 'empty readback also skips projection while uncertain')

    failAccepted = false
    const recovered = await projected.reconcile(f.key, async () => { lookups++; return receipt })
    assert.equal(recovered.status, 'succeeded')
    assert.deepEqual(recovered.receipt, receipt)
    assert.deepEqual(await local(), { state: 'accepted', receipt, revision: 2, acceptedWrites: 1 })
    const final = await f.stored()
    assert.equal(final.status, 'succeeded')
    assert.deepEqual(final.receipt, receipt)
    assert.equal(final.invokedAt?.getTime(), invoked.invokedAt.getTime())
    assert.equal(final.attemptToken, invoked.attemptToken)
    assert.equal(final.runId, null)
    await projected.reconcile(f.key, async () => { throw new Error('completed readback must not query the provider again') })
    assert.deepEqual({ effects, lookups, projections }, { effects: 1, lookups: 4, projections: 4 })
    assert.equal((await local()).acceptedWrites, 1, 'replaying a completed receipt cannot apply its projection again')
  })

  await t.test('settle and its rejected projection commit together or leave the claim unchanged', async () => {
    const f = await operation()
    let failProjection = true, projections = 0
    const failure = new Error('controlled rejected projection failure')
    const projected = createOperationLedger(pool, f.authorize, { project: async (tx, record) => {
      projections++
      assert.equal(record.status, 'failed')
      assert.equal(record.receipt, null)
      assert.equal((await tx.query('SELECT status FROM operation_ledger WHERE "operationId"=$1', [record.operationId])).rows[0].status, 'failed')
      const changed = await tx.query(`UPDATE fixture_review_projection SET state='rejected',revision=revision+1 WHERE "operationId"=$1`, [record.operationId])
      assert.equal(changed.rowCount, 1)
      if (failProjection) throw failure
    } })
    const local = async () => (await pool.query<{ state: string; revision: number }>(
      'SELECT state,revision FROM fixture_review_projection WHERE "operationId"=$1', [f.key.operationId])).rows[0]!
    await projected.reserve(f.binding)
    await pool.query('INSERT INTO fixture_review_projection("operationId") VALUES($1)', [f.key.operationId])
    const claimed = await projected.claim(f.key, null)
    await assert.rejects(projected.settle(f.key, claimed.attemptToken!, { status: 'failed' }), error => error === failure)
    const unchanged = await f.stored()
    assert.equal(unchanged.status, 'executing')
    assert.equal(unchanged.attemptToken, claimed.attemptToken)
    assert.equal(unchanged.invokedAt, null)
    assert.equal(unchanged.receipt, null)
    assert.deepEqual(await local(), { state: 'prepared', revision: 0 })
    failProjection = false
    assert.equal((await projected.settle(f.key, claimed.attemptToken!, { status: 'failed' })).status, 'failed')
    assert.equal((await f.stored()).status, 'failed')
    assert.deepEqual(await local(), { state: 'rejected', revision: 1 })
    assert.equal(projections, 2, 'only the successful settlement commits a projection update')
  })
})
