import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import test from 'node:test'
import {Pool} from 'pg'
import {claimCloudRun,claimLocalRun} from '../computer/claim'
import {createExecutionClaimGuard} from '../factory/execution-claim'
import {projectionTestTarget} from './testing/projection-target'

/** Actual SQL composition in fresh retained fixtures. No historical migrations,
 * provider or cleanup; only own locks/transactions/connections are released. */
test('retained PG claim composition: Factory terminal/lineage fence and native binding share the CAS transaction',{timeout:30000},async t=>{
 const target=projectionTestTarget(process.env),schema=`skill_claim_composition_${randomUUID().replaceAll('-','')}`
 const admin=new Pool({connectionString:target.toString(),max:1}),pools:Pool[]=[]
 t.after(async()=>{await Promise.all(pools.map(pool=>pool.end()));await admin.end()})
 await admin.query(`CREATE SCHEMA "${schema}"`)
 console.info(JSON.stringify({retainedSchema:schema,phase:'created',historicalSqlReplay:false,realProviderCalls:0}))
 target.searchParams.set('options',`-c search_path=${schema}`)
 const applicationName=`skill-claim-${randomUUID()}`
 const pool=new Pool({connectionString:target.toString(),max:3,application_name:applicationName});pools.push(pool)
 for(const sql of [
  'CREATE TABLE agent_runs(id uuid PRIMARY KEY,"userId" text,"deviceId" uuid,"issueId" uuid,"agentId" uuid,"retryOf" uuid,status text,"stopRequestedAt" timestamptz,"startedAt" timestamptz,"leaseExpiresAt" timestamptz,"updatedAt" timestamptz)',
  'CREATE TABLE factory_tasks(id uuid PRIMARY KEY,"userId" text,"issueId" uuid,status text,stage text,"attemptId" uuid)',
  'CREATE TABLE factory_attempts(id uuid PRIMARY KEY,"taskId" uuid,"runId" uuid,stage text,status text)',
  'CREATE TABLE computer_run_bindings("runId" uuid PRIMARY KEY)',
  'CREATE TABLE byos_native_runs("runId" uuid PRIMARY KEY,"bindingId" uuid)',
  'CREATE TABLE workspace_computer_policies("workspaceId" text PRIMARY KEY,permission text,version integer)',
 ])await pool.query(sql)
 const owner='synthetic-owner',device=randomUUID(),issue=randomUUID(),binding=randomUUID(),workspace=randomUUID()
 async function run(mode:'ordinary'|'current'|'cancelled'|'retry-unadopted'|'stopped'|'computer'){
  const id=randomUUID(),parent=mode==='retry-unadopted'?randomUUID():null
  await pool.query('INSERT INTO agent_runs(id,"userId","deviceId","issueId","agentId","retryOf",status,"stopRequestedAt") VALUES($1,$2,$3,$4,$5,$6,\'queued\',$7)',[id,owner,device,issue,randomUUID(),parent,mode==='stopped'?new Date():null])
  if(parent)await pool.query('INSERT INTO agent_runs(id,"userId","deviceId","issueId",status) VALUES($1,$2,$3,$4,\'failed\')',[parent,owner,device,issue])
  if(['current','cancelled','retry-unadopted'].includes(mode)){
   const task=randomUUID(),attempt=randomUUID()
   await pool.query('INSERT INTO factory_tasks(id,"userId","issueId",status,stage,"attemptId") VALUES($1,$2,$3,$4,\'execute\',$5)',[task,owner,issue,mode==='cancelled'?'cancelled':'running',attempt])
   await pool.query('INSERT INTO factory_attempts(id,"taskId","runId",stage,status) VALUES($1,$2,$3,\'execute\',\'running\')',[attempt,task,parent??id])
  }
  if(mode==='computer')await pool.query('INSERT INTO computer_run_bindings("runId") VALUES($1)',[id])
  return id
 }
 const guard=createExecutionClaimGuard(async(user,requested)=>user===owner&&requested===issue)
 const lease=new Date(Date.now()+60000)
 for(const mode of ['ordinary','current','cancelled','retry-unadopted','stopped','computer'] as const){
  const id=await run(mode),claim=()=>claimLocalRun(pool,id,device,lease,binding,tx=>guard(tx,owner,id))
  if(['cancelled','retry-unadopted'].includes(mode))await assert.rejects(claim,/factoryStopped|factoryRunMismatch/)
  else assert.equal(await claim(),mode==='computer'?'cloud-required':mode==='stopped'?'unavailable':'claimed')
  const {rows:[record]}=await pool.query('SELECT status FROM agent_runs WHERE id=$1',[id])
  const {rowCount}=await pool.query('SELECT 1 FROM byos_native_runs WHERE "runId"=$1',[id])
  const claimed=mode==='ordinary'||mode==='current'
  assert.equal(record.status,claimed?'preparing':'queued');assert.equal(rowCount,claimed?1:0)
 }
 // Callback failure after real row locking must not commit a CAS/native binding.
 const rollbackId=await run('current')
 await assert.rejects(claimLocalRun(pool,rollbackId,device,lease,binding,async tx=>{await guard(tx,owner,rollbackId);throw Error('Synthetic fenced failure')}),/Synthetic fenced failure/)
 assert.equal((await pool.query('SELECT status FROM agent_runs WHERE id=$1',[rollbackId])).rows[0].status,'queued')
 assert.equal((await pool.query('SELECT 1 FROM byos_native_runs WHERE "runId"=$1',[rollbackId])).rowCount,0)
 // Reproduce policy->run binding concurrency. The cloud claim must wait on
 // policy before its Factory guard locks run; the reversed order deadlocks.
 const cloudId=await run('current')
 await pool.query('INSERT INTO workspace_computer_policies("workspaceId",permission,version) VALUES($1,\'deny\',1)',[workspace])
 const binder=await pool.connect();let cloud:Promise<unknown>|undefined
 try {
  await binder.query('BEGIN')
  await binder.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`computer-policy:${workspace}`])
  cloud=claimCloudRun(pool,{userId:owner,workspaceId:workspace},cloudId,device,lease,binding,tx=>guard(tx,owner,cloudId))
  let waiting=false
  const until=Date.now()+5000
  while(Date.now()<until){
   const {rowCount}=await admin.query("SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event='advisory'",[applicationName])
   if(rowCount){waiting=true;break}
   await new Promise(resolve=>setTimeout(resolve,20))
  }
  assert.equal(waiting,true,'Cloud claim actually waits on the held policy lock')
  await binder.query('SELECT id FROM agent_runs WHERE id=$1 FOR UPDATE',[cloudId])
  await binder.query('COMMIT')
  assert.equal(await cloud,null,'Existing deny policy remains authoritative')
 }finally {await binder.query('ROLLBACK');binder.release();await cloud?.catch(()=>null)}
 assert.equal((await pool.query('SELECT status FROM agent_runs WHERE id=$1',[cloudId])).rows[0].status,'queued')
 console.info(JSON.stringify({retainedSchema:schema,phase:'verified',realProviderCalls:0,tokenIssued:false,productionAcceptance:false}))
})
