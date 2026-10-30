import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { acquireCiMembership } from './authority'

const target = process.env.CI_NOTICE_TEST_PG_URL ?? (process.env.CI === 'true' && process.env.GITHUB_ACTIONS === 'true' ? process.env.E2E_DATABASE_URL : undefined)
if (process.env.REQUIRE_DB === '1' && !target) throw new Error('CI authority database fixture is required')
if (target) { const url = new URL(target); if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hostname !== '127.0.0.1' || (url.port !== '5432' && !(process.env.CI_NOTICE_TEST_PG_URL && url.port === '5433')) || url.pathname !== '/mikka_e2e' || url.search || url.hash) throw new Error('CI notice test requires isolated loopback database') }

test('retained PG: active membership and issue link remain locked across a notice transaction; revoked member is denied', { skip: !target }, async () => {
  const schema = `ci_authority_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: target })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: target, options: `-c search_path=${schema}` })
  const issue = randomUUID(), workspace = randomUUID(), team = randomUUID(), changedWorkspace = randomUUID()
  try {
    await pool.query('CREATE TABLE mikka_teams (id uuid primary key,"workspaceId" uuid not null); CREATE TABLE mikka_team_issues ("issueId" uuid primary key,"workspaceId" uuid not null,"teamId" uuid not null); CREATE TABLE mikka_workspace_members ("workspaceId" uuid,"userId" text,status text,primary key ("workspaceId","userId"))')
    await pool.query('INSERT INTO mikka_teams VALUES ($1,$2)', [team, workspace])
    await pool.query('INSERT INTO mikka_team_issues VALUES ($1,$2,$3)', [issue, workspace, team])
    await pool.query('INSERT INTO mikka_workspace_members VALUES ($1,$2,$3)', [workspace, 'member', 'active'])
    const lease = await acquireCiMembership(issue, 'member', 'owner', pool)
    try {
      const other = await pool.connect()
      try { await other.query('BEGIN'); await other.query("SET LOCAL lock_timeout='100ms'"); await assert.rejects(other.query('UPDATE mikka_workspace_members SET status=$1 WHERE "workspaceId"=$2 AND "userId"=$3', ['suspended', workspace, 'member']), { code: '55P03' }); await other.query('ROLLBACK') } finally { other.release() }
      const competing = await pool.connect()
      try { await competing.query('BEGIN'); await competing.query("SET LOCAL lock_timeout='100ms'"); await assert.rejects(competing.query('UPDATE mikka_teams SET "workspaceId"=$1 WHERE id=$2', [changedWorkspace,team]), { code: '55P03' }); await competing.query('ROLLBACK') } finally { competing.release() }
      await lease.check()
    } finally { await lease.close() }
    await pool.query('UPDATE mikka_teams SET "workspaceId"=$1 WHERE id=$2', [changedWorkspace,team])
    await assert.rejects(acquireCiMembership(issue, 'member', 'owner', pool), /authority unavailable/)
    await pool.query('UPDATE mikka_teams SET "workspaceId"=$1 WHERE id=$2', [workspace,team])
    await pool.query('UPDATE mikka_workspace_members SET status=$1 WHERE "workspaceId"=$2 AND "userId"=$3', ['suspended', workspace, 'member'])
    await assert.rejects(acquireCiMembership(issue, 'member', 'owner', pool), /authority unavailable/)
    console.log(`Retained synthetic CI authority schema: ${schema}`)
  } finally { await pool.end(); await admin.end() }
})
