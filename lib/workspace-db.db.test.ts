import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { Pool } from 'pg'
import { sql } from 'drizzle-orm'
import { disposableDatabase } from '../tests/helpers/e2e-target.mjs'
import { afterDatabaseCommit, COMMIT_EXECUTOR } from './db/commit-effects'

const url = process.env.E2E_DATABASE_URL
if (process.env.REQUIRE_DB === '1') assert.ok(url, 'workspace transaction regression requires PostgreSQL')
if (url) assert.ok(disposableDatabase(process.env, url), 'loopback *_e2e only')

test('workspace transactions reuse one checkout, roll back savepoints, and release their async lease before commit effects', { skip: !url, timeout: 60_000 }, async t => {
  const admin = new Pool({ connectionString: url, max: 2 })
  const name = `workspace_tx_${randomUUID().replaceAll('-', '')}`
  await admin.query(`CREATE SCHEMA "${name}"`)
  // One connection makes a nested checkout fail deterministically instead of
  // relying on ten requests happening to exhaust a larger pool together.
  const backing = new Pool({ connectionString: url, options: `-c search_path=${name}`, max: 1, connectionTimeoutMillis: 2_000 })
  const globals = globalThis as unknown as { workspacePool?: Pool }
  const previous = globals.workspacePool
  globals.workspacePool = backing
  try {
    await backing.query('CREATE TABLE transaction_fixture (label text PRIMARY KEY)')
    const { workspaceDb, workspacePool } = await import('./workspace-db')
    let acquisitions = 0
    backing.on('acquire', () => { acquisitions++ })
    const rows = async () => (await admin.query<{ label: string }>(`SELECT label FROM "${name}".transaction_fixture ORDER BY label`)).rows.map(row => row.label)
    const rawRows = async () => (await workspacePool.query<{ label: string }>('SELECT label FROM transaction_fixture ORDER BY label')).rows.map(row => row.label)

    await t.test('raw reads and nested Drizzle transactions share the outer client; only committed savepoint effects survive', async () => {
      const effects: string[] = []
      const before = acquisitions
      await workspaceDb.transaction(async outer => {
        const pid = (await workspacePool.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid
        await outer.execute(sql`INSERT INTO transaction_fixture VALUES ('outer')`)
        assert.deepEqual(await rows(), [], 'a separate connection cannot see the uncommitted write')
        assert.deepEqual(await rawRows(), ['outer'], 'raw workspace reads see the transaction\'s own write without another checkout')
        afterDatabaseCommit(workspacePool, 'replace', () => { effects.push('outer') })
        await assert.rejects(workspaceDb.transaction(async inner => {
          await workspaceDb.execute(sql`INSERT INTO transaction_fixture VALUES ('reverted')`)
          assert.equal((await inner.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`)).rows[0].pid, pid)
          afterDatabaseCommit(workspaceDb, 'replace', () => { effects.push('reverted replacement') })
          afterDatabaseCommit(inner, 'discard', () => { effects.push('reverted only') })
          throw new Error('nested fixture rollback')
        }), /nested fixture rollback/)
        assert.deepEqual(await rawRows(), ['outer'])
        await workspaceDb.transaction(async inner => {
          await inner.execute(sql`INSERT INTO transaction_fixture VALUES ('nested')`)
          assert.equal((await workspacePool.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid, pid)
          afterDatabaseCommit(inner, 'nested', () => { effects.push('nested') })
        })
        assert.deepEqual(effects, [], 'releasing an inner savepoint does not publish before the outer COMMIT')
        assert.deepEqual(await rows(), [])
      })
      assert.equal(acquisitions - before, 1, 'composed actions use one checked-out connection')
      assert.deepEqual(effects, ['outer', 'nested'])
      assert.deepEqual(await rows(), ['nested', 'outer'])
      await assert.rejects(workspaceDb.transaction(async () => {
        await workspacePool.query(`INSERT INTO transaction_fixture VALUES ('outer rollback')`)
        afterDatabaseCommit(workspacePool, 'rollback', () => { effects.push('outer rollback') })
        throw new Error('outer fixture rollback')
      }), /outer fixture rollback/)
      assert.deepEqual(effects, ['outer', 'nested'])
      assert.deepEqual(await rows(), ['nested', 'outer'])
    })

    await t.test('an immediate after-commit effect starts a fresh transaction instead of a savepoint on the committed client', async () => {
      let effect: Promise<void> | undefined
      let writerTransaction: string | undefined
      const before = acquisitions
      await workspaceDb.transaction(async writer => {
        writerTransaction = (await writer.execute<{ id: string }>(sql`SELECT txid_current()::text AS id`)).rows[0].id
        await writer.execute(sql`INSERT INTO transaction_fixture VALUES ('before effect')`)
        afterDatabaseCommit(workspaceDb, 'fresh transaction', () => {
          // Commit observers invoke this before Drizzle's transaction promise
          // resolves, while the original callback's ALS context is retained.
          effect = (async () => {
            assert.equal((workspacePool as unknown as { [COMMIT_EXECUTOR]: object })[COMMIT_EXECUTOR], backing)
            await workspaceDb.transaction(async fresh => {
              const id = (await fresh.execute<{ id: string }>(sql`SELECT txid_current()::text AS id`)).rows[0].id
              assert.notEqual(id, writerTransaction)
              assert.ok((await rawRows()).includes('before effect'))
              await fresh.execute(sql`INSERT INTO transaction_fixture VALUES ('after effect')`)
            })
          })()
          return effect
        })
      })
      assert.ok(effect, 'the observed COMMIT invokes its effect')
      await effect
      assert.equal(acquisitions - before, 2, 'the effect obtains its own lease even with a one-connection pool')
      assert.deepEqual(await rows(), ['after effect', 'before effect', 'nested', 'outer'])
    })

    await t.test('a committed live notification starts independently while the workspace writer still holds its transaction', async () => {
      const { scheduleLive } = await import('./live/notify')
      const { workspaceTransactionKey } = await import('./workspace-db')
      const entered = Promise.withResolvers<object | null>()
      const completed = Promise.withResolvers<string>()
      let writerTransaction: string | undefined
      let borrowed: object | null = null
      await workspaceDb.transaction(async writer => {
        writerTransaction = (await writer.execute<{ id: string }>(sql`SELECT txid_current()::text AS id`)).rows[0].id
        scheduleLive(async () => {
          entered.resolve(workspaceTransactionKey())
          try {
            const id = await workspaceDb.transaction(async job =>
              (await job.execute<{ id: string }>(sql`SELECT txid_current()::text AS id`)).rows[0].id)
            completed.resolve(id)
          } catch (error) { completed.reject(error) }
        })
        borrowed = await entered.promise
        // A regressed job can finish its nested query before the writer releases
        // the client, so the assertion reports the borrowed transaction cleanly.
        if (borrowed) await completed.promise
      })
      assert.equal(borrowed, null, 'live work must never borrow the still-active writer transaction')
      assert.notEqual(await completed.promise, writerTransaction)
    })

    await t.test('a delayed callback cannot read through a released client currently borrowed by another transaction', async () => {
      let delayed!: () => Promise<string[]>
      await workspaceDb.transaction(async () => {
        delayed = AsyncLocalStorage.bind(rawRows)
      })
      const borrower = await backing.connect()
      let reading: Promise<string[]> | undefined
      try {
        await borrower.query('BEGIN')
        await borrower.query(`INSERT INTO transaction_fixture VALUES ('another transaction private row')`)
        reading = delayed()
        assert.equal(backing.waitingCount, 1, 'the stale async scope waits for a new checkout instead of reusing the released client')
      } finally {
        await borrower.query('ROLLBACK')
        borrower.release()
      }
      assert.ok(reading)
      assert.deepEqual(await reading, ['after effect', 'before effect', 'nested', 'outer'])
    })
  } finally {
    globals.workspacePool = previous
    await backing.end()
    await admin.query(`DROP SCHEMA "${name}" CASCADE`)
    await admin.end()
  }
})
