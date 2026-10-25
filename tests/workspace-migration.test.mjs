import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { Pool } from 'pg'

test('legacy workspaces upgrade twice without losing data or team constraints', async () => {
  const target = new URL(process.env.E2E_DATABASE_URL)
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) && target.pathname.endsWith('_e2e'), 'Requires the isolated CI database')
  const pool = new Pool({ connectionString: target.toString(), max: 1 })
  const client = await pool.connect()
  try {
    await client.query('begin')
    const schema = `workspace_migration_${randomUUID().replaceAll('-', '')}`
    await client.query(`create schema "${schema}"`)
    await client.query(`set local search_path to "${schema}"`)
    await client.query('create table mikka_workspaces (id uuid primary key, "userId" text not null unique, name varchar(120) not null)')
    const first = randomUUID()
    await client.query('insert into mikka_workspaces values ($1, $2, $3)', [first, 'owner', 'Existing workspace'])
    const migration = await readFile(new URL('../drizzle/0014_workspace_teams.sql', import.meta.url), 'utf8')
    const rename = await readFile(new URL('../drizzle/20261025005500_mikka_team_tables.sql', import.meta.url), 'utf8')
    await client.query(migration)
    await client.query(migration)
    await client.query(rename)
    await client.query(rename)
    assert.deepEqual((await client.query('select name, slug from mikka_workspaces where id = $1', [first])).rows, [{ name: 'Existing workspace', slug: null }])
    const second = randomUUID()
    await client.query('insert into mikka_workspaces (id, "userId", name, slug) values ($1, $2, $3, $4)', [second, 'owner', 'Second workspace', 'second-workspace'])
    await client.query('savepoint duplicate_slug')
    await assert.rejects(client.query('insert into mikka_workspaces (id, "userId", name, slug) values ($1, $2, $3, $4)', [randomUUID(), 'other', 'Duplicate', 'second-workspace']), { code: '23505' })
    await client.query('rollback to savepoint duplicate_slug')
    const team = randomUUID()
    await client.query('insert into mikka_teams (id, "workspaceId", "userId", name, identifier) values ($1, $2, $3, $4, $5)', [team, second, 'owner', 'Engineering', 'ENG'])
    await client.query('insert into mikka_team_members ("teamId", "userId", role) values ($1, $2, $3)', [team, 'owner', 'owner'])
    await client.query('insert into mikka_team_issues ("issueId", "teamId", "workspaceId", "userId") values ($1, $2, $3, $4)', [randomUUID(), team, second, 'owner'])
    await client.query('insert into mikka_team_projects ("projectId", "teamId", "workspaceId", "userId", "isPrimary") values ($1, $2, $3, $4, true)', [randomUUID(), team, second, 'owner'])
    await client.query('savepoint duplicate_team')
    await assert.rejects(client.query('insert into mikka_teams (id, "workspaceId", "userId", name, identifier) values ($1, $2, $3, $4, $5)', [randomUUID(), second, 'owner', 'Duplicate', 'ENG']), { code: '23505' })
  } finally {
    await client.query('rollback')
    client.release()
    await pool.end()
  }
})
