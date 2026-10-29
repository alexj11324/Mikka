import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { AgentToolApprovalStore } from './store'
import { readCliRunPolicy } from './policy-store'
import { acquireWorkspaceMembership } from '../workspace-membership-guard'
import { setCliPolicy } from './policy-settings'

const url = process.env.APPROVAL_TEST_DATABASE_URL
if (!url) throw new Error('An isolated local approval_e2e database is required')
const target = new URL(url)
if (!['localhost','127.0.0.1','[::1]'].includes(target.hostname) || !/^\/approval_e2e(?:_[a-f0-9]{24})?$/.test(target.pathname)) throw new Error('Refusing non-isolated database')
const pool = new Pool({ connectionString: url })
const store = new AgentToolApprovalStore(pool)
const runId = randomUUID(), deviceId = randomUUID(), actor = { userId: 'synthetic-owner', deviceId }
let initialRevision = ''
const payload = (requestId: string) => ({ runId, requestId, harness: 'codex' as const, method: 'item/commandExecution/requestApproval', input: { command: 'synthetic' }, policyRevision: initialRevision })
before(async () => {
  await pool.query(`CREATE TABLE agent_runs (id uuid PRIMARY KEY, "userId" text NOT NULL, "deviceId" uuid NOT NULL, status text NOT NULL, "stopRequestedAt" timestamptz, "leaseExpiresAt" timestamptz, "agentId" uuid NOT NULL, "agentDefinition" jsonb, "botId" uuid)`)
  await pool.query(`CREATE TABLE agents (id uuid PRIMARY KEY, "userId" text NOT NULL, harness text NOT NULL, "deviceId" uuid); CREATE TABLE devices (id uuid PRIMARY KEY, "ownerId" text NOT NULL, enabled boolean NOT NULL, kind text NOT NULL); CREATE TABLE bots (id uuid PRIMARY KEY, "workspaceId" uuid, "ownerId" text NOT NULL); CREATE TABLE mikka_workspace_members ("workspaceId" uuid, "userId" text, status text, role text, PRIMARY KEY ("workspaceId", "userId")); CREATE TABLE agent_kit_heads (owner_id text, bot_key text, bot_id uuid, workspace_id uuid, PRIMARY KEY (owner_id, bot_key)); CREATE TABLE workspace_computer_policies ("workspaceId" uuid PRIMARY KEY, permission text NOT NULL DEFAULT 'ask')` )
  await pool.query(await readFile('drizzle/20261029011700_agent_tool_approvals.sql', 'utf8'))
  await pool.query(await readFile('drizzle/20261029011701_cli_run_policy.sql', 'utf8'))
  const agentId = randomUUID()
  await pool.query(`INSERT INTO agents (id,"userId",harness,"deviceId") VALUES ($1,$2,'codex',$3)`, [agentId,actor.userId,deviceId])
  await pool.query(`INSERT INTO devices VALUES ($1,$2,true,'local')`, [deviceId,actor.userId])
  await pool.query(`INSERT INTO agent_kit_heads (owner_id,bot_key,workspace_id) VALUES ($1,'coordinator',NULL)`, [actor.userId])
  await pool.query(`INSERT INTO agent_runs VALUES ($1,$2,$3,'running',NULL,now()+interval '5 minutes',$4,NULL,NULL)`, [runId,actor.userId,deviceId,agentId])
  initialRevision = (await readCliRunPolicy(pool, runId, actor.userId)).revision
})
after(async () => { await pool.end() })
test('pending, owner decision, exactly one consumer, and scope isolation', async () => {
  const proposal = await store.propose(actor, payload('one'))
  assert.equal(await store.take(actor, runId, proposal.id, proposal.digest), 'pending')
  assert.equal((await store.list(actor.userId, runId)).length, 1)
  await assert.rejects(store.list('other', runId))
  await assert.rejects(store.decide('other', runId, proposal.id, proposal.digest, 'approve'))
  await assert.rejects(store.decide(actor.userId, runId, proposal.id, 'bad', 'approve'))
  await store.decide(actor.userId, runId, proposal.id, proposal.digest, 'approve')
  const decisions = await Promise.all([store.take(actor, runId, proposal.id, proposal.digest), store.take(actor, runId, proposal.id, proposal.digest)])
  assert.deepEqual(decisions.sort(), ['allow', 'deny'])
  await assert.rejects(store.decide(actor.userId, runId, proposal.id, proposal.digest, 'approve'))
  await assert.rejects(store.propose(actor, { ...payload('one'), input: { command: 'different' } }))
  await assert.rejects(store.take({ ...actor, deviceId: randomUUID() }, runId, proposal.id, proposal.digest))
})
test('deny, cancellation and stopped run never authorize', async () => {
  const denied = await store.propose(actor, payload('denied'))
  await store.decide(actor.userId, runId, denied.id, denied.digest, 'deny')
  assert.equal(await store.take(actor, runId, denied.id, denied.digest), 'deny')
  const cancelled = await store.propose(actor, payload('cancel'))
  await store.decide(actor.userId, runId, cancelled.id, cancelled.digest, 'approve')
  assert.equal(await store.cancel(actor, runId, cancelled.id, cancelled.digest), true)
  assert.equal(await store.take(actor, runId, cancelled.id, cancelled.digest), 'deny')
  const stopped = await store.propose(actor, payload('stop'))
  await pool.query('UPDATE agent_runs SET "stopRequestedAt"=now() WHERE id=$1', [runId])
  await assert.rejects(store.decide(actor.userId, runId, stopped.id, stopped.digest, 'approve'))
  await assert.rejects(store.take(actor, runId, stopped.id, stopped.digest))
})

test('a changed worker policy revokes an approved but unconsumed request', async () => {
  await pool.query('UPDATE agent_runs SET "stopRequestedAt"=NULL WHERE id=$1', [runId])
  const pending = await store.propose(actor, payload('policy-change'))
  await store.decide(actor.userId, runId, pending.id, pending.digest, 'approve')
  await setCliPolicy(pool, actor.userId, runId, 'worker', initialRevision, { permissions: { install_dependency:'deny' } })
  await assert.rejects(store.take(actor, runId, pending.id, pending.digest))
  await assert.rejects(store.propose(actor, payload('stale-revision')))
  assert.equal(await store.check(actor, runId, initialRevision), false)
  const current = await readCliRunPolicy(pool,runId,actor.userId)
  assert.equal(current.policy.permissions.install_dependency, 'deny')
  assert.equal(await store.check(actor, runId, current.revision), true)
})

test('workspace may narrow agent policy, rejects forged generations, and invalidates a recreated fixture', async () => {
  const wid=randomUUID(), botId=randomUUID(), workerId=randomUUID(), scopedRun=randomUUID()
  await pool.query(`INSERT INTO bots VALUES ($1,$2,$3)`, [botId,wid,actor.userId])
  await pool.query(`INSERT INTO mikka_workspace_members VALUES ($1,$2,'active','admin')`, [wid,actor.userId])
  const guard = (workspaceId: string, userId: string, signal: AbortSignal) => acquireWorkspaceMembership(pool, {workspaceId,userId},signal)
  await pool.query(`INSERT INTO agents (id,"userId",harness,"deviceId") VALUES ($1,$2,'codex',$3)`, [workerId,actor.userId,deviceId])
  await pool.query(`INSERT INTO agent_kit_heads (owner_id,bot_key,workspace_id,cli_run_policy) VALUES ($1,$2,$3,$4)`, [actor.userId,botId,wid,{permissions:{install_dependency:'allow'}}])
  await pool.query(`INSERT INTO workspace_computer_policies ("workspaceId",cli_run_policy) VALUES ($1,$2)`, [wid,{permissions:{install_dependency:'deny'}}])
  await pool.query(`INSERT INTO agent_runs VALUES ($1,$2,$3,'running',NULL,now()+interval '5 minutes',$4,NULL,$5)`, [scopedRun,actor.userId,deviceId,workerId,botId])
  const denied = await readCliRunPolicy(pool,scopedRun,actor.userId,guard)
  assert.equal(denied.policy.permissions.install_dependency,'deny')
  const asking = await setCliPolicy(pool,actor.userId,scopedRun,'workspace',denied.revision,{permissions:{install_dependency:'ask'}},guard)
  await assert.rejects(setCliPolicy(pool,actor.userId,scopedRun,'workspace',denied.revision,{permissions:{install_dependency:'allow'}},guard))
  assert.equal(asking.policy.permissions.install_dependency,'ask')
  assert.notEqual(asking.revision, denied.revision)
  await assert.rejects(pool.query(`UPDATE workspace_computer_policies SET cli_run_policy_generation=$2 WHERE "workspaceId"=$1`, [wid,randomUUID()]))
  const regenerated = await readCliRunPolicy(pool,scopedRun,actor.userId,guard)
  assert.equal(regenerated.policy.permissions.install_dependency, 'ask')
  assert.equal(regenerated.revision,asking.revision)
  // This nonce-owned row was created by this test immediately above. Current
  // authorization permits recycling newly created temporary test resources;
  // no pre-existing policy row, database, volume, directory or log is removed.
  await pool.query(`DELETE FROM workspace_computer_policies WHERE "workspaceId"=$1`, [wid])
  const recreated = await readCliRunPolicy(pool,scopedRun,actor.userId,guard)
  assert.equal(recreated.policy.permissions.install_dependency,'allow')
  assert.notEqual(recreated.revision,asking.revision)
  await pool.query(`UPDATE mikka_workspace_members SET role='member' WHERE "workspaceId"=$1 AND "userId"=$2`, [wid,actor.userId])
  await assert.rejects(setCliPolicy(pool,actor.userId,scopedRun,'workspace',recreated.revision,{},guard))
  const scopedStore = new AgentToolApprovalStore(pool, guard)
  const pending = await scopedStore.propose(actor, { ...payload('workspace-revocation'), runId:scopedRun, policyRevision:recreated.revision })
  await pool.query(`UPDATE mikka_workspace_members SET status='removed' WHERE "workspaceId"=$1 AND "userId"=$2`, [wid,actor.userId])
  await assert.rejects(scopedStore.decide(actor.userId,scopedRun,pending.id,pending.digest,'approve'))
  assert.equal((await pool.query('SELECT status FROM agent_tool_approvals WHERE id=$1',[pending.id])).rows[0].status,'pending')
})

test('legacy runs materialize stable defaults without touching unrelated permission fields', async () => {
  const user=`legacy-${randomUUID()}`, workerId=randomUUID(), legacyRun=randomUUID(), legacyDevice=randomUUID()
  await pool.query(`INSERT INTO devices VALUES ($1,$2,true,'local')`,[legacyDevice,user])
  await pool.query(`INSERT INTO agents (id,"userId",harness,"deviceId") VALUES ($1,$2,'codex',$3)`,[workerId,user,legacyDevice])
  await pool.query(`INSERT INTO agent_runs VALUES ($1,$2,$3,'running',NULL,now()+interval '5 minutes',$4,NULL,NULL)`,[legacyRun,user,deviceId,workerId])
  const first=await readCliRunPolicy(pool,legacyRun,user)
  const second=await readCliRunPolicy(pool,legacyRun,user)
  assert.equal(first.policy.permissions.install_dependency,'allow')
  assert.equal(first.revision,second.revision)
  assert.deepEqual(first.layers.agent,{})
  const results = await Promise.allSettled([
    setCliPolicy(pool,user,legacyRun,'worker',first.revision,{permissions:{install_dependency:'allow'}}),
    setCliPolicy(pool,user,legacyRun,'worker',first.revision,{permissions:{install_dependency:'deny'}}),
  ])
  assert.equal(results.filter(result => result.status === 'fulfilled').length,1)
  assert.equal(results.filter(result => result.status === 'rejected').length,1)
})
