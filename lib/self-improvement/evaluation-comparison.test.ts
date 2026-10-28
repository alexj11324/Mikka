import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { digest } from './contract'
import { compareRegisteredEvaluation,currentModelEvaluation,isModelEvaluationResult,type ComparisonState,type EvaluationComparisonSnapshot,type ModelEvaluationResult } from './evaluation-comparison'
import { createSkillComparisonCollector } from './comparison-collector'
import { createRegisteredSkillEvaluator,type RegisteredSkillEvaluator } from './registered-evaluation'
import { registeredComparisonFixture } from './testing/registered-comparison-fixture'
import { syntheticDecision } from './testing/evaluation-fixture'
import { syntheticModelResult } from './testing/evaluation-result-fixture'

function fixture() {
  const f=registeredComparisonFixture(),c=f.context
  const snapshot:EvaluationComparisonSnapshot={evaluationId:c.evaluationId,instanceId:c.instanceId,proposalId:c.proposalId,
    candidateVersionId:c.candidateVersionId,scope:c.scope,instanceDigest:c.instance.instanceDigest,
    baselineSha256:c.baselineVersion.artifact.sha256,candidateSha256:c.candidateVersion.artifact.sha256,evidenceDigest:'a'.repeat(64)}
  let state:ComparisonState={snapshot,stored:null},commits=0,reads=0,inRead=false
  const read=async()=>{assert.equal(inRead,false);inRead=true;reads++;try{return structuredClone(state)}finally{inRead=false}}
  const commit=async(before:EvaluationComparisonSnapshot,result:ModelEvaluationResult)=>{
    assert.equal(inRead,false);assert.equal(digest(before),digest(state.snapshot));commits++
    if(!state.stored)state.stored={result,digest:digest(result)}
    return currentModelEvaluation(state.stored,state.snapshot)
  }
  const evaluator=(choice:string,onInvoke?:()=>void)=>createRegisteredSkillEvaluator({
    loadComparison:createSkillComparisonCollector(f.pool,f.authorize,f.readObject),modelEvaluationEnabled:true,
    invokeDecision:async(...args)=>{assert.equal(inRead,false);onInvoke?.();return syntheticDecision(choice)(...args)}})
  return {f,snapshot,read,commit,evaluator,get state(){return state},set state(next){state=next},
    get commits(){return commits},get reads(){return reads}}
}

test('no model or trusted collection means pending without filling the immutable result slot',async()=>{
  for(const assess of [undefined,(async()=>{throw Error('unavailable')}) as RegisteredSkillEvaluator]){
    const f=fixture(),result=await compareRegisteredEvaluation(f.f.request.userId,{read:f.read,commit:f.commit,assess})
    assert.equal(result.passed,false);assert.equal(result.semantic.status,'pending');assert.equal(result.semantic.improved,null)
    assert.equal(f.commits,0);assert.equal(f.state.stored,null);assert.equal(f.reads,2)
  }
})

test('structured model assessment controls semantic effect with current case/artifact bindings',async()=>{
  for(const choice of ['improved','not_improved','regressed','unknown']){
    const f=fixture(),result=await compareRegisteredEvaluation(f.f.request.userId,{read:f.read,commit:f.commit,assess:f.evaluator(choice)})
    assert.equal(result.passed,choice==='improved');assert.equal(result.productionEligible,false)
    assert.equal(result.semantic.outcome,choice);assert.equal(f.commits,choice==='unknown'?0:1)
    assert.equal(result.semantic.execution?.vision,'no-image-input')
  }
})

test('model disabled uses the actual collector but cannot claim improvement or commit a final result',async()=>{
  const f=fixture();let modelCalls=0
  const assess=createRegisteredSkillEvaluator({loadComparison:createSkillComparisonCollector(f.f.pool,f.f.authorize,f.f.readObject),
    modelEvaluationEnabled:false,invokeDecision:async()=>{modelCalls++;throw Error('must not invoke')}})
  const result=await compareRegisteredEvaluation(f.f.request.userId,{read:f.read,commit:f.commit,assess})
  assert.equal(result.semantic.reason,'decision_model_disabled');assert.equal(modelCalls,0);assert.equal(f.commits,0)
  assert.ok(f.f.readKeys.length>0)
})

test('stale source, permission revocation and foreign candidate never commit an assessment',async()=>{
  const f=fixture()
  await assert.rejects(compareRegisteredEvaluation(f.f.request.userId,{read:f.read,commit:f.commit,
    assess:f.evaluator('improved',()=>{f.state={snapshot:{...f.snapshot,evidenceDigest:'b'.repeat(64)},stored:null}})}))
  assert.equal(f.commits,0)
  const revoked=fixture()
  const result=await compareRegisteredEvaluation(revoked.f.request.userId,{read:revoked.read,commit:revoked.commit,
    assess:revoked.evaluator('improved',()=>revoked.f.revoke())})
  assert.equal(result.semantic.status,'pending');assert.equal(revoked.commits,0)
  const foreign=fixture(),assess=foreign.evaluator('improved')
  const mismatch=await compareRegisteredEvaluation(foreign.f.request.userId,{read:foreign.read,commit:foreign.commit,
    assess:async(...args)=>({...await assess(...args),registeredBinding:{evaluationId:randomUUID(),instanceId:foreign.snapshot.instanceId,
      proposalId:foreign.snapshot.proposalId,issueId:foreign.snapshot.scope.issueId,candidateVersionId:foreign.snapshot.candidateVersionId,sourceCommit:foreign.snapshot.scope.sourceCommit}})})
  assert.equal(mismatch.semantic.reason,'assessment_binding_mismatch');assert.equal(foreign.commits,0)
})

test('immutable model results replay without a provider; changed bindings and old CPU results are rejected',async()=>{
  const f=fixture(),result=syntheticModelResult(f.snapshot)
  f.state={snapshot:f.snapshot,stored:{result,digest:digest(result)}}
  const replay=await compareRegisteredEvaluation(f.f.request.userId,{read:f.read,commit:f.commit,
    assess:async()=>{throw Error('must not invoke during replay')}})
  assert.deepEqual(replay,result);assert.equal(f.commits,0)
  for(const change of [
    {...f.snapshot,candidateSha256:'c'.repeat(64)}, {...f.snapshot,evidenceDigest:'d'.repeat(64)},
    {...f.snapshot,scope:{...f.snapshot.scope,candidateId:randomUUID()}},
  ])assert.throws(()=>currentModelEvaluation(f.state.stored!,change),/sourceMismatch/)
  const legacy={passed:true,evaluationId:f.snapshot.evaluationId}
  assert.equal(isModelEvaluationResult(legacy),false)
  assert.throws(()=>currentModelEvaluation({result:legacy,digest:digest(legacy)},f.snapshot),/sourceMismatch/)
})

test('forged execution/scorer/outcome flags cannot become a passing saved result',()=>{
  const f=fixture(),result=syntheticModelResult(f.snapshot)
  for(const semantic of [
    {...result.semantic,execution:null}, {...result.semantic,outcome:'unknown'},
    {...result.semantic,improved:false}, {...result.semantic,scorer:{...result.semantic.scorer!,version:2}},
    {...result.semantic,execution:{...result.semantic.execution!,modelId:'different'}},
  ])assert.equal(isModelEvaluationResult({...result,semantic}),false)
})
