import assert from 'node:assert/strict'
import test from 'node:test'
import { GROUP_BASELINE_VERSION, GROUP_POLICY_VERSION } from './group-decision-policy'
import { GROUP_REPLAY_CASE_IDS, replayGroupDecision, summarizeGroupDecisionReplay } from './group-decision-replay'
import { groupDecisionReplayInput } from './group-decision-replay-api'
import { DECISION_MODEL, type DecisionAnswer } from './decision'
import type { DecisionExecution, invokeDecision } from './decide'
import { runGroupDecisionReplay } from '../../scripts/group-decision-replay'

const ui='00000000-0000-4000-8000-000000000001',coding='00000000-0000-4000-8000-000000000002'
// Synthetic transport fixtures test the gate, not live model quality.
const receipt:DecisionExecution={executionId:'synthetic-execution',modelId:DECISION_MODEL,providerGenerationId:'synthetic-generation',startedAt:'2026-11-03T00:00:00.000Z',completedAt:'2026-11-03T00:00:00.100Z',requestDigest:'a'.repeat(64),imageDigests:[],vision:'no-image-input'}
const answer=(values:Record<string,string>,execution=receipt)=>({answers:new Map<string,Exclude<DecisionAnswer,{type:'refusal'}>>(Object.entries(values).map(([name,choice])=>[name,{name,type:'choice',choice}])),execution})
const response=(action:string,id:string,extra:Record<string,string>={})=>answer({action,reason:'useful_answer',contributions:'single',task_operation:'none',task_target:'none',report_timing:'now',responder_0:id,responder_1:'end',responder_2:'end',...extra})

test('fixed-case replay uses the model route, never expected labels, and never executes its projection',async()=>{
  let calls=0
  const invoke:typeof invokeDecision=async(purpose,input,questions)=>{
    calls++;assert.equal(purpose,'group-routing')
    assert.ok(typeof input!=='string')
    const supplied=JSON.parse(input.text)
    assert.equal(supplied.policyVersion,GROUP_POLICY_VERSION)
    assert.ok(!('expected' in supplied));assert.doesNotMatch(input.text,/maxPublicMessages|evidenceKind/)
    assert.ok(questions.some(question=>question.name==='action'))
    // Intentionally wrong for small-talk: the observation must preserve it.
    return response('reply',ui)
  }
  const row=await replayGroupDecision('small-talk',GROUP_POLICY_VERSION,invoke)
  assert.equal(calls,1);assert.equal(row.route?.action,'reply');assert.deepEqual(row.route?.responders,[ui])
  assert.equal(row.executionPerformed,false);assert.equal(row.policyChanged,false)
  assert.equal(row.projection?.intervention,true);assert.equal(row.decisionLatencyMs,100);assert.equal(row.decisionCostUsd,null)
  assert.equal(summarizeGroupDecisionReplay([row]).falseIntervention,1)
  assert.ok(!JSON.stringify(row).includes('今天午饭'))
})

test('baseline and candidate share fixed inputs but use distinct prompts; mentions and task targets stay host-bound',async()=>{
  const before=await replayGroupDecision('small-talk',GROUP_BASELINE_VERSION,async(_purpose,_input,questions)=>{
    assert.ok(!questions.some(question=>question.name==='action'));return answer({responder_0:ui,responder_1:'end',responder_2:'end'})
  })
  const after=await replayGroupDecision('small-talk',GROUP_POLICY_VERSION,async()=>response('ignore','end'))
  assert.equal(before.inputDigest,after.inputDigest);assert.equal(before.route?.action,'reply');assert.equal(after.route?.action,'ignore')
  const mentioned=await replayGroupDecision('explicit-mention',GROUP_POLICY_VERSION,async(_purpose,input)=>{
    assert.ok(typeof input!=='string');const supplied=JSON.parse(input.text);assert.deepEqual(supplied.members.map((member:{id:string})=>member.id),[ui]);return response('reply',ui)
  })
  assert.equal(mentioned.route?.by,'mention')
  const delegated=await replayGroupDecision('silent-delegation',GROUP_POLICY_VERSION,async(_purpose,input)=>{
    assert.ok(typeof input!=='string');const supplied=JSON.parse(input.text);assert.equal(supplied.message.tasks[0].reporterId,coding)
    return response('delegate',coding,{task_operation:'continue',task_target:supplied.message.tasks[0].issueId,report_timing:'on_completion'})
  })
  assert.equal(delegated.route?.delegation?.reportTiming,'on_completion');assert.equal(delegated.executionPerformed,false)
  assert.equal(summarizeGroupDecisionReplay([delegated]).failures.length,0)
  const noisy={...delegated,route:{...delegated.route!,delegation:{...delegated.route!.delegation!,reportTiming:'now' as const}}}
  assert.deepEqual(summarizeGroupDecisionReplay([noisy]).failures,[{caseId:'silent-delegation',reason:'report_timing'}])
})

test('missing/malformed receipts cannot be counted as actual inference; runtime faults are not invented provider responses',async()=>{
  for(const invoke of [async()=>null,async()=>{throw Error('PRIVATE_UPSTREAM_DETAIL')},async()=>({...response('reply',ui),execution:{...receipt,requestDigest:'invalid'}})]) {
    const row=await replayGroupDecision('ui-help',GROUP_POLICY_VERSION,invoke)
    assert.equal(row.status,'unavailable');assert.equal(row.receipt,null);assert.equal(row.route,null);assert.equal(row.projection,null)
    assert.equal(summarizeGroupDecisionReplay([row]).measured,0);assert.ok(!JSON.stringify(row).includes('PRIVATE'))
  }
  const invalid=await replayGroupDecision('ui-help',GROUP_POLICY_VERSION,async()=>response('reply','foreign'))
  assert.equal(invalid.status,'invalid_decision');assert.ok(invalid.receipt);assert.equal(summarizeGroupDecisionReplay([invalid]).measured,0)
  for(const id of ['unknown','decision-outage','duplicate-delivery'])await assert.rejects(replayGroupDecision(id,GROUP_POLICY_VERSION,async()=>assert.fail('no call')),/unsupported_group_replay_case/)
  assert.equal(GROUP_REPLAY_CASE_IDS.length,12)
  const normal={caseId:'ui-help',policyVersion:GROUP_POLICY_VERSION}
  assert.equal(groupDecisionReplayInput.safeParse(normal).success,true)
  for(const extra of [{prompt:'arbitrary'},{members:[]},{workspaceId:'foreign'},{userId:'foreign'},{policyVersion:'arbitrary'}])assert.equal(groupDecisionReplayInput.safeParse({...normal,...extra}).success,false)
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
