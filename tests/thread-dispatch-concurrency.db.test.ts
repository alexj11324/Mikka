import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { test } from 'node:test'
import { dbUrl, seedIssue, seedPersonalWorkspace, seedUser } from './support/workspace-admin-db'

test('task dispatch locks preserve concurrency, serialization and database ownership', { skip: !dbUrl }, async t => {
  const { pool } = await import('../lib/db')
  const { dispatchToTask } = await import('../lib/thread-dispatch')
  const { createRequestDatabaseScope } = await import('../lib/db/request-scope')
  const { withTaskDispatchLock } = await import('../lib/task-dispatch-lock')
  t.after(() => pool.end())
  const userId = await seedUser(pool, 'dispatch-concurrency')
  const workspaceId = await seedPersonalWorkspace(pool, userId)
  const issues = await Promise.all(Array.from({ length: 5 }, () => seedIssue(pool, userId, workspaceId)))
  await t.test('five independent personal tasks can enter admission without exhausting its APP pool', async () => {
    const results = await Promise.allSettled(issues.map(issueId => dispatchToTask(userId, issueId, {
      start: async () => {
        await pool.query('SELECT 1')
        return { runId: randomUUID() }
      },
    })))
    for (const result of results) assert.equal(result.status, 'fulfilled', result.status === 'rejected' ? String(result.reason) : undefined)
  })
  await t.test('another connection cannot take the same task lock before the owner commits', async () => {
    await withTaskDispatchLock(userId, issues[0], async () => {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const key = JSON.stringify(['task-thread', userId, issues[0]])
        const { rows: [result] } = await client.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS acquired', [key])
        assert.equal(result.acquired, false, 'same-task serialization survives across database connections')
        await client.query('ROLLBACK')
      } finally { client.release() }
    })
  })
  await t.test('a failed admission rolls back and releases its task lock', async () => {
    const failure = new Error('synthetic admission failure')
    await assert.rejects(withTaskDispatchLock(userId, issues[1], async () => { throw failure }), error => error === failure)
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const key = JSON.stringify(['task-thread', userId, issues[1]])
      const { rows: [result] } = await client.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS acquired', [key])
      assert.equal(result.acquired, true)
      await client.query('ROLLBACK')
    } finally { client.release() }
  })
  await t.test('request database routing owns the lock and closes both pools', async () => {
    const name = `dispatch_${randomUUID().replaceAll('-', '')}_e2e`
    const target = new URL(dbUrl!)
    target.pathname = `/${name}`
    await pool.query(`CREATE DATABASE "${name}"`)
    const { Client } = await import('pg')
    const ended: Promise<unknown>[] = []
    const end = Client.prototype.end
    const observeEnd = t.mock.method(Client.prototype, 'end', function(this: InstanceType<typeof Client>, ...args: unknown[]) {
      if (this.database === name) ended.push(once(this, 'end'))
      return Reflect.apply(end, this, args)
    })
    const request = createRequestDatabaseScope(target.toString())
    const key = JSON.stringify(['task-thread', userId, issues[2]])
    try {
      await request.run(() => withTaskDispatchLock(userId, issues[2], async () => {
        const { rows } = await pool.query(`SELECT a.datname FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid
          WHERE l.locktype='advisory' AND l.granted AND l.objsubid=1
            AND l.classid=((hashtextextended($1,0)>>32)&4294967295)::oid
            AND l.objid=(hashtextextended($1,0)&4294967295)::oid`, [key])
        assert.deepEqual(rows, [{ datname: name }], 'the lock must use the effective request database, never the default')
      }))
      await request.close()
      // Pool.end drops logical owners before their asynchronous socket ends.
      await Promise.all(ended)
      const { rows: [result] } = await pool.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=$1', [name])
      assert.equal(result.n, 0, 'scope shutdown ends its business and derived task-lock connections')
    } finally {
      await request.close()
      await Promise.all(ended)
      observeEnd.mock.restore()
      await pool.query(`DROP DATABASE "${name}"`)
    }
  })
})
