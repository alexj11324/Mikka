import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { disposableDatabase } from './helpers/e2e-target.mjs'

// #560/#499: reads never allocate numbers or lock issue rows; writes allocate
// transactionally from the owner counter without scanning existing issues.
const connection = process.env.E2E_DATABASE_URL
const required = process.env.REQUIRE_DB === '1'
const enabled = disposableDatabase() && process.env.DATABASE_URL === connection
if (required && !enabled) throw new Error('Issue numbering regression requires a loopback *_e2e PG')

test('issue numbering: read-only lists and transactional owner counters', { skip: !enabled, timeout: 120000 }, async (t) => {
  const { db, pool } = await import('../lib/db')
  const { issues } = await import('../lib/db/schema')
  const { allocateIssueNumbers } = await import('../lib/issue-numbering')
  const { readIssueMetadata, withIssueMetadata } = await import('../lib/issue-metadata')
  const user = async () => {
    const id = `numbering-${randomUUID()}`
    await pool.query('insert into "user"(id,name,email,"emailVerified","createdAt","updatedAt") values($1,$1,$2,false,now(),now())', [id, `${id}@example.invalid`])
    return id
  }
  const base = { type: 'doc', content: [] }
  const content = (number?: number) => withIssueMetadata(base, { ...readIssueMetadata(base), ...(number ? { number } : {}) })
  try {
    await t.test('list reads are read-only and hold no issue locks, including missing numbers', async () => {
      const { listIssues, listWorkspaceIssues } = await import('../app/actions/issues')
      const { actAs } = await import('../lib/acting-user')
      const { withDatabaseTransaction } = await import('../lib/db')
      const { seedWorkspace } = await import('./support/workspace-admin-db')
      const { sql } = await import('drizzle-orm')
      const owner = await user()
      const workspace = await seedWorkspace(pool, owner, [{ userId: owner, role: 'admin' }], 'Read-only list fixture')
      const ids = [randomUUID(), randomUUID()]
      // Model a row from a writer that did not use the new allocator. Reading
      // it must leave it alone; historical backfill belongs to the migration.
      await db.insert(issues).values([
        { id: ids[0], userId: owner, title: 'already numbered', content: content(7), status: 'todo', priority: 'normal' },
        { id: ids[1], userId: owner, title: 'missing number', content: content(), status: 'todo', priority: 'normal' },
      ])
      const snapshot = async () => ({
        rows: (await pool.query('SELECT id,content FROM issues WHERE "userId"=$1 ORDER BY id', [owner])).rows,
        counter: (await pool.query('SELECT "lastIssueNumber" FROM "user" WHERE id=$1', [owner])).rows[0],
      })
      const before = await snapshot()
      for (const explicitWorkspace of [false, true, false]) {
        let ready!: () => void, failed!: (error: unknown) => void, release!: () => void
        const listed = new Promise<void>((resolve, reject) => { ready = resolve; failed = reject })
        const held = new Promise<void>(resolve => { release = resolve })
        const read = db.transaction(async tx => {
          await tx.execute(sql`SET TRANSACTION READ ONLY`)
          const result = await withDatabaseTransaction(tx, () => actAs(owner, () => explicitWorkspace ? listWorkspaceIssues(workspace.id) : listIssues()))
          assert.deepEqual(new Set(result.map(row => row.id)), new Set(ids))
          assert.equal(result.find(row => row.id === ids[1])?.metadata.number, undefined)
          ready()
          await held // The request transaction remains in flight during NOWAIT.
        })
        void read.catch(failed)
        const writer = await pool.connect()
        try {
          await listed
          await writer.query('BEGIN')
          await writer.query('SELECT id FROM issues WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE NOWAIT', [ids])
          await writer.query('ROLLBACK')
          if (!explicitWorkspace) {
            const { updateIssueRelation } = await import('../app/actions/issue-operations')
            const writeRelation = (revision: number, remove: boolean) => db.transaction(async tx => {
              await tx.execute(sql`SET LOCAL lock_timeout = '1s'`)
              return withDatabaseTransaction(tx, () => actAs(owner, () => updateIssueRelation({ id: ids[0], revision, targetId: ids[1], kind: 'related', remove })))
            })
            const revision = Number((await pool.query('SELECT revision FROM issues WHERE id=$1', [ids[0]])).rows[0].revision)
            const added = await writeRelation(revision, false)
            assert.ok('issue' in added, `relation edit must complete while list transaction is held: ${JSON.stringify(added)}`)
            const removed = await writeRelation(added.issue.revision, true)
            assert.ok('issue' in removed, `relation removal must complete while list transaction is held: ${JSON.stringify(removed)}`)
          }
        } finally {
          await writer.query('ROLLBACK').catch(() => {})
          writer.release()
          release()
          await read
        }
      }
      assert.deepEqual(await snapshot(), before, 'list reads must not change metadata or reserve unused numbers')
    })

    await t.test('the counter owner lock remains compatible with FK KEY SHARE', async () => {
      const owner = await user()
      const holder = await pool.connect()
      try {
        await holder.query('BEGIN')
        await holder.query('SELECT id FROM "user" WHERE id=$1 FOR KEY SHARE', [owner])
        assert.equal(await db.transaction(async tx => {
          await tx.execute((await import('drizzle-orm')).sql`SET LOCAL lock_timeout = '1s'`)
          return allocateIssueNumbers(tx, owner)
        }), 1)
      } finally { await holder.query('ROLLBACK'); holder.release() }
    })

    await t.test('concurrent allocations are serialized: numbers are unique and consecutive', async () => {
      const owner = await user()
      const numbers = await Promise.all(Array.from({ length: 8 }, (_, i) => db.transaction(async (tx) => {
        const number = await allocateIssueNumbers(tx, owner)
        await new Promise((r) => setTimeout(r, 20))
        await tx.insert(issues).values({ id: randomUUID(), userId: owner, title: `n${i}`, content: content(number), status: 'todo', priority: 'normal' } as typeof issues.$inferInsert)
        return number
      })))
      assert.deepEqual([...numbers].sort((x, y) => x - y), [1, 2, 3, 4, 5, 6, 7, 8])
    })

    await t.test('a failed creation rolls the counter back with its issue', async () => {
      const owner = await user()
      await assert.rejects(db.transaction(async tx => {
        assert.equal(await allocateIssueNumbers(tx, owner), 1)
        throw new Error('fixture rollback')
      }), /fixture rollback/)
      const number = await db.transaction(async tx => {
        const allocated = await allocateIssueNumbers(tx, owner)
        await tx.insert(issues).values({ id: randomUUID(), userId: owner, title: 'after rollback', content: content(allocated), status: 'todo', priority: 'normal' })
        return allocated
      })
      assert.equal(number, 1)
    })

    await t.test('allocation does not wait for an existing issue row lock', async () => {
      const owner = await user()
      const issueId = randomUUID()
      await db.insert(issues).values({ id: issueId, userId: owner, title: 'locked existing issue', content: content(1), status: 'todo', priority: 'normal' })
      const locked = await pool.connect()
      try {
        await locked.query('BEGIN')
        await locked.query('SELECT id FROM issues WHERE id=$1 FOR UPDATE', [issueId])
        const number = await db.transaction(async tx => {
          await tx.execute((await import('drizzle-orm')).sql`SET LOCAL lock_timeout = '1s'`)
          return allocateIssueNumbers(tx, owner)
        })
        assert.equal(number, 2)
      } finally { await locked.query('ROLLBACK'); locked.release() }
    })

    await t.test('database rejects duplicate owner numbers but permits the same number for another owner', async () => {
      const owner = await user(), peer = await user()
      const insert = (userId: string) => pool.query('INSERT INTO issues(id,"userId",title,content,status,priority) VALUES($1,$2,\'unique fixture\',$3,\'todo\',\'normal\')', [randomUUID(), userId, JSON.stringify(content(1))])
      await insert(owner)
      await assert.rejects(insert(owner), (error: unknown) => (error as { code: string }).code === '23505')
      await insert(peer)
    })
  } finally {
    await pool.end()
    await (await import('../lib/workspace-db')).workspacePool.end()
  }
})

test('counter expand backfills once and synchronizes legacy writers', { skip: !enabled, timeout: 120000 }, async () => {
  const { Pool } = await import('pg')
  const { readFile } = await import('node:fs/promises')
  const admin = new Pool({ connectionString: connection, max: 1 })
  const schema = `counter_${randomUUID().replaceAll('-', '')}`
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: connection, options: `-c search_path=${schema}`, max: 10 })
  const content = (number?: number) => JSON.stringify({ type: 'doc', attrs: { mikka: { ...(number ? { number } : {}), preserved: true } }, content: [] })
  const insert = (owner: string, number?: number) => pool.query('INSERT INTO issues(id,"userId",content) VALUES ($1,$2,$3)', [randomUUID(), owner, content(number)])
  try {
    await pool.query(`CREATE TABLE "user" (id text PRIMARY KEY);
      CREATE TABLE issues (id uuid PRIMARY KEY,"userId" text NOT NULL,content jsonb NOT NULL,"createdAt" timestamptz NOT NULL DEFAULT now());
      INSERT INTO "user" VALUES ('owner'),('peer')`)
    await insert('owner', 7)
    await insert('owner', 12)
    await insert('owner')
    await insert('peer', 7)
    const expand = await readFile(new URL('../drizzle/20261031000250_issue_number_counter_expand.sql', import.meta.url), 'utf8')
    // A single client keeps the migration transaction and its search path together.
    const migration = await pool.connect()
    try { await migration.query(expand) } finally { migration.release() }
    assert.deepEqual((await pool.query('SELECT number FROM issues WHERE "userId"=$1 ORDER BY number', ['owner'])).rows.map(row => Number(row.number)), [7, 12, 13])
    assert.equal((await pool.query('SELECT "lastIssueNumber" FROM "user" WHERE id=$1', ['owner'])).rows[0].lastIssueNumber, '13')
    assert.equal((await pool.query("SELECT bool_and((content #>> '{attrs,mikka,preserved}')::boolean) AS kept FROM issues")).rows[0].kept, true)
    await insert('owner', 14)
    assert.equal((await pool.query('SELECT "lastIssueNumber" FROM "user" WHERE id=$1', ['owner'])).rows[0].lastIssueNumber, '14')
    const numbers = await Promise.all(Array.from({ length: 8 }, async (_, index) => {
      const tx = await pool.connect()
      try {
        await tx.query('BEGIN')
        let number: number
        if (index % 2) {
          await tx.query('SELECT id FROM "user" WHERE id=$1 FOR NO KEY UPDATE', ['owner'])
          number = Number((await tx.query('SELECT coalesce(max(number),0)+1 AS n FROM issues WHERE "userId"=$1', ['owner'])).rows[0].n)
        } else {
          number = Number((await tx.query('UPDATE "user" SET "lastIssueNumber"="lastIssueNumber"+1 WHERE id=$1 RETURNING "lastIssueNumber"', ['owner'])).rows[0].lastIssueNumber)
        }
        await tx.query('INSERT INTO issues(id,"userId",content) VALUES ($1,$2,$3)', [randomUUID(), 'owner', content(number)])
        await tx.query('COMMIT')
        return number
      } catch (error) { await tx.query('ROLLBACK'); throw error } finally { tx.release() }
    }))
    assert.deepEqual(numbers.sort((a, b) => a - b), [15, 16, 17, 18, 19, 20, 21, 22])
    const retry = await pool.connect()
    try { await retry.query(expand) } finally { retry.release() }
    assert.equal((await pool.query('SELECT "lastIssueNumber" FROM "user" WHERE id=$1', ['owner'])).rows[0].lastIssueNumber, '22')
    const unique = await readFile(new URL('../drizzle/20261031000251_issue_owner_number_unique.sql', import.meta.url), 'utf8')
    await pool.query(unique)
    await assert.rejects(insert('owner', 7), (error: unknown) => (error as { code: string }).code === '23505')
    assert.equal((await pool.query('SELECT count(*) FROM issues WHERE "userId"=$1 AND number=7', ['owner'])).rows[0].count, '1')
  } finally {
    await pool.end()
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`)
    await admin.end()
  }
})
