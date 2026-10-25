import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { configureMigrationSession } from './migration-session.mjs'

test('migration connection has bounded lock/statement waits and leaves other sessions unchanged', {skip: !process.env.MIGRATION_TEST_DATABASE_URL, timeout: 15000}, async () => {
  const url=new URL(process.env.MIGRATION_TEST_DATABASE_URL)
  assert.equal(url.hostname,'127.0.0.1'); assert.equal(url.pathname,'/mikka_208_test')
  const pool=new Pool({connectionString:url.toString(),max:2})
  const blocker=await pool.connect(), migration=await pool.connect()
  const table=`migration_timeout_${randomUUID().replaceAll('-','')}`
  try {
    const prior=(await blocker.query('SHOW lock_timeout')).rows[0].lock_timeout
    await configureMigrationSession(migration)
    assert.equal((await migration.query('SHOW lock_timeout')).rows[0].lock_timeout,'5s')
    assert.equal((await migration.query('SHOW statement_timeout')).rows[0].statement_timeout,'1min')
    await blocker.query(`CREATE TABLE ${table}(id integer)`)
    await blocker.query('BEGIN')
    await blocker.query(`LOCK TABLE ${table} IN ACCESS EXCLUSIVE MODE`)
    await assert.rejects(migration.query(`ALTER TABLE ${table} ADD COLUMN forbidden integer`),error=>error.code==='55P03')
    await blocker.query('COMMIT')
    assert.equal((await migration.query('SELECT 1 FROM information_schema.columns WHERE table_name=$1 AND column_name=$2',[table,'forbidden'])).rowCount,0)
    assert.equal((await blocker.query('SHOW lock_timeout')).rows[0].lock_timeout,prior)
    // Exercise statement cancellation without a minute-long fixture sleep.
    await migration.query("SET statement_timeout='50ms'")
    await assert.rejects(migration.query('SELECT pg_sleep(1)'),error=>error.code==='57014')
    await configureMigrationSession(migration)
    assert.equal((await migration.query('SHOW statement_timeout')).rows[0].statement_timeout,'1min')
  } finally {
    await blocker.query('ROLLBACK'); blocker.release(true); migration.release(true); await pool.end()
  }
})
