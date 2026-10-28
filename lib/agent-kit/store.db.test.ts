import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { before, after, test } from 'node:test'
import { Pool } from 'pg'
import { DEFAULT_AGENT_DEFINITION, builtinAgentDefinition } from './builtin'
import { digest } from './definition'
import { DECISION_MODEL } from '../coordinator/decision'
import { AgentKitStore, type AgentScope } from './store'
import { CORE_EVAL_CASES, EVAL_RUNNER_VERSION, bindSemanticEvidence, type EvalReport } from './evals'
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
before(async()=>{
  // Setup is metadata-only. The historical migration rebuilds triggers, so it
  // must not be replayed automatically under the resource-retention rule.
  for(const name of ['user','bots','agent_runs','agent_kit_heads','agent_kit_versions','agent_kit_executions','agent_kit_events','agent_kit_proposals','agent_kit_evaluations','agent_kit_activations']){
    const {rows}=await pool.query("select to_regclass(format('%I.%I',current_schema(),$1::text)) as relation",[name])
    assert.ok(rows[0]?.relation,`Existing isolated Agent Kit schema required: ${name}; no automatic migration or rebuild`)
  }
})
after(async()=>{await pool.end()})
async function owner(bot=true):Promise<AgentScope>{
  const ownerId=`test-agent-kit-${randomUUID()}`
  const botId=bot ? randomUUID() : null
  const workspaceId=bot ? randomUUID() : null
  await pool.query('insert into "user"(id,name,email,"emailVerified","createdAt","updatedAt") values($1,$2,$3,false,now(),now())',[ownerId,'Synthetic Agent Kit',`${ownerId}@example.com`])
  console.info(JSON.stringify({event:'agent_kit_fixture_owner_retained',ownerId,botId,workspaceId}))
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
// Synthetic DB activation contract only; no model is invoked by this fixture.
function report(definitionDigest:string,passed:boolean,mode:'fixture'|'live'):EvalReport {
  const suiteDigest=digest(CORE_EVAL_CASES),hostInstructions='synthetic test host policy',hostInstructionsDigest=digest(hostInstructions)
  const results=CORE_EVAL_CASES.map(item=>{
    const result={caseId:item.id,passed,failures:passed?[]:['testFailure']}
    if(mode!=='live') return result
    const semantic=bindSemanticEvidence({
      testCase:item,trace:{text:'synthetic contract',outcome:item.expectedOutcome,tools:[]},
      definitionDigest,hostInstructionsDigest,hostInstructions,suiteDigest,
    },{
      decision:passed?'pass':'fail',execution:{
        executionId:randomUUID(),modelId:DECISION_MODEL,providerGenerationId:'synthetic-database-contract',
        startedAt:'2026-10-28T20:00:00Z',completedAt:'2026-10-28T20:00:00Z',
        requestDigest:digest('synthetic-database-contract'),imageDigests:[],vision:'no-image-input',
      },
    })
    return {...result,semantic}
  })
  return {runnerVersion:EVAL_RUNNER_VERSION,suiteDigest,definitionDigest,hostInstructionsDigest,
    mode,model:mode==='live'?'synthetic-test-model':null,results,
    passed:passed?CORE_EVAL_CASES.length:0,total:CORE_EVAL_CASES.length,errors:0}
}

test('the unchanged Agent Kit migration replays only in a newly created CI-owned database and retains historical rows',async t=>{
  // The newer user authorization covers this run's NEW managed CI resources.
  // It does not permit replay against a prior dedicated retained database.
  assert.ok(actions,'Migration replay requires this Actions job\'s owned temporary PostgreSQL service')
  const migration=readFileSync(new URL('../../drizzle/20261027181000_agent_kit.sql',import.meta.url),'utf8')
  assert.equal(createHash('sha256').update(migration).digest('hex'),'365230faab874af93a8f696a1f83f1b3276a83bb6ea933b3939a6b654dea1be2')
  const database=`mikka_agent_kit_replay_${randomUUID().replaceAll('-','')}`
  assert.match(database,/^mikka_agent_kit_replay_[a-f0-9]{32}$/)
  await pool.query(`create database "${database}"`)
  t.diagnostic(JSON.stringify({event:'agent_kit_replay_database_created',database,retention:'retain',syntheticRowsMaximum:1}))
  const isolatedTarget=new URL(connectionString)
  isolatedTarget.pathname='/'+database
  const isolated=new Pool({connectionString:isolatedTarget.href,max:1})
  try{
    const actual=await isolated.query('select current_database() as database')
    assert.equal(actual.rows[0].database,database)
    await isolated.query(`
      create table "user"(id text primary key);
      create table bots(id uuid primary key,"ownerId" text not null references "user"(id),"workspaceId" uuid not null,unique(id,"workspaceId","ownerId"));
      create table agent_runs(id uuid primary key);
    `)
    const historicalId=randomUUID()
    await isolated.query('insert into agent_runs(id) values($1)',[historicalId])
    await isolated.query(migration)
    await isolated.query(migration)
    const rows=await isolated.query('select "agentDefinition" from agent_runs where id=$1',[historicalId])
    assert.deepEqual(rows.rows,[{agentDefinition:null}],'migration replay does not invent or delete historical execution evidence')
    const triggers=await isolated.query("select tgname from pg_trigger where tgrelid in ('agent_kit_versions'::regclass,'agent_kit_events'::regclass,'agent_kit_activations'::regclass,'agent_kit_executions'::regclass) and not tgisinternal order by tgname")
    assert.deepEqual(triggers.rows.map(row=>row.tgname),['agent_kit_activations_immutable','agent_kit_events_immutable','agent_kit_execution_guard','agent_kit_versions_immutable'])
    const constraint=await isolated.query("select count(*)::int as count from pg_constraint where conrelid='agent_kit_heads'::regclass and conname='agent_kit_active_version_fk'")
    assert.equal(constraint.rows[0].count,1)
  }finally{
    await isolated.end()
    t.diagnostic(JSON.stringify({event:'agent_kit_replay_database_retained',database}))
  }
})

test('existing migrated schema leaves historical runs unrecorded',async()=>{
  const id=randomUUID();await pool.query('insert into agent_runs(id) values($1)',[id]).catch(async()=>{
    // A full app schema has required run identity; its nullable column is checked directly instead.
    const column=await pool.query("select is_nullable,column_default from information_schema.columns where table_name='agent_runs' and column_name='agentDefinition'")
    assert.equal(column.rows[0].is_nullable,'YES');assert.equal(column.rows[0].column_default,null)
  })
  const rows=await pool.query('select "agentDefinition" from agent_runs where id=$1',[id])
  if(rows.rowCount) assert.equal(rows.rows[0].agentDefinition,null)
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
  const legacy={...defaults,tools:defaults.tools.filter(name=>name!=='read_gmail_message')}
  const initial=await store.beginExecution(scope,'turn-1','HOST ONE',{harness:'codex',model:null},legacy)
  await store.save(scope,{...defaults,instructions:'new behavior'},1,randomUUID(),defaults)
  const hostDefaults=builtinAgentDefinition({computerEnabled:true})
  const stored=await store.active(scope,hostDefaults)
  assert.deepEqual(stored.definition,{...defaults,instructions:'new behavior'})
  assert.equal(stored.definition.tools.includes('list_computer_bots'),false)
  const replay=await store.beginExecution(scope,'turn-1','HOST TWO',{harness:'ai_sdk',model:'different'},defaults)
  assert.deepEqual(replay.snapshot,initial.snapshot)
  assert.equal(replay.snapshot.hostInstructions,'HOST ONE')
  assert.equal(replay.snapshot.revision,1)
  assert.equal(replay.snapshot.effectiveTools.includes('read_gmail_message'),false)
  const next=await store.beginExecution(scope,'turn-2','HOST TWO',{harness:'ai_sdk',model:'different'},hostDefaults)
  assert.equal(next.snapshot.revision,2)
  assert.equal(next.snapshot.effectiveTools.includes('read_gmail_message'),true)
  assert.equal(next.snapshot.effectiveTools.includes('list_computer_bots'),false)
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
