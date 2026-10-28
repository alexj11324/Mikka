import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { Pool } from 'pg'
import { createSkillComparisonCollector } from './comparison-collector'
import { createRegisteredSkillEvaluator } from './registered-evaluation'
import { registeredComparisonFixture } from './testing/registered-comparison-fixture'
import { createSkillCandidate } from './regression'

// A projection of existing #316/main read contracts, not application migration
// history. Setup only creates fresh named fixtures and inserts synthetic rows;
// no historical SQL, teardown cleanup, deletion or resource restoration runs.
const DDL = [
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
]
test('retained PG17 projection: actual owner/run/case/mount/version/document SELECTs, with live model OFF',{
  skip:!process.env.SKILL_COMPARISON_TEST_URL,timeout:30000,
},async t=>{
  const target=new URL(process.env.SKILL_COMPARISON_TEST_URL!)
  assert.ok(['127.0.0.1','localhost','[::1]'].includes(target.hostname));assert.equal(target.pathname,'/mikka_improvement')
  const schema=`skill_text_collection_${randomUUID().replaceAll('-','')}`
  const admin=new Pool({connectionString:target.toString(),max:1})
  const pools:Pool[]=[]
  t.after(async()=>{await Promise.all(pools.map(pool=>pool.end()));await admin.end()})
  assert.equal((await admin.query('SHOW server_version_num')).rows[0].server_version_num.slice(0,2),'17')
  await admin.query(`CREATE SCHEMA "${schema}"`)
  target.searchParams.set('options',`-c search_path=${schema}`)
  const pool=new Pool({connectionString:target.toString(),max:2});pools.push(pool)
  for(const statement of DDL)await pool.query(statement)
  async function insert(table:string,record:Record<string,unknown>){
    assert.match(table,/^[a-z_]+$/)
    const keys=Object.keys(record);assert.ok(keys.every(key=>/^[a-zA-Z][a-zA-Z0-9]*$/.test(key)))
    await pool.query(`INSERT INTO ${table}(${keys.map(key=>`"${key}"`).join(',')}) VALUES(${keys.map((_,i)=>`$${i+1}`).join(',')})`,keys.map(key=>record[key]))
  }
  const f=registeredComparisonFixture(),c=f.context
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
  const load=createSkillComparisonCollector(pool,f.authorize,f.readObject)
  const comparison=await load(f.request);assert.ok(comparison)
  assert.equal(comparison.sourceCommit,'a'.repeat(40));assert.equal(comparison.candidateCommitSha,'b'.repeat(40))
  assert.equal(comparison.baselineRuns.length+comparison.candidateRuns.length,f.runs.length)
  const foreign=createSkillComparisonCollector(pool,async()=>true,f.readObject)
  assert.equal(await foreign({...f.request,userId:'foreign-synthetic-owner'}),null)
  let modelCalls=0
  const evaluate=createRegisteredSkillEvaluator({loadComparison:load,modelEvaluationEnabled:false,invokeDecision:async()=>{modelCalls++;return null}})
  const result=await evaluate(f.request.userId,{id:f.request.proposalId,issueId:f.request.issueId,candidate:createSkillCandidate()})
  assert.equal(result.reason,'decision_model_disabled');assert.equal(result.improved,null);assert.ok(result.evidenceDigest);assert.equal(modelCalls,0)
  // One-way synthetic tamper: leave the new fixture altered for inspection,
  // without restoring, deleting or rebuilding any existing resource.
  await pool.query('UPDATE improvement_skill_mounts SET "sessionId"=$2 WHERE "runId"=$1',[f.runs[0].runId,'tampered-synthetic-session'])
  assert.equal(await load(f.request),null)
  console.info(JSON.stringify({retainedSchema:schema,scope:'new synthetic projection only',historicalSqlReplay:false,modelCalls,productionAcceptance:false}))
})
