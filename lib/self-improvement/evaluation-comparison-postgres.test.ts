import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { Pool } from 'pg'
import { createSkillComparisonCollector } from './comparison-collector'
import { createRegisteredSkillEvaluator } from './registered-evaluation'
import { createSkillEvaluations } from './evaluations'
import { handleImprovement } from './http'
import { registeredComparisonFixture } from './testing/registered-comparison-fixture'
import { syntheticDecision } from './testing/evaluation-fixture'

// New retained synthetic projection only. No historical SQL, migration runner,
// app server, model/provider, existing-row mutation or teardown deletion.
const DDL = [
  'CREATE TABLE issues(id uuid PRIMARY KEY)',
  'CREATE TABLE improvement_evaluation_results("evaluationId" uuid PRIMARY KEY,result jsonb,digest text)',
  'CREATE TABLE improvement_skill_evaluations(id uuid PRIMARY KEY,"instanceId" uuid,"userId" text,"proposalId" uuid,"candidateVersionId" uuid,scope jsonb)',
  'CREATE TABLE improvement_benchmark_instances(id uuid PRIMARY KEY,"userId" text,"issueId" uuid,"agentId" uuid,"repoId" uuid,"sourceRunId" uuid,"sourceCommit" text,"definitionDigest" text,"instanceDigest" text,seed text,settings jsonb)',
  'CREATE TABLE improvement_skill_candidates("versionId" uuid PRIMARY KEY,"userId" text,"issueId" uuid,"agentId" uuid,"repoId" uuid,"proposalId" uuid,"factoryTaskId" uuid,"candidateId" uuid,repository text,"commitSha" text,path text,"baselineVersionId" uuid)',
  'CREATE TABLE improvement_skill_versions(id uuid PRIMARY KEY,artifact jsonb,markdown text)',
  'CREATE TABLE factory_tasks(id uuid PRIMARY KEY,"userId" text,"issueId" uuid,"attemptId" uuid,"candidateId" uuid,status text)',
  'CREATE TABLE factory_candidates(id uuid PRIMARY KEY,"taskId" uuid,sha text,repository text)',
  'CREATE TABLE agent_runs(id uuid PRIMARY KEY,"userId" text,"issueId" uuid,"agentId" uuid,"deviceId" uuid,"deviceRepoId" uuid,status text,"sessionId" text,"startedAt" timestamptz,"finishedAt" timestamptz,"stopRequestedAt" timestamptz,"baseBranch" text,prompt text,report jsonb)',
  'CREATE TABLE agents(id uuid PRIMARY KEY,"userId" text,"deviceId" uuid,harness text)',
  'CREATE TABLE devices(id uuid PRIMARY KEY,"ownerId" text,enabled boolean)',
  'CREATE TABLE device_repos(id uuid PRIMARY KEY,"userId" text,"deviceId" uuid,"repoPath" text)',
  'CREATE TABLE improvement_skill_receipts(id uuid PRIMARY KEY,"runId" uuid,"userId" text,receipt jsonb)',
  'CREATE TABLE improvement_skill_mounts("runId" uuid PRIMARY KEY,"userId" text,"deviceId" uuid,"receiptId" uuid,"versionId" uuid,sha256 text,"sessionId" text,"mountedAt" timestamptz,execution jsonb)',
  'CREATE TABLE improvement_skill_selections("runId" uuid PRIMARY KEY,"userId" text,"issueId" uuid,"agentId" uuid,"repoId" uuid,"deviceId" uuid,"versionId" uuid)',
  'CREATE TABLE improvement_skill_run_purposes("runId" uuid PRIMARY KEY,"userId" text,"versionId" uuid,purpose text,"evaluationId" uuid)',
  'CREATE TABLE improvement_benchmark_runs("runId" uuid PRIMARY KEY,"instanceId" uuid,"evaluationId" uuid,"caseId" text,arm text,"versionId" uuid,"userId" text)',
  'CREATE TABLE improvement_skill_lifecycle("versionId" uuid,"userId" text,operation text)',
  'CREATE TABLE artifacts(id uuid PRIMARY KEY,"userId" text,"issueId" uuid,"runId" uuid,kind text)',
  'CREATE TABLE artifact_versions("artifactId" uuid,version integer,"storageKey" text,"inlineContent" text,sha256 text,size integer,"createdAt" timestamptz)',
  `CREATE FUNCTION reject_comparison_rewrite() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'immutable'; END $$`,
  'CREATE TRIGGER evaluation_result_immutable BEFORE UPDATE OR DELETE ON improvement_evaluation_results FOR EACH ROW EXECUTE FUNCTION reject_comparison_rewrite()',
]
test('retained PG17/HTTP handler: actual evaluation snapshots, pending, immutable replay and current lineage', {timeout:30000},async t=>{
  assert.ok(process.env.SKILL_COMPARISON_TEST_URL,'Explicit dedicated local projection target required; this test never silently skips')
  const target=new URL(process.env.SKILL_COMPARISON_TEST_URL)
  assert.ok(['127.0.0.1','localhost','[::1]'].includes(target.hostname));assert.equal(target.pathname,'/mikka_improvement')
  assert.equal(target.port,'55439');assert.equal(target.username,'improvement');assert.equal(target.password,'');assert.equal(target.search,'')
  const schema=`skill_model_comparison_${randomUUID().replaceAll('-','')}`
  const admin=new Pool({connectionString:target.toString(),max:1})
  const pools:Pool[]=[]
  // Only release this test's own connections. Server, schema, rows and logs stay.
  t.after(async()=>{await Promise.all(pools.map(pool=>pool.end()));await admin.end()})
  assert.equal((await admin.query('SHOW server_version_num')).rows[0].server_version_num.slice(0,2),'17')
  await admin.query(`CREATE SCHEMA "${schema}"`)
  target.searchParams.set('options',`-c search_path=${schema}`)
  // A one-connection pool exposes any connection retained over model/storage awaits.
  const pool=new Pool({connectionString:target.toString(),max:1});pools.push(pool)
  for(const statement of DDL)await pool.query(statement)
  async function insert(table:string,record:Record<string,unknown>){
    assert.match(table,/^[a-z_]+$/)
    const keys=Object.keys(record);assert.ok(keys.every(key=>/^[a-zA-Z][a-zA-Z0-9]*$/.test(key)))
    await pool.query(`INSERT INTO ${table}(${keys.map(key=>`"${key}"`).join(',')}) VALUES(${keys.map((_,i)=>`$${i+1}`).join(',')})`,keys.map(key=>record[key]))
  }
  const f=registeredComparisonFixture(),c=f.context
  await insert('issues',{id:f.request.issueId})
  await insert('improvement_benchmark_instances',c.instance)
  await insert('improvement_skill_candidates',c.metadata)
  await insert('improvement_skill_versions',c.baselineVersion)
  await insert('improvement_skill_versions',c.candidateVersion)
  await insert('factory_tasks',c.task)
  await insert('factory_candidates',c.factoryCandidate)
  await insert('agent_runs',c.sourceRun)
  await insert('improvement_skill_receipts',c.sourceReceipt)
  await insert('devices',{id:c.sourceRun.deviceId,ownerId:f.request.userId,enabled:true})
  await insert('agents',{id:c.instance.agentId,userId:f.request.userId,deviceId:c.sourceRun.deviceId,harness:c.instance.settings.harness})
  await insert('device_repos',{id:c.instance.repoId,userId:f.request.userId,deviceId:c.sourceRun.deviceId,repoPath:'/synthetic/case'})
  await insert('improvement_skill_evaluations',{id:c.evaluationId,instanceId:c.instanceId,userId:f.request.userId,proposalId:c.proposalId,candidateVersionId:c.candidateVersionId,scope:c.scope})
  for(const row of f.runs){
    await insert('agent_runs',row.run);await insert('improvement_skill_mounts',row.mount)
    await insert('improvement_skill_receipts',row.receipt);await insert('improvement_skill_selections',row.selection)
    if(row.purpose)await insert('improvement_skill_run_purposes',row.purpose)
    await insert('improvement_benchmark_runs',{runId:row.runId,instanceId:row.instanceId,evaluationId:row.evaluationId,caseId:row.caseId,arm:row.arm,versionId:row.versionId,userId:row.userId})
  }
  for(const document of f.documents){
    const{artifactId,runId,kind,...version}=document
    await insert('artifacts',{id:artifactId,userId:f.request.userId,issueId:f.request.issueId,runId,kind})
    await insert('artifact_versions',{artifactId,...version})
  }
  let syntheticModelCalls=0
  const loadComparison=createSkillComparisonCollector(pool,f.authorize,f.readObject)
  const service=(enabled:boolean)=>createSkillEvaluations(pool,{authorize:async(user,issue)=>f.authorize(user,issue),
    queue:async()=>{throw Error('No Harness dispatch in a projection test')},selectBaseline:async()=>{},selectVersion:async()=>{},
    settings:async()=>c.instance.settings,
    assess:createRegisteredSkillEvaluator({loadComparison,modelEvaluationEnabled:enabled,invokeDecision:async(...args)=>{
      syntheticModelCalls++;assert.equal(pool.idleCount,pool.totalCount)
      return syntheticDecision('improved')(...args)
    }})})
  const off=service(false)
  const request=()=>new Request('https://synthetic.invalid/api/self-improvement',{method:'POST',headers:{origin:'https://synthetic.invalid','content-type':'application/json'},
    body:JSON.stringify({action:'compare_evaluation',evaluationId:c.evaluationId})})
  const store={} as Parameters<typeof handleImprovement>[0]
  const response=await handleImprovement(store,request(),f.request.userId,undefined,undefined,undefined,off)
  assert.equal(response.status,200)
  const pending=await response.json()
  assert.equal(pending.semantic.reason,'decision_model_disabled');assert.equal(pending.passed,false)
  assert.equal(pending.semantic.improved,null);assert.equal(syntheticModelCalls,0)
  assert.equal((await pool.query('SELECT * FROM improvement_evaluation_results')).rowCount,0)
  const noResultTx=await pool.connect()
  try {await noResultTx.query('BEGIN');await assert.rejects(off.passingEvaluation(noResultTx,f.request.userId,c.proposalId,c.candidateVersionId,c.evaluationId),/sourceRequired/)}
  finally {await noResultTx.query('ROLLBACK');noResultTx.release()}
  const on=service(true) // Synthetic transport only. No runtime provider is imported.
  const assessed=await handleImprovement(store,request(),f.request.userId,undefined,undefined,undefined,on)
  assert.equal(assessed.status,200)
  const result=await assessed.json()
  assert.equal(result.kind,'registered-skill-model-v1');assert.equal(result.passed,true)
  assert.equal(result.productionEligible,false);assert.equal(result.semantic.execution.providerGenerationId,'synthetic-generation')
  assert.equal(syntheticModelCalls,1)
  assert.equal((await pool.query('SELECT * FROM improvement_evaluation_results')).rowCount,1)
  assert.equal((await pool.query("SELECT tgname FROM pg_trigger WHERE tgrelid='improvement_evaluation_results'::regclass AND tgname='evaluation_result_immutable'")).rowCount,1)
  assert.deepEqual(await off.compare(f.request.userId,c.evaluationId),result)
  assert.equal(syntheticModelCalls,1,'A saved result replays without provider work, even with the runtime model gate OFF')
  const tx=await pool.connect()
  try {await tx.query('BEGIN');const passing=await off.passingEvaluation(tx,f.request.userId,c.proposalId,c.candidateVersionId,c.evaluationId)
    assert.equal(passing.result.passed,true)}finally {await tx.query('ROLLBACK');tx.release()}
  // Leave only this newly-created fixture altered for inspection. No restoration.
  await pool.query('UPDATE improvement_skill_mounts SET "sessionId"=$2 WHERE "runId"=$1',[f.runs[0].runId,'tampered-synthetic-session'])
  await assert.rejects(off.compare(f.request.userId,c.evaluationId),/sourceMismatch/)
  await pool.query('UPDATE devices SET enabled=false WHERE id=$1',[c.sourceRun.deviceId])
  await assert.rejects(off.compare(f.request.userId,c.evaluationId),/runUnavailable/)
  assert.equal((await pool.query('SELECT * FROM improvement_evaluation_results')).rowCount,1)
  console.info(JSON.stringify({retainedSchema:schema,scope:'new synthetic projection only',historicalSqlReplay:false,
    syntheticModelCalls,realModelCalls:0,actualHarnessDispatch:false,productionAcceptance:false}))
})
