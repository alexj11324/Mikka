import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, test } from 'node:test'
import { Pool } from 'pg'
import { readCliRunPolicy } from '../agent-tool-approval/policy-store'
import { ApprovalUnavailable } from '../agent-tool-approval/store'
import { RunToolApprovalStore } from '../agent-tool-approval/approvals'
import { freezeThreadMode, readThreadMode, threadModeLocked, threadModeTarget, setThreadMode, ThreadModeConflict } from './store'
import { readThreadModeSupport } from './support'
import { workspacePool } from '../workspace-db'
import { seedFixtureWorkspace } from '../../tests/helpers/task-workspace'
import { disposableDatabase } from '../../tests/helpers/e2e-target.mjs'

// Explicitly isolated local database or the CI job's disposable *_e2e
// service. Never an application database.
const explicit = process.env.THREAD_MODE_TEST_DATABASE_URL
const connectionString = explicit ?? process.env.E2E_DATABASE_URL
if (!connectionString) throw new Error('Thread mode database tests require an explicit isolated database')
const target = new URL(connectionString)
const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname) && !target.search && !target.hash &&
  ['postgres:', 'postgresql:'].includes(target.protocol)
const dedicated = explicit && /^\/mikka_thread_mode_[a-z0-9_]+$/.test(target.pathname)
const actions = !explicit && disposableDatabase() && process.env.DATABASE_URL === connectionString && process.env.MIKKA_DATABASE_URL === connectionString
if (!loopback || (!dedicated && !actions)) throw new Error('Refusing non-isolated thread mode test database')

const pool = new Pool({ connectionString, max: 8 })
const owner = `synthetic-${randomUUID()}`
const other = `synthetic-${randomUUID()}`
const deviceId = randomUUID(), agentId = randomUUID()

before(async () => {
  for (const name of ['user', 'issues', 'agent_runs', 'task_thread_modes', 'agent_tool_approvals']) {
    const { rows: [relation] } = await pool.query(`SELECT to_regclass(format('%I.%I',current_schema(),$1::text)) AS relation`, [name])
    assert.ok(relation?.relation, `CI must migrate the full schema first: ${name}`)
  }
  await pool.query(`INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES ($1,$1,$2,true,now(),now()),($3,$3,$4,true,now(),now())`,
    [owner, `${owner}@example.invalid`, other, `${other}@example.invalid`])
  await seedFixtureWorkspace(pool, owner)
  await seedFixtureWorkspace(pool, other)
  await pool.query(`INSERT INTO devices (id,"ownerId",name,kind,"protocolVersion",harnesses) VALUES ($1,$2,'Thread mode device','local',1,'[]'::jsonb)`, [deviceId, owner])
  await pool.query(`INSERT INTO agents (id,"userId","deviceId",harness,name) VALUES ($1,$2,$3,'codex','Thread mode worker')`, [agentId, owner, deviceId])
  await pool.query(`INSERT INTO issues (id,"userId","workspaceId",title,content,status,priority,scope,"ownershipState")
    SELECT $1,$2,id,'Thread mode task',$3,'todo','normal','personal','bound' FROM mikka_workspaces WHERE "userId"=$2 AND kind='personal'`,
    [randomUUID(), owner, JSON.stringify({ type: 'doc', attrs: { mikka: { number: 1 } }, content: [] })])
})

after(async () => {
  await Promise.all([pool.end(), workspacePool.end()])
})

async function issueId(userId = owner) {
  const { rows: [issue] } = await pool.query(`SELECT id FROM issues WHERE "userId"=$1 ORDER BY "createdAt" DESC LIMIT 1`, [userId])
  assert.ok(issue?.id)
  return issue.id as string
}

async function workspaceId(userId = owner) {
  const { rows: [workspace] } = await pool.query(`SELECT id FROM mikka_workspaces WHERE "userId"=$1 AND kind='personal'`, [userId])
  assert.ok(workspace?.id)
  return workspace.id as string
}

async function askRun(): Promise<string> {
  const id = randomUUID()
  await pool.query(`INSERT INTO agent_runs (id,"userId","deviceId","issueId","agentId","workspaceId",status,mode,"leaseExpiresAt")
    VALUES ($1,$2,$3,$4,$5,$6,'running','ask',now()+interval '10 minutes')`, [id, owner, deviceId, await issueId(), agentId, await workspaceId()])
  return id
}

test('a thread starts in execute at version 0 and a transition bumps the version with an audit', async () => {
  const id = await issueId()
  const workspace = await workspaceId()
  assert.deepEqual(await readThreadMode(pool, owner, id), { mode: 'execute', version: 0 })
  const state = await setThreadMode(pool, { userId: owner, issueId: id, workspaceId: workspace, mode: 'plan', expectedVersion: 0, actorName: 'Synthetic owner' })
  assert.deepEqual(state, { mode: 'plan', version: 1 })
  assert.deepEqual(await readThreadMode(pool, owner, id), { mode: 'plan', version: 1 })
  const { rows } = await pool.query(`SELECT metadata FROM workspace_audit_events WHERE "workspaceId"=$1 AND action='thread.mode_changed'`, [workspace])
  assert.deepEqual(rows, [{ metadata: { from: 'execute', to: 'plan', version: 1 } }])
})

test('a stale version changes nothing (optimistic concurrency)', async () => {
  const id = await issueId()
  const workspace = await workspaceId()
  await assert.rejects(
    setThreadMode(pool, { userId: owner, issueId: id, workspaceId: workspace, mode: 'ask', expectedVersion: 0 }),
    error => error instanceof ThreadModeConflict && error.reason === 'threadModeChanged')
  assert.deepEqual(await readThreadMode(pool, owner, id), { mode: 'plan', version: 1 })
})

test('another person cannot transition this thread', async () => {
  const id = await issueId()
  const workspace = await workspaceId()
  await assert.rejects(
    setThreadMode(pool, { userId: other, issueId: id, workspaceId: workspace, mode: 'execute', expectedVersion: 1 }),
    error => error instanceof ThreadModeConflict && error.reason === 'threadModeChanged')
})

test('a running thread keeps the mode it froze; the change waits for it to end', async () => {
  const id = await issueId()
  const workspace = await workspaceId()
  const run = randomUUID()
  await pool.query(`INSERT INTO agent_runs (id,"userId","deviceId","issueId","agentId",status,mode,"leaseExpiresAt")
    VALUES ($1,$2,$3,$4,$5,'running','plan',now()+interval '10 minutes')`, [run, owner, deviceId, id, agentId])
  await assert.rejects(
    setThreadMode(pool, { userId: owner, issueId: id, workspaceId: workspace, mode: 'execute', expectedVersion: 1 }),
    error => error instanceof ThreadModeConflict && error.reason === 'threadModeLocked')
  assert.deepEqual(await readThreadMode(pool, owner, id), { mode: 'plan', version: 1 })
  await pool.query(`UPDATE agent_runs SET status='succeeded',"finishedAt"=now() WHERE id=$1`, [run])
  assert.deepEqual(await setThreadMode(pool, { userId: owner, issueId: id, workspaceId: workspace, mode: 'execute', expectedVersion: 1 }), { mode: 'execute', version: 2 })
})

test('admission inherits the thread mode, and an explicit mode is a transition', async () => {
  const id = await issueId()
  const workspace = await workspaceId()
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    assert.equal(await freezeThreadMode(client, { userId: owner, issueId: id, workspaceId: workspace }), 'execute')
    assert.equal(await freezeThreadMode(client, { userId: owner, issueId: id, workspaceId: workspace, requested: 'ask' }), 'ask')
    await client.query('COMMIT')
  } finally { client.release() }
  assert.deepEqual(await readThreadMode(pool, owner, id), { mode: 'ask', version: 3 })
})

test('an Ask request is approved once, consumed once, and fenced by mode and revision', async () => {
  const run = await askRun()
  const store = new RunToolApprovalStore(pool)
  const actor = { userId: owner, deviceId }
  const revision = (await readCliRunPolicy(pool, run, owner)).revision
  const request = { policyRevision: revision, requestId: `turn:${randomUUID()}`, harness: 'codex' as const, method: 'tool' as const, tool: 'Bash', input: { command: 'npm test' } }
  const created = await store.request(actor, run, request)
  assert.equal(created.status, 'pending')
  // A replay of the exact request returns the same approval.
  assert.deepEqual(await store.request(actor, run, request), created)
  // The same request id with another operation is a different call.
  await assert.rejects(store.request(actor, run, { ...request, input: { command: 'npm publish' } }), error => error instanceof ApprovalUnavailable)
  // Another device cannot read it.
  await assert.rejects(store.state({ userId: owner, deviceId: randomUUID() }, run, created.approvalId), error => error instanceof ApprovalUnavailable)
  // Another person cannot decide it.
  await assert.rejects(store.decide(other, run, created.approvalId, 'approve'), error => error instanceof ApprovalUnavailable)
  assert.equal((await store.decide(owner, run, created.approvalId, 'approve', 'Synthetic owner')).status, 'approved')
  assert.equal((await store.consume(actor, run, created.approvalId)).status, 'consumed')
  // A consumed approval cannot be replayed.
  await assert.rejects(store.decide(owner, run, created.approvalId, 'deny'), error => error instanceof ApprovalUnavailable && error.revokeReason === 'not_pending')
  const audits = (await pool.query(`SELECT action FROM workspace_audit_events WHERE "workspaceId"=$1 AND action IN ('agent.approval_decided','agent.approval_consumed')`, [await workspaceId()])).rows.map(row => row.action)
  assert.deepEqual(audits.sort(), ['agent.approval_consumed', 'agent.approval_decided'])
})

test('a mode change fences a pending approval instead of granting it', async () => {
  const run = await askRun()
  const store = new RunToolApprovalStore(pool)
  const actor = { userId: owner, deviceId }
  const revision = (await readCliRunPolicy(pool, run, owner)).revision
  const created = await store.request(actor, run, { policyRevision: revision, requestId: `turn:${randomUUID()}`, harness: 'codex', method: 'tool', tool: 'Bash', input: { command: 'npm test' } })
  // The fixture cannot transition a live thread through the API, so it
  // changes the frozen column the policy revision is derived from. The
  // decision must still refuse: Execute does not accept Ask approvals.
  await pool.query(`UPDATE agent_runs SET mode='execute' WHERE id=$1`, [run])
  await assert.rejects(store.decide(owner, run, created.approvalId, 'approve'), error => error instanceof ApprovalUnavailable && error.revokeReason === 'mode_not_ask')
  assert.deepEqual((await pool.query(`SELECT status FROM agent_tool_approvals WHERE id=$1`, [created.approvalId])).rows, [{ status: 'pending' }])
})

test('the lock the picker reads follows the thread, not the run it was asked by', async () => {
  const id = await issueId()
  await askRun()
  assert.equal(await threadModeLocked(pool, owner, id), true)
  assert.equal(await threadModeLocked(pool, other, await issueId(other)), false)
})

test('mode support follows the harness matrix and the daemon report, never a guess', async () => {
  const run = await askRun()
  // A local daemon that names the modes it enforces: all three are offered.
  await pool.query(`UPDATE devices SET harnesses=$2::jsonb WHERE id=$1`, [deviceId, JSON.stringify([{ harness: 'codex', installed: true, threadModes: ['plan', 'execute', 'ask'] }])])
  assert.deepEqual((await readThreadModeSupport(pool, owner, run)).support, {
    plan: { state: 'enforced' }, execute: { state: 'enforced' }, ask: { state: 'enforced' },
  })
  // The same device without a report predates the gate.
  await pool.query(`UPDATE devices SET harnesses='[]'::jsonb WHERE id=$1`, [deviceId])
  assert.deepEqual((await readThreadModeSupport(pool, owner, run)).support.ask, { state: 'unsupported', reason: 'daemon' })
  // A harness with no native ask surface is refused by the matrix first.
  await pool.query(`UPDATE agents SET harness='cursor' WHERE id=$1`, [agentId])
  assert.deepEqual((await readThreadModeSupport(pool, owner, run)).support, {
    plan: { state: 'unsupported', reason: 'harness' }, execute: { state: 'enforced' }, ask: { state: 'unsupported', reason: 'harness' },
  })
  await pool.query(`UPDATE agents SET harness='codex' WHERE id=$1`, [agentId])
})

test('the badge reads the continuation run, not the root it continues', async () => {
  const id = await issueId()
  const root = randomUUID(), continuation = randomUUID()
  await pool.query(`INSERT INTO agent_runs (id,"userId","deviceId","issueId","agentId",status,mode,"leaseExpiresAt")
    VALUES ($1,$2,$3,$4,$5,'succeeded','ask',NULL),($6,$2,$3,$4,$5,'running','plan',now()+interval '10 minutes')`, [root, owner, deviceId, id, agentId, continuation])
  await pool.query(`UPDATE agent_runs SET "continuesRunId"=$2 WHERE id=$1`, [continuation, root])
  assert.equal((await threadModeTarget(pool, owner, root))?.frozenMode, 'ask')
  assert.equal((await threadModeTarget(pool, owner, continuation))?.frozenMode, 'plan')
})

test('a policy revision change fences a pending approval', async () => {
  const run = await askRun()
  const store = new RunToolApprovalStore(pool)
  const actor = { userId: owner, deviceId }
  const revision = (await readCliRunPolicy(pool, run, owner)).revision
  const created = await store.request(actor, run, { policyRevision: revision, requestId: `turn:${randomUUID()}`, harness: 'codex', method: 'tool', tool: 'Bash', input: { command: 'npm test' } })
  await pool.query(`UPDATE agent_kit_heads SET cli_run_policy='{"permissions":{"network":"deny"}}'::jsonb,cli_run_policy_version=cli_run_policy_version+1 WHERE owner_id=$1 AND bot_key='coordinator'`, [owner])
  await assert.rejects(store.decide(owner, run, created.approvalId, 'approve'), error => error instanceof ApprovalUnavailable && error.revokeReason === 'policy_changed')
})

test('an approval disappears from the list and cannot be decided once its run ended', async () => {
  const run = await askRun()
  const store = new RunToolApprovalStore(pool)
  const actor = { userId: owner, deviceId }
  const revision = (await readCliRunPolicy(pool, run, owner)).revision
  const created = await store.request(actor, run, { policyRevision: revision, requestId: `turn:${randomUUID()}`, harness: 'codex', method: 'tool', tool: 'Bash', input: { command: 'npm test' } })
  assert.deepEqual((await store.list(owner, run)).map(item => item.approvalId), [created.approvalId])
  // The run ended: its Ask request is no longer a live card, and the
  // decision path refuses before touching the row.
  await pool.query(`UPDATE agent_runs SET status='stopped',"stopRequestedAt"=now(),"finishedAt"=now() WHERE id=$1`, [run])
  assert.deepEqual(await store.list(owner, run), [])
  await assert.rejects(store.decide(owner, run, created.approvalId, 'approve'), error => error instanceof ApprovalUnavailable)
  assert.deepEqual((await pool.query(`SELECT status FROM agent_tool_approvals WHERE id=$1`, [created.approvalId])).rows, [{ status: 'pending' }])
})
