import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

// Regression for the page-load backfill deadlock (#451): the owner-row lock taken by
// issue numbering must not conflict with FK KEY SHARE locks, yet must still serialize allocators.
const connection = process.env.E2E_DATABASE_URL
const required = process.env.REQUIRE_DB === '1'
const ci = process.env.CI === 'true' && process.env.GITHUB_ACTIONS === 'true'
let enabled = false
if (connection) {
  const url = new URL(connection)
  enabled = ['postgres:', 'postgresql:'].includes(url.protocol) && url.hostname === '127.0.0.1' &&
    /^\/[A-Za-z0-9_]+_e2e$/.test(url.pathname) && !url.search && !url.hash && process.env.DATABASE_URL === connection &&
    (ci ? url.port === '5432' && url.pathname === '/mikka_e2e' : true)
}
if (required && !enabled) throw new Error('Issue numbering regression requires a loopback *_e2e PG')

test('issue numbering: no deadlock with FK KEY SHARE; concurrent numbers unique and consecutive', { skip: !enabled, timeout: 120000 }, async (t) => {
  const { db, pool } = await import('../lib/db')
  const { issues } = await import('../lib/db/schema')
  const { allocateIssueNumbers, ensureIssueNumbers } = await import('../lib/issue-numbering')
  const { readIssueMetadata, withIssueMetadata } = await import('../lib/issue-metadata')
  const { eq } = await import('drizzle-orm')
  const user = async () => {
    const id = `numbering-${randomUUID()}`
    await pool.query('insert into "user"(id,name,email,"emailVerified","createdAt","updatedAt") values($1,$1,$2,false,now(),now())', [id, `${id}@example.invalid`])
    return id
  }
  const base = { type: 'doc', content: [] }
  const content = (number?: number) => withIssueMetadata(base, { ...readIssueMetadata(base), ...(number ? { number } : {}) })
  try {
    await t.test('holder of an issue lock can take KEY SHARE on the owner during a backfill', async () => {
      const owner = await user()
      const issueId = randomUUID()
      await db.insert(issues).values({ id: issueId, userId: owner, title: 'unnumbered', content: content(), status: 'todo', priority: 'normal' } as typeof issues.$inferInsert)
      const a = await pool.connect()
      try {
        await a.query('begin')
        await a.query("set local lock_timeout = '5s'")
        await a.query('select id from issues where id=$1 for update', [issueId])
        const backfill = ensureIssueNumbers(owner) // owner lock, then waits on the issue row A holds
        await new Promise((r) => setTimeout(r, 500))
        // What an FK insert referencing "user" takes. Under FOR UPDATE on the owner this deadlocks.
        await a.query('select id from "user" where id=$1 for key share', [owner])
        await a.query('commit')
        assert.equal(await backfill, 2)
      } catch (error) {
        await a.query('rollback').catch(() => {})
        throw error
      } finally {
        a.release()
      }
      const [row] = await db.select().from(issues).where(eq(issues.id, issueId))
      assert.equal(readIssueMetadata(row.content).number, 1)
      assert.equal(await ensureIssueNumbers(owner), 2)
      assert.equal(await ensureIssueNumbers(owner), 2, 'page reads must not reserve unused numbers')
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
    const expand = await readFile(new URL('../drizzle/20261030203400_issue_number_counter_expand.sql', import.meta.url), 'utf8')
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
    const unique = await readFile(new URL('../drizzle/20261030203401_issue_owner_number_unique.sql', import.meta.url), 'utf8')
    await pool.query(unique)
    await assert.rejects(insert('owner', 7), (error: unknown) => (error as { code: string }).code === '23505')
    assert.equal((await pool.query('SELECT count(*) FROM issues WHERE "userId"=$1 AND number=7', ['owner'])).rows[0].count, '1')
  } finally {
    await pool.end()
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`)
    await admin.end()
  }
})
