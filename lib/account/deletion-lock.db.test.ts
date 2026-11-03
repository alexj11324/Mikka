import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { Pool } from 'pg'
import { dbUrl, seedUser } from '../../tests/support/workspace-admin-db'
import { AccountDeletionBusy, acquireAccountDeletionLock, deletionLockPoolOptions } from './deletion-lock'
import { cancelAccountDeletion, requestAccountDeletion, resumeAccountDeletion, sweepAccountDeletions } from './deletion-jobs'

test('only the Neon pooler host changes for a deletion session', () => {
  const source = new URL('postgresql://ep-test-pooler.c-7.us-east-2.aws.neon.tech/app?sslmode=require')
  source.username = randomUUID(); source.password = randomUUID()
  const config = deletionLockPoolOptions({ connectionString: source.href, max: 5 })
  const parsed = new URL(config.connectionString!)
  assert.equal(parsed.hostname, 'ep-test.c-7.us-east-2.aws.neon.tech')
  assert.equal(parsed.username, source.username); assert.equal(parsed.password, source.password)
  assert.equal(parsed.pathname, '/app'); assert.equal(parsed.searchParams.get('sslmode'), 'require')
  assert.equal(config.max, 1)
  assert.equal(deletionLockPoolOptions({ host: 'localhost-pooler.example.test' }).host, 'localhost-pooler.example.test')
  assert.equal(deletionLockPoolOptions({ connectionString: dbUrl }).connectionString, dbUrl)
})

test('Postgres sessions demonstrate the transaction-pooler lock hazard and owned sessions release safely', { skip: !dbUrl }, async t => {
  const main = new Pool({ connectionString: dbUrl, max: 5 })
  t.after(() => main.end())
  const owner = await main.connect(), other = await main.connect()
  const id = randomUUID(), key = `mikka-account-deletion-job:${id}`
  try {
    await owner.query('SELECT pg_advisory_lock(hashtextextended($1,0))', [key])
    assert.equal((await other.query('SELECT pg_advisory_unlock(hashtextextended($1,0)) AS unlocked', [key])).rows[0].unlocked, false, 'a switched backend cannot release the earlier backend lock')
    await assert.rejects(acquireAccountDeletionLock(main, id), AccountDeletionBusy)
  } finally { await owner.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [key]); owner.release(); other.release() }
  const first = await acquireAccountDeletionLock(main, id)
  const firstPid = (await first.client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
  try { await assert.rejects(acquireAccountDeletionLock(main, id), AccountDeletionBusy) }
  finally { await first.close() }
  const second = await acquireAccountDeletionLock(main, id)
  await second.close()
  const { rows: [locks] } = await main.query('SELECT count(*)::int AS n FROM pg_locks WHERE locktype=\'advisory\' AND pid=$1', [firstPid])
  assert.equal(locks.n, 0)
})

test('a busy deletion sweep preserves the pending report and retries after closure, cancellation and errors', { skip: !dbUrl }, async t => {
  // A real server statement timeout also bounds the old implementation's wait
  // so the regression fails on its report mutation instead of hanging a test.
  const main = new Pool({ connectionString: dbUrl, max: 5, statement_timeout: 500 })
  const workspace = new Pool({ connectionString: dbUrl, max: 5 })
  let disposeJob: (() => Promise<void>) | undefined
  t.after(async () => { try { await disposeJob?.() } finally { await main.end(); await workspace.end() } })
  const options = { mainPool: main, workspacePool: workspace, externalCleanup: async () => ['provider_pending'] }
  const user = await seedUser(main, 'deletion-lock')
  const requested = await requestAccountDeletion(user, `${user}@example.invalid`, randomUUID(), options)
  assert.ok(requested.ok)
  if (!requested.ok) throw new Error('fixture unexpectedly refused')
  const id = requested.id
  disposeJob = async () => {
    await main.query('DELETE FROM account_deletion_guards WHERE "subjectId"=$1', [user])
    await main.query('DELETE FROM account_deletion_jobs WHERE id=$1', [id])
    await main.query('DELETE FROM "user" WHERE id=$1', [user])
  }
  const pending = await resumeAccountDeletion(id, options)
  assert.equal(pending.stage, 'external_pending')
  const holder = await main.connect()
  await holder.query('SELECT pg_advisory_lock(hashtextextended($1,0))', [`mikka-account-deletion-job:${id}`])
  try {
    let externalCalls = 0
    const before = await main.query('SELECT stage,"blockedReasons","updatedAt" FROM account_deletion_jobs WHERE id=$1', [id])
    // Scope this real sweep to its disposable fixture; sibling DB test files
    // may have their own live deletion jobs in the shared isolated database.
    const sweepPool = new Proxy(main, { get(target, property) {
      if (property === 'query') return (query: string, values?: unknown[]) => query.startsWith('SELECT id FROM account_deletion_jobs WHERE stage NOT IN')
        ? target.query(query.replace(' ORDER BY', ' AND id=$1 ORDER BY'), [id]) : target.query(query, values)
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    } })
    const result = await sweepAccountDeletions({ ...options, mainPool: sweepPool, externalCleanup: async () => { externalCalls++; return [] } })
    assert.ok(result.pending >= 1)
    assert.equal(externalCalls, 0, 'a competing sweep never repeats provider cleanup')
    const after = await main.query('SELECT stage,"blockedReasons","updatedAt" FROM account_deletion_jobs WHERE id=$1', [id])
    assert.deepEqual(after.rows, before.rows, 'lock contention must not overwrite the active job report')
  } finally { await holder.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [`mikka-account-deletion-job:${id}`]); holder.release() }
  const errored = await resumeAccountDeletion(id, { ...options, externalCleanup: async () => { throw new Error('fixture provider unavailable') } })
  assert.deepEqual(errored.blockedReasons, ['external_cleanup_failed'])
  assert.equal((await resumeAccountDeletion(id, options)).stage, 'external_pending', 'an exception releases the session for the retry')
  assert.equal(await cancelAccountDeletion(user, id, options), false, 'external cleanup has begun')
  const retryLock = await acquireAccountDeletionLock(main, id)
  await retryLock.close()
})
