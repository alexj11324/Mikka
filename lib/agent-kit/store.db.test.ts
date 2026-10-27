import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { before, after, test } from 'node:test'
import { Pool } from 'pg'
import { DEFAULT_AGENT_DEFINITION } from './builtin'
import { digest } from './definition'
import { AgentKitStore, type AgentScope } from './store'
import { CORE_EVAL_CASES, EVAL_RUNNER_VERSION, type EvalReport } from './evals'
import { createAgentDefinitionHandler } from './http'

// Explicitly isolated cloud sandbox OR the existing Actions loopback DB gate.
// Never falls back to an application's DATABASE_URL or a cloud database.
const explicit=process.env.AGENT_KIT_TEST_DATABASE_URL
const connectionString=explicit ?? process.env.E2E_DATABASE_URL
if(!connectionString) throw new Error('Agent Kit database tests require an explicit isolated database')
const target=new URL(connectionString)
const loopback=['127.0.0.1','localhost'].includes(target.hostname) && !target.search && !target.hash && ['postgres:','postgresql:'].includes(target.protocol)
const dedicated=explicit && process.env.MIKKA_AGENT_KIT_ISOLATED==='1' && /^\/mikka_agent_kit_[a-z0-9_]+$/.test(target.pathname)
const actions=!explicit && process.env.CI==='true' && process.env.GITHUB_ACTIONS==='true' && target.hostname==='127.0.0.1' && target.port==='5432' && target.pathname==='/mikka_e2e' && process.env.DATABASE_URL===connectionString && process.env.MIKKA_DATABASE_URL===connectionString
if(!loopback || (!dedicated && !actions)) throw new Error('Refusing non-isolated Agent Kit test database')
const pool=new Pool({connectionString,max:12})
const store=new AgentKitStore(pool)
const defaults=DEFAULT_AGENT_DEFINITION
const migration=readFileSync(new URL('../../drizzle/20261027040500_agent_kit.sql',import.meta.url),'utf8')

before(async()=>{
  // Dedicated tests can start with only the real migration's parent contracts.
  // Existing CI uses the complete application schema and does not recreate tables.
  if(dedicated) await pool.query(`
    create table if not exists "user"(id text primary key,name text not null,email text not null unique,"emailVerified" boolean not null default false,"createdAt" timestamptz not null default now(),"updatedAt" timestamptz not null default now());
    create table if not exists bots(id uuid primary key,"ownerId" text not null references "user"(id),"workspaceId" uuid not null,name text not null,color text default 'encre',shape text default 'cercle',"createdAt" timestamptz default now(),"updatedAt" timestamptz default now(),unique(id,"workspaceId","ownerId"));
    create table if not exists agent_runs(id uuid primary key);
  `)
  await pool.query(migration)
  await pool.query(migration)
})
after(async()=>{await pool.end()})
async function owner(bot=true):Promise<AgentScope>{
  const ownerId=`test-agent-kit-${randomUUID()}`
  const botId=bot ? randomUUID() : null
  const workspaceId=bot ? randomUUID() : null
  await pool.query('insert into "user"(id,name,email,"emailVerified","createdAt","updatedAt") values($1,$2,$3,false,now(),now())',[ownerId,'Synthetic Agent Kit',`${ownerId}@example.com`])
  if(botId) await pool.query('insert into bots(id,"ownerId","workspaceId",name) values($1,$2,$3,$4)',[botId,ownerId,workspaceId,'Synthetic bot'])
  return {ownerId,botId,workspaceId}
}
async function failures(scope:AgentScope){
  const current=await store.active(scope,defaults)
  for(let index=0;index<3;index++){
    const execution=await store.beginExecution(scope,`failure-${index}`,'immutable host',{harness:'codex',model:null},defaults)
    await store.recordTool(scope,execution.id,`call-${index}`,'web_search','start')
    await store.recordTool(scope,execution.id,`call-${index}`,'web_search','finish','error')
    await store.finishExecution(scope,execution.id,'failed','tool_error')
  }
  return store.propose(scope,current.version,randomUUID(),defaults)
}
function report(definitionDigest:string,passed:boolean,mode:'fixture'|'live'):EvalReport{
  return {runnerVersion:EVAL_RUNNER_VERSION,suiteDigest:digest(CORE_EVAL_CASES),definitionDigest,mode,model:mode==='live'?'synthetic-test-model':null,results:CORE_EVAL_CASES.map(item=>({caseId:item.id,passed,failures:passed?[]:['testFailure']})),passed:passed?CORE_EVAL_CASES.length:0,total:CORE_EVAL_CASES.length,errors:0}
}

test('real PostgreSQL migration is rerunnable and historical runs stay unrecorded',async()=>{
  const id=randomUUID();await pool.query('insert into agent_runs(id) values($1)',[id]).catch(async()=>{
    // A full app schema has required run identity; its nullable column is checked directly instead.
    const column=await pool.query("select is_nullable,column_default from information_schema.columns where table_name='agent_runs' and column_name='agentDefinition'")
    assert.equal(column.rows[0].is_nullable,'YES');assert.equal(column.rows[0].column_default,null)
  })
  const rows=await pool.query('select "agentDefinition" from agent_runs where id=$1',[id])
  if(rows.rowCount) assert.equal(rows.rows[0].agentDefinition,null)
  await pool.query(migration)
})
test('concurrent first reads seed exactly one immutable default version',async()=>{
  const scope=await owner()
  const versions=await Promise.all(Array.from({length:8},()=>store.active(scope,defaults)))
  assert.equal(new Set(versions.map(item=>item.id)).size,1)
  assert.equal((await store.history(scope)).length,1)
  await assert.rejects(pool.query('update agent_kit_versions set definition=$2 where id=$1',[versions[0].id,JSON.stringify({...defaults,instructions:'tampered'})]),/agentKitImmutableRecord/)
})
test('optimistic concurrent edits have one winner and replay cannot overwrite a newer head',async()=>{
  const scope=await owner();const initial=await store.active(scope,defaults)
  const requests=[randomUUID(),randomUUID()]
  const results=await Promise.allSettled(requests.map((request,index)=>store.save(scope,{...defaults,instructions:`revision ${index}`},initial.version,request,defaults)))
  assert.equal(results.filter(item=>item.status==='fulfilled').length,1)
  const winner=results.findIndex(item=>item.status==='fulfilled')
  const version=(results[winner] as PromiseFulfilledResult<Awaited<ReturnType<typeof store.save>>>).value
  const replay=await store.save(scope,{...defaults,instructions:`revision ${winner}`},initial.version,requests[winner],defaults)
  assert.equal(replay.id,version.id)
  await assert.rejects(store.save(scope,{...defaults,instructions:'different'},initial.version,requests[winner],defaults),/agentRequestConflict/)
  assert.equal((await store.active(scope,defaults)).id,version.id)
})
test('definition reads, histories and snapshots cannot cross owners or bot scopes',async()=>{
  const one=await owner();const two=await owner()
  const version=await store.active(one,defaults)
  await store.active(two,defaults)
  await assert.rejects(store.active({...one,ownerId:two.ownerId},defaults),/agentScopeNotFound/)
  await assert.rejects(store.active({...one,workspaceId:two.workspaceId},defaults),/agentScopeNotFound/)
  await assert.rejects(store.rollback(two,version.id,1,randomUUID(),defaults),/agentVersionNotFound/)
  const execution=await store.beginExecution(one,'one','host',{harness:'codex',model:null},defaults)
  await assert.rejects(store.readExecution(two,execution.id),/agentExecutionNotFound/)
  const coordinator={ownerId:one.ownerId,botId:null,workspaceId:null}
  assert.notEqual((await store.active(coordinator,defaults)).id,version.id)
})
test('an execution pins exact definitions and host policy across edits and replay',async()=>{
  const scope=await owner()
  const initial=await store.beginExecution(scope,'turn-1','HOST ONE',{harness:'codex',model:null},defaults)
  await store.save(scope,{...defaults,instructions:'new behavior'},1,randomUUID(),defaults)
  const replay=await store.beginExecution(scope,'turn-1','HOST TWO',{harness:'ai_sdk',model:'different'},defaults)
  assert.deepEqual(replay.snapshot,initial.snapshot)
  assert.equal(replay.snapshot.hostInstructions,'HOST ONE')
  assert.equal(replay.snapshot.revision,1)
  const next=await store.beginExecution(scope,'turn-2','HOST TWO',{harness:'ai_sdk',model:'different'},defaults)
  assert.equal(next.snapshot.revision,2)
  await assert.rejects(pool.query('update agent_kit_executions set snapshot=$2 where id=$1',[initial.id,'{}']),/agentKitImmutableSnapshot/)
})
test('audit events are idempotent, immutable, redacted and closed to unassigned tools',async()=>{
  const scope=await owner();const execution=await store.beginExecution(scope,'audit','host',{harness:'codex',model:null},defaults)
  await store.recordTool(scope,execution.id,'call','web_search','start')
  await store.recordTool(scope,execution.id,'call','web_search','start')
  await store.recordTool(scope,execution.id,'call','web_search','finish','error')
  await store.recordTool(scope,execution.id,'call','web_search','finish','error')
  await assert.rejects(store.recordTool(scope,execution.id,'call','web_search','finish','ok'),/agentEventConflict/)
  await assert.rejects(store.recordTool(scope,execution.id,'unknown','shell','start'),/agentToolNotAllowed/)
  const events=await pool.query('select kind,payload from agent_kit_events where execution_id=$1',[execution.id])
  assert.equal(events.rowCount,3)
  assert.equal((await store.dataset(scope)).length,1)
  assert.doesNotMatch(JSON.stringify(events.rows),/password|arguments|access_token/)
  await assert.rejects(pool.query("update agent_kit_events set payload='{}' where execution_id=$1",[execution.id]),/agentKitImmutableRecord/)
  await store.finishExecution(scope,execution.id,'failed','tool_error')
  await assert.rejects(store.recordTool(scope,execution.id,'new-call','web_search','start'),/agentExecutionClosed/)
})
test('three distinct failure cases generate an inactive capability-preserving candidate',async()=>{
  const scope=await owner();const proposal=await failures(scope)
  assert.equal(proposal.evidence.length,3)
  assert.equal((await store.active(scope,defaults)).id,proposal.baseline_id)
  const version=(await pool.query('select definition from agent_kit_versions where id=$1',[proposal.candidate_id])).rows[0]
  assert.deepEqual(version.definition.tools,defaults.tools)
  assert.match(version.definition.instructions,/tool or runtime fails/)
  await assert.rejects(store.rollback(scope,proposal.candidate_id,1,randomUUID(),defaults),/agentCandidateNotApproved/)
})
test('fixture scores are never eligible for activation and candidates cannot overwrite a newer edit',async()=>{
  const scope=await owner();const proposal=await failures(scope)
  const job=await store.beginEvaluation(scope,proposal.id,randomUUID(),'fixture',null)
  assert.equal(job.replayed,false);if(job.replayed) return
  await store.finishEvaluation(scope,job.evaluation.id,{baseline:report(job.baseline.digest,false,'fixture'),candidate:report(job.candidate.digest,true,'fixture')})
  await assert.rejects(store.approve(scope,proposal.id,job.evaluation.id,1,randomUUID(),defaults),/agentEvaluationNotEligible/)
  await store.save(scope,{...defaults,instructions:'new user decision'},1,randomUUID(),defaults)
  await assert.rejects(store.approve(scope,proposal.id,job.evaluation.id,2,randomUUID(),defaults),/agentVersionConflict/)
})
test('evaluation reservation deduplicates requests and never accepts model or proposal substitution',async()=>{
  const scope=await owner();const proposal=await failures(scope);const request=randomUUID()
  const first=await store.beginEvaluation(scope,proposal.id,request,'fixture',null)
  const second=await store.beginEvaluation(scope,proposal.id,request,'fixture',null)
  assert.equal(second.replayed,true);assert.equal(first.evaluation.id,second.evaluation.id)
  await assert.rejects(store.beginEvaluation(scope,proposal.id,request,'live','other-model'),/agentRequestConflict/)
})
test('approval and rollback bind exact candidate, baseline and scoped evidence (synthetic report contract)',async()=>{
  const scope=await owner();const proposal=await failures(scope)
  const job=await store.beginEvaluation(scope,proposal.id,randomUUID(),'live','synthetic-test-model')
  assert.equal(job.replayed,false);if(job.replayed) return
  // These synthetic report rows validate the gate, not real model quality or provider acceptance.
  await store.finishEvaluation(scope,job.evaluation.id,{baseline:report(job.baseline.digest,false,'live'),candidate:report(job.candidate.digest,true,'live')})
  const approvalRequest=randomUUID()
  const candidate=await store.approve(scope,proposal.id,job.evaluation.id,1,approvalRequest,defaults)
  assert.equal((await store.approve(scope,proposal.id,job.evaluation.id,1,approvalRequest,defaults)).id,candidate.id)
  assert.equal(candidate.id,proposal.candidate_id)
  assert.equal((await store.active(scope,defaults)).id,candidate.id)
  const request=randomUUID()
  const rolled=await store.rollback(scope,proposal.baseline_id,candidate.version,request,defaults)
  assert.equal(rolled.id,proposal.baseline_id)
  assert.equal((await store.rollback(scope,proposal.baseline_id,candidate.version,request,defaults)).id,rolled.id)
  assert.equal((await store.active(scope,defaults)).id,rolled.id)
})
test('authenticated HTTP commands use the actual PostgreSQL store with optimistic versions',async()=>{
  const scope=await owner();const origin='https://example.test'
  const handler=createAgentDefinitionHandler({enabled:()=>true,authenticate:async()=>scope.ownerId,scope:async()=>scope,store,defaults,evaluate:async()=>{throw new Error('not invoked')}})
  const url=`${origin}/api/bots/${scope.botId}/definition`
  assert.equal((await handler(new Request(url),scope.botId!)).status,200)
  const command={action:'save',definition:{...defaults,instructions:'HTTP version'},expectedVersion:1,requestId:randomUUID()}
  const request=()=>new Request(url,{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify(command)})
  assert.equal((await handler(request(),scope.botId!)).status,200)
  assert.equal((await handler(request(),scope.botId!)).status,200)
  command.requestId=randomUUID()
  assert.equal((await handler(request(),scope.botId!)).status,409)
  assert.equal((await store.active(scope,defaults)).definition.instructions,'HTTP version')
})
