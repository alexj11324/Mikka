// Required suite: executes only in the shared GitHub Actions ephemeral PG17 service.
import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { applyMigration, planMigration } from '../scripts/migration-steps.mjs'
import { validateTarget } from '../scripts/run-db-tests.mjs'

// Fail closed even when accidentally invoked locally, before importing/connecting pg.
validateTarget(process.env)
const { Client } = await import('pg')
const NOTX = '-- migrate: no-transaction\n'

test('PG17: nontransactional indexes, invalid retry, ledger and separate validation', async (t) => {
  const client = new Client({ connectionString: process.env.E2E_DATABASE_URL })
  await client.connect()
  const version = Number((await client.query('show server_version_num')).rows[0].server_version_num)
  assert.ok(version >= 170000 && version < 180000, 'Requires PostgreSQL 17')
  const schema = `migration_steps_${randomUUID().replaceAll('-', '')}`
  t.after(async () => {
    try { await client.query('reset search_path'); await client.query(`drop schema if exists ${schema} cascade`) }
    finally { await client.end() }
  })
  await client.query(`create schema ${schema}; set search_path to ${schema}`)
  await client.query('create table schema_migrations (name text primary key); create table t (a int); insert into t values (1), (1)')
  const recorded = async () => (await client.query('select name from schema_migrations order by name')).rows.map(r => r.name)
  const apply = (name, sql, log) => applyMigration(client, name, planMigration(name, sql), log)

  // A normal multi-statement file still executes atomically as one query.
  await assert.rejects(apply('rollback.sql', 'create table rolled_back (id int); select 1/0;'), { code: '22012' })
  assert.equal((await client.query("select to_regclass('rolled_back') as name")).rows[0].name, null)
  assert.deepEqual(await recorded(), [])

  const ok = `${NOTX}create index concurrently if not exists Ok_Idx on t (a)`
  await apply('ok.sql', ok)
  assert.deepEqual(await recorded(), ['ok.sql'], 'successful concurrent index is outside implicit transaction and recorded')
  const dup = `${NOTX}create unique index concurrently if not exists u_idx on t (a)`
  const hints = []
  await assert.rejects(apply('dup.sql', dup, message => hints.push(message)), { code: '23505' })
  assert.match(hints.join('\n'), /u_idx is INVALID.*DROP INDEX CONCURRENTLY/)
  await assert.rejects(apply('dup.sql', dup), /u_idx is INVALID.*not recorded/)
  assert.deepEqual(await recorded(), ['ok.sql'], 'INVALID retry never enters ledger')
  await client.query('drop index concurrently u_idx')
  await client.query('delete from t; insert into t values (1), (2)')
  await apply('dup.sql', dup)
  assert.deepEqual(await recorded(), ['dup.sql', 'ok.sql'])

  // General no-transaction statements are supported, not just concurrent indexes.
  await apply('constraint.sql', `${NOTX}alter table t add constraint positive check (a > 0) not valid`)
  // A second session can validate after the ADD query returns: its table lock was
  // released. First prove this assertion would fail while an exclusive lock is held.
  const other = new Client({ connectionString: process.env.E2E_DATABASE_URL })
  await other.connect()
  t.after(async () => { await other.end() })
  await other.query(`set search_path to ${schema}`)
  await other.query("set lock_timeout = '500ms'")
  const validation = planMigration('validate.sql', `${NOTX}alter table t validate constraint positive`)
  await client.query('begin; lock table t in access exclusive mode')
  try {
    await assert.rejects(applyMigration(other, 'validate.sql', validation), { code: '55P03' })
    assert.deepEqual(await recorded(), ['constraint.sql', 'dup.sql', 'ok.sql'])
  } finally { await client.query('rollback') }
  await applyMigration(other, 'validate.sql', validation)
  assert.equal((await client.query("select convalidated from pg_constraint where conrelid='t'::regclass and conname='positive'")).rows[0].convalidated, true)
  assert.deepEqual(await recorded(), ['constraint.sql', 'dup.sql', 'ok.sql', 'validate.sql'])
})
