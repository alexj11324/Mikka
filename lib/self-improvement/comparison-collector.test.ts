import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { createSkillComparisonCollector } from './comparison-collector'
import { createConfiguredSkillEvaluator, createRegisteredSkillEvaluator } from './registered-evaluation'
import { createSkillCandidate,BASELINE } from './regression'
import { digest } from './contract'
import { REPORT_BENCHMARK } from './report-benchmark'
import { registeredComparisonFixture } from './testing/registered-comparison-fixture'
import { syntheticDecision } from './testing/evaluation-fixture'

test('actual registered case contract collects distinct runs, mount receipts and stored Markdown/HTML without fetching document links',async()=>{
  const f=registeredComparisonFixture(),load=createSkillComparisonCollector(f.pool,f.authorize,f.readObject)
  const comparison=await load(f.request)
  assert.ok(comparison);assert.equal(comparison.baselineRuns.length,REPORT_BENCHMARK.evaluationCaseIds.length)
  assert.equal(comparison.candidateRuns.length,REPORT_BENCHMARK.evaluationCaseIds.length)
  assert.equal(new Set([...comparison.baselineRuns,...comparison.candidateRuns].map(r=>r.runId)).size,f.runs.length)
  assert.equal(comparison.sourceCommit,'a'.repeat(40));assert.equal(comparison.candidateCommitSha,'b'.repeat(40))
  assert.equal(comparison.requiresVisual,false);assert.deepEqual(f.readKeys,[f.documents[1].storageKey])
  assert.ok(comparison.candidateRuns.at(-1)?.documents[0].text.includes('https://untrusted.invalid'))
  assert.ok(f.queryCalls.some(call=>call.sql.includes('artifact_versions')&&call.values[0]===f.request.userId))
})

test('owner/source/instance/case/arm/mount/version/settings/text mismatches remain unknown evidence',async()=>{
  const mutations:((f:ReturnType<typeof registeredComparisonFixture>)=>void)[]=[
    f=>{f.context.instance.definitionDigest='0'.repeat(64)},
    f=>{f.context.scope.sourceCommit=f.context.metadata.commitSha},
    f=>{f.context.factoryCandidate.sha='c'.repeat(40)},
    f=>{f.context.task.status='revoked'},
    f=>{f.runs.pop()},
    f=>{f.runs[0].run.sessionId=f.runs[1].run.sessionId},
    f=>{f.runs[0].mount.receiptId=randomUUID()},
    f=>{f.runs[0].receipt.receipt.id=randomUUID()},
    f=>{f.runs[0].mount.execution.observedModel='different-model'},
    f=>{f.runs[0].mount.execution.sourceCommit=f.context.metadata.commitSha},
    f=>{f.runs[0].run.report.sourceCommit=f.context.metadata.commitSha},
    f=>{f.runs[0].run.prompt+='altered fixed task'},
    f=>{f.runs[0].run.stopRequestedAt='2026-01-01T00:00:00Z' as never},
    f=>{f.runs.at(-1)!.purpose!.evaluationId=randomUUID()},
    f=>{f.documents[0].storageKey='foreign/key.md'},
    f=>{f.documents[0].inlineContent='tampered'},
    f=>{f.documents[0].createdAt='2020-01-01T00:00:00Z'},
  ]
  for(const mutate of mutations){const f=registeredComparisonFixture();mutate(f)
    assert.equal(await createSkillComparisonCollector(f.pool,f.authorize,f.readObject)(f.request),null)}
  const f=registeredComparisonFixture();f.revoke()
  assert.equal(await createSkillComparisonCollector(f.pool,f.authorize,f.readObject)(f.request),null)
  assert.equal(f.queryCalls.length,0)
})

test('storage I/O cannot retain a stale owner authorization or substitute bytes',async()=>{
  const f=registeredComparisonFixture()
  const load=createSkillComparisonCollector(f.pool,f.authorize,async key=>{const value=await f.readObject(key);f.revoke();return value})
  assert.equal(await load(f.request),null)
  const altered=registeredComparisonFixture()
  assert.equal(await createSkillComparisonCollector(altered.pool,altered.authorize,async()=>'<p>different bytes</p>')(altered.request),null)
})

test('document count and total text bytes fail closed before storage reads, without changing quality thresholds',async()=>{
  const many=registeredComparisonFixture()
  while(many.documents.length<101)many.documents.push({...many.documents[0],artifactId:randomUUID()})
  assert.equal(await createSkillComparisonCollector(many.pool,many.authorize,many.readObject)(many.request),null)
  assert.equal(many.readKeys.length,0)
  const large=registeredComparisonFixture()
  for(const document of large.documents)document.size=64000
  assert.equal(await createSkillComparisonCollector(large.pool,large.authorize,large.readObject)(large.request),null)
  assert.equal(large.readKeys.length,0)
})

test('server-shaped loadComparison is actually consumed while live model evaluation stays OFF',async()=>{
  const f=registeredComparisonFixture(),loadComparison=createSkillComparisonCollector(f.pool,f.authorize,f.readObject)
  let modelCalls=0
  const evaluator=createRegisteredSkillEvaluator({loadComparison,modelEvaluationEnabled:false,invokeDecision:async()=>{modelCalls++;throw Error('must not call')}})
  const result=await evaluator(f.request.userId,{id:f.request.proposalId,issueId:f.request.issueId})
  assert.equal(result.reason,'decision_model_disabled');assert.equal(result.status,'pending');assert.equal(result.improved,null)
  assert.ok(result.evidenceDigest);assert.equal(result.artifactBaselineSha256,f.context.baselineVersion.artifact.sha256)
  assert.equal(result.artifactCandidateSha256,f.context.candidateVersion.artifact.sha256);assert.equal(modelCalls,0)
  assert.equal(result.baselineDigest,digest(BASELINE));assert.notEqual(result.baselineDigest,result.artifactBaselineSha256)
  assert.notEqual(result.candidateDigest,createSkillCandidate().candidateDigest,'Different frozen candidate bytes cannot satisfy the legacy bridge identity')
})

test('injected semantic judgment uses the unchanged real case definitions, preserves no-image meaning, and revalidates after the await',async()=>{
  const f=registeredComparisonFixture(),loadComparison=createSkillComparisonCollector(f.pool,f.authorize,f.readObject)
  const evaluator=createRegisteredSkillEvaluator({loadComparison,modelEvaluationEnabled:true,invokeDecision:async(...args)=>{
    assert.ok(typeof args[1]!=='string');assert.equal(args[1].images?.length,0)
    assert.ok(args[1].text.includes(f.context.instance.instanceDigest));assert.ok(args[1].text.includes(f.context.metadata.commitSha))
    return syntheticDecision('not_improved')(...args)
  }})
  const p={id:f.request.proposalId,issueId:f.request.issueId}
  const result=await evaluator(f.request.userId,p)
  assert.equal(result.outcome,'not_improved');assert.equal(result.execution?.vision,'no-image-input');assert.equal(result.productionEligible,false)
  const revoke=createRegisteredSkillEvaluator({loadComparison,modelEvaluationEnabled:true,invokeDecision:async(...args)=>{
    const response=await syntheticDecision()(...args);f.revoke();return response}})
  const denied=await revoke(f.request.userId,p)
  assert.equal(denied.reason,'comparison_changed');assert.equal(denied.improved,null)
})

test('production evaluator defaults to no paid judgment; explicit host configuration reaches the real assessment chain',async()=>{
  const f=registeredComparisonFixture(),loadComparison=createSkillComparisonCollector(f.pool,f.authorize,f.readObject)
  let calls=0
  const dependencies={loadComparison,invokeDecision:async(...args:Parameters<ReturnType<typeof syntheticDecision>>)=>{calls++;return syntheticDecision()(...args)}}
  const proposal={id:f.request.proposalId,issueId:f.request.issueId,evaluationId:f.request.evaluationId}
  for(const env of [{},{MIKKA_SKILL_MODEL_EVALUATION:'0'},{MIKKA_SKILL_MODEL_EVALUATION:'true'}]){
    const pending=await createConfiguredSkillEvaluator(dependencies,env)(f.request.userId,proposal)
    assert.equal(pending.reason,'decision_model_disabled');assert.equal(pending.status,'pending')
  }
  assert.equal(calls,0)
  const assessed=await createConfiguredSkillEvaluator(dependencies,{MIKKA_SKILL_MODEL_EVALUATION:'1'})(f.request.userId,proposal)
  assert.equal(calls,1);assert.equal(assessed.status,'assessed');assert.equal(assessed.outcome,'improved')
  assert.equal(assessed.registeredBinding?.evaluationId,f.request.evaluationId)
  assert.equal(assessed.productionEligible,false);assert.equal(assessed.independentVerification,false)
})

test('the enabled production cost switch cannot bypass unavailable current comparison authority',async()=>{
  const f=registeredComparisonFixture(),loadComparison=createSkillComparisonCollector(f.pool,f.authorize,f.readObject)
  let calls=0
  f.revoke()
  const result=await createConfiguredSkillEvaluator({loadComparison,invokeDecision:async(...args)=>{calls++;return syntheticDecision()(...args)}},
    {MIKKA_SKILL_MODEL_EVALUATION:'1'})(f.request.userId,{id:f.request.proposalId,issueId:f.request.issueId})
  assert.equal(calls,0);assert.equal(result.reason,'trusted_comparison_unavailable');assert.equal(result.status,'pending')
})
