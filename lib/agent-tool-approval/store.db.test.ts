import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { Pool, type PoolClient } from 'pg'
import { observePoolCommits } from '../db/commit-effects'
import { AgentToolApprovalStore, ApprovalUnavailable } from './store'
import { readCliRunPolicy, readCliAgentPolicy } from './policy-store'
import { acquireWorkspaceMembership } from '../workspace-membership-guard'
import { setCliPolicy } from './policy-settings'
import { workspacePool } from '../workspace-db'
import { ActionFailureError } from '../action-error'

const url = process.env.APPROVAL_TEST_DATABASE_URL
if (!url || process.env.MIKKA_DATABASE_URL !== url || process.env.DATABASE_URL !== url) throw new Error('All approval store connections must use its isolated approval_e2e database')
const target = new URL(url)
if (!['localhost','127.0.0.1','[::1]'].includes(target.hostname) || !/^\/approval_e2e(?:_[a-f0-9]{24})?$/.test(target.pathname)) throw new Error('Refusing non-isolated database')
const pool = new Pool({ connectionString: url })
observePoolCommits(pool)
const store = new AgentToolApprovalStore(pool)
const runId = randomUUID(), deviceId = randomUUID(), actor = { userId: 'synthetic-owner', deviceId }
const personalWorkspaceId = randomUUID()
let initialRevision = ''
async function seedWorkspace(userId: string, workspaceId = randomUUID(), kind: 'personal' | 'team' = 'personal', role: 'admin' | 'member' = 'admin') {
  await pool.query(`INSERT INTO mikka_workspaces (id,"userId",name,kind) VALUES ($1,$2,'Approval fixture',$3)`, [workspaceId,userId,kind])
  await pool.query(`INSERT INTO mikka_workspace_members ("workspaceId","userId",name,email,status,role) VALUES ($1,$2,'Approval fixture',$3,'active',$4)`, [workspaceId,userId,`${userId}@example.invalid`,role])
  return workspaceId
}
before(async () => {
  await pool.query(`CREATE TABLE agent_runs (id uuid PRIMARY KEY, "userId" text NOT NULL, "deviceId" uuid NOT NULL, status text NOT NULL, "stopRequestedAt" timestamptz, "leaseExpiresAt" timestamptz, "agentId" uuid NOT NULL, "agentDefinition" jsonb, "botId" uuid)`)
  await pool.query(`ALTER TABLE agent_runs ADD COLUMN "issueId" uuid, ADD COLUMN "workspaceId" uuid`)
  await pool.query(`CREATE TABLE issues (id uuid PRIMARY KEY, "workspaceId" uuid, "ownershipState" text NOT NULL DEFAULT 'pending', "scopeVersion" integer NOT NULL DEFAULT 0, content jsonb)`)
  await pool.query(`ALTER TABLE agent_runs ADD COLUMN "machineAuthority" boolean NOT NULL DEFAULT false,
    ADD COLUMN cli_policy_hierarchy jsonb, ADD COLUMN "updatedAt" timestamptz NOT NULL DEFAULT now()`)
  await pool.query(`CREATE TABLE factory_tasks (id uuid PRIMARY KEY,"userId" text NOT NULL,"sourceEventId" uuid NOT NULL,status text NOT NULL);
    CREATE TABLE factory_attempts (id uuid PRIMARY KEY,"taskId" uuid NOT NULL,"runId" uuid NOT NULL,output jsonb NOT NULL);
    CREATE TABLE factory_events (id uuid PRIMARY KEY,"taskId" uuid NOT NULL,request jsonb NOT NULL,result jsonb NOT NULL)`)
  await pool.query(`CREATE TABLE agents (id uuid PRIMARY KEY, "userId" text NOT NULL, harness text NOT NULL, "deviceId" uuid); CREATE TABLE devices (id uuid PRIMARY KEY, "ownerId" text NOT NULL, enabled boolean NOT NULL, kind text NOT NULL DEFAULT 'local'); CREATE TABLE bots (id uuid PRIMARY KEY, "workspaceId" uuid, "ownerId" text NOT NULL); CREATE TABLE mikka_workspaces (id uuid PRIMARY KEY, "userId" text NOT NULL, name varchar(120) NOT NULL, slug varchar(64) UNIQUE, icon text, kind text NOT NULL, "createdAt" timestamptz NOT NULL DEFAULT now()); CREATE TABLE mikka_workspace_members ("workspaceId" uuid NOT NULL REFERENCES mikka_workspaces(id), "userId" text NOT NULL, name text NOT NULL, email text NOT NULL, status text NOT NULL, role text NOT NULL, "createdAt" timestamptz NOT NULL DEFAULT now(), PRIMARY KEY ("workspaceId", "userId")); CREATE TABLE agent_kit_heads (owner_id text, bot_key text, bot_id uuid, workspace_id uuid, PRIMARY KEY (owner_id, bot_key)); CREATE TABLE workspace_computer_policies ("workspaceId" uuid PRIMARY KEY, permission text NOT NULL DEFAULT 'ask')` )
  await pool.query(await readFile('drizzle/20261029011700_agent_tool_approvals.sql', 'utf8'))
  await pool.query(await readFile('drizzle/20261029011701_cli_run_policy.sql', 'utf8'))
  await pool.query(await readFile('drizzle/20261030204836_agent_tool_approval_input_digest.sql', 'utf8'))
  await pool.query(await readFile('drizzle/20261030204833_workspace_audit_events.sql', 'utf8'))
  await seedWorkspace(actor.userId, personalWorkspaceId)
  const agentId = randomUUID()
  await pool.query(`INSERT INTO agents (id,"userId",harness,"deviceId") VALUES ($1,$2,'codex',$3)`, [agentId,actor.userId,deviceId])
  await pool.query(`INSERT INTO devices (id,"ownerId",enabled) VALUES ($1,$2,true)`, [deviceId,actor.userId])
  await pool.query(`INSERT INTO agent_kit_heads (owner_id,bot_key,workspace_id) VALUES ($1,'coordinator',NULL)`, [actor.userId])
  await pool.query(`INSERT INTO agent_runs (id,"userId","deviceId",status,"leaseExpiresAt","agentId","workspaceId") VALUES ($1,$2,$3,'running',now()+interval '5 minutes',$4,$5)`, [runId,actor.userId,deviceId,agentId,personalWorkspaceId])
  initialRevision = (await readCliRunPolicy(pool, runId, actor.userId)).revision
})
after(async () => { await Promise.all([pool.end(), workspacePool.end()]) })
test('checkState rejects another device', async () => {
  await assert.rejects(store.checkState({ ...actor, deviceId: randomUUID() }, runId, initialRevision))
})

test('a stopped run is never live', async () => {
  await pool.query('UPDATE agent_runs SET "stopRequestedAt"=now() WHERE id=$1', [runId])
  await assert.rejects(store.checkState(actor, runId, initialRevision), error => error instanceof ApprovalUnavailable && error.revokeReason === undefined)
})

async function watchdogFixture(receipt = true) {
  const stoppedRun = randomUUID(), taskId = randomUUID(), attemptId = randomUUID(), epoch = randomUUID(), workerId = randomUUID()
  await pool.query(`INSERT INTO agents (id,"userId",harness,"deviceId") VALUES ($1,$2,'codex',$3)`, [workerId,actor.userId,deviceId])
  await pool.query(`INSERT INTO agent_runs (id,"userId","deviceId",status,"stopRequestedAt","leaseExpiresAt","agentId","workspaceId")
    SELECT $1,"userId","deviceId",'running',now(),now()+interval '5 minutes',$3,"workspaceId" FROM agent_runs WHERE id=$2`, [stoppedRun,runId,workerId])
  const revision = (await readCliRunPolicy(pool,stoppedRun,actor.userId)).revision
  await pool.query(`INSERT INTO factory_tasks VALUES($1,$2,$3,'blocked')`, [taskId,actor.userId,epoch])
  await pool.query('INSERT INTO factory_attempts VALUES($1,$2,$3,$4)', [attemptId,taskId,stoppedRun,{
    requestEpoch:epoch, watchdog:{reasonCode:'task_stalled',requestEpoch:epoch,stoppedAt:new Date().toISOString()},
  }])
  if (receipt) await pool.query('INSERT INTO factory_events VALUES($1,$2,$3,$4)', [randomUUID(),taskId,
    {kind:'task_watchdog',attemptId,requestEpoch:epoch},{action:'stalled',blocked:true}])
  return { runId:stoppedRun,taskId,epoch,check:() => store.checkState(actor,stoppedRun,revision),revision }
}

test('only the current epoch host watchdog receipt classifies a stopped run as lease-revoked', async () => {
  const current = await watchdogFixture()
  await assert.rejects(current.check(), error => error instanceof ApprovalUnavailable && error.revokeReason === 'device_lost')
  await pool.query('UPDATE factory_tasks SET "sourceEventId"=$2 WHERE id=$1', [current.taskId,randomUUID()])
  await assert.rejects(current.check(), error => error instanceof ApprovalUnavailable && error.revokeReason === undefined)
  const noReceipt = await watchdogFixture(false)
  await assert.rejects(noReceipt.check(), error => error instanceof ApprovalUnavailable && error.revokeReason === undefined)
})

test('watchdog cause does not escape owner, device or cancelled-task boundaries', async () => {
  const current = await watchdogFixture()
  for (const foreign of [{...actor,deviceId:randomUUID()},{...actor,userId:'another-owner'}]) {
    await assert.rejects(store.checkState(foreign,current.runId,current.revision), error => !(error instanceof ApprovalUnavailable) || error.revokeReason === undefined)
  }
  await pool.query(`UPDATE factory_tasks SET status='cancelled' WHERE id=$1`, [current.taskId])
  await assert.rejects(current.check(), error => error instanceof ApprovalUnavailable && error.revokeReason === undefined)
})

test('an actually expired lease carries its cause, while a manual stop and terminal run do not', async () => {
  const current = await watchdogFixture(false)
  await pool.query(`UPDATE agent_runs SET "stopRequestedAt"=NULL,"leaseExpiresAt"=now()-interval '1 second' WHERE id=$1`, [current.runId])
  await assert.rejects(current.check(), error => error instanceof ApprovalUnavailable && error.revokeReason === 'device_lost')
  await pool.query('UPDATE agent_runs SET "stopRequestedAt"=now() WHERE id=$1', [current.runId])
  await assert.rejects(current.check(), error => error instanceof ApprovalUnavailable && error.revokeReason === undefined)
  await pool.query(`UPDATE agent_runs SET "stopRequestedAt"=NULL,status='failed' WHERE id=$1`, [current.runId])
  await assert.rejects(current.check(), error => error instanceof ApprovalUnavailable && error.revokeReason === undefined)
})

test('a changed policy revision cannot be hidden by an expired lease or watchdog stop', async () => {
  for (const expired of [false,true]) {
    const current = await watchdogFixture()
    if (expired) await pool.query(`UPDATE agent_runs SET "stopRequestedAt"=NULL,"leaseExpiresAt"=now()-interval '1 second' WHERE id=$1`, [current.runId])
    await setCliPolicy(pool,actor.userId,current.runId,'worker',current.revision,{permissions:{install_dependency:'deny'}})
    await assert.rejects(current.check(), error => error instanceof ApprovalUnavailable && error.revokeReason === undefined)
    const updated = await readCliRunPolicy(pool,current.runId,actor.userId)
    assert.notEqual(updated.revision,current.revision)
    await assert.rejects(store.checkState(actor,current.runId,updated.revision), error => error instanceof ApprovalUnavailable && error.revokeReason === 'device_lost')
  }
})

test('a changed worker policy ends the live check for the old revision', async () => {
  await pool.query('UPDATE agent_runs SET "stopRequestedAt"=NULL WHERE id=$1', [runId])
  await setCliPolicy(pool, actor.userId, runId, 'worker', initialRevision, { permissions: { install_dependency:'deny' } })
  assert.equal(await store.check(actor, runId, initialRevision), false)
  const current = await readCliRunPolicy(pool,runId,actor.userId)
  assert.equal(current.policy.permissions.install_dependency, 'deny')
  assert.equal(await store.check(actor, runId, current.revision), true)
})

test('workspace may narrow agent policy, rejects forged generations, and invalidates a recreated fixture', async () => {
  const wid=randomUUID(), botId=randomUUID(), workerId=randomUUID(), scopedRun=randomUUID()
  await pool.query(`INSERT INTO bots VALUES ($1,$2,$3)`, [botId,wid,actor.userId])
  await seedWorkspace(actor.userId,wid,'team')
  const guard = (workspaceId: string, userId: string, signal: AbortSignal) => acquireWorkspaceMembership(pool, {workspaceId,userId},signal)
  await pool.query(`INSERT INTO agents (id,"userId",harness,"deviceId") VALUES ($1,$2,'codex',$3)`, [workerId,actor.userId,deviceId])
  await pool.query(`INSERT INTO agent_kit_heads (owner_id,bot_key,workspace_id,cli_run_policy) VALUES ($1,$2,$3,$4)`, [actor.userId,botId,wid,{permissions:{install_dependency:'allow'}}])
  await pool.query(`INSERT INTO workspace_computer_policies ("workspaceId",cli_run_policy) VALUES ($1,$2)`, [wid,{permissions:{install_dependency:'deny'}}])
  await pool.query(`INSERT INTO agent_runs (id,"userId","deviceId",status,"leaseExpiresAt","agentId","botId","workspaceId") VALUES ($1,$2,$3,'running',now()+interval '5 minutes',$4,$5,$6)`, [scopedRun,actor.userId,deviceId,workerId,botId,wid])
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
  await pool.query(`UPDATE mikka_workspace_members SET status='removed' WHERE "workspaceId"=$1 AND "userId"=$2`, [wid,actor.userId])
  await pool.query(`UPDATE agent_runs SET "leaseExpiresAt"=now()-interval '1 second' WHERE id=$1`, [scopedRun])
  await assert.rejects(scopedStore.checkState(actor,scopedRun,recreated.revision), error => !(error instanceof ApprovalUnavailable) || error.revokeReason === undefined)
})

test('workspace policy changes immediately stop botless machine runs only in the persisted tenant', async () => {
  const userId = `workspace-stop-${randomUUID()}`, workerId = randomUUID(), device = randomUUID(), botId = randomUUID()
  const workspaceId = await seedWorkspace(userId,randomUUID(),'team')
  const otherWorkspaceId = await seedWorkspace(userId,randomUUID(),'team')
  await pool.query(`INSERT INTO devices (id,"ownerId",enabled) VALUES ($1,$2,true)`, [device,userId])
  await pool.query(`INSERT INTO agents (id,"userId",harness,"deviceId") VALUES ($1,$2,'codex',$3)`, [workerId,userId,device])
  await pool.query(`INSERT INTO bots VALUES ($1,$2,$3)`, [botId,workspaceId,userId])
  const own = randomUUID(), other = randomUUID(), staleBot = randomUUID(), staleHierarchy = randomUUID(), legacy = randomUUID()
  // Retained legacy hints cannot override a non-null tenant. This isolated
  // schema deliberately preserves such historical rows for the stop reader.
  for (const [id, tenant, bot, hierarchy] of [
    [own,workspaceId,null,null], [other,otherWorkspaceId,null,null],
    [staleBot,otherWorkspaceId,botId,null],
    [staleHierarchy,otherWorkspaceId,null,{ workspaceId,teamId:randomUUID(),projectId:null }],
    [legacy,null,botId,null],
  ] as const) {
    await pool.query(`INSERT INTO agent_runs (id,"userId","deviceId",status,"leaseExpiresAt","agentId","workspaceId","botId",cli_policy_hierarchy,"machineAuthority")
      VALUES ($1,$2,$3,'running',now()+interval '5 minutes',$4,$5,$6,$7,true)`, [id,userId,device,workerId,tenant,bot,hierarchy])
  }
  const initial = await readCliRunPolicy(pool,own,userId)
  const changed = await setCliPolicy(pool,userId,own,'workspace',initial.revision,{permissions:{install_dependency:'deny'}})
  assert.equal(changed.policy.permissions.install_dependency,'deny')
  const { rows } = await pool.query<{ id: string; stopped: boolean; expired: boolean }>(`SELECT id,"stopRequestedAt" IS NOT NULL AS stopped,"leaseExpiresAt"<=clock_timestamp() AS expired
    FROM agent_runs WHERE id=ANY($1::uuid[])`, [[own,other,staleBot,staleHierarchy,legacy]])
  assert.equal(rows.length,5)
  for (const row of rows) {
    const expected = row.id === own || row.id === legacy
    assert.equal(row.stopped,expected,'only the persisted tenant or an unbound legacy tenant is stopped')
    assert.equal(row.expired,expected,'revocation expires the machine lease in the policy transaction')
  }
})

test('legacy local runs materialize stable sandbox defaults without changing explicit choices', async () => {
  const user=`legacy-${randomUUID()}`, workerId=randomUUID(), legacyRun=randomUUID(), legacyDevice=randomUUID()
  await pool.query('INSERT INTO devices (id,"ownerId",enabled) VALUES ($1,$2,true)',[legacyDevice,user])
  await pool.query(`INSERT INTO agents (id,"userId",harness,"deviceId") VALUES ($1,$2,'codex',$3)`,[workerId,user,legacyDevice])
  const workspaceId = await seedWorkspace(user)
  await pool.query(`INSERT INTO agent_runs (id,"userId","deviceId",status,"leaseExpiresAt","agentId","workspaceId") VALUES ($1,$2,$3,'running',now()+interval '5 minutes',$4,$5)`,[legacyRun,user,legacyDevice,workerId,workspaceId])
  const first=await readCliRunPolicy(pool,legacyRun,user)
  const second=await readCliRunPolicy(pool,legacyRun,user)
  assert.equal(first.policy.permissions.install_dependency,'allow')
  // Network is open by default (decision 2026-11-01-1230).
  assert.equal(first.policy.permissions.network,'allow')
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

test('unbound workers get open network defaults and only owned cloud devices are read',async()=>{
 const user=`device-defaults-${randomUUID()}`,worker=randomUUID(),device=randomUUID()
 await pool.query(`INSERT INTO agents(id,"userId",harness) VALUES($1,$2,'codex')`,[worker,user])
 const unbound=await readCliAgentPolicy(pool,user,worker,null)
 // Network is open by default everywhere (decision 2026-11-01-1230).
 assert.equal(unbound.policy.permissions.network,'allow')
 await pool.query(`INSERT INTO devices(id,"ownerId",enabled,kind) VALUES($1,$2,true,'cloud')`,[device,user])
 await pool.query('UPDATE agents SET "deviceId"=$2 WHERE id=$1',[worker,device])
 const cloud=await readCliAgentPolicy(pool,user,worker,null)
 assert.equal(cloud.policy.permissions.network,'allow')
 assert.notEqual(cloud.revision,unbound.revision)
 await pool.query(`UPDATE agents SET cli_run_policy='{"permissions":{"network":"deny"}}' WHERE id=$1`,[worker])
 assert.equal((await readCliAgentPolicy(pool,user,worker,null)).policy.permissions.network,'deny')
 await pool.query('UPDATE devices SET "ownerId"=$2 WHERE id=$1',[device,'someone-else'])
 await assert.rejects(readCliAgentPolicy(pool,user,worker,null),/agentPolicyUnavailable/)
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

test('human control preserves the existing lease, then expires through the existing liveness poll', async () => {
  await pool.query(`ALTER TABLE agent_runs ADD COLUMN "pauseReason" text, ADD COLUMN "resumeStatus" text`)
  await pool.query(`CREATE TABLE computer_run_bindings ("runId" uuid, "botId" uuid, "ownerId" text, "workspaceId" uuid);
    CREATE TABLE bot_desktops ("botId" uuid, "ownerId" text, "workspaceId" uuid, control text, "controlUntil" timestamptz)`)
  const bot = randomUUID(), workspace = personalWorkspaceId
  await pool.query(`INSERT INTO computer_run_bindings VALUES ($1,$2,$3,$4)`, [runId,bot,actor.userId,workspace])
  await pool.query(`INSERT INTO bot_desktops VALUES ($1,$2,$3,'user',now()+interval '5 minutes')`, [bot,actor.userId,workspace])
  await pool.query(`UPDATE agent_runs SET status='running',"stopRequestedAt"=NULL,"leaseExpiresAt"=now()+interval '1 hour' WHERE id=$1`, [runId])
  const revision = (await readCliRunPolicy(pool,runId,actor.userId)).revision
  let statusReads = 0
  const observed = new AgentToolApprovalStore({ query: pool.query.bind(pool), connect: async () => {
    const client = await pool.connect()
    return new Proxy(client, { get(target, key) {
      if (key === 'query') return (...args: unknown[]) => {
        if (String(args[0]).startsWith('SELECT status FROM agent_runs')) statusReads++
        return Reflect.apply(target.query, target, args)
      }
      const value = Reflect.get(target, key, target)
      return typeof value === 'function' ? value.bind(target) : value
    } })
  } })
  const checkState = async (reads: number) => {
    statusReads = 0
    const result = await observed.checkState(actor,runId,revision)
    assert.equal(statusReads, reads, 'unpaused checks reuse the locked status; paused checks reread after their update')
    return result
  }
  assert.deepEqual(await checkState(1),{live:true,paused:false})
  await pool.query(`UPDATE agent_runs SET status='paused',"pauseReason"='human_control',"resumeStatus"='running' WHERE id=$1`, [runId])
  const lease = (await pool.query('SELECT "leaseExpiresAt" FROM agent_runs WHERE id=$1',[runId])).rows[0].leaseExpiresAt
  assert.deepEqual(await checkState(2),{live:true,paused:true})
  await pool.query(`UPDATE agent_runs SET "leaseExpiresAt"=now()-interval '1 second' WHERE id=$1`, [runId])
  await assert.rejects(observed.checkState(actor,runId,revision))
  await pool.query('UPDATE agent_runs SET "leaseExpiresAt"=$2 WHERE id=$1', [runId,lease])
  await pool.query(`UPDATE bot_desktops SET "controlUntil"=now()-interval '1 second' WHERE "botId"=$1`, [bot])
  assert.deepEqual(await checkState(2),{live:true,paused:false})
  const resumed = (await pool.query('SELECT status,"pauseReason","resumeStatus","leaseExpiresAt" FROM agent_runs WHERE id=$1',[runId])).rows[0]
  assert.deepEqual(resumed,{status:'running',pauseReason:null,resumeStatus:null,leaseExpiresAt:lease})
})

async function distributionFixture(workspace = false) {
  const userId = `distribution-${randomUUID()}`, deviceId = randomUUID(), agentId = randomUUID(), runId = randomUUID()
  const workspaceId = await seedWorkspace(userId,randomUUID(),workspace ? 'team' : 'personal',workspace ? 'member' : 'admin'), botId = workspace ? randomUUID() : null
  await pool.query('INSERT INTO devices (id,"ownerId",enabled) VALUES ($1,$2,true)', [deviceId,userId])
  await pool.query(`INSERT INTO agents (id,"userId",harness,"deviceId") VALUES ($1,$2,'codex',$3)`, [agentId,userId,deviceId])
  if (botId) await pool.query('INSERT INTO bots VALUES ($1,$2,$3)', [botId,workspaceId,userId])
  await pool.query(`INSERT INTO agent_runs (id,"userId","deviceId",status,"leaseExpiresAt","agentId","botId","workspaceId")
    VALUES ($1,$2,$3,'preparing',now()+interval '5 minutes',$4,$5,$6)`, [runId,userId,deviceId,agentId,botId,workspaceId])
  const membership = (workspaceId: string, userId: string, signal: AbortSignal) => acquireWorkspaceMembership(pool, {workspaceId,userId}, signal)
  const current = await readCliRunPolicy(pool,runId,userId,membership)
  return { actor: {userId,deviceId}, runId, agentId, workspaceId, current, membership }
}

test('policy distribution resolves each fresh request once under the original transaction', async t => {
  const fixture = await distributionFixture(true)
  const statements: string[] = []
  const observed = new AgentToolApprovalStore({ query: pool.query.bind(pool), connect: async () => {
    const client = await pool.connect()
    return new Proxy(client, { get(target,key) {
      if (key === 'query') return (...args: unknown[]) => {
        statements.push(String(args[0]))
        return Reflect.apply(target.query,target,args)
      }
      const value = Reflect.get(target,key,target)
      return typeof value === 'function' ? value.bind(target) : value
    } })
  } }, fixture.membership)
  for (let request = 1; request <= 2; request++) {
    statements.length = 0
    assert.deepEqual(await observed.policyDistribution(fixture.actor,fixture.runId,fixture.current.revision), fixture.current)
    const resolutions = statements.filter(sql => sql.startsWith('SELECT "botId","agentId","issueId"')).length
    t.diagnostic(JSON.stringify({kind:'policy_distribution_queries',request,appStatements:statements.length,policyResolutions:resolutions}))
    assert.equal(resolutions,1,'each fresh request must resolve its locked policy once')
    assert.equal(statements[0],'BEGIN')
    assert.equal(statements.at(-1),'COMMIT')
    assert.equal(statements.filter(sql => sql.startsWith('SELECT id FROM agent_runs') && sql.includes('FOR UPDATE')).length,1)
  }
})

test('policy distribution retains owner, device, revision, stop, lease and state refusals', async () => {
  const fixture = await distributionFixture()
  const current = new AgentToolApprovalStore(pool,fixture.membership)
  await assert.rejects(current.policyDistribution({...fixture.actor,userId:'another-owner'},fixture.runId), ApprovalUnavailable)
  await assert.rejects(current.policyDistribution({...fixture.actor,deviceId:randomUUID()},fixture.runId), ApprovalUnavailable)
  await assert.rejects(current.policyDistribution(fixture.actor,fixture.runId,'stale-revision'), ApprovalUnavailable)
  for (const update of [
    `"stopRequestedAt"=now()`,
    `"leaseExpiresAt"=now()-interval '1 second'`,
    `status='succeeded'`,
  ]) {
    await pool.query(`UPDATE agent_runs SET ${update} WHERE id=$1`, [fixture.runId])
    await assert.rejects(current.policyDistribution(fixture.actor,fixture.runId,fixture.current.revision), ApprovalUnavailable)
    await pool.query(`UPDATE agent_runs SET "stopRequestedAt"=NULL,"leaseExpiresAt"=now()+interval '5 minutes',status='preparing' WHERE id=$1`, [fixture.runId])
  }
  await pool.query(`UPDATE agent_runs SET status='paused' WHERE id=$1`, [fixture.runId])
  assert.deepEqual(await current.policyDistribution(fixture.actor,fixture.runId,fixture.current.revision), fixture.current)
})

test('policy distribution refuses membership withdrawn after policy locks but before the membership lease', {timeout:10000}, async () => {
  const fixture = await distributionFixture(true)
  const entered = Promise.withResolvers<void>(), proceed = Promise.withResolvers<void>()
  const guarded = new AgentToolApprovalStore(pool, async (workspaceId,userId,signal) => {
    entered.resolve()
    await proceed.promise
    return fixture.membership(workspaceId,userId,signal)
  })
  const pending = guarded.policyDistribution(fixture.actor,fixture.runId,fixture.current.revision)
  void pending.catch(() => undefined)
  try {
    await Promise.race([entered.promise,pending])
    await pool.query(`UPDATE mikka_workspace_members SET status='removed' WHERE "workspaceId"=$1 AND "userId"=$2`, [fixture.workspaceId,fixture.actor.userId])
  } finally { proceed.resolve(); await pending.catch(() => undefined) }
  await assert.rejects(pending,/Workspace membership lease unavailable/)
  // Rejection rolled back and released the APP locks as well as the membership connection.
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(`SET LOCAL lock_timeout='250ms'`)
    await client.query(`UPDATE agent_runs SET "stopRequestedAt"=now() WHERE id=$1`, [fixture.runId])
    await client.query('COMMIT')
  } finally { await client.query('ROLLBACK'); client.release() }
})

test('policy distribution holds run, policy and membership locks through its guarded commit', {timeout:10000}, async () => {
  const fixture = await distributionFixture(true)
  const entered = Promise.withResolvers<void>(), proceed = Promise.withResolvers<void>()
  let closed = 0
  const guarded = new AgentToolApprovalStore(pool, async (workspaceId,userId,signal) => {
    const lease = await fixture.membership(workspaceId,userId,signal)
    entered.resolve()
    return { ...lease,
      async check() { await proceed.promise; await lease.check() },
      async close() { closed++; await lease.close() },
    }
  })
  const pending = guarded.policyDistribution(fixture.actor,fixture.runId,fixture.current.revision)
  void pending.catch(() => undefined)
  try {
    await Promise.race([entered.promise,pending])
    for (const [sql,values] of [
      [`UPDATE mikka_workspace_members SET status='removed' WHERE "workspaceId"=$1 AND "userId"=$2`, [fixture.workspaceId,fixture.actor.userId]],
      [`UPDATE agent_runs SET "stopRequestedAt"=now() WHERE id=$1`, [fixture.runId]],
      [`UPDATE agents SET cli_run_policy=cli_run_policy WHERE id=$1`, [fixture.agentId]],
    ] as const) {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        await client.query(`SET LOCAL lock_timeout='100ms'`)
        await assert.rejects(client.query(sql,[...values]), (error: unknown) => (error as {code?:string}).code === '55P03')
      } finally { await client.query('ROLLBACK'); client.release() }
    }
  } finally { proceed.resolve(); await pending.catch(() => undefined) }
  assert.deepEqual(await pending,fixture.current)
  assert.equal(closed,1)
  await pool.query(`UPDATE mikka_workspace_members SET status='removed' WHERE "workspaceId"=$1 AND "userId"=$2`, [fixture.workspaceId,fixture.actor.userId])
  await assert.rejects(new AgentToolApprovalStore(pool,fixture.membership).policyDistribution(fixture.actor,fixture.runId), error =>
    error instanceof Error && error.message === 'agentPolicyUnavailable' && error.cause instanceof ActionFailureError && error.cause.code === 'workspaceAccessDenied')
})
