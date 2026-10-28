import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { Pool } from 'pg'
import { recordCredentialAction, consumeCredentialAction, withCredentialActionFence } from './credential-action-ledger'

const url = process.env.CREDENTIAL_LEDGER_TEST_DATABASE_URL
test('isolated PostgreSQL: pending action is claimed once; STOP and policy revocation fence I/O', { skip: !url }, async () => {
  const pool = new Pool({ connectionString: url })
  const owner = 'fixture-owner', workspace = randomUUID(), bot = randomUUID(), subagent = randomUUID(), run = randomUUID(), device = randomUUID(), agent = randomUUID(), subscription = randomUUID(), connection = randomUUID()
  try {
    await pool.query(`CREATE TABLE pending_actions (id uuid PRIMARY KEY,"userId" text,action text,input jsonb,status text,context jsonb,"createdAt" timestamptz DEFAULT now());
      CREATE TABLE bots (id uuid, "ownerId" text, "workspaceId" uuid);
      CREATE TABLE bot_subagents (id uuid PRIMARY KEY,"ownerId" text,"workspaceId" uuid,"botId" uuid,status text,epoch int,"targetId" text);
      CREATE TABLE subagent_run_bindings ("subagentId" uuid,"runId" uuid,"ownerId" text,"workspaceId" uuid,"botId" uuid);
      CREATE TABLE agent_runs (id uuid PRIMARY KEY,"userId" text,"deviceId" uuid,"agentId" uuid,status text,"stopRequestedAt" timestamptz,"leaseExpiresAt" timestamptz);
      CREATE TABLE cloud_machines ("workspaceId" uuid,"ownerId" text,"deviceId" uuid,state text,"sandboxId" text);
      CREATE TABLE devices (id uuid,"ownerId" text,kind text,enabled boolean);
      CREATE TABLE byos_native_runs ("runId" uuid,"bindingId" uuid);
      CREATE TABLE byos_bindings (id uuid,"ownerId" text,"workspaceId" text,"consumerId" text,"connectionId" uuid,"connectionRevision" int);
      CREATE TABLE byos_connections (id uuid,"ownerId" text,"workspaceId" text,state text,epoch int);
      CREATE TABLE workspace_computer_policies ("workspaceId" uuid,permission text,version int)`)
    await pool.query('INSERT INTO bots VALUES ($1,$2,$3)', [bot, owner, workspace])
    await pool.query('INSERT INTO bot_subagents VALUES ($1,$2,$3,$4,\'running\',1,\'target\')', [subagent, owner, workspace, bot])
    await pool.query('INSERT INTO subagent_run_bindings VALUES ($1,$2,$3,$4,$5)', [subagent, run, owner, workspace, bot])
    await pool.query('INSERT INTO agent_runs VALUES ($1,$2,$3,$4,\'running\',NULL,now()+interval \'1 minute\')', [run, owner, device, agent])
    await pool.query('INSERT INTO cloud_machines VALUES ($1,$2,$3,\'running\',\'sandbox\')', [workspace, owner, device])
    await pool.query('INSERT INTO devices VALUES ($1,$2,\'cloud\',true)', [device, owner])
    await pool.query('INSERT INTO byos_native_runs VALUES ($1,$2)', [run, subscription])
    await pool.query('INSERT INTO byos_bindings VALUES ($1,$2,$3,$4,$5,1)', [subscription, owner, workspace, agent, connection])
    await pool.query('INSERT INTO byos_connections VALUES ($1,$2,$3,\'connected\',1)', [connection, owner, workspace])
    await pool.query('INSERT INTO workspace_computer_policies VALUES ($1,\'allow\',2)', [workspace])
    const binding = { userId: owner, workspaceId: workspace, botId: bot, subagentId: subagent, runId: subagent, epoch: 1, policyVersion: 2, targetId: 'target', origin: 'https://example.test', loaderId: 'loader', backendNodeId: 42, role: 'password' as const, expiresAt: Date.now()+60_000 }
    const stableId = randomUUID()
    const { action } = await recordCredentialAction(pool, binding, 'allow', false, stableId)
    assert.deepEqual((await recordCredentialAction(pool, binding, 'allow', false, stableId)).action, action)
    await assert.rejects(recordCredentialAction(pool, { ...binding, targetId: 'other' }, 'allow', false, stableId))
    const attempts = await Promise.allSettled([consumeCredentialAction(pool, action), consumeCredentialAction(pool, action)])
    assert.equal(attempts.filter(a => a.status === 'fulfilled').length, 1)
    const ask = (await recordCredentialAction(pool, binding, 'ask', false, randomUUID())).action
    await assert.rejects(consumeCredentialAction(pool, ask))
    await pool.query('UPDATE pending_actions SET status=\'running\' WHERE id=$1 AND status=\'pending\'', [ask.actionId])
    await consumeCredentialAction(pool, ask)
    let calls = 0
    const execute = () => withCredentialActionFence(pool, action, async () => { calls++; return 'ok' })
    assert.equal(await execute(), 'ok')
    await assert.rejects(execute(), 'a successful action cannot execute twice')
    const stopped = (await recordCredentialAction(pool, binding, 'allow', false, randomUUID())).action
    await consumeCredentialAction(pool, stopped)
    await pool.query("UPDATE bot_subagents SET status='stopped' WHERE id=$1", [subagent])
    await assert.rejects(withCredentialActionFence(pool, stopped, async () => { calls++; return 'bad' }))
    await pool.query("UPDATE bot_subagents SET status='running' WHERE id=$1", [subagent])
    await assert.rejects(withCredentialActionFence(pool, ask, async () => { calls++; throw new Error('outcome unknown') }))
    await assert.rejects(withCredentialActionFence(pool, ask, async () => { calls++; return 'bad' }))
    const revoked = (await recordCredentialAction(pool, binding, 'allow', false, randomUUID())).action
    await consumeCredentialAction(pool, revoked)
    await pool.query('UPDATE workspace_computer_policies SET permission=\'deny\',version=3 WHERE "workspaceId"=$1', [workspace])
    await assert.rejects(withCredentialActionFence(pool, revoked, async () => { calls++; return 'bad' }))
    assert.equal(calls, 2)
  } finally { await pool.end() }
})
