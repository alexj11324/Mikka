import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { Pool } from 'pg'
import { createExecutionClaim } from './factory/execution-claim'
import { bindSubscriptionClaim } from './subscription-claim'
const url=process.env.BYOS_CLAIM_TEST_DATABASE_URL
if(url) { const parsed=new URL(url); assert.equal(parsed.hostname,'127.0.0.1');assert.equal(parsed.pathname,'/byos_claim_fixture') }
test('real PG claim atomically publishes binding; concurrency, failure and cancellation preserve fences',{skip:!url},async()=>{
 const pool=new Pool({connectionString:url,max:12})
 try {
  await pool.query(`CREATE TABLE agent_runs(id uuid PRIMARY KEY,"userId" text,"deviceId" uuid,"agentId" uuid,status text,"retryOf" uuid,"continuesRunId" uuid,"stopRequestedAt" timestamptz,"mailboxId" uuid,"startedAt" timestamptz,"leaseExpiresAt" timestamptz,"updatedAt" timestamptz);
  CREATE TABLE factory_tasks(id uuid PRIMARY KEY); CREATE TABLE factory_attempts(id uuid,"taskId" uuid,"runId" uuid); CREATE TABLE session_mailboxes(id uuid,disabled boolean);`)
  for(const name of (await readdir('drizzle')).filter(n=>n.includes('_byos_')).sort()) await pool.query(await readFile(`drizzle/${name}`,'utf8'))
  const owner='synthetic-owner', workspace=randomUUID(), consumer=randomUUID(), device=randomUUID(), connection=randomUUID(), id=randomUUID()
  await pool.query(`INSERT INTO byos_connections(id,"ownerId","workspaceId",provider,state,epoch,"secretName","secretDigest","providerSubject") VALUES($1,$2,$3,'claude','connected',1,'mikka-byos-synthetic',repeat('a',64),'synthetic-subject')`,[connection,owner,workspace])
  await pool.query(`INSERT INTO byos_bindings(id,"ownerId","workspaceId","consumerId","connectionId","connectionRevision",route,"modelId") VALUES($1,$2,$3,$4,$5,1,'claude_code_cli','fixture')`,[id,owner,workspace,consumer,connection])
  const binding={id,ownerId:owner,workspaceId:workspace,consumerId:consumer,connectionRevision:1}
  const claim=createExecutionClaim(pool,async()=>true)
  const add=async()=>{const run=randomUUID(); await pool.query(`INSERT INTO agent_runs(id,"userId","deviceId","agentId",status) VALUES($1,$2,$3,$4,'queued')`,[run,owner,device,consumer]);return run}
  const expiry=()=>new Date(Date.now()+90000).toISOString()
  const run=await add()
  const results=await Promise.all(Array.from({length:10},()=>claim(owner,device,run,expiry(),tx=>bindSubscriptionClaim(tx,run,binding))))
  assert.equal(results.reduce((n,r)=>n+r.length,0),1)
  assert.equal((await pool.query('SELECT count(*)::int n FROM byos_native_runs')).rows[0].n,1)
  const rollback=await add()
  await assert.rejects(claim(owner,device,rollback,expiry(),async tx=>{await bindSubscriptionClaim(tx,rollback,binding);throw new Error('synthetic-after-binding-failure')}))
  assert.equal((await pool.query('SELECT status FROM agent_runs WHERE id=$1',[rollback])).rows[0].status,'queued')
  assert.equal((await pool.query('SELECT count(*)::int n FROM byos_native_runs WHERE "runId"=$1',[rollback])).rows[0].n,0)
  await pool.query('UPDATE byos_connections SET epoch=2 WHERE id=$1',[connection])
  await assert.rejects(claim(owner,device,rollback,expiry(),tx=>bindSubscriptionClaim(tx,rollback,binding)),/stale_binding/)
  await pool.query('UPDATE agent_runs SET "stopRequestedAt"=now() WHERE id=$1',[rollback])
  assert.deepEqual(await claim(owner,device,rollback,expiry(),()=>{throw new Error('must not call binding')}),[])
 } finally {await pool.end()}
})
