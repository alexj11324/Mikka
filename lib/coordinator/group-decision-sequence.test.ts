import assert from 'node:assert/strict'
import test from 'node:test'
import { createGroupJudgment } from './group-judgment'
import { GroupJudgmentPendingError } from './group-correction'
import { DECISION_MODEL, type DecisionQuestion } from './decision'
import type { DecisionExecution, invokeDecision } from './decide'
import { overrideDeploymentSwitch } from '../deployment-switches'
import { GROUP_BASELINE_VERSION, GROUP_POLICY_VERSION } from './group-decision-policy'

const ids=['00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000003']
const members=ids.map((id,index)=>({id,name:`Member ${index}`,description:'Public role',memberType:'bot' as const,executionAvailable:true}))
function transport(script: {name:string; value:string; inspect?:(input:any,question:DecisionQuestion)=>void}[]) {
  let calls=0
  const invoke:typeof invokeDecision=async(_purpose,input,questions)=>{
    const expected=script[calls++]
    assert.ok(expected,'no extra provider request')
    assert.equal(questions.length,1,'dependent questions must use separate requests')
    assert.equal(questions[0].name,expected.name)
    assert.ok(typeof input!=='string')
    expected.inspect?.(JSON.parse(input.text),questions[0])
    const execution:DecisionExecution={executionId:`execution-${calls}`,modelId:DECISION_MODEL,providerGenerationId:`generation-${calls}`,startedAt:'2026-11-04T00:00:00.000Z',completedAt:'2026-11-04T00:00:00.100Z',requestDigest:'a'.repeat(64),imageDigests:[],vision:'no-image-input'}
    return {answers:new Map([[expected.name,{type:'choice' as const,name:expected.name,choice:expected.value}]]),execution}
  }
  return {invoke,calls:()=>calls}
}

test('independent-question protocol: silence completes after one atomic intent with no responder request',async()=>{
  const t=transport([{name:'intent',value:'ignore_ordinary_conversation'}])
  const route=await createGroupJudgment(t.invoke).route({text:'ordinary conversation',mentions:[]},members,null,[])
  assert.equal(route.action,'ignore');assert.deepEqual(route.responders,[]);assert.equal(t.calls(),1)
  assert.equal(route.decisions?.length,1);assert.equal(route.decisions?.[0].phase,'intent')
  assert.equal(route.execution?.executionId,route.decisions?.[0].receipt?.executionId)
})

test('sequential responders receive confirmed prior selections; duplicates are unavailable choices and end stops calls',async()=>{
  const t=transport([
    {name:'intent',value:'reply_independent_contributions'},
    {name:'responder_0',value:ids[0],inspect:input=>assert.equal(input.confirmed.action,'reply')},
    {name:'responder_1',value:ids[1],inspect:(input,q)=>{assert.deepEqual(input.confirmed.responders,[ids[0]]);assert.equal(q.type,'choice');if(q.type==='choice')assert.ok(!q.choices.some(c=>c.value===ids[0]))}},
    {name:'responder_2',value:'end',inspect:input=>assert.deepEqual(input.confirmed.responders,[ids[0],ids[1]])},
  ])
  const route=await createGroupJudgment(t.invoke).route({text:'two independent contributions',mentions:[]},members,null,[])
  assert.deepEqual(route.responders,ids.slice(0,2));assert.equal(t.calls(),4);assert.equal(route.decisions?.length,4)
  assert.equal(new Set(route.decisions?.map(step=>step.receipt?.executionId)).size,4)
})

test('an uncertain later answer preserves the real earlier and failed receipts without fabricating a partial route',async()=>{
  const t=transport([{name:'intent',value:'reply_independent_contributions'},{name:'responder_0',value:ids[0]},{name:'responder_1',value:'uncertain'}])
  await assert.rejects(createGroupJudgment(t.invoke).route({text:'help',mentions:[]},members,null,[]),(error:unknown)=>{
    assert.ok(error instanceof GroupJudgmentPendingError)
    assert.equal(error.decisionFailure,'uncertain');assert.equal(error.decisions.length,3)
    assert.equal(error.decisions[2].status,'invalid_decision');assert.equal(error.decisions[2].receipt?.providerGenerationId,'generation-3')
    return true
  })
  assert.equal(t.calls(),3)
})

test('multiple explicit authorized mentions retain direct delivery and order after semantic intent',async()=>{
  const t=transport([{name:'intent',value:'reply_useful_answer'}])
  const route=await createGroupJudgment(t.invoke).route({text:'both of you please answer',mentions:[ids[1],ids[0],ids[1]]},members,null,[])
  assert.deepEqual(route.responders,[ids[1],ids[0]]);assert.equal(t.calls(),1)
  let calls=0
  await assert.rejects(createGroupJudgment(async()=>{calls++;return null}).route({text:'unknown',mentions:['foreign']},members,null,[]),GroupJudgmentPendingError)
  assert.equal(calls,0)
})

test('delegation chooses an atomic host task plan before timing; an existing task keeps its designated reporter',async()=>{
  const task={issueId:ids[2],taskId:ids[2],reporterId:ids[1],title:'Host task',status:'running',runId:ids[0],requestEpoch:ids[0]}
  const t=transport([
    {name:'intent',value:'delegate_task_followup'},
    {name:'task_plan',value:'continue_0',inspect:input=>assert.equal(input.confirmed.action,'delegate')},
    {name:'report_timing',value:'on_completion',inspect:input=>{assert.equal(input.confirmed.delegation.issueId,task.issueId);assert.deepEqual(input.confirmed.responders,[ids[1]])}},
  ])
  const route=await createGroupJudgment(t.invoke).route({text:'continue and notify only when complete',mentions:[],tasks:[task]},members,null,[])
  assert.deepEqual(route.responders,[ids[1]]);assert.deepEqual(route.delegation,{operation:'continue',issueId:ids[2],reportTiming:'on_completion'});assert.equal(t.calls(),3)
})

test('baseline preserves forced reply with multiple responders while automatic selection remains bounded',async()=>{
  const t=transport(ids.map((value,index)=>({name:`responder_${index}`,value})))
  const many=[...members,...Array.from({length:5},(_,index)=>({id:`extra-${index}`,name:'Extra',description:'public'}))]
  const route=await createGroupJudgment(t.invoke,'group-route-v0').route({text:'casual input still requires a baseline reply',mentions:[]},many,null,[])
  assert.equal(route.action,'reply');assert.deepEqual(route.responders,ids);assert.equal(t.calls(),3)
})

test('a live policy change applies to the next routing attempt and cannot mix phases inside the current attempt',async t=>{
  t.after(()=>overrideDeploymentSwitch('groupContribution',undefined))
  overrideDeploymentSwitch('groupContribution',true)
  const current=transport([
    {name:'intent',value:'reply_useful_answer',inspect:input=>{
      assert.equal(input.policyVersion,GROUP_POLICY_VERSION)
      overrideDeploymentSwitch('groupContribution',false)
    }},
    {name:'responder_0',value:ids[0],inspect:input=>assert.equal(input.policyVersion,GROUP_POLICY_VERSION)},
  ])
  const retained:string[]=[]
  const route=await createGroupJudgment(current.invoke).route({text:'help',mentions:[]},members,null,[],async(_steps,version)=>{retained.push(version!)})
  assert.equal(route.policyVersion,GROUP_POLICY_VERSION)
  assert.deepEqual(retained,[GROUP_POLICY_VERSION,GROUP_POLICY_VERSION])
  assert.ok(route.decisions?.every(step=>step.policyVersion===GROUP_POLICY_VERSION))
  const next=transport([{name:'responder_0',value:ids[0],inspect:input=>assert.equal(input.policyVersion,GROUP_BASELINE_VERSION)},{name:'responder_1',value:'end'}])
  const nextRoute=await createGroupJudgment(next.invoke).route({text:'next request',mentions:[]},members,null,[])
  assert.equal(nextRoute.policyVersion,GROUP_BASELINE_VERSION)
  assert.ok(nextRoute.decisions?.every(step=>step.policyVersion===GROUP_BASELINE_VERSION))
})
