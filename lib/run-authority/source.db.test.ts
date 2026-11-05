import {after,before,test} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {Pool} from 'pg'
import {instrumentFixtureAuthority} from '../../tests/helpers/run-authority-version-fixture'
import {completeRunAuthoritySource} from './source'

const raw=process.env.E2E_DATABASE_URL
if(!raw)throw Error('Explicit disposable database required')
const base=new URL(raw)
if(base.hostname!=='127.0.0.1'||!/^\/authority_[a-z0-9_]+_e2e$/.test(base.pathname))throw Error('Only this authority fixture loopback target is permitted')
const suffix=randomUUID().replaceAll('-','')
const appURL=new URL(base),workspaceURL=new URL(base)
appURL.pathname=`/authority_app_${suffix}_e2e`;workspaceURL.pathname=`/authority_workspace_${suffix}_e2e`
const prior={MIKKA_DATABASE_URL:process.env.MIKKA_DATABASE_URL,DATABASE_URL:process.env.DATABASE_URL}
process.env.MIKKA_DATABASE_URL=appURL.toString();process.env.DATABASE_URL=workspaceURL.toString()
let app:Pool,workspace:Pool
before(async()=>{
  const admin=new Pool({connectionString:base.toString(),max:1})
  try {
    await admin.query(`CREATE DATABASE "${appURL.pathname.slice(1)}"`)
    await admin.query(`CREATE DATABASE "${workspaceURL.pathname.slice(1)}"`)
  } finally {await admin.end()}
  await promisify(execFile)(process.execPath,['scripts/migrate.mjs'],{env:{...process.env,MIGRATE:'1'},maxBuffer:4<<20,timeout:120_000})
  app=(await import('../db/index')).pool
  workspace=(await import('../workspace-db')).workspacePool
  assert.notEqual((await app.query('SELECT current_database() AS name')).rows[0].name,(await workspace.query('SELECT current_database() AS name')).rows[0].name)
  await instrumentFixtureAuthority(app);await instrumentFixtureAuthority(workspace)
  console.info(JSON.stringify({event:'authority_version_databases',app:appURL.pathname.slice(1),workspace:workspaceURL.pathname.slice(1),instrumentation:'test-only all public tables'}))
})
after(async()=>{
  await Promise.all([app?.end(),workspace?.end()])
  for(const [name,value] of Object.entries(prior)){if(value===undefined)delete process.env[name];else process.env[name]=value}
})

async function fixture() {
  const owner=`authority-${randomUUID()}`,deviceId=randomUUID(),agentId=randomUUID(),issueId=randomUUID(),botId=randomUUID(),workspaceId=randomUUID(),runId=randomUUID()
  await app.query(`INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt")VALUES($1,'Synthetic authority',$2,true,now(),now())`,[owner,`${owner}@example.invalid`])
  await workspace.query(`INSERT INTO mikka_workspaces(id,"userId",name)VALUES($1,$2,'Synthetic authority workspace')`,[workspaceId,owner])
  await workspace.query(`INSERT INTO mikka_workspace_members("workspaceId","userId",name,email,role,status)VALUES($1,$2,'Synthetic authority',$3,'admin','active')`,[workspaceId,owner,`${owner}@example.invalid`])
  await app.query(`INSERT INTO bots(id,"ownerId","workspaceId",name)VALUES($1,$2,$3,'Synthetic authority Bot')`,[botId,owner,workspaceId])
  await app.query(`INSERT INTO devices(id,"ownerId",name,kind)VALUES($1,$2,'Synthetic authority device','local')`,[deviceId,owner])
  await app.query(`INSERT INTO agents(id,"userId","deviceId",harness,name)VALUES($1,$2,$3,'codex','Synthetic authority agent')`,[agentId,owner,deviceId])
  await app.query(`INSERT INTO issues(id,"userId",title,content,status,priority,scope)VALUES($1,$2,'Synthetic authority task',$3,'todo','normal','personal')`,[issueId,owner,JSON.stringify({type:'doc',attrs:{mikka:{number:1}},content:[]})])
  await app.query(`INSERT INTO agent_runs(id,"userId","deviceId","agentId","botId","issueId",status,"leaseExpiresAt",kind,prompt)VALUES($1,$2,$3,$4,$5,$6,'running',now()+interval '5 minutes','implement','No model invocation')`,[runId,owner,deviceId,agentId,botId,issueId])
  const {AgentToolApprovalStore}=await import('../agent-tool-approval/store')
  const {readCliRunPolicy}=await import('../agent-tool-approval/policy-store')
  const revision=(await readCliRunPolicy(app,runId,owner)).revision
  const store=new AgentToolApprovalStore(app)
  const stats={full:0,appVersionQueries:0,workspaceVersionQueries:0}
  const counted=(pool:Pool,key:'appVersionQueries'|'workspaceVersionQueries')=>({query:((...args:unknown[])=>{
    stats[key]++;return Reflect.apply(pool.query,pool,args)
  }) as Pool['query']})
  const read=async()=>{
    stats.full++
    const state=await store.checkState({userId:owner,deviceId},runId,revision)
    const {rows:[timed]}=await app.query(`SELECT EXTRACT(EPOCH FROM("leaseExpiresAt"-clock_timestamp()))*1000 AS ms FROM agent_runs WHERE id=$1`,[runId])
    return {live:state.live&&!state.paused,validForMs:Number(timed?.ms)}
  }
  const source=(reader:typeof read=read)=>completeRunAuthoritySource({runId,app:counted(app,'appVersionQueries'),workspace:counted(workspace,'workspaceVersionQueries'),read:reader})
  const challenge={runId,nonce:randomUUID()}
  return {owner,deviceId,agentId,issueId,botId,workspaceId,runId,revision,stats,read,source,challenge}
}

test('brackets the actual CLI policy and real membership reader across distinct databases',async()=>{
  const f=await fixture()
  assert.equal((await f.source()(f.challenge,new AbortController().signal)).live,true)
  assert.deepEqual(f.stats,{full:1,appVersionQueries:2,workspaceVersionQueries:2})
  console.info(JSON.stringify({event:'authority_complete_snapshot',...f.stats,physicalDatabases:2,cache:'none'}))
})

test('does not publish a positive snapshot when real Stop commits after the full App read',async()=>{
  const f=await fixture(),{stopOwnedRun}=await import('../run-control'),{db}=await import('../db/index')
  let changed=false
  const read=async()=>{
    const value=await f.read()
    if(!changed){changed=true;await stopOwnedRun(db,f.owner,f.runId)}
    return value
  }
  await assert.rejects(f.source(read)(f.challenge,new AbortController().signal),/approvalUnavailable/)
  assert.equal(f.stats.full,2)
  assert.equal((await app.query(`SELECT "stopRequestedAt" IS NOT NULL AS stopped FROM agent_runs WHERE id=$1`,[f.runId])).rows[0].stopped,true)
})

test('does not publish a positive snapshot when Workspace membership is revoked after the full read',async()=>{
  const f=await fixture()
  let changed=false
  const read=async()=>{
    const value=await f.read()
    if(!changed){changed=true;await workspace.query(`UPDATE mikka_workspace_members SET status='suspended' WHERE "workspaceId"=$1 AND "userId"=$2`,[f.workspaceId,f.owner])}
    return value
  }
  await assert.rejects(f.source(read)(f.challenge,new AbortController().signal),/membership lease unavailable/i)
  assert.equal(f.stats.full,2)
})

test('rolls back the business write and dependency version together',async()=>{
  const f=await fixture(),tx=await app.connect()
  try {
    const before=(await app.query(`SELECT revision::text FROM run_authority_version`)).rows[0].revision
    await tx.query('BEGIN')
    await tx.query(`UPDATE agent_runs SET "stopRequestedAt"=now() WHERE id=$1`,[f.runId])
    assert.notEqual((await tx.query(`SELECT revision::text FROM run_authority_version`)).rows[0].revision,before)
    assert.equal((await app.query(`SELECT revision::text FROM run_authority_version`)).rows[0].revision,before,'uncommitted authority cannot leak into a barrier')
    await tx.query('ROLLBACK')
    assert.equal((await app.query(`SELECT revision::text FROM run_authority_version`)).rows[0].revision,before)
    assert.equal((await f.source()(f.challenge,new AbortController().signal)).live,true)
    assert.equal(f.stats.full,1)
  } finally {await tx.query('ROLLBACK');tx.release()}
})

test('captures a normal FK parent deletion between complete read and publication',async()=>{
  const f=await fixture()
  let changed=false
  const read=async()=>{
    const value=await f.read()
    if(!changed){changed=true;await app.query(`DELETE FROM agents WHERE id=$1`,[f.agentId])}
    return value
  }
  await assert.rejects(f.source(read)(f.challenge,new AbortController().signal),/approvalUnavailable/)
  assert.equal(f.stats.full,2)
  assert.equal((await app.query(`SELECT id FROM agent_runs WHERE id=$1`,[f.runId])).rowCount,0,'the normal agent FK cascades to its run')
})

test('re-reads after changes in both databases even when the final values return to their originals',async()=>{
  const f=await fixture()
  let changed=false
  const read=async()=>{
    const value=await f.read()
    if(!changed){
      changed=true
      await app.query(`UPDATE agent_runs SET status='preparing' WHERE id=$1`,[f.runId])
      await app.query(`UPDATE agent_runs SET status='running' WHERE id=$1`,[f.runId])
      await workspace.query(`UPDATE mikka_workspace_members SET status='suspended' WHERE "workspaceId"=$1 AND "userId"=$2`,[f.workspaceId,f.owner])
      await workspace.query(`UPDATE mikka_workspace_members SET status='active' WHERE "workspaceId"=$1 AND "userId"=$2`,[f.workspaceId,f.owner])
    }
    return value
  }
  assert.equal((await f.source(read)(f.challenge,new AbortController().signal)).live,true)
  assert.deepEqual(f.stats,{full:2,appVersionQueries:4,workspaceVersionQueries:4})
})

