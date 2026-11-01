import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { Pool, type PoolClient } from 'pg'
import { AgentToolApprovalStore } from './store'
import { readCliRunPolicy, readCliAgentPolicy } from './policy-store'
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
  await pool.query(`ALTER TABLE agent_runs ADD COLUMN "issueId" uuid`)
  await pool.query(`CREATE TABLE agents (id uuid PRIMARY KEY, "userId" text NOT NULL, harness text NOT NULL, "deviceId" uuid); CREATE TABLE devices (id uuid PRIMARY KEY, "ownerId" text NOT NULL, enabled boolean NOT NULL, kind text NOT NULL DEFAULT 'local'); CREATE TABLE bots (id uuid PRIMARY KEY, "workspaceId" uuid, "ownerId" text NOT NULL); CREATE TABLE mikka_workspace_members ("workspaceId" uuid, "userId" text, status text, role text, PRIMARY KEY ("workspaceId", "userId")); CREATE TABLE agent_kit_heads (owner_id text, bot_key text, bot_id uuid, workspace_id uuid, PRIMARY KEY (owner_id, bot_key)); CREATE TABLE workspace_computer_policies ("workspaceId" uuid PRIMARY KEY, permission text NOT NULL DEFAULT 'ask')` )
  await pool.query(await readFile('drizzle/20261029011700_agent_tool_approvals.sql', 'utf8'))
  await pool.query(await readFile('drizzle/20261029011701_cli_run_policy.sql', 'utf8'))
  await pool.query(await readFile('drizzle/20261030204836_agent_tool_approval_input_digest.sql', 'utf8'))
  await pool.query(await readFile('drizzle/20261030204833_workspace_audit_events.sql', 'utf8'))
  const agentId = randomUUID()
  await pool.query(`INSERT INTO agents (id,"userId",harness,"deviceId") VALUES ($1,$2,'codex',$3)`, [agentId,actor.userId,deviceId])
  await pool.query(`INSERT INTO devices (id,"ownerId",enabled) VALUES ($1,$2,true)`, [deviceId,actor.userId])
  await pool.query(`INSERT INTO agent_kit_heads (owner_id,bot_key,workspace_id) VALUES ($1,'coordinator',NULL)`, [actor.userId])
  await pool.query(`INSERT INTO agent_runs VALUES ($1,$2,$3,'running',NULL,now()+interval '5 minutes',$4,NULL,NULL,NULL)`, [runId,actor.userId,deviceId,agentId])
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
test('#438 E: the same requestId with a different original input is rejected even when both mask alike', async () => {
  const masked = { ...payload('masked-replay'), input: { command: 'echo [secret:API_TOKEN]' } }
  const first = await store.propose(actor, { ...masked, originalInput: { command: 'echo sk_one' } })
  assert.equal('inputDigest' in first, false)
  assert.deepEqual(await store.propose(actor, { ...masked, originalInput: { command: 'echo sk_one' } }), first)
  await assert.rejects(store.propose(actor, { ...masked, originalInput: { command: 'echo sk_two' } }))
  await assert.rejects(store.propose(actor, masked), 'dropping the original input does not match either')
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
  await pool.query(`INSERT INTO agent_runs VALUES ($1,$2,$3,'running',NULL,now()+interval '5 minutes',$4,NULL,$5,NULL)`, [scopedRun,actor.userId,deviceId,workerId,botId])
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

test('legacy local runs materialize stable sandbox defaults without changing explicit choices', async () => {
  const user=`legacy-${randomUUID()}`, workerId=randomUUID(), legacyRun=randomUUID(), legacyDevice=randomUUID()
  await pool.query('INSERT INTO devices (id,"ownerId",enabled) VALUES ($1,$2,true)',[legacyDevice,user])
  await pool.query(`INSERT INTO agents (id,"userId",harness,"deviceId") VALUES ($1,$2,'codex',$3)`,[workerId,user,legacyDevice])
  await pool.query(`INSERT INTO agent_runs VALUES ($1,$2,$3,'running',NULL,now()+interval '5 minutes',$4,NULL,NULL,NULL)`,[legacyRun,user,legacyDevice,workerId])
  const first=await readCliRunPolicy(pool,legacyRun,user)
  const second=await readCliRunPolicy(pool,legacyRun,user)
  assert.equal(first.policy.permissions.install_dependency,'allow')
  assert.equal(first.policy.permissions.network,'ask')
  assert.equal(first.policy.permissions.git_push,'allow','push is the GitHub App grant, never ask')
  assert.equal(first.revision,second.revision)
  assert.deepEqual(first.layers.agent,{})
  const results = await Promise.allSettled([
    setCliPolicy(pool,user,legacyRun,'worker',first.revision,{permissions:{install_dependency:'allow'}}),
    setCliPolicy(pool,user,legacyRun,'worker',first.revision,{permissions:{install_dependency:'deny'}}),
  ])
  assert.equal(results.filter(result => result.status === 'fulfilled').length,1)
  assert.equal(results.filter(result => result.status === 'rejected').length,1)
})

test('unbound workers configure safely and only owned cloud devices receive open defaults',async()=>{
 const user=`device-defaults-${randomUUID()}`,worker=randomUUID(),device=randomUUID()
 const guard=async()=>({async check(){},async close(){}})
 await pool.query(`INSERT INTO agents(id,"userId",harness) VALUES($1,$2,'codex')`,[worker,user])
 const unbound=await readCliAgentPolicy(pool,user,worker,null,guard)
 assert.equal(unbound.policy.permissions.network,'ask')
 await pool.query(`INSERT INTO devices(id,"ownerId",enabled,kind) VALUES($1,$2,true,'cloud')`,[device,user])
 await pool.query('UPDATE agents SET "deviceId"=$2 WHERE id=$1',[worker,device])
 const cloud=await readCliAgentPolicy(pool,user,worker,null,guard)
 assert.equal(cloud.policy.permissions.network,'allow')
 assert.notEqual(cloud.revision,unbound.revision)
 await pool.query(`UPDATE agents SET cli_run_policy='{"permissions":{"network":"deny"}}' WHERE id=$1`,[worker])
 assert.equal((await readCliAgentPolicy(pool,user,worker,null,guard)).policy.permissions.network,'deny')
 await pool.query('UPDATE devices SET "ownerId"=$2 WHERE id=$1',[device,'someone-else'])
 await assert.rejects(readCliAgentPolicy(pool,user,worker,null,guard),/agentPolicyUnavailable/)
})


test('policy changes and live tool checks share run-before-policy lock order', { timeout: 10000 }, async () => {
  const current = await readCliRunPolicy(pool,runId,actor.userId)
  let checkLocked!: () => void, settingsLockingRun!: () => void
  const held = new Promise<void>(resolve => { checkLocked=resolve })
  const setting = new Promise<void>(resolve => { settingsLockingRun=resolve })
  const instrument = (query: (client:PoolClient,args:unknown[]) => Promise<unknown>) => ({ connect: async () => {
    const client = await pool.connect()
    return new Proxy(client, { get(target,key) {
      if (key === 'query') return (...args:unknown[]) => query(target,args)
      const value = Reflect.get(target,key,target)
      return typeof value === 'function' ? value.bind(target) : value
    } })
  } })
  const checks = instrument(async (client,args) => {
    const result = await Reflect.apply(client.query,client,args)
    if (String(args[0]).startsWith('SELECT id FROM agent_runs') && String(args[0]).includes('FOR UPDATE')) {
      checkLocked()
      await setting
    }
    return result
  })
  const settings = instrument(async (client,args) => {
    if (/FROM agent_runs WHERE id=\$1 AND "userId"=\$2 FOR (SHARE|UPDATE)/.test(String(args[0]))) settingsLockingRun()
    return Reflect.apply(client.query,client,args)
  })
  const checking = new AgentToolApprovalStore({...checks,query:pool.query.bind(pool)}).checkState(actor,runId,current.revision)
  await held
  const changing = setCliPolicy(settings,actor.userId,runId,'worker',current.revision,current.layers.worker)
  const results = await Promise.allSettled([checking,changing])
  assert.deepEqual(results.map(result => result.status === 'fulfilled' ? 'ok' : (result.reason as {code?:string}).code),['ok','ok'])
})

test('human control preserves pending approval and existing lease, then expires through the existing liveness poll', async () => {
  await pool.query(`ALTER TABLE agent_runs ADD COLUMN "pauseReason" text, ADD COLUMN "resumeStatus" text, ADD COLUMN "updatedAt" timestamptz`)
  await pool.query(`CREATE TABLE computer_run_bindings ("runId" uuid, "botId" uuid, "ownerId" text, "workspaceId" uuid);
    CREATE TABLE bot_desktops ("botId" uuid, "ownerId" text, "workspaceId" uuid, control text, "controlUntil" timestamptz)`)
  const bot = randomUUID(), workspace = randomUUID()
  await pool.query(`INSERT INTO computer_run_bindings VALUES ($1,$2,$3,$4)`, [runId,bot,actor.userId,workspace])
  await pool.query(`INSERT INTO bot_desktops VALUES ($1,$2,$3,'user',now()+interval '5 minutes')`, [bot,actor.userId,workspace])
  await pool.query(`UPDATE agent_runs SET status='running',"stopRequestedAt"=NULL,"leaseExpiresAt"=now()+interval '1 hour' WHERE id=$1`, [runId])
  const revision = (await readCliRunPolicy(pool,runId,actor.userId)).revision
  const approval = await store.propose(actor,{ ...payload('pause-boundary'),policyRevision:revision })
  await pool.query(`UPDATE agent_runs SET status='paused',"pauseReason"='human_control',"resumeStatus"='running' WHERE id=$1`, [runId])
  const lease = (await pool.query('SELECT "leaseExpiresAt" FROM agent_runs WHERE id=$1',[runId])).rows[0].leaseExpiresAt
  assert.deepEqual(await store.checkState(actor,runId,revision),{live:true,paused:true})
  assert.equal(await store.take(actor,runId,approval.id,approval.digest),'pending')
  assert.equal((await pool.query('SELECT status FROM agent_tool_approvals WHERE id=$1',[approval.id])).rows[0].status,'pending')
  await pool.query(`UPDATE bot_desktops SET "controlUntil"=now()-interval '1 second' WHERE "botId"=$1`, [bot])
  assert.deepEqual(await store.checkState(actor,runId,revision),{live:true,paused:false})
  const resumed = (await pool.query('SELECT status,"pauseReason","resumeStatus","leaseExpiresAt" FROM agent_runs WHERE id=$1',[runId])).rows[0]
  assert.deepEqual(resumed,{status:'running',pauseReason:null,resumeStatus:null,leaseExpiresAt:lease})
  await store.decide(actor.userId,runId,approval.id,approval.digest,'approve')
  assert.equal(await store.take(actor,runId,approval.id,approval.digest),'allow')
})
