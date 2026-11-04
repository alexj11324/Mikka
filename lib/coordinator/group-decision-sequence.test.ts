import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import dataset from '../../tests/fixtures/group-decision-cases.json'
import { createGroupJudgment } from './group-judgment'
import { GroupJudgmentPendingError } from './group-correction'
import { DECISION_MODEL, decisionRequestInput, type DecisionQuestion } from './decision'
import type { DecisionExecution, invokeDecision } from './decide'
import { overrideDeploymentSwitch } from '../deployment-switches'
import { GROUP_BASELINE_VERSION, GROUP_POLICY_VERSION, GROUP_LIVE_POLICY_VERSION, GROUP_PREVIOUS_POLICY_VERSION, GROUP_V2_POLICY_VERSION } from './group-decision-policy'

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
      assert.equal(input.policyVersion,GROUP_LIVE_POLICY_VERSION)
      overrideDeploymentSwitch('groupContribution',false)
    }},
    {name:'responder_0',value:ids[0],inspect:input=>assert.equal(input.policyVersion,GROUP_LIVE_POLICY_VERSION)},
  ])
  const retained:string[]=[]
  const route=await createGroupJudgment(current.invoke).route({text:'help',mentions:[]},members,null,[],async(_steps,version)=>{retained.push(version!)})
  assert.equal(route.policyVersion,GROUP_LIVE_POLICY_VERSION)
  assert.deepEqual(retained,[GROUP_LIVE_POLICY_VERSION,GROUP_LIVE_POLICY_VERSION])
  assert.ok(route.decisions?.every(step=>step.policyVersion===GROUP_LIVE_POLICY_VERSION))
  const next=transport([{name:'responder_0',value:ids[0],inspect:input=>assert.equal(input.policyVersion,GROUP_BASELINE_VERSION)},{name:'responder_1',value:'end'}])
  const nextRoute=await createGroupJudgment(next.invoke).route({text:'next request',mentions:[]},members,null,[])
  assert.equal(nextRoute.policyVersion,GROUP_BASELINE_VERSION)
  assert.ok(nextRoute.decisions?.every(step=>step.policyVersion===GROUP_BASELINE_VERSION))
})

test('v2 clarification selects a questioner without treating the missing task details as a missing responder',async()=>{
  const t=transport([
    {name:'intent',value:'clarify_missing_information'},
    {name:'responder_0',value:ids[1],inspect:(input,q)=>{
      assert.equal(input.policyVersion,'group-contribution-v2')
      assert.equal(input.confirmed.action,'clarify')
      assert.match(q.instructions,/Missing task details are why clarification was selected/)
      assert.match(q.instructions,/without requiring a uniquely best member/)
      assert.equal(q.type,'choice');if(q.type==='choice')assert.ok(q.choices.some(choice=>choice.value==='uncertain'))
    }},
  ])
  const route=await createGroupJudgment(t.invoke,GROUP_V2_POLICY_VERSION).route({text:'Which problem needs clarification?',mentions:[]},members,null,[])
  assert.equal(route.action,'clarify');assert.deepEqual(route.responders,[ids[1]]);assert.equal(t.calls(),2)
  assert.ok(route.decisions?.every(step=>step.policyVersion==='group-contribution-v2'))
})

test('v2 independent contributions select speaking order, then still require a separate bounded responder decision',async()=>{
  const t=transport([
    {name:'intent',value:'reply_independent_contributions'},
    {name:'responder_0',value:ids[0],inspect:(input,q)=>{
      assert.equal(input.confirmed.reason,'independent_contributions')
      assert.match(q.instructions,/speaking order, not the only competent member/)
    }},
    {name:'responder_1',value:ids[2]},
    {name:'responder_2',value:'end'},
  ])
  const route=await createGroupJudgment(t.invoke,GROUP_V2_POLICY_VERSION).route({text:'Give the two requested perspectives',mentions:[]},members,null,[])
  assert.deepEqual(route.responders,[ids[0],ids[2]]);assert.equal(t.calls(),4)
  const uncertain=transport([{name:'intent',value:'clarify_missing_information'},{name:'responder_0',value:'uncertain'}])
  await assert.rejects(createGroupJudgment(uncertain.invoke,GROUP_V2_POLICY_VERSION).route({text:'Cannot select a questioner',mentions:[]},members,null,[]),(error:unknown)=>{
    assert.ok(error instanceof GroupJudgmentPendingError);assert.equal(error.decisionFailure,'uncertain')
    assert.equal(error.decisions.length,2);assert.ok(error.decisions.every(step=>step.receipt && step.policyVersion==='group-contribution-v2'))
    return true
  })
})

test('v0 baseline and historical v1 request bytes match the six recorded synthetic production request digests',async()=>{
  const samples=[
    {caseId:'small-talk',policy:GROUP_BASELINE_VERSION,digest:'270faaf10fd1d7a00f8396821c3220df29d4a437387a28b1e7d4564fa3e410ad'},
    {caseId:'already-answered',policy:GROUP_BASELINE_VERSION,digest:'53d3657c3cfc042e966730e1f0f48d2d8f9ab6a471e7ae1f97ae25f9e8fc12df'},
    {caseId:'unrelated',policy:GROUP_BASELINE_VERSION,digest:'3f8e9b0412eef45b0ffd83de333ec15dc2c2a1a5702ecc45ec201a992aa9601e'},
    {caseId:'prompt-injection',policy:GROUP_BASELINE_VERSION,digest:'1800b67f59c91d71ad05d4515f46ed3b22c443a96fd0e3e2d3dae9585ff9f5c9'},
    {caseId:'ambiguous-task',policy:GROUP_PREVIOUS_POLICY_VERSION,intent:'clarify_missing_information',digest:'664dd77878e4239fd01730f6e16d75174d8736e9b6343ece02f470d454092585'},
    {caseId:'independent-views',policy:GROUP_PREVIOUS_POLICY_VERSION,intent:'reply_independent_contributions',digest:'f4f73924c0cb6939f64b21c0dde0fe28a3866dc743ef1256c4bfbe350b09fa77'},
  ]
  for(const sample of samples){
    let ordinal=0
    const invoke:typeof invokeDecision=async(_purpose,input,questions)=>{
      ordinal++
      const name=questions[0].name
      const value=name==='intent'?sample.intent!:'uncertain'
      const requestDigest=createHash('sha256').update(JSON.stringify({model:DECISION_MODEL,input:decisionRequestInput(input),questions})).digest('hex')
      if(name==='responder_0')assert.equal(requestDigest,sample.digest,`historical prompt changed: ${sample.caseId}`)
      const execution:DecisionExecution={executionId:`historical-${ordinal}`,modelId:DECISION_MODEL,providerGenerationId:`historical-generation-${ordinal}`,startedAt:'2026-11-04T00:00:00Z',completedAt:'2026-11-04T00:00:01Z',requestDigest,imageDigests:[],vision:'no-image-input'}
      return {answers:new Map([[name,{type:'choice',name,choice:value}]]),execution}
    }
    const item=dataset.cases.find(item=>item.id===sample.caseId)!
    await assert.rejects(createGroupJudgment(invoke,sample.policy).route({text:item.message,mentions:[],recent:'context' in item?item.context:[],tasks:[]},
      structuredClone(dataset.members) as typeof members,null,[]),GroupJudgmentPendingError)
    assert.equal(ordinal,sample.policy===GROUP_BASELINE_VERSION?1:2)
  }
})

test('v3 independently requested perspectives survive overlapping skills and stop once the requested views are represented',async()=>{
  const optionalQuestions:DecisionQuestion[]=[]
  const overlapping=members.map((member,index)=>({...member,name:['Research','Reliability','Writing'][index],description:'Can discuss design, testing and documentation; public duties overlap.'}))
  const t=transport([
    {name:'intent',value:'reply_independent_contributions'},
    {name:'responder_0',value:ids[0],inspect:(_input,q)=>assert.match(q.instructions,/speaking order, not the only competent member/)},
    {name:'responder_1',value:ids[1],inspect:(input,q)=>{
      assert.deepEqual(input.confirmed.responders,[ids[0]])
      optionalQuestions.push(q)
      assert.equal(q.type,'choice');if(q.type==='choice'){
        assert.ok(q.choices.some(option=>option.value===ids[1]))
        assert.ok(q.choices.some(option=>option.value==='end'))
        assert.ok(q.choices.some(option=>option.value==='uncertain'))
        assert.ok(!q.choices.some(option=>option.value===ids[0]))
      }
    }},
    {name:'responder_2',value:'end',inspect:(input,q)=>{
      assert.deepEqual(input.confirmed.responders,[ids[0],ids[1]])
      optionalQuestions.push(q)
    }},
  ])
  const route=await createGroupJudgment(t.invoke,GROUP_POLICY_VERSION).route({text:'Research and Reliability, please give separate perspectives on preserving a draft after save failure.',mentions:[]},overlapping,null,[])
  assert.deepEqual(route.responders,[ids[0],ids[1]]);assert.equal(t.calls(),4)
  assert.equal(route.decisions?.length,4);assert.ok(route.decisions?.every(step=>step.policyVersion===GROUP_POLICY_VERSION))
  assert.equal(optionalQuestions.length,2)
  for(const q of optionalQuestions){
    assert.match(q.instructions,/explicitly requested.*roles or perspectives/i)
    assert.match(q.instructions,/not yet represented/i)
    assert.match(q.instructions,/overlap/i)
    assert.doesNotMatch(q.instructions,/confirmed responders cannot cover/)
    assert.match(q.instructions,/end.*all requested.*represented/i)
  }
  // These are request-contract checks with scripted answers, not model-quality evidence.
})

test('historical v0/v1/v2 offline request compatibility matches 63 archived synthetic production receipt digests',async()=>{
  // v0/v2: real preflight 41785533094; v1: real core 41778455749.
  // Scripted answers reconstruct host state; hashes come from the archived real receipts.
  // This is offline request-byte compatibility, with no new provider inference or user content.
  const samples = [
    {"policy":"group-route-v0","caseId":"small-talk","failed":true,"answers":["uncertain"],"digests":["270faaf10fd1d7a00f8396821c3220df29d4a437387a28b1e7d4564fa3e410ad"]},
    {"policy":"group-route-v0","caseId":"already-answered","failed":true,"answers":["uncertain"],"digests":["53d3657c3cfc042e966730e1f0f48d2d8f9ab6a471e7ae1f97ae25f9e8fc12df"]},
    {"policy":"group-route-v0","caseId":"unrelated","failed":true,"answers":["uncertain"],"digests":["3f8e9b0412eef45b0ffd83de333ec15dc2c2a1a5702ecc45ec201a992aa9601e"]},
    {"policy":"group-route-v0","caseId":"ui-help","failed":false,"answers":["00000000-0000-4000-8000-000000000001","end"],"digests":["18e3ea08c7457b1f8e7139216c5c585f450bb88f2e66660c8293335b6f96c022","6564a446adbb9c3d1258df1f199a791f4ada4136c14cbfafd3a4c67657d905c1"]},
    {"policy":"group-route-v0","caseId":"testing-help","failed":false,"answers":["00000000-0000-4000-8000-000000000003","end"],"digests":["edb056e67f279d258507df3f7e93bc44c2725ea1e7e8ebdd4c232d2a935ea1e8","cd7fca2516ca54dea4ff8e03d3f1286808c5d28ce0ac9e7a8ade774fd02d13bb"]},
    {"policy":"group-route-v0","caseId":"ambiguous-task","failed":false,"answers":["00000000-0000-4000-8000-000000000002","end"],"digests":["c548a3da37f938285b822c1936eba262d1b0372f0faa22b019dcb4d955f34336","3b87ce480c0356c52d7dfd7f7d9c2e47ad4ba97ed594318f36bc33438c51eb68"]},
    {"policy":"group-route-v0","caseId":"new-member","failed":false,"answers":["00000000-0000-4000-8000-000000000003","end"],"digests":["5beb7825e7829c259e34b683d5a219fa9d48d9907d8b64c91101e8d9b8127eb6","f7f80ddeaaee3d1d2de248c4ae4536d1066bfaffe95982ca3b7c292e3e5fe171"]},
    {"policy":"group-route-v0","caseId":"explicit-mention","failed":false,"answers":["00000000-0000-4000-8000-000000000001"],"digests":["84fe9ea7dddbe64db84648457aaac721181c2b1c1307455aca3077b4c668435e"]},
    {"policy":"group-route-v0","caseId":"prompt-injection","failed":true,"answers":["uncertain"],"digests":["1800b67f59c91d71ad05d4515f46ed3b22c443a96fd0e3e2d3dae9585ff9f5c9"]},
    {"policy":"group-route-v0","caseId":"independent-views","failed":false,"answers":["00000000-0000-4000-8000-000000000001","00000000-0000-4000-8000-000000000003","00000000-0000-4000-8000-000000000002"],"digests":["9041f58f4429324fe87110e2467ecefdb73ef6bb0d402e302182ddfa739199a2","45e24750e59484fd9e5bd26de91c578476e583c1d84718aceea38493d6ac3128","3e9795a818719179eee73cea65f3f3aec30c1b10143fc8a8311e0166684a7563"]},
    {"policy":"group-route-v0","caseId":"delegate-task","failed":false,"answers":["00000000-0000-4000-8000-000000000002","end"],"digests":["5b2736037c9076b24f2b6b19c93036f30a313241f22013b240cb81c1493fd454","30b5ee1730f9bd4060d2511078e92498bcce4bc9605b3343ac7fc8b7039dd120"]},
    {"policy":"group-route-v0","caseId":"silent-delegation","failed":false,"answers":["00000000-0000-4000-8000-000000000002","end"],"digests":["ce7b0d3d7d121753f059304f99358f649195812eed318382843a60cf962637c2","a75360e42ad79d59aa050c683e8b33e78465d018aa94cc1cd333028b816b4cd1"]},
    {"policy":"group-contribution-v1","caseId":"small-talk","failed":false,"answers":["ignore_ordinary_conversation"],"digests":["8fda771e516f46bf9e984bed4ba0306ca12151711a3db7971c7ba85983ec8e11"]},
    {"policy":"group-contribution-v1","caseId":"already-answered","failed":false,"answers":["observe_already_answered"],"digests":["8f5eb44078f4ca62e34d0476e86a5d8adeb4a48dd8f8967a070576a2baa8fff6"]},
    {"policy":"group-contribution-v1","caseId":"unrelated","failed":false,"answers":["ignore_ordinary_conversation"],"digests":["596634c75adabd78af8f56b788cda9df2fd1169bb43cdef848a3291f71870cc0"]},
    {"policy":"group-contribution-v1","caseId":"ui-help","failed":false,"answers":["reply_useful_answer","00000000-0000-4000-8000-000000000001"],"digests":["9a74c3c055d865106f8bd1cbe59bb35b939811b3db0770687944e8bca51fad33","178c911e0da1517d685b4bb27015874ecb3a548f8e703c217d72bc144ddae050"]},
    {"policy":"group-contribution-v1","caseId":"testing-help","failed":false,"answers":["reply_useful_answer","00000000-0000-4000-8000-000000000003"],"digests":["72f364d32ea56ead141b767837091d067568bab96ab6cc17562563a7d10d2060","7b98e63ef4b70059c347da760a94aaa85cf258a5f93dfd0e61c6647e23bd0088"]},
    {"policy":"group-contribution-v1","caseId":"ambiguous-task","failed":true,"answers":["clarify_missing_information","uncertain"],"digests":["5ceeeaacd331dad7284a4abae5dde3cda9ff52bc45480992f7463defe7525985","664dd77878e4239fd01730f6e16d75174d8736e9b6343ece02f470d454092585"]},
    {"policy":"group-contribution-v1","caseId":"new-member","failed":false,"answers":["reply_useful_answer","00000000-0000-4000-8000-000000000003"],"digests":["5d998a59d9478132c133c200938031c2c544723d5c81fe936ca9333ae1b3b131","aafda9dd929b2df7aed645a16fcb9bf71540a5c02af0872caa74ce16a3ca30b7"]},
    {"policy":"group-contribution-v1","caseId":"explicit-mention","failed":false,"answers":["reply_useful_answer"],"digests":["ce64ac220f6b354f618109db4a57c310201aff76ccf2b87bfc2259ff1c9dc55f"]},
    {"policy":"group-contribution-v1","caseId":"prompt-injection","failed":false,"answers":["ignore_ordinary_conversation"],"digests":["d0c7a7d1fa0c7b69375230830bdf104f027915d568e9c28a89ac21e769285dd9"]},
    {"policy":"group-contribution-v1","caseId":"independent-views","failed":true,"answers":["reply_independent_contributions","uncertain"],"digests":["b282b5aa012c3871d708a9b3e2965586c749d3c7cbdbbd7042696d692e71e4a6","f4f73924c0cb6939f64b21c0dde0fe28a3866dc743ef1256c4bfbe350b09fa77"]},
    {"policy":"group-contribution-v1","caseId":"delegate-task","failed":false,"answers":["delegate_task_followup","continue_0","now"],"digests":["982f0171c7bc4d476927eedfa9c42df90541f56c520e42c1712e2109e88af628","27f75c92763f50a2ec0f5edd683bd55b0ca68ca8969623af42e6c4f3f1667e8e","e2b8245f32ee92318392ebbf6dfb8dfbf904255faca6fd523106d555e3f3fd5b"]},
    {"policy":"group-contribution-v1","caseId":"silent-delegation","failed":false,"answers":["delegate_task_followup","continue_0","on_completion"],"digests":["e0c4823de31a4c904ddb264a15b29c9f7ac7618678437edab0b2da6899004734","f9cc3e6530a7cd2573e6203a45502276bddfe3b4008f8fb9ed70fad939cafc65","7f1ca0035a9ca0f708023a3015bf8c7aae8d7d42a57ab054863881e54560d2b9"]},
    {"policy":"group-contribution-v2","caseId":"small-talk","failed":false,"answers":["ignore_ordinary_conversation"],"digests":["1d1c45417cf8fdc41873ea9913f010ef71d041c9abb04c8330f8089fa89016e3"]},
    {"policy":"group-contribution-v2","caseId":"already-answered","failed":false,"answers":["observe_already_answered"],"digests":["f8b0efdd2754daf06f0f61799203d7dbf7c7c8bee5f402b7ee320026484264e7"]},
    {"policy":"group-contribution-v2","caseId":"unrelated","failed":false,"answers":["ignore_ordinary_conversation"],"digests":["ad15888d8396ac8805a0c1a918ed8d21421f328f5b6dca3309c7aae8315dfeb0"]},
    {"policy":"group-contribution-v2","caseId":"ui-help","failed":false,"answers":["reply_useful_answer","00000000-0000-4000-8000-000000000001"],"digests":["dadd93008b09d8aa7456d80eef277b2826053feefc5badd8cf888a6a76907654","beafed4d9c3f3ccbba8fb341d6eb41460d5a91ace237257054aa903b661635b1"]},
    {"policy":"group-contribution-v2","caseId":"testing-help","failed":false,"answers":["reply_useful_answer","00000000-0000-4000-8000-000000000003"],"digests":["ef22220b6d594c0446fcb5c1a7af9aff0468c92d469ae203876bf3e07dc1c300","e5add4959e0f374dcf8504ee8d8b38666f6012698a376ce58c3339f1b3727feb"]},
    {"policy":"group-contribution-v2","caseId":"ambiguous-task","failed":false,"answers":["clarify_missing_information","00000000-0000-4000-8000-000000000002"],"digests":["2476d0f86981841dcde2061076f765c5d06f41ec3a2f7cb068f4197945b56b1a","f9442f68a7c26247527435d59844e7496ed2dd08965433539ad4e837945eb2c9"]},
    {"policy":"group-contribution-v2","caseId":"new-member","failed":false,"answers":["reply_useful_answer","00000000-0000-4000-8000-000000000003"],"digests":["58b04f1d9815f95622b9a690519e876e6c94db6cdf65a6b1931e1e961c81d701","f4d7128f96d847c44118ab9f39c94bcc0923e2f56ccd46d1ac9fcc5d3126f306"]},
    {"policy":"group-contribution-v2","caseId":"explicit-mention","failed":false,"answers":["reply_useful_answer"],"digests":["cd48f3fdccc3dfe54f40ead29234270e81f826ce68468e6ee81f0e4ecfe5d185"]},
    {"policy":"group-contribution-v2","caseId":"prompt-injection","failed":false,"answers":["ignore_ordinary_conversation"],"digests":["0899c97a5ae6abee293f461c70c966840a784c5247be1fd9c8e78acf1d46a592"]},
    {"policy":"group-contribution-v2","caseId":"independent-views","failed":false,"answers":["reply_independent_contributions","00000000-0000-4000-8000-000000000001","end"],"digests":["0f72b6bdfc8229aad28c627d69eb06caa158f3b1cf3e1a1842c4e7b82bb45c19","566b7fec8c2084463d3f51848460cabb829ee5dd91c5a336dafc237e404a2498","109840d2621f3c7a0037128d710f99a79510ca12a8a23c01331ea251da4bbf3a"]},
    {"policy":"group-contribution-v2","caseId":"delegate-task","failed":false,"answers":["delegate_task_followup","continue_0","now"],"digests":["ca0f22957e7f52a558c8ece2a63c0e6d0829787d3bec6ad243c52bca539a33a2","b26a0773f76d8bcb6f6e2b63b03e819ce12a6416b2dd152dc51d9b9d041d3435","e15fae089d17f1c4706782c1418bb35b252b230d4ff60ff199bf3ad484dcc977"]},
    {"policy":"group-contribution-v2","caseId":"silent-delegation","failed":false,"answers":["delegate_task_followup","continue_0","on_completion"],"digests":["aee6897ad4fc7e94491528e0025e6bc6ca07baa9d0878dcd1f836967fe0f0181","329fcd44f326d914a1f8eb61abf0e68826d77f09fee8cc29b894a96b9f8de40d","acd7af94909efadb9adc37c2b7a783558bd01dc62055ab18452f2f5b0584d30e"]},
  ] as const
  for(const sample of samples){
    let ordinal=0
    const invoke:typeof invokeDecision=async(_purpose,input,questions)=>{
      const index=ordinal++
      assert.ok(index<sample.answers.length,'no extra historical request')
      assert.equal(questions.length,1)
      const name=questions[0].name
      const requestDigest=createHash('sha256').update(JSON.stringify({model:DECISION_MODEL,input:decisionRequestInput(input),questions})).digest('hex')
      assert.equal(requestDigest,sample.digests[index],`historical request changed: ${sample.policy}/${sample.caseId}/${name}`)
      const execution:DecisionExecution={executionId:`recorded-${ordinal}`,modelId:DECISION_MODEL,providerGenerationId:`recorded-generation-${ordinal}`,startedAt:'2026-11-04T00:00:00Z',completedAt:'2026-11-04T00:00:01Z',requestDigest,imageDigests:[],vision:'no-image-input'}
      return {answers:new Map([[name,{type:'choice',name,choice:sample.answers[index]}]]),execution}
    }
    const item=dataset.cases.find(item=>item.id===sample.caseId)!
    const message={text:item.message,mentions:('mentions' in item?item.mentions:[]) ?? [],recent:('context' in item?item.context:[]) ?? [],tasks:('tasks' in item?item.tasks:[]) ?? []}
    const run=createGroupJudgment(invoke,sample.policy).route(message,structuredClone(dataset.members) as typeof members,null,[])
    if(sample.failed)await assert.rejects(run,GroupJudgmentPendingError)
    else await run
    assert.equal(ordinal,sample.answers.length)
  }
})
