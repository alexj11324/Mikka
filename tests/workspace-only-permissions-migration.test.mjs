import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { Pool } from 'pg'
import { isE2eTarget, E2E_DB_RULE } from './helpers/e2e-target.mjs'

const sql = name => readFile(new URL(`../drizzle/${name}`, import.meta.url), 'utf8')
const BASE_MIGRATIONS = [
  '20261027164515_workspace_computer_policy.sql',
  '20261029010447_workspace_computer_policy_allow.sql',
  '20261027181000_agent_kit.sql',
  '20261029011701_cli_run_policy.sql',
  '20261029043646_agent_external_write_policy.sql',
  '20261029043647_workspace_external_write_policy.sql',
  '20261030204751_workspace_computer_policy_default_allow.sql',
  '20261101140000_coordinator_bots.sql',
]
const NEW_MIGRATIONS = [
  '20261110230000_workspace_only_app_permissions.sql',
  '20261110230001_retire_worker_run_policy.sql',
]
const BASE_SCHEMA = `
  create table "user"(id text primary key);
  create table bots(id uuid primary key, "workspaceId" uuid not null, "ownerId" text not null, unique(id,"workspaceId","ownerId"));
  create table agents(id uuid primary key, "userId" text not null, "deviceId" uuid);
  create table agent_runs(id uuid primary key, "agentId" uuid not null, "workspaceId" uuid);
  create table agent_tool_approvals(id uuid primary key);
`

const target = process.env.E2E_DATABASE_URL ? new URL(process.env.E2E_DATABASE_URL) : null
const enabled = Boolean(target) && ['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) && isE2eTarget(target.href)
const pool = enabled ? new Pool({ connectionString: target.toString(), max: 1 }) : null

async function withSchema(fn) {
  const client = await pool.connect()
  const schema = `workspace_only_${randomUUID().replaceAll('-', '')}`
  try {
    await client.query(`create schema "${schema}"`)
    await client.query(`set search_path to "${schema}"`)
    await client.query(BASE_SCHEMA)
    for (const name of BASE_MIGRATIONS) await client.query(await sql(name))
    return await fn(client)
  } finally {
    try { await client.query('rollback') } catch {}
    try { await client.query('reset search_path') } catch {}
    try { await client.query(`drop schema if exists "${schema}" cascade`) } catch {}
    client.release()
  }
}

const id = () => randomUUID()
async function owner(client, ownerId = 'owner') {
  await client.query('insert into "user"(id) values ($1)', [ownerId])
  return ownerId
}
async function bot(client, workspaceId, ownerId = 'owner') {
  const botId = id()
  await client.query('insert into bots(id,"workspaceId","ownerId") values ($1,$2,$3)', [botId, workspaceId, ownerId])
  return botId
}
async function head(client, { ownerId = 'owner', botId = null, workspaceId = null, external = {}, cli = {} }) {
  await client.query(`insert into agent_kit_heads(owner_id,bot_key,bot_id,workspace_id,external_write_permissions,cli_run_policy)
    values ($1,$2,$3,$4,$5,$6)`, [ownerId, botId ?? 'coordinator', botId, workspaceId, external, cli])
}
async function workspace(client, workspaceId, external = {}, cli = {}) {
  await client.query(`insert into workspace_computer_policies("workspaceId",permission,external_write_permissions,external_write_policy_version,cli_run_policy)
    values ($1,'allow',$2,case when $2::jsonb='{}'::jsonb then 0 else 1 end,$3)`, [workspaceId, external, cli])
}
async function worker(client, ownerId = 'owner') {
  const agentId = id()
  await client.query('insert into agents(id,"userId") values ($1,$2)', [agentId, ownerId])
  return agentId
}
async function running(client, agentId, workspaceId) {
  const runId = id()
  await client.query('insert into agent_runs(id,"agentId","workspaceId") values ($1,$2,$3)', [runId, agentId, workspaceId])
  return runId
}
async function fold(client) {
  for (const name of NEW_MIGRATIONS) await client.query(await sql(name))
  // A second pass must be a no-op on every value and version.
  for (const name of NEW_MIGRATIONS) await client.query(await sql(name))
}
const external = async (client, workspaceId) => (await client.query('select external_write_permissions,external_write_policy_version from workspace_computer_policies where "workspaceId"=$1', [workspaceId])).rows[0]
const cli = async (client, workspaceId) => (await client.query('select cli_run_policy,cli_run_policy_version from workspace_computer_policies where "workspaceId"=$1', [workspaceId])).rows[0]

test('external and CLI restrictions fold into the workspace, never an allow; the fold is idempotent', { skip: !enabled }, async () => {
  assert.ok(isE2eTarget(target.href), E2E_DB_RULE)
  await withSchema(async client => {
    await owner(client)
    const w1 = id(), w2 = id(), w3 = id(), w4 = id(), w5 = id(), w6 = id(), w7a = id(), w7b = id(), w8 = id(), w9 = id()
    const b1 = await bot(client, w1), b2 = await bot(client, w1)
    await head(client, { botId: b1, workspaceId: w1, external: { slack: 'deny' } })
    await head(client, { botId: b2, workspaceId: w1, external: { slack: 'ask' } })
    await head(client, { botId: await bot(client, w2), workspaceId: w2, external: { slack: 'ask' } })
    await head(client, { botId: await bot(client, w3), workspaceId: w3, external: { slack: 'allow' } })
    await workspace(client, w4, { slack: 'allow' })
    await head(client, { botId: await bot(client, w4), workspaceId: w4, external: { slack: 'deny' } })
    await workspace(client, w5, { slack: 'deny' })
    await head(client, { botId: await bot(client, w5), workspaceId: w5, external: { slack: 'ask' } })
    await workspace(client, w6, { slack: 'ask' })
    await head(client, { botId: await bot(client, w6), workspaceId: w6, external: { slack: 'allow' } })
    await head(client, { botId: await bot(client, w7a), workspaceId: w7a, external: { slack: 'deny' } })
    await head(client, { botId: await bot(client, w7b), workspaceId: w7b, external: { slack: 'ask' } })
    await head(client, { botId: await bot(client, w8), workspaceId: w8, external: { slack: 'deny' } })
    await workspace(client, w9, { slack: 'allow' })
    await head(client, { botId: await bot(client, w9), workspaceId: w9, external: { slack: 'ask' } })
    // Keys that must not be folded: a browser ask, a normalized git_push ask,
    // and the retired pull-request key.
    const skipped = id()
    await head(client, { botId: await bot(client, skipped), workspaceId: skipped, external: { browser_payment: 'ask', git_push: 'ask', github_pull_request: 'deny' } })

    await fold(client)

    assert.deepEqual(await external(client, w1), { external_write_permissions: { slack: 'deny' }, external_write_policy_version: 1 })
    assert.deepEqual(await external(client, w2), { external_write_permissions: { slack: 'ask' }, external_write_policy_version: 1 })
    assert.equal(await external(client, w3), undefined, 'a Bot allow and no workspace value create no row')
    assert.deepEqual(await external(client, w4), { external_write_permissions: { slack: 'deny' }, external_write_policy_version: 2 })
    assert.deepEqual(await external(client, w5), { external_write_permissions: { slack: 'deny' }, external_write_policy_version: 1 })
    assert.deepEqual(await external(client, w6), { external_write_permissions: { slack: 'ask' }, external_write_policy_version: 1 })
    assert.deepEqual(await external(client, w7a), { external_write_permissions: { slack: 'deny' }, external_write_policy_version: 1 })
    assert.deepEqual(await external(client, w7b), { external_write_permissions: { slack: 'ask' }, external_write_policy_version: 1 })
    assert.deepEqual(await external(client, w8), { external_write_permissions: { slack: 'deny' }, external_write_policy_version: 1 })
    assert.deepEqual(await external(client, w9), { external_write_permissions: { slack: 'ask' }, external_write_policy_version: 2 }, 'a second pass does not bump the version again')
    assert.equal(await external(client, skipped), undefined)
    assert.deepEqual((await client.query('select external_write_permissions from agent_kit_heads where workspace_id is not null and external_write_permissions <> \'{}\'::jsonb')).rows, [])

    // CLI: permissions are restrictive, network intersects, read_only wins, defaults stay.
    const w10 = id(), w11 = id(), w12 = id(), w13 = id(), w14 = id()
    await head(client, { botId: await bot(client, w10), workspaceId: w10, cli: { networkAllow: ['a.com', 'b.com'] } })
    await head(client, { botId: await bot(client, w10), workspaceId: w10, cli: { networkAllow: ['b.com'] } })
    await head(client, { botId: await bot(client, w11), workspaceId: w11, cli: { networkAllow: [] } })
    await head(client, { botId: await bot(client, w11), workspaceId: w11, cli: { networkAllow: ['a.com'] } })
    await head(client, { botId: await bot(client, w12), workspaceId: w12, cli: { approvalMode: 'read_only' } })
    await workspace(client, w13, {}, { defaults: { permissions: { network: 'allow' } }, permissions: { install_dependency: 'deny' } })
    await head(client, { botId: await bot(client, w13), workspaceId: w13, cli: { permissions: { network: 'ask' } } })
    await head(client, { botId: await bot(client, w14), workspaceId: w14, cli: { permissions: { install_dependency: 'deny', git_push: 'deny' } } })

    await fold(client)

    assert.deepEqual((await cli(client, w10)).cli_run_policy, { networkAllow: ['b.com'] })
    assert.deepEqual((await cli(client, w11)).cli_run_policy, { networkAllow: [] })
    assert.deepEqual((await cli(client, w12)).cli_run_policy, { approvalMode: 'read_only' })
    assert.deepEqual((await cli(client, w13)).cli_run_policy, {
      permissions: { install_dependency: 'deny', network: 'ask' },
      defaults: { permissions: { network: 'allow' } },
    })
    assert.deepEqual((await cli(client, w14)).cli_run_policy, { permissions: { install_dependency: 'deny', git_push: 'deny' } })
    assert.deepEqual((await client.query('select cli_run_policy from agent_kit_heads where workspace_id is not null and cli_run_policy <> \'{}\'::jsonb')).rows, [])
  })
})

test('a legacy owner head folds into every coordinator workspace and is not cleared', { skip: !enabled }, async () => {
  await withSchema(async client => {
    await owner(client, 'legacy-owner')
    const a = id(), b = id()
    const botA = await bot(client, a, 'legacy-owner'), botB = await bot(client, b, 'legacy-owner')
    await client.query('insert into coordinator_bots("ownerId","workspaceId","botId") values ($1,$2,$3),($1,$4,$5)', ['legacy-owner', a, botA, b, botB])
    await head(client, { ownerId: 'legacy-owner', external: { slack: 'deny' }, cli: { permissions: { git_push: 'deny' } } })
    // No coordinator_bots row: nothing to fold, nothing to clear.
    await owner(client, 'unmapped-owner')
    await head(client, { ownerId: 'unmapped-owner', external: { slack: 'deny' }, cli: { permissions: { git_push: 'deny' } } })
    const untouched = id()
    await workspace(client, untouched, { slack: 'allow' })

    await fold(client)

    assert.deepEqual(await external(client, a), { external_write_permissions: { slack: 'deny' }, external_write_policy_version: 1 })
    assert.deepEqual(await external(client, b), { external_write_permissions: { slack: 'deny' }, external_write_policy_version: 1 })
    assert.deepEqual((await cli(client, a)).cli_run_policy, { permissions: { git_push: 'deny' } })
    assert.deepEqual((await cli(client, b)).cli_run_policy, { permissions: { git_push: 'deny' } })
    assert.deepEqual(await external(client, untouched), { external_write_permissions: { slack: 'allow' }, external_write_policy_version: 1 })
    const legacy = (await client.query(`select external_write_permissions,cli_run_policy from agent_kit_heads where owner_id='legacy-owner'`)).rows[0]
    assert.deepEqual(legacy, { external_write_permissions: { slack: 'deny' }, cli_run_policy: { permissions: { git_push: 'deny' } } }, 'the legacy head stays as the botless ceiling')
    const unmapped = (await client.query(`select external_write_permissions,cli_run_policy from agent_kit_heads where owner_id='unmapped-owner'`)).rows[0]
    assert.deepEqual(unmapped, legacy, 'an unmapped legacy head is untouched')
  })
})

test('per-worker policies fold into every workspace they ran in, then clear', { skip: !enabled }, async () => {
  await withSchema(async client => {
    await owner(client)
    const a = id(), b = id(), untouched = id()
    const w = await worker(client)
    await running(client, w, a)
    await running(client, w, b)
    await workspace(client, a, {}, { permissions: { install_dependency: 'allow' }, networkAllow: ['a.com', 'b.com'] })
    await workspace(client, b, {}, { networkAllow: ['c.com'] })
    await client.query('update agents set cli_run_policy=$2 where id=$1', [w, { permissions: { install_dependency: 'deny' }, networkAllow: ['a.com'], approvalMode: 'read_only' }])
    const idle = await worker(client)
    await client.query('update agents set cli_run_policy=$2 where id=$1', [idle, { permissions: { install_dependency: 'deny' } }])
    await workspace(client, untouched, {}, { networkAllow: ['z.com'] })

    await fold(client)

    assert.deepEqual((await cli(client, a)).cli_run_policy, {
      permissions: { install_dependency: 'deny' },
      networkAllow: ['a.com'],
      approvalMode: 'read_only',
    })
    assert.equal((await cli(client, b)).cli_run_policy.approvalMode, 'read_only')
    assert.deepEqual((await cli(client, untouched)).cli_run_policy, { networkAllow: ['z.com'] }, 'a worker with no run cannot restrict a workspace')
    assert.deepEqual((await client.query('select cli_run_policy from agents')).rows, [{ cli_run_policy: {} }, { cli_run_policy: {} }])
  })
})

test('malformed and over-limit policies abort before any write', { skip: !enabled }, async () => {
  await withSchema(async client => {
    await owner(client)
    const w = id(), b = await bot(client, w)
    await workspace(client, w, { slack: 'allow' })
    await client.query(`insert into agent_kit_heads(owner_id,bot_key,bot_id,workspace_id,external_write_permissions) values ('owner',$1,$1,$2,'[]'::jsonb)`, [b, w])
    await assert.rejects(client.query(await sql(NEW_MIGRATIONS[0])), /external_write_permissions is not an object/)
  })
  await withSchema(async client => {
    await owner(client)
    const w = id(), b = await bot(client, w)
    const big = Object.fromEntries(Array.from({ length: 101 }, (_, index) => [`app_${index}`, 'deny']))
    await head(client, { botId: b, workspaceId: w, external: big })
    await assert.rejects(client.query(await sql(NEW_MIGRATIONS[0])), /limit is 100/)
  })
  await withSchema(async client => {
    await owner(client)
    const w = id(), b = await bot(client, w)
    await workspace(client, w, { browser_payment: 'ask' })
    await head(client, { botId: b, workspaceId: w, external: { slack: 'deny' } })
    await assert.rejects(client.query(await sql(NEW_MIGRATIONS[0])), /browser ask/)
  })
  await withSchema(async client => {
    await owner(client)
    const w = id(), b = await bot(client, w)
    await head(client, { botId: b, workspaceId: w, cli: { permissions: { computer_use: 'allow' } } })
    await assert.rejects(client.query(await sql(NEW_MIGRATIONS[0])), /unsupported cli action computer_use/)
  })
  await withSchema(async client => {
    await owner(client)
    const w = id(), b = await bot(client, w)
    await head(client, { botId: b, workspaceId: w, cli: { defaults: {} } })
    await assert.rejects(client.query(await sql(NEW_MIGRATIONS[0])), /unknown cli key defaults/)
  })
})

test.after(async () => { if (pool) await pool.end() })
