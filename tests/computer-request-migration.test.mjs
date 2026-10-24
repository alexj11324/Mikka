import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { Pool } from 'pg'

// Intentionally not runnable against any developer/production database.
test('workspace CUA migration is additive, idempotent, scoped, and admits one atomic claim', async () => {
  assert.equal(process.env.CI, 'true', 'Database tests run only in CI')
  const target = new URL(process.env.E2E_DATABASE_URL)
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) && target.pathname === '/mikka_e2e', 'Requires the existing CI Postgres 17 service')
  const pool = new Pool({ connectionString: target.toString(), max: 1 })
  const client = await pool.connect()
  try {
    await client.query('begin')
    const schema = `computer_migration_${randomUUID().replaceAll('-', '')}`
    await client.query(`create schema "${schema}"`)
    await client.query(`set local search_path to "${schema}"`)
    await client.query('create table mikka_workspaces (id uuid primary key)')
    const migration = await readFile(new URL('../drizzle/20261023185539_computer_requests.sql', import.meta.url), 'utf8')
    await client.query(migration)
    await client.query(migration)
    const workspace = randomUUID(), session = randomUUID(), id = randomUUID()
    await client.query('insert into mikka_workspaces values ($1)', [workspace])
    await client.query('insert into agent_settings ("workspaceId", "updatedBy") values ($1, $2)', [workspace, 'owner'])
    assert.deepEqual((await client.query('select permissions from agent_settings')).rows[0].permissions, {})
    await client.query(`insert into computer_requests (id, "workspaceId", "userId", "sessionId", target, operation, "expiresAt") values ($1, $2, 'owner', $3, 'endpoint-hash', '{"tool":"screenshot"}', now() + interval '5 minutes')`, [id, workspace, session])
    const claim = (owner = 'owner', requestSession = session, target = 'endpoint-hash') => client.query(`update computer_requests set status='executing' where id=$1 and "userId"=$2 and "sessionId"=$3 and target=$4 and status='pending' and "expiresAt">now() returning id`, [id, owner, requestSession, target])
    assert.equal((await claim('other')).rowCount, 0)
    assert.equal((await claim('owner', randomUUID())).rowCount, 0)
    assert.equal((await claim('owner', session, 'rotated')).rowCount, 0)
    assert.equal((await claim()).rowCount, 1)
    assert.equal((await claim()).rowCount, 0)
    // Endpoint token/screenshots have no columns; actual operation only.
    assert.equal((await client.query(`select column_name from information_schema.columns where table_schema=$1 and table_name='computer_requests' and column_name in ('token', 'screenshot', 'credentials')`, [schema])).rowCount, 0)
    await client.query('delete from mikka_workspaces where id=$1', [workspace])
    assert.equal((await client.query('select id from computer_requests')).rowCount, 0)
  } finally {
    await client.query('rollback')
    client.release()
    await pool.end()
  }
})
