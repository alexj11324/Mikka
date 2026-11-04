import assert from 'node:assert/strict'
import test from 'node:test'
import { GROUP_BASELINE_VERSION, GROUP_POLICY_VERSION } from './group-decision-policy'
import { GROUP_REPLAY_CASE_IDS, replayGroupDecision, summarizeGroupDecisionReplay } from './group-decision-replay'
import { groupDecisionReplayInput } from './group-decision-replay-api'
import { DECISION_MODEL, type DecisionAnswer } from './decision'
import type { DecisionExecution, invokeDecision } from './decide'
import { runGroupDecisionReplay } from '../../scripts/group-decision-replay'
import { groupDecisionTotals } from './group-decision-chain'
import dataset from '../../tests/fixtures/group-decision-cases.json'

const ui='00000000-0000-4000-8000-000000000001',coding='00000000-0000-4000-8000-000000000002'
// Synthetic transport fixtures test the gate, not live model quality.
const receipt:DecisionExecution={executionId:'synthetic-execution',modelId:DECISION_MODEL,providerGenerationId:'synthetic-generation',startedAt:'2026-11-03T00:00:00.000Z',completedAt:'2026-11-03T00:00:00.100Z',requestDigest:'a'.repeat(64),imageDigests:[],vision:'no-image-input'}
let sequence=0
const answer=(values:Record<string,string>,execution?:DecisionExecution)=>({answers:new Map<string,Exclude<DecisionAnswer,{type:'refusal'}>>(Object.entries(values).map(([name,choice])=>[name,{name,type:'choice',choice}])),execution:execution??{...receipt,executionId:`synthetic-${++sequence}`,providerGenerationId:`synthetic-generation-${sequence}`}})
const response=(action:string,id:string,extra:Record<string,string>={}):typeof invokeDecision=>async(_purpose,_input,questions)=>{
  const values:Record<string,string>={intent:action==='ignore'?'ignore_ordinary_conversation':action==='delegate'?'delegate_task_followup':'reply_useful_answer',responder_0:id,responder_1:'end',responder_2:'end',task_plan:'continue_0',report_timing:'now',...extra}
  return answer(Object.fromEntries(questions.map(question=>{const value=values[question.name];assert.ok(value);return[question.name,value]})))
}

test('fixed-case replay uses the model route, never expected labels, and never executes its projection',async()=>{
  let calls=0
  const scripted=response('reply',ui)
  const invoke:typeof invokeDecision=async(purpose,input,questions,...rest)=>{
    calls++;assert.equal(purpose,'group-routing');assert.equal(questions.length,1)
    assert.ok(typeof input!=='string')
    const supplied=JSON.parse(input.text)
    assert.equal(supplied.policyVersion,GROUP_POLICY_VERSION)
    assert.ok(!('expected' in supplied));assert.doesNotMatch(input.text,/maxPublicMessages|evidenceKind/)
    // Intentionally wrong for small-talk: the observation must preserve it.
    return scripted(purpose,input,questions,...rest)
  }
  const row=await replayGroupDecision('small-talk',GROUP_POLICY_VERSION,invoke)
  assert.equal(calls,2);assert.equal(row.route?.action,'reply');assert.deepEqual(row.route?.responders,[ui])
  assert.equal(row.executionPerformed,false);assert.equal(row.policyChanged,false)
  assert.equal(row.projection?.intervention,true);assert.equal(row.decisionLatencyMs,200);assert.equal(row.decisionCostUsd,null)
  assert.deepEqual(row.decisionCalls,{attempted:2,receipted:2,unreceipted:0})
  const summary=summarizeGroupDecisionReplay([row])
  assert.equal(summary.falseIntervention,1);assert.equal(summary.logicalReplays,1);assert.equal(summary.decisionCalls.receipted,2)
  assert.ok(!JSON.stringify(row).includes('今天午饭'))
})

test('baseline and candidate share fixed inputs but use distinct prompts; mentions and task targets stay host-bound',async()=>{
  const before=await replayGroupDecision('small-talk',GROUP_BASELINE_VERSION,async(_purpose,_input,questions)=>{
    assert.ok(!questions.some(question=>question.name==='intent'));assert.equal(questions.length,1)
    return answer({[questions[0].name]:questions[0].name==='responder_0'?ui:'end'})
  })
  const after=await replayGroupDecision('small-talk',GROUP_POLICY_VERSION,response('ignore','end'))
  assert.equal(before.inputDigest,after.inputDigest);assert.equal(before.route?.action,'reply');assert.equal(after.route?.action,'ignore')
  const mentioned=await replayGroupDecision('explicit-mention',GROUP_POLICY_VERSION,async(_purpose,input,questions)=>{
    assert.ok(typeof input!=='string');const supplied=JSON.parse(input.text);assert.deepEqual(supplied.members.map((member:{id:string})=>member.id),[ui]);assert.equal(questions[0].name,'intent')
    return answer({intent:'reply_useful_answer'})
  })
  assert.equal(mentioned.route?.by,'mention');assert.deepEqual(mentioned.route?.responders,[ui])
  const scripted=response('delegate',coding,{report_timing:'on_completion'})
  const delegated=await replayGroupDecision('silent-delegation',GROUP_POLICY_VERSION,async(purpose,input,questions,...rest)=>{
    assert.ok(typeof input!=='string');const supplied=JSON.parse(input.text);assert.equal(supplied.message.tasks[0].reporterId,coding)
    return scripted(purpose,input,questions,...rest)
  })
  assert.equal(delegated.route?.delegation?.reportTiming,'on_completion');assert.equal(delegated.executionPerformed,false)
  assert.equal(delegated.decisions.length,3);assert.equal(summarizeGroupDecisionReplay([delegated]).failures.length,0)
  const noisy={...delegated,route:{...delegated.route!,delegation:{...delegated.route!.delegation!,reportTiming:'now' as const}}}
  assert.deepEqual(summarizeGroupDecisionReplay([noisy]).failures,[{caseId:'silent-delegation',reason:'report_timing'}])
})

test('missing/malformed receipts cannot be measured as actual inference; runtime faults are not invented provider responses',async()=>{
  for(const invoke of [async()=>null,async()=>{throw Error('PRIVATE_UPSTREAM_DETAIL')},async()=>answer({intent:'reply_useful_answer'},{...receipt,requestDigest:'invalid'})]) {
    const row=await replayGroupDecision('ui-help',GROUP_POLICY_VERSION,invoke)
    assert.equal(row.status,'unavailable');assert.equal(row.receipt,null);assert.equal(row.route,null);assert.equal(row.projection,null)
    assert.equal(summarizeGroupDecisionReplay([row]).measured,0);assert.ok(!JSON.stringify(row).includes('PRIVATE'))
  }
  const invalid=await replayGroupDecision('ui-help',GROUP_POLICY_VERSION,response('reply','foreign'))
  assert.equal(invalid.status,'invalid_decision');assert.ok(invalid.receipt);assert.equal(invalid.failureReason,'choice_outside_contract')
  assert.equal(invalid.decisions.length,2);assert.equal(summarizeGroupDecisionReplay([invalid]).measured,0)
  for(const id of ['unknown','decision-outage','duplicate-delivery'])await assert.rejects(replayGroupDecision(id,GROUP_POLICY_VERSION,async()=>assert.fail('no call')),/unsupported_group_replay_case/)
  assert.equal(GROUP_REPLAY_CASE_IDS.length,12)
  const normal={caseId:'ui-help',policyVersion:GROUP_POLICY_VERSION}
  assert.equal(groupDecisionReplayInput.safeParse(normal).success,true)
  for(const extra of [{prompt:'arbitrary'},{members:[]},{workspaceId:'foreign'},{userId:'foreign'},{policyVersion:'arbitrary'},{retainInvalidReceipt:true}])assert.equal(groupDecisionReplayInput.safeParse({...normal,...extra}).success,false)
})

test('cost and latency include invalid paid requests; partial/unknown costs never become a complete total',async()=>{
  const row=await replayGroupDecision('ui-help',GROUP_POLICY_VERSION,response('reply','foreign'))
  row.decisions[0].decisionCostUsd=0.000138;row.decisions[1].decisionCostUsd=null
  const summary=summarizeGroupDecisionReplay([row])
  assert.equal(summary.measured,0);assert.equal(summary.cost.knownUsd,0.000138)
  assert.equal(summary.cost.knownCalls,1);assert.equal(summary.cost.unknownCalls,1);assert.equal(summary.cost.completeTotalUsd,null)
  assert.equal(summary.decisionLatency.samples,2);assert.equal(summary.decisionCalls.receipted,2)
  const legacy={...row,receipt,decisions:undefined,decisionCostUsd:0.000138} as unknown as typeof row
  const old=summarizeGroupDecisionReplay([legacy])
  assert.equal(old.measured,0);assert.equal(old.cost.knownUsd,0.000138);assert.equal(old.cost.knownCalls,1);assert.equal(old.cost.unknownCalls,0)
})

test('real replay runner fails before calls without normal auth/fixed deployment and stops on unreceipted evidence',async()=>{
  let calls=0
  const env={GROUP_REPLAY_CONVERSATION:ui,GROUP_REPLAY_DEPLOYMENT:'dpl_fixture',GROUP_REPLAY_REVISION:'b'.repeat(40),GROUP_REPLAY_COOKIE:'fixture-session'}
  const absent=async()=>{calls++;throw Error('should not fetch')}
  await assert.rejects(runGroupDecisionReplay({env:{...env,GROUP_REPLAY_COOKIE:undefined},fetchImpl:absent}),/normal_auth/)
  await assert.rejects(runGroupDecisionReplay({env:{...env,GROUP_REPLAY_DEPLOYMENT:undefined},fetchImpl:absent}),/fixed_deployment/)
  assert.equal(calls,0)
  const result=await runGroupDecisionReplay({env,fetchImpl:async(url,options)=>{
    calls++
    assert.equal(options?.redirect,'error')
    if(String(url).endsWith('/api/version'))return Response.json({build:'dpl_fixture'})
    const body=JSON.parse(options?.body as string)
    assert.deepEqual(body,{caseId:'small-talk',policyVersion:GROUP_BASELINE_VERSION})
    return Response.json(await replayGroupDecision(body.caseId,body.policyVersion,async()=>null),{status:503})
  }})
  assert.equal(calls,2);assert.equal(result.status,'failed');assert.equal(result.baseline.length,1);assert.equal(result.candidate.length,0)
  assert.equal(result.comparison.decisionReviewReady,false);assert.equal(result.comparison.baseline.measured,0)
  assert.ok(!JSON.stringify(result).includes(env.GROUP_REPLAY_COOKIE))
})

test('fixed replay collection continues after real uncertain and partial invalid results without making quality pass',async()=>{
  const env={GROUP_REPLAY_CONVERSATION:ui,GROUP_REPLAY_DEPLOYMENT:'dpl_fixture',GROUP_REPLAY_REVISION:'b'.repeat(40),GROUP_REPLAY_COOKIE:'fixture-session'}
  const requested:string[]=[]
  const result=await runGroupDecisionReplay({env,fetchImpl:async(url,options)=>{
    if(String(url).endsWith('/api/version'))return Response.json({build:'dpl_fixture'})
    const body=JSON.parse(options?.body as string)
    requested.push(`${body.policyVersion}:${body.caseId}`)
    const uncertain=body.policyVersion===GROUP_BASELINE_VERSION && body.caseId==='small-talk'
    const partial=body.policyVersion===GROUP_POLICY_VERSION && body.caseId==='ui-help'
    const invoke:typeof invokeDecision=uncertain?async(_purpose,_input,questions)=>answer({[questions[0].name]:'uncertain'})
      :partial?async(_purpose,_input,questions)=>questions[0].name==='intent'?answer({intent:'reply_useful_answer'}):null
      :response('reply',ui)
    const row=await replayGroupDecision(body.caseId,body.policyVersion,invoke)
    if(uncertain){row.decisions[0].decisionCostUsd=0.000061;Object.assign(row,groupDecisionTotals(row.decisions))}
    return Response.json(row)
  }})
  assert.equal(requested.length,24);assert.equal(new Set(requested).size,24)
  assert.deepEqual(requested,[GROUP_BASELINE_VERSION,GROUP_POLICY_VERSION].flatMap(policy=>GROUP_REPLAY_CASE_IDS.map(id=>`${policy}:${id}`)))
  assert.equal(result.collectionComplete,true);assert.equal(result.qualityAccepted,false)
  assert.equal(result.status,'failed');assert.equal(result.error,'replay_decision_unavailable');assert.equal(result.comparison.decisionReviewReady,false)
  assert.equal(result.baseline[0].failureReason,'uncertain');assert.equal(result.baseline[0].decisionCostUsd,0.000061)
  assert.equal(result.comparison.baseline.logicalReplays,12);assert.equal(result.comparison.candidate.logicalReplays,12)
  const partial=result.candidate.find(row=>row.caseId==='ui-help')!
  assert.equal(partial.status,'invalid_decision');assert.equal(partial.failureReason,'unavailable')
  assert.deepEqual(partial.decisionCalls,{attempted:2,receipted:1,unreceipted:1});assert.equal(partial.decisionCostUsd,null)
  assert.equal(result.comparison.baseline.cost.knownUsd,0.000061);assert.equal(result.comparison.candidate.cost.completeTotalUsd,null)
})

test('collector rejects a repeated provider receipt across different logical cases without retrying',async()=>{
  const env={GROUP_REPLAY_CONVERSATION:ui,GROUP_REPLAY_DEPLOYMENT:'dpl_fixture',GROUP_REPLAY_REVISION:'b'.repeat(40),GROUP_REPLAY_COOKIE:'fixture-session'}
  let posts=0
  const result=await runGroupDecisionReplay({env,fetchImpl:async(url,options)=>{
    if(String(url).endsWith('/api/version'))return Response.json({build:'dpl_fixture'})
    posts++
    const body=JSON.parse(options?.body as string)
    return Response.json(await replayGroupDecision(body.caseId,body.policyVersion,async(_purpose,_input,questions)=>answer({[questions[0].name]:'uncertain'},receipt)))
  }})
  assert.equal(posts,2);assert.equal(result.baseline.length,2);assert.equal(result.candidate.length,0)
  assert.equal(result.collectionComplete,false);assert.equal(result.qualityAccepted,false)
  assert.equal(result.error,'replay_chain_unbound');assert.equal(result.comparison.decisionReviewReady,false)
  assert.equal(result.comparison.baseline.decisionCalls.receipted,1)
})

test('a changed deployment after an invalid observation prevents the next fixed replay',async()=>{
  const env={GROUP_REPLAY_CONVERSATION:ui,GROUP_REPLAY_DEPLOYMENT:'dpl_fixture',GROUP_REPLAY_REVISION:'b'.repeat(40),GROUP_REPLAY_COOKIE:'fixture-session'}
  let posts=0
  const result=await runGroupDecisionReplay({env,fetchImpl:async(url,options)=>{
    if(String(url).endsWith('/api/version'))return Response.json({build:posts?'dpl_changed':'dpl_fixture'})
    posts++
    const body=JSON.parse(options?.body as string)
    return Response.json(await replayGroupDecision(body.caseId,body.policyVersion,async(_purpose,_input,questions)=>answer({[questions[0].name]:'uncertain'})))
  }})
  assert.equal(posts,1);assert.equal(result.baseline.length,1)
  assert.equal(result.collectionComplete,false);assert.equal(result.qualityAccepted,false)
  assert.equal(result.error,'replay_deployment_changed')
})


test('full-dataset accuracy retains uncertain and missing cases in its denominator',async()=>{
  const valid=await replayGroupDecision('ui-help',GROUP_POLICY_VERSION,response('reply',ui))
  const abstained=await replayGroupDecision('small-talk',GROUP_BASELINE_VERSION,async(_purpose,_input,questions)=>answer({[questions[0].name]:'uncertain'}))
  const summary=summarizeGroupDecisionReplay([valid,abstained])
  assert.equal(summary.actionAccuracy,1/12)
  assert.equal(summary.responderAccuracy,1/12)
  assert.equal(summary.measured,1)
  assert.equal(summary.abstentions,1)
  assert.equal(summary.unresolvedNegative,1)
  assert.equal(summary.falseIntervention,0)
  assert.equal(summary.intentionalNonIntervention,0,'uncertain is never a successful quiet outcome')
  assert.equal(summary.observed,2)
  const positive=await replayGroupDecision('ui-help',GROUP_POLICY_VERSION,async(_purpose,_input,questions)=>answer({[questions[0].name]:'uncertain'}))
  assert.equal(summarizeGroupDecisionReplay([positive]).missedIntervention,1)
})

// Synthetic transport fixtures exercise comparison semantics, not model quality.
// Actual replay inputs still exclude these expected labels.
async function comparisonFixture({baselineFailure='uncertain',candidateFailure=false}:{baselineFailure?:string;candidateFailure?:boolean}={}) {
  const env={GROUP_REPLAY_CONVERSATION:ui,GROUP_REPLAY_DEPLOYMENT:'dpl_fixture',GROUP_REPLAY_REVISION:'b'.repeat(40),GROUP_REPLAY_COOKIE:'fixture-session'}
  const requested:string[]=[]
  const report=await runGroupDecisionReplay({env,fetchImpl:async(url,options)=>{
    if(String(url).endsWith('/api/version'))return Response.json({build:'dpl_fixture'})
    const body=JSON.parse(options?.body as string)
    requested.push([body.policyVersion,body.caseId].join(':'))
    const item=dataset.cases.find(item=>item.id===body.caseId)!
    const baseline=body.policyVersion===GROUP_BASELINE_VERSION
    const failed=baseline&&body.caseId==='small-talk' || !baseline&&candidateFailure&&body.caseId==='ui-help'
    const target=item.expected.actions[0]
    const responders=item.expected.responders?.length?item.expected.responders:[coding]
    const invoke:typeof invokeDecision=async(_purpose,_input,questions)=>{
      const name=questions[0].name
      if(failed)return baselineFailure==='unavailable'&&baseline?null:answer({[name]:baseline?baselineFailure:'uncertain'})
      const values:Record<string,string>={
        intent:target==='ignore'?'ignore_ordinary_conversation':target==='clarify'?'clarify_missing_information':target==='delegate'?'delegate_task_followup':responders.length>1?'reply_independent_contributions':'reply_useful_answer',
        responder_0:responders[0],responder_1:responders[1]??'end',responder_2:responders[2]??'end',
        task_plan:'continue_0',report_timing:item.expected.reportTiming??'now',
      }
      return answer({[name]:values[name]})
    }
    return Response.json(await replayGroupDecision(body.caseId,body.policyVersion,invoke))
  }})
  return {report,requested}
}

test('a fixed baseline abstention remains a failure while a fully correct candidate becomes reviewable',async()=>{
  const {report,requested}=await comparisonFixture()
  assert.equal(requested.length,24);assert.equal(new Set(requested).size,24)
  assert.equal(report.comparisonVersion,'group-decision-comparison-v2')
  assert.equal(report.status,'comparison_ready');assert.equal(report.collectionComplete,true)
  assert.equal(report.qualityAccepted,true)
  assert.equal(report.comparison.baseline.abstentions,1)
  assert.equal(report.comparison.baseline.measured,11)
  assert.equal(report.baseline[0].status,'invalid_decision');assert.equal(report.baseline[0].route,null)
  assert.equal(report.baseline[0].projection,null);assert.equal(report.baseline[0].failureReason,'uncertain')
  assert.equal(report.comparison.candidate.measured,12);assert.equal(report.comparison.candidate.actionAccuracy,1)
  assert.equal(report.comparison.candidate.failures.length,0)
  assert.equal(report.productionAccepted,false);assert.equal(report.policyChanged,false)
})

test('new comparison rejects candidate uncertainty and non-semantic baseline failures',async()=>{
  for(const options of [{candidateFailure:true},{baselineFailure:'foreign'},{baselineFailure:'unavailable'}]){
    const {report,requested}=await comparisonFixture(options)
    assert.equal(report.qualityAccepted,false);assert.equal(report.comparison.decisionReviewReady,false)
    assert.equal(new Set(requested).size,requested.length,'no failed observation is retried')
  }
})
