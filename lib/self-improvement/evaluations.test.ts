import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { benchmarkEvidence, createSkillEvaluations, type EvaluationSettings } from './evaluations'
import { BASELINE_ARTIFACT } from './builtin-skill'
import { REPORT_BENCHMARK, freezeBenchmarkInstance } from './report-benchmark'

const settings:EvaluationSettings = {harness:'codex',model:'observed-model',policyDigest:'a'.repeat(64),fixtureDigest:'b'.repeat(64),verifyCommand:REPORT_BENCHMARK.verifyCommand}
const expected = {sourceCommit:'c'.repeat(40),instanceDigest:freezeBenchmarkInstance('d'.repeat(64)).digest,settings,artifact:BASELINE_ARTIFACT,receiptId:randomUUID()}
const execution = {harness:settings.harness,requestedModel:settings.model,observedModel:settings.model,
  policyDigest:settings.policyDigest,fixtureDigest:settings.fixtureDigest,verifyCommand:settings.verifyCommand,
  sourceCommit:expected.sourceCommit,benchmarkDigest:expected.instanceDigest,caseId:REPORT_BENCHMARK.evaluationCaseIds[0]}
const row = {runId:randomUUID(),caseId:execution.caseId,versionId:BASELINE_ARTIFACT.versionId,status:'succeeded',
  report:{summary:'actual persisted output',sourceCommit:expected.sourceCommit,verify:{status:'passed',command:settings.verifyCommand,exitCode:0}},sessionId:'actual-session',stopRequestedAt:null,
  finishedAt:new Date(),deviceId:randomUUID(),mount:{receiptId:expected.receiptId,sessionId:'actual-session',
    versionId:BASELINE_ARTIFACT.versionId,sha256:BASELINE_ARTIFACT.sha256,deviceId:'',execution}}
row.mount.deviceId=row.deviceId

test('benchmark evidence uses persisted output and exact host/session/model/fixture/Skill identity',()=>{
  const result=benchmarkEvidence(row,expected)
  assert.equal(result.actualOutput,row.report.summary)
  assert.equal(result.provenance.artifactDigest,BASELINE_ARTIFACT.sha256)
  for(const changed of [
    {...row,status:'failed'}, {...row,report:{...row.report,verify:{status:'failed',command:settings.verifyCommand,exitCode:1}}}, {...row,finishedAt:null}, {...row,stopRequestedAt:new Date()}, {...row,mount:null},
    {...row,report:{...row.report,sourceCommit:'f'.repeat(40)}}, {...row,sessionId:'reused-other-session'},
    {...row,mount:{...row.mount,receiptId:randomUUID()}}, {...row,mount:{...row.mount,sha256:'f'.repeat(64)}},
    {...row,mount:{...row.mount,deviceId:randomUUID()}}, {...row,mount:{...row.mount,execution:undefined}},
    ...Object.keys(execution).map(key=>({...row,mount:{...row.mount,execution:{...execution,[key]:'forged'}}})),
  ]) assert.throws(()=>benchmarkEvidence(changed,expected),/sourceMismatch/)
})

test('unobserved provider model cannot pass despite the requested model',()=>{
  assert.throws(()=>benchmarkEvidence({...row,mount:{...row.mount,execution:{...execution,observedModel:null}}},expected),/sourceMismatch/)
})

test('freeze rejects malformed caller source IDs before opening a transaction',async()=>{
  let connections=0
  const pool={connect:async()=>{connections++;throw Error('must not connect')}} as unknown as Pool
  const service=createSkillEvaluations(pool,{authorize:async()=>true,queue:async()=>{throw Error('unused')},
    settings:async()=>settings,selectVersion:async()=>{},selectBaseline:async()=>{}})
  await assert.rejects(service.freezeBenchmark('owner','caller-controlled-sha'),/invalid/)
  assert.equal(connections,0)
})

test('missing owned source rolls back without freezing or queueing',async()=>{
  const calls:string[]=[]
  const tx={query:async(sql:string)=>{calls.push(sql);return {rows:[]}},release:()=>{calls.push('release')}} as unknown as PoolClient
  const service=createSkillEvaluations({connect:async()=>tx} as unknown as Pool,{authorize:async()=>true,
    queue:async()=>{throw Error('must not queue')},settings:async()=>settings,selectVersion:async()=>{},selectBaseline:async()=>{}})
  await assert.rejects(service.freezeBenchmark('owner',randomUUID()),/notFound/)
  assert.ok(calls.includes('ROLLBACK'))
  assert.ok(!calls.some(sql=>sql.startsWith('INSERT')))
})

test('ordinary receipted runs can finish without benchmark execution and cannot mint execution metadata',async()=>{
  const tx={query:async()=>({rows:[]})} as unknown as PoolClient
  const service=createSkillEvaluations({} as Pool,{authorize:async()=>true,queue:async()=>{throw Error('unused')},
    settings:async()=>settings,selectVersion:async()=>{},selectBaseline:async()=>{}})
  await service.validateExecution(tx,'owner',randomUUID(),undefined)
  await assert.rejects(service.validateExecution(tx,'owner',randomUUID(),execution),/sourceRequired/)
})
