import assert from 'node:assert/strict'
import test from 'node:test'
import { createGroupJudgment } from './group-judgment'
import { runGroupRounds, GroupJudgmentPendingError } from './group-turns'
import { mentionRoute, UnknownMentionError, type GroupMessage } from './group-routing'
import { groupBotCatalog } from './group-member-catalog'
import type { DecisionExecution, invokeDecision } from './decide'
import { DECISION_MODEL, type DecisionAnswer } from './decision'

const a='00000000-0000-4000-8000-000000000001', b='00000000-0000-4000-8000-000000000002', c='00000000-0000-4000-8000-000000000003'
const members=[{id:a,name:'Code',description:'Implement software',memberType:'bot' as const,executionAvailable:true},{id:b,name:'Design',description:'Design interfaces'},{id:c,name:'Review',description:'Review correctness'}]
const receipt:DecisionExecution={executionId:'test',modelId:DECISION_MODEL,providerGenerationId:'test',startedAt:'2026-11-03T00:00:00Z',completedAt:'2026-11-03T00:00:01Z',requestDigest:'a'.repeat(64),imageDigests:[],vision:'no-image-input'}
let calls=0
const answers=(values:Record<string,string>)=>({answers:new Map<string,Exclude<DecisionAnswer,{type:'refusal'}>>(Object.entries(values).map(([name,choice])=>[name,{name,type:'choice',choice}])),execution:{...receipt,executionId:`test-${++calls}`,providerGenerationId:`generation-${calls}`}})
const routeAnswers=(action:string,responders:string[],extra:Record<string,string>={}):typeof invokeDecision=>async(_purpose,input,questions)=>{
  assert.equal(questions.length,1)
  const supplied=JSON.parse(typeof input==='string'?input:input.text)
  const values:Record<string,string>={intent:action==='ignore'?'ignore_ordinary_conversation':action==='observe'?'observe_already_answered':action==='delegate'?'delegate_execution_requested':extra.contributions==='independent'?'reply_independent_contributions':'reply_useful_answer',report_timing:extra.report_timing??'now',...Object.fromEntries(members.map((_,i)=>[`responder_${i}`,responders[i]??'end']))}
  values.task_plan=extra.task_plan??(extra.task_operation==='create'?'create':`${extra.task_operation}_${supplied.message.tasks?.findIndex((task:{issueId:string})=>task.issueId===extra.task_target)??-1}`)
  return answers(Object.fromEntries(questions.map(q=>[q.name,values[q.name]])))
}

test('Decision ignore/observe are completed zero-wake actions, distinct from unavailable judgments',async()=>{
  for (const [action,text] of [['ignore','周末天气不错'],['observe','这个问题已经解决'],['ignore','只讨论各自日程']]) {
    const judge=createGroupJudgment(routeAnswers(action,[]))
    const message={text,mentions:[]}
    const route=await judge.route(message,members,null,[])
    assert.equal(route.action,action);assert.equal(route.reason,action==='ignore'?'ordinary_conversation':'already_answered')
    assert.equal(route.policyVersion,'group-contribution-v1');assert.deepEqual(route.responders,[])
    await runGroupRounds(route,message,{eligible:async()=>members,status:async()=>assert.fail('zero wake'),generate:async()=>assert.fail('zero generation'),publish:async()=>assert.fail('zero publish')})
  }
  for (const invoke of [async()=>null,async()=>{throw new DOMException('upstream private detail','TimeoutError')},async()=>answers({intent:'uncertain'}),async()=>answers({intent:'foreign'}),routeAnswers('reply',[])]) {
    await assert.rejects(createGroupJudgment(invoke).route({text:'question',mentions:[]},members,null,[]),GroupJudgmentPendingError)
  }
})

test('one relevant responder generates once; a second needs incremental contribution before generation',async()=>{
  const route=await createGroupJudgment(routeAnswers('reply',[a,b],{contributions:'independent'})).route({text:'代码及设计审查',mentions:[]},members,null,[])
  const calls:string[]=[],published:string[]=[],seen:string[]=[]
  await runGroupRounds(route,{text:'代码及设计审查',mentions:[]},{eligible:async()=>members,status:async()=>{},contribution:async(_message,member,earlier)=>{seen.push(member.id);assert.equal(earlier[0].text,'all covered');return{contribute:false}},generate:async member=>{calls.push(member.id);return{text:'all covered',mentions:[]}},publish:async id=>{published.push(id);return true}})
  assert.deepEqual(calls,[a]);assert.deepEqual(published,[a]);assert.deepEqual(seen,[b])
  const single=await createGroupJudgment(routeAnswers('reply',[a,b])).route({text:'one question',mentions:[]},members,null,[])
  assert.deepEqual(single.responders,[a]);assert.equal(single.decisions?.length,2)
})

test('explicit mentions remain restricted; a foreign ID fails before decision or execution',async()=>{
  assert.deepEqual(mentionRoute({text:'help',mentions:[b,b]},members)?.responders,[b])
  assert.throws(()=>mentionRoute({text:'help',mentions:['foreign']},members),UnknownMentionError)
  const explicit=await createGroupJudgment(routeAnswers('reply',[a])).route({text:'help',mentions:[b]},members,null,[])
  assert.deepEqual(explicit.responders,[b])
  await assert.rejects(createGroupJudgment(routeAnswers('ignore',[])).route({text:'help',mentions:[b]},members,null,[]),GroupJudgmentPendingError)
})

test('delegate selects a host task and exactly one existing reporter; host result needs no generation',async()=>{
  const message:GroupMessage={text:'继续这个任务',mentions:[],tasks:[{issueId:b,taskId:c,reporterId:a,title:'Task',status:'running',runId:c,requestEpoch:b}]}
  const route=await createGroupJudgment(routeAnswers('delegate',[a],{task_operation:'continue',task_target:b})).route(message,members,null,[])
  let delegated=0,published=0
  await runGroupRounds(route,message,{eligible:async()=>members,status:async()=>assert.fail('no chat wake'),generate:async()=>assert.fail('no generation'),delegate:async(member,input)=>{delegated++;assert.equal(member.id,a);assert.deepEqual(input,{operation:'continue',issueId:b,reportTiming:'now'});return{text:'server receipt',mentions:[]}},publish:async(id,reply)=>{published++;assert.equal(id,a);assert.equal(reply.text,'server receipt');return true}})
  assert.equal(delegated,1);assert.equal(published,1)
  for (const extra of [{task_plan:'continue_foreign'},{task_plan:'create_existing'},{task_plan:'status_none'}]) await assert.rejects(createGroupJudgment(routeAnswers('delegate',[a],extra)).route(message,members,null,[]),GroupJudgmentPendingError)
})

test('catalog reads only public skill descriptors, reflects tool removal and revoked owners on the next read',async()=>{
  let tools:unknown=['dispatch_run','read_gmail_message'], active=true,available=true
  const client={query:async(sql:string)=>{assert.doesNotMatch(sql,/v\.definition\s*(?:,|FROM)|instructions|->>'body'|credential|token/);return{rows:[{id:a,name:'Developer',ownerId:'other-owner',repository:'org/repo',tools,skills:[{name:'Programming',description:'Build and review code',body:'PRIVATE'}]}]}}} as any
  const read=()=>groupBotCatalog(client,'requester','workspace',[a],async()=>({available,reason:'noDevice'}),async()=>active)
  const first=(await read())[0]
  assert.equal(first.role,null);assert.match(first.description,/Programming: Build and review code/);assert.equal(first.executionAvailable,true)
  assert.doesNotMatch(JSON.stringify(first),/PRIVATE|read_gmail|other-owner/)
  available=false;assert.equal((await read())[0].executionReason,'noDevice')
  tools=['read_gmail_message'];assert.equal((await read())[0].executionReason,'task_tool_disabled')
  active=false;assert.deepEqual(await read(),[])
})

test('silent delegation still executes once, without an acknowledgement or chat generation',async()=>{
  const route=await createGroupJudgment(routeAnswers('delegate',[a],{task_operation:'create',report_timing:'on_completion'})).route({text:'创建报告，完成后再通知',mentions:[]},members,null,[])
  let delegated=0
  await runGroupRounds(route,{text:'完成后再通知',mentions:[]},{eligible:async()=>members,status:async()=>assert.fail('no wake'),generate:async()=>assert.fail('no generation'),delegate:async()=>{delegated++;return{text:'',mentions:[],taskReceipt:{taskId:c,issueId:b,runId:c,requestEpoch:b,outcome:'succeeded',reportTiming:'on_completion'}}},publish:async()=>assert.fail('no acknowledgement')})
  assert.equal(delegated,1)
  const reply=await createGroupJudgment(routeAnswers('reply',[a],{report_timing:'on_completion'})).route({text:'answer',mentions:[]},members,null,[])
  assert.equal(reply.delegation,undefined);assert.equal(reply.decisions?.some(step=>step.phase==='report_timing'),false)
})

test('bots sharing a repository retain their own capability decision and changed public duties',async()=>{
  let publicRole='Build software'
  const rows=()=>[{id:a,name:'Coder',publicRole,ownerId:'requester',repository:'org/repo',tools:['dispatch_run'],skills:[]},{id:b,name:'Reviewer',publicRole:'Review changes',ownerId:'requester',repository:'org/repo',tools:['dispatch_run'],skills:[]}]
  const client={query:async()=>({rows:rows()})} as any
  const checked:string[]=[]
  const read=()=>groupBotCatalog(client,'requester','workspace',[a,b],async bot=>{checked.push(bot.id);assert.equal(bot.repository,'org/repo');return bot.id===a?{available:true}:{available:false,reason:'missing_credentials'}},async()=>true)
  const catalog=await read()
  assert.deepEqual(checked,[a,b]);assert.equal(catalog[0].executionAvailable,true);assert.equal(catalog[1].executionAvailable,false)
  assert.equal(catalog[0].role,'Build software')
  publicRole='Design interfaces';assert.equal((await read())[0].description,'Design interfaces')
})
