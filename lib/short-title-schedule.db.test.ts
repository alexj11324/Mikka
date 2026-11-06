import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { disposableDatabase } from '../tests/helpers/e2e-target.mjs'

// Production, 2026-11-06: the Coordinator created a task inside its transaction, and the short-title job, run after the
// COMMIT, still saw that transaction as its ambient database. Its first read went to the released writer and failed.
const url = process.env.E2E_DATABASE_URL
if (process.env.CI === 'true' && process.env.GITHUB_ACTIONS === 'true') assert.ok(url, 'CI requires real isolated PostgreSQL')
if (url) assert.ok(disposableDatabase(process.env, url), 'loopback *_e2e only')

let seen: { inTransaction: boolean; read: boolean } | null = null
let finish!: () => void
const finished = new Promise<void>(resolve => { finish = resolve })
mock.module(new URL('./short-title-server.ts', import.meta.url).href, { namedExports: { writeShortTitle: async () => {
  const { db, inDatabaseTransaction } = await import('./db/request-scope')
  const inTransaction = inDatabaseTransaction()
  let read = true
  try { await db.execute(sql`select 1`) } catch { read = false }
  seen = { inTransaction, read }
  finish()
} } })

test('the short-title job runs after COMMIT on its own connection, not on the released writer', { skip: !url, timeout: 30_000 }, async () => {
  const { db, pool, withDatabaseClient } = await import('./db/request-scope')
  const { scheduleShortTitle } = await import('./short-title-schedule')
  const tx = await pool.connect()
  try {
    await tx.query('BEGIN')
    await withDatabaseClient(tx, async () => {
      scheduleShortTitle(db, randomUUID(), 'short-title-fixture')
      await tx.query('COMMIT')
    })
  } finally { tx.release() }
  await finished
  assert.deepEqual(seen, { inTransaction: false, read: true })
})
