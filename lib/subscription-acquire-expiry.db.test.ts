import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { Pool } from 'pg'
import { disposableDatabase } from '../tests/helpers/e2e-target.mjs'
import { CLEANUP_DUE_SQL, expireSubscriptionAcquisitions, subscriptionCleanupDue } from './subscription-acquire-expiry'

const databaseURL = process.env.E2E_DATABASE_URL
const disposable = disposableDatabase(process.env, databaseURL)
if (process.env.REQUIRE_DB === '1' && !disposable) throw new Error('Subscription acquisition expiry tests require an isolated local database')

const migration = '20261105150000_byos_acquire_expiry.sql'
const digest = 'a'.repeat(64)

async function withDatabase(run: (pool: Pool) => Promise<void>) {
  const admin = new Pool({ connectionString: databaseURL })
  const schema = `subscription_expiry_${randomUUID().replaceAll('-', '')}`
  await admin.query(`CREATE SCHEMA ${schema}`)
  const pool = new Pool({ connectionString: databaseURL, options: `-c search_path=${schema}`, statement_timeout: 5000 })
  try {
    for (const name of [
      '20261027164503_byos_credential_publications.sql',
      '20261027164504_byos_bindings_oauth.sql',
      '20261027164505_byos_device_authorization.sql',
      '20261027164506_byos_access_and_cleanup.sql',
      '20261027164508_byos_enrollment_transfers.sql',
      '20261027164509_byos_enrollment_cleanup.sql',
      '20261029043631_byos_account_label.sql',
      '20261029043633_byos_connection_removed.sql',
      '20261031050731_account_deletion_jobs.sql',
      migration,
      migration,
    ]) await pool.query(await readFile(new URL(`../drizzle/${name}`, import.meta.url), 'utf8'))
    await run(pool)
  } finally {
    await pool.end()
    await admin.query(`DROP SCHEMA ${schema} CASCADE`)
    await admin.end()
  }
}

async function connection(pool: Pool, ownerId = 'alice', state = 'pending', kind: 'acquire' | 'refresh' | null = 'acquire', seconds = -60) {
  const id = randomUUID(), operationId = state === 'connected' || kind === null ? null : randomUUID()
  await pool.query(`INSERT INTO byos_connections
    (id,"ownerId","workspaceId",provider,state,epoch,"credentialVersion","operationId","operationKind","operationDeadline",
      "secretName","secretDigest","providerSubject","stagedSecretName","stagedDigest","stagedAccessName","stagedAccessDigest")
    VALUES ($1,$2,'workspace','codex',$3,4,7,$4,$5,CASE WHEN $4::uuid IS NULL THEN NULL ELSE now()+$6*interval '1 second' END,
      $7,$8,$9,$10,$11,$12,$11)`,
  [id, ownerId, state, operationId, operationId ? kind : null, seconds,
    state === 'connected' ? `grant-${id}` : null, state === 'connected' ? digest : null, state === 'connected' ? 'provider-subject' : null,
    state === 'publication_pending' ? `staged-${id}` : null, state === 'publication_pending' ? digest : null,
    state === 'publication_pending' ? `access-${id}` : null])
  return { id, operationId, ownerId }
}

async function attempt(pool: Pool, row: Awaited<ReturnType<typeof connection>>, operationId = row.operationId, consumed = false) {
  const stateHash = randomBytes(32).toString('hex'), secretName = `oauth-${randomUUID()}`
  await pool.query(`INSERT INTO byos_oauth_attempts
    ("stateHash","sessionHash","connectionId","ownerId","workspaceId","operationId","secretName","expiresAt",flow,polling,"consumedAt")
    VALUES ($1,$2,$3,$4,'workspace',$5,$6,now()+interval '1 hour','device',true,CASE WHEN $7 THEN now()-interval '1 minute' ELSE NULL END)`,
  [stateHash, randomBytes(32).toString('hex'), row.id, row.ownerId, operationId, secretName, consumed])
  return stateHash
}

async function rows(pool: Pool, ids: string[]) {
  return (await pool.query('SELECT * FROM byos_connections WHERE id=ANY($1::uuid[]) ORDER BY id', [ids])).rows
}

test('expired acquisitions are fenced and consumed atomically; unrelated states and repeated sweeps are unchanged', { skip: !disposable }, async () => {
  await withDatabase(async pool => {
    const expired = []
    // Includes reservations that never reached the worker and have no attempt.
    for (let index = 0; index < 19; index++) expired.push(await connection(pool, index % 2 ? 'alice' : 'bob'))
    const currentAttempt = await attempt(pool, expired[0])
    const consumedAttempt = await attempt(pool, expired[0], expired[0].operationId, true)
    const otherOperationAttempt = await attempt(pool, expired[0], randomUUID())
    await pool.query('UPDATE byos_oauth_attempts SET "expiresAt"=now()-interval \'1 second\' WHERE "connectionId"=$1', [expired[0].id])
    const beforeConsumed = (await pool.query('SELECT "consumedAt" FROM byos_oauth_attempts WHERE "stateHash"=$1', [consumedAttempt])).rows[0].consumedAt
    await pool.query(`INSERT INTO byos_secret_artifacts
      (name,"connectionId","ownerId","workspaceId",provider,kind,"operationId","notBefore","createStarted","createSettled")
      SELECT "secretName","connectionId","ownerId","workspaceId",'codex','oauth',"operationId",now(),true,true
      FROM byos_oauth_attempts WHERE "stateHash"=$1`, [currentAttempt])
    const artifactsBefore = (await pool.query('SELECT * FROM byos_secret_artifacts')).rows
    const untouched = [
      await connection(pool, 'alice', 'pending', 'acquire', 3600),
      await connection(pool, 'alice', 'connected'),
      await connection(pool, 'alice', 'publication_pending'),
      await connection(pool, 'alice', 'pending', 'refresh'),
      await connection(pool, 'alice', 'refreshing', 'refresh'),
      await connection(pool, 'alice', 'pending', null),
    ]
    const untouchedAttempt = await attempt(pool, untouched[0])
    const before = await rows(pool, untouched.map(row => row.id))
    await assert.rejects(pool.query('UPDATE byos_connections SET "lastErrorCode"=$2 WHERE id=$1', [expired[0].id, 'unknown_error']), { code: '23514' })
    for (const code of ['publication_failed', 'refresh_failed', 'publication_missing', 'integrity_failed']) {
      await pool.query('UPDATE byos_connections SET "lastErrorCode"=$2 WHERE id=$1', [expired[0].id, code])
    }

    assert.deepEqual(await expireSubscriptionAcquisitions(pool), { expired: 19, ownerIds: ['alice', 'bob'] })
    for (const row of await rows(pool, expired.map(row => row.id))) {
      assert.equal(row.state, 'disconnected')
      assert.ok(row.removedAt)
      assert.equal(row.lastErrorCode, 'acquire_expired')
      assert.equal(row.epoch, '5')
      assert.equal(row.credentialVersion, '7')
      for (const key of ['operationId', 'operationKind', 'operationDeadline', 'stagedSecretName', 'stagedDigest', 'stagedAccessName', 'stagedAccessDigest']) assert.equal(row[key], null)
    }
    const attempts = (await pool.query('SELECT * FROM byos_oauth_attempts')).rows
    for (const hash of [currentAttempt, consumedAttempt]) {
      const row = attempts.find(row => row.stateHash === hash)
      assert.ok(row.consumedAt)
      assert.equal(row.polling, false)
    }
    assert.deepEqual(attempts.find(row => row.stateHash === consumedAttempt).consumedAt, beforeConsumed)
    for (const hash of [otherOperationAttempt, untouchedAttempt]) {
      const row = attempts.find(row => row.stateHash === hash)
      assert.equal(row.consumedAt, null)
      assert.equal(row.polling, true)
    }
    assert.deepEqual((await pool.query('SELECT * FROM byos_secret_artifacts')).rows, artifactsBefore, 'secret cleanup retains its own artifact ledger')
    assert.deepEqual(await rows(pool, untouched.map(row => row.id)), before)

    const old = expired[0]
    const lateStage = await pool.query(`UPDATE byos_connections SET state='publication_pending',"stagedSecretName"='late-grant',"stagedDigest"=$3
      WHERE id=$1 AND epoch=4 AND "credentialVersion"=7 AND "operationId"=$2 AND "operationDeadline">now() AND state='pending'`, [old.id, old.operationId, digest])
    assert.equal(lateStage.rowCount, 0, 'an in-flight exchange cannot publish after expiry')
    const lateFailure = await pool.query(`UPDATE byos_connections SET "lastErrorCode"='publication_failed'
      WHERE id=$1 AND epoch=4 AND "credentialVersion"=7 AND "operationId"=$2`, [old.id, old.operationId])
    assert.equal(lateFailure.rowCount, 0, 'a late worker failure cannot overwrite the expiry reason')
    const after = await rows(pool, expired.map(row => row.id))
    assert.deepEqual(await expireSubscriptionAcquisitions(pool), { expired: 0, ownerIds: [] })
    assert.deepEqual(await rows(pool, expired.map(row => row.id)), after)
    await pool.query(await readFile(new URL(`../drizzle/${migration}`, import.meta.url), 'utf8'))
    assert.deepEqual(await rows(pool, expired.map(row => row.id)), after, 'reapplying the CHECK migration preserves expired rows')
  })
})

test('owner-scoped expiry changes only that owner and returns only changed owners', { skip: !disposable }, async () => {
  await withDatabase(async pool => {
    await connection(pool, 'alice')
    await connection(pool, 'alice')
    const other = await connection(pool, 'bob')
    const before = await rows(pool, [other.id])
    assert.deepEqual(await expireSubscriptionAcquisitions(pool, 'alice'), { expired: 2, ownerIds: ['alice'] })
    assert.deepEqual(await rows(pool, [other.id]), before)
    assert.deepEqual(await expireSubscriptionAcquisitions(pool, 'alice'), { expired: 0, ownerIds: [] })
    assert.deepEqual(await expireSubscriptionAcquisitions(pool), { expired: 1, ownerIds: ['bob'] })
  })
})

test('stale empty failures are removed; account, credential, binding and live OAuth evidence are preserved', { skip: !disposable }, async () => {
  await withDatabase(async pool => {
    const abandoned = await connection(pool, 'alice', 'reconnect_required', null)
    const disconnected = await connection(pool, 'alice', 'disconnected', null)
    const protectedRows = []
    for (const column of ['providerSubject', 'accountLabel', 'secretName', 'accessSecretName', 'stagedSecretName', 'stagedAccessName']) {
      const row = await connection(pool, 'alice', 'reconnect_required', null)
      const value = column === 'accountLabel' ? 'fixture@example.test' : 'fixture-evidence'
      const digestColumn = column === 'secretName' ? 'secretDigest' : column === 'accessSecretName' ? 'accessDigest' : column === 'stagedSecretName' ? 'stagedDigest' : column === 'stagedAccessName' ? 'stagedAccessDigest' : null
      await pool.query(`UPDATE byos_connections SET "${column}"=$2${digestColumn ? `,"${digestColumn}"='${digest}'` : ''} WHERE id=$1`, [row.id, value])
      protectedRows.push(row)
    }
    const bound = await connection(pool, 'alice', 'reconnect_required', null)
    await pool.query(`INSERT INTO byos_bindings (id,"ownerId","workspaceId","consumerId","connectionId","connectionRevision",route,"modelId")
      VALUES ($1,'alice','workspace','consumer',$2,4,'codex_cpa','fixture-model')`, [randomUUID(), bound.id])
    protectedRows.push(bound)
    const active = await connection(pool, 'alice')
    await attempt(pool, active)
    protectedRows.push(active)
    const retainedAccount = await connection(pool, 'alice')
    await pool.query('UPDATE byos_connections SET "providerSubject"=\'known-account\' WHERE id=$1', [retainedAccount.id])
    await pool.query('UPDATE byos_connections SET "updatedAt"=now()-interval \'2 hours\'')
    const before = await rows(pool, protectedRows.map(row => row.id))
    assert.equal(await subscriptionCleanupDue(pool), true)
    assert.deepEqual(await expireSubscriptionAcquisitions(pool), { expired: 3, ownerIds: ['alice'] })
    for (const row of await rows(pool, [abandoned.id, disconnected.id])) {
      assert.equal(row.state, 'disconnected')
      assert.ok(row.removedAt)
      assert.equal(row.epoch, '5')
    }
    const [retained] = await rows(pool, [retainedAccount.id])
    assert.equal(retained.state, 'reconnect_required', 'a previously identified account still offers reconnect')
    assert.equal(retained.removedAt, null)
    assert.deepEqual(await rows(pool, protectedRows.map(row => row.id)), before)
    assert.deepEqual(await expireSubscriptionAcquisitions(pool), { expired: 0, ownerIds: [] })
  })
})

test('a successful reconnect removes older empty shells in the same account and provider without waiting an hour', { skip: !disposable }, async () => {
  await withDatabase(async pool => {
    const old = await connection(pool, 'alice', 'reconnect_required', null)
    const otherOwner = await connection(pool, 'bob', 'reconnect_required', null)
    const otherProvider = await connection(pool, 'alice', 'reconnect_required', null)
    await pool.query('UPDATE byos_connections SET provider=\'claude\' WHERE id=$1', [otherProvider.id])
    await pool.query('UPDATE byos_connections SET "createdAt"=now()-interval \'5 minutes\'')
    const reconnected = await connection(pool, 'alice', 'connected')
    await pool.query('UPDATE byos_connections SET "workspaceId"=\'other-workspace\',"createdAt"=now()-interval \'1 day\' WHERE id=$1', [reconnected.id])
    assert.deepEqual(await expireSubscriptionAcquisitions(pool, 'alice'), { expired: 1, ownerIds: ['alice'] })
    assert.ok((await rows(pool, [old.id]))[0].removedAt)
    assert.ok((await rows(pool, [otherOwner.id, otherProvider.id])).every(row => row.removedAt === null))
  })
})

test('a concurrent credential publication keeps its epoch, staged credentials and OAuth attempt', { skip: !disposable }, async () => {
  await withDatabase(async pool => {
    const publishing = await connection(pool, 'alice')
    const stateHash = await attempt(pool, publishing)
    await pool.query('UPDATE byos_oauth_attempts SET "expiresAt"=now()-interval \'1 second\' WHERE "stateHash"=$1', [stateHash])
    await connection(pool, 'bob')
    const writer = await pool.connect()
    try {
      await writer.query('BEGIN')
      // Stage with a valid deadline, then advance the fixture past its deadline
      // while publication still owns the row. The sweep sees the old pending row.
      await writer.query('UPDATE byos_connections SET "operationDeadline"=now()+interval \'5 minutes\' WHERE id=$1', [publishing.id])
      const staged = await writer.query(`UPDATE byos_connections SET state='publication_pending',
        "stagedSecretName"='current-grant',"stagedDigest"=$3,"stagedAccessName"='current-access',"stagedAccessDigest"=$3
        WHERE id=$1 AND epoch=4 AND "credentialVersion"=7 AND "operationId"=$2 AND "operationDeadline">now() AND state='pending'`, [publishing.id, publishing.operationId, digest])
      assert.equal(staged.rowCount, 1)
      await writer.query('UPDATE byos_connections SET "operationDeadline"=now()-interval \'1 minute\' WHERE id=$1', [publishing.id])
      const expected = (await writer.query('SELECT * FROM byos_connections WHERE id=$1', [publishing.id])).rows
      assert.deepEqual(await expireSubscriptionAcquisitions(pool), { expired: 1, ownerIds: ['bob'] }, 'locked publication is skipped without blocking unrelated expiry')
      await writer.query('COMMIT')
      assert.deepEqual(await rows(pool, [publishing.id]), expected)
      assert.deepEqual(await expireSubscriptionAcquisitions(pool), { expired: 0, ownerIds: [] }, 'an overdue publication remains recoverable')
      assert.deepEqual((await pool.query('SELECT "consumedAt",polling FROM byos_oauth_attempts WHERE "stateHash"=$1', [stateHash])).rows, [{ consumedAt: null, polling: true }])
    } finally {
      await writer.query('ROLLBACK')
      writer.release()
    }
  })
})

test('expired enrollment reservations preserve their recovery sources before binding; a later OAuth acquisition still expires', { skip: !disposable }, async () => {
  await withDatabase(async pool => {
    const protectedRows = [await connection(pool, 'enrollment-owner'), await connection(pool, 'enrollment-owner')]
    const reconnected = await connection(pool, 'oauth-owner')
    const all = [...protectedRows, reconnected]
    await pool.query('UPDATE byos_connections SET provider=\'claude\' WHERE id=ANY($1::uuid[])', [all.map(row => row.id)])
    for (const [index, row] of all.entries()) {
      const enrollmentId = randomUUID(), oldTransfer = row.id === reconnected.id
      await pool.query(`INSERT INTO byos_enrollment_transfers
        ("enrollmentId","transferId","connectionId","ownerId","workspaceId",principal,"databaseIdentity","escrowDigest","providerSubject",epoch,"operationId","claimConfirmedAt")
        VALUES ($1,$2,$3,$4,'workspace','operator:fixture',$5,$5,'provider-subject',$6,$7,CASE WHEN $8 THEN now() ELSE NULL END)`,
      [enrollmentId, randomUUID(), row.id, row.ownerId, digest, oldTransfer ? 3 : 4, oldTransfer ? randomUUID() : row.operationId, index === 1])
      await pool.query(`INSERT INTO byos_enrollment_sources ("enrollmentId",kind,"connectionId")
        VALUES ($1,'escrow',$2),($1,'attempt',$2)`, [enrollmentId, row.id])
    }
    const protectedIds = protectedRows.map(row => row.id)
    const before = await rows(pool, protectedIds)
    const transfersBefore = (await pool.query('SELECT * FROM byos_enrollment_transfers WHERE "connectionId"=ANY($1::uuid[]) ORDER BY "enrollmentId"', [protectedIds])).rows
    const sourcesBefore = (await pool.query('SELECT * FROM byos_enrollment_sources WHERE "connectionId"=ANY($1::uuid[]) ORDER BY "enrollmentId",kind', [protectedIds])).rows
    const cleanupEligible = async () => (await pool.query(`SELECT count(*)::int AS count
      FROM byos_enrollment_sources source JOIN byos_enrollment_transfers transfer ON transfer."enrollmentId"=source."enrollmentId"
      JOIN byos_connections c ON c.id=source."connectionId"
      WHERE c.id=ANY($1::uuid[]) AND source."deletedAt" IS NULL
        AND (transfer."canonicalPublishedAt" IS NOT NULL OR transfer."boundAt" IS NOT NULL OR c.epoch>transfer.epoch)`, [protectedIds])).rows[0].count
    assert.equal(await cleanupEligible(), 0)
    assert.deepEqual(await expireSubscriptionAcquisitions(pool, 'enrollment-owner'), { expired: 0, ownerIds: [] }, 'the reservation is protected even before its immutable claim is confirmed')
    assert.deepEqual(await expireSubscriptionAcquisitions(pool), { expired: 1, ownerIds: ['oauth-owner'] }, 'an older enrollment transfer does not protect a newer OAuth operation')
    assert.deepEqual(await rows(pool, protectedIds), before)
    assert.deepEqual((await pool.query('SELECT * FROM byos_enrollment_transfers WHERE "connectionId"=ANY($1::uuid[]) ORDER BY "enrollmentId"', [protectedIds])).rows, transfersBefore)
    assert.deepEqual((await pool.query('SELECT * FROM byos_enrollment_sources WHERE "connectionId"=ANY($1::uuid[]) ORDER BY "enrollmentId",kind', [protectedIds])).rows, sourcesBefore)
    assert.equal(await cleanupEligible(), 0, 'the sweep must never authorize deletion of unpublished recovery credentials')
    for (const row of protectedRows) {
      const resumed = await pool.query(`UPDATE byos_connections c SET "operationDeadline"=now()+interval '5 minutes'
        WHERE c.id=$1 AND c."ownerId"=$2 AND c."workspaceId"='workspace' AND c.epoch=4 AND c."operationId"=$3 AND c.state='pending'
          AND EXISTS (SELECT 1 FROM byos_enrollment_transfers transfer WHERE transfer."connectionId"=c.id
            AND transfer.epoch=c.epoch AND transfer."operationId"=c."operationId" AND transfer."boundAt" IS NULL)
        RETURNING epoch,"operationId"`, [row.id, row.ownerId, row.operationId])
      assert.deepEqual(resumed.rows, [{ epoch: '4', operationId: row.operationId }], 'the original enrollment operation can still resume without reacquiring')
    }
    assert.equal(await cleanupEligible(), 0)
    assert.deepEqual(await expireSubscriptionAcquisitions(pool), { expired: 0, ownerIds: [] })
  })
})

test('the hourly pre-check is false when idle and true exactly when the sweep has an abandoned sign-in to expire', { skip: !disposable }, async () => {
  await withDatabase(async pool => {
    assert.equal(await subscriptionCleanupDue(pool), false, 'an idle hour runs only this one statement')
    await connection(pool, 'future-owner', 'pending', 'acquire', 300)
    assert.equal(await subscriptionCleanupDue(pool), false, 'a sign-in still inside its deadline is not due')
    await connection(pool, 'expired-owner', 'pending', 'acquire', -60)
    assert.equal(await subscriptionCleanupDue(pool), true)
    assert.deepEqual(await expireSubscriptionAcquisitions(pool), { expired: 1, ownerIds: ['expired-owner'] })
    assert.equal(await subscriptionCleanupDue(pool), false, 'nothing left after the sweep')
  })
})

for (const consolidated of [true, false]) {
  test(`ordinary cleanup leaves deletion-owned work to its job in a ${consolidated ? 'consolidated' : 'split'} database`, { skip: !disposable }, async () => {
    await withDatabase(async pool => {
      const job = randomUUID(), solo = randomUUID(), shared = randomUUID()
      const inSolo = await connection(pool, 'former-member')
      const byOwner = await connection(pool, 'deleting-owner')
      const ordinary = await connection(pool, 'other-owner')
      await pool.query('UPDATE byos_connections SET "workspaceId"=CASE WHEN id=$1 THEN $2 ELSE $3 END', [inSolo.id, solo, shared])
      for (const row of [inSolo, byOwner, ordinary]) {
        await pool.query(`INSERT INTO byos_secret_artifacts (name,"connectionId","ownerId","workspaceId",provider,kind,"notBefore")
          SELECT id::text,id,"ownerId","workspaceId",provider,'grant',now() FROM byos_connections WHERE id=$1`, [row.id])
      }
      const enrollment = randomUUID()
      await pool.query(`INSERT INTO byos_enrollment_transfers
        ("enrollmentId","transferId","connectionId","ownerId","workspaceId",principal,"databaseIdentity","escrowDigest","providerSubject",epoch,"operationId","boundAt")
        SELECT $1,$2,id,"ownerId","workspaceId",'fixture',$3,$3,'fixture',epoch-1,"operationId",now() FROM byos_connections WHERE id=$4`,
      [enrollment, randomUUID(), digest, inSolo.id])
      await pool.query('INSERT INTO byos_enrollment_sources ("enrollmentId",kind,"connectionId") VALUES ($1,\'escrow\',$2)', [enrollment, inSolo.id])
      if (consolidated) {
        await pool.query(await readFile(new URL('../drizzle/20261031050732_workspace_deletion_guards.sql', import.meta.url), 'utf8'))
        await pool.query('INSERT INTO account_deletion_workspace_guards ("workspaceId","jobId") VALUES ($1,$2)', [solo, job])
        await assert.rejects(pool.query('UPDATE byos_connections SET epoch=epoch WHERE id=$1', [inSolo.id]), { code: '55000' })
      } else {
        assert.equal((await pool.query("SELECT to_regclass('account_deletion_workspace_guards') AS guard")).rows[0].guard, null)
      }
      await pool.query(`INSERT INTO account_deletion_jobs (id,"subjectUserId","subjectEmailHash",stage,plan)
        VALUES ($1,$2,$3,'external_pending',$4)`, [job, byOwner.ownerId, digest, JSON.stringify({ solo: [solo] })])
      await pool.query('INSERT INTO account_deletion_guards ("subjectId","jobId") VALUES ($1,$2)', [byOwner.ownerId, job])
      await pool.query(`INSERT INTO account_deletion_jobs (id,"subjectUserId","subjectEmailHash",stage,plan)
        VALUES ($1,$2,$3,'cancelled',$4)`, [randomUUID(), ordinary.ownerId, digest, JSON.stringify({ solo: [shared] })])
      const protectedIds = [inSolo.id, byOwner.id], before = await rows(pool, protectedIds)
      assert.equal(await subscriptionCleanupDue(pool), true)
      assert.deepEqual(await expireSubscriptionAcquisitions(pool), { expired: 1, ownerIds: [ordinary.ownerId] })
      assert.deepEqual(await expireSubscriptionAcquisitions(pool, byOwner.ownerId), { expired: 0, ownerIds: [] })
      assert.deepEqual((await pool.query(CLEANUP_DUE_SQL)).rows.map(row => row.connectionId), [ordinary.id])
      await pool.query('UPDATE byos_secret_artifacts SET "deletedAt"=now() WHERE "connectionId"=$1', [ordinary.id])
      assert.equal(await subscriptionCleanupDue(pool), false)
      assert.deepEqual(await rows(pool, protectedIds), before)
      assert.equal((await pool.query('SELECT count(*)::int AS retained FROM byos_secret_artifacts WHERE "deletedAt" IS NULL')).rows[0].retained, 2)
      assert.equal((await pool.query('SELECT "deletedAt" FROM byos_enrollment_sources WHERE "enrollmentId"=$1', [enrollment])).rows[0].deletedAt, null)
    })
  })
}
