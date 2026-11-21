import assert from 'node:assert/strict'
import { before, beforeEach, after, mock, test } from 'node:test'
import { decisionFailureScope, recordDecisionFailure, type DecisionFailureReason } from '../coordinator/decision-failure'
let scope: { workspaceId: string; ownerId: string } | undefined
let balance = true, deniedAt: 'prepare' | 'send' | null = null, checks = 0, sends = 0, reservations = 0
const settlements: Array<number | null> = []
const logs: unknown[][] = []
const original = { fetch: globalThis.fetch, key: process.env.MIKKA_LITELLM_MASTER_KEY, url: process.env.MIKKA_LITELLM_URL, edition: process.env.MIKKA_EDITION, error: console.error }
mock.module(new URL('../abuse/context.ts',import.meta.url).href,{namedExports:{hostedBillingScope:{getStore:()=>scope}}})
mock.module(new URL('../abuse/runtime.ts',import.meta.url).href,{namedExports:{
  canUseMikkaPaid:async()=>{if(!balance)throw new Error('points_exhausted')},
  hostedUsage:{reserve:async()=>{reservations++},settle:async(_id:string,cost:number|null)=>{settlements.push(cost)}},
}})
mock.module(new URL('../abuse/alerts.ts',import.meta.url).href,{namedExports:{checkAbuseAlerts:async()=>{}}})
// This transport unit owns no DB; real payer resolution and revocation run in billing/credit-share PG suites.
mock.module(new URL('../credit-shares.ts',import.meta.url).href,{namedExports:{withSharedCredits:async(workspaceId:string,attempt:(payer:string)=>unknown)=>attempt(workspaceId)}})
mock.module(new URL('./runtime.ts',import.meta.url).href,{namedExports:{assertLiteLLMModelTransport:async(identity:unknown)=>{
  assert.deepEqual(identity,scope);checks++
  if(deniedAt===(checks===1?'prepare':'send'))throw new Error('modelRouteDenied')
}}})
let invoke:typeof import('../coordinator/decide').invokeDecision
before(async()=>{invoke=(await import('../coordinator/decide')).invokeDecision})
beforeEach(()=>{
  process.env.MIKKA_LITELLM_URL='https://litellm.example';process.env.MIKKA_LITELLM_MASTER_KEY='synthetic-test-only';process.env.MIKKA_EDITION='community';console.error=(...args:unknown[])=>{logs.push(args)}
  scope={workspaceId:'fixture-workspace',ownerId:'fixture-owner'}
  balance=true;deniedAt=null;checks=0;sends=0;reservations=0;settlements.length=0
  logs.length=0
  globalThis.fetch=async(_url,init)=>{
    sends++;assert.equal(init?.redirect,'error')
    return Response.json({model:'backing-decision-model',
      answers:[{type:'choice',name:'outcome',choice:'yes'}]},{headers:{'x-litellm-call-id':'synthetic','x-litellm-response-cost':'0.000001'}})
  }
})
after(()=>{
  globalThis.fetch=original.fetch;console.error=original.error
  if(original.key===undefined)delete process.env.MIKKA_LITELLM_MASTER_KEY;else process.env.MIKKA_LITELLM_MASTER_KEY=original.key
  if(original.url===undefined)delete process.env.MIKKA_LITELLM_URL;else process.env.MIKKA_LITELLM_URL=original.url
  if(original.edition===undefined)delete process.env.MIKKA_EDITION;else process.env.MIKKA_EDITION=original.edition
})
const questions=[{type:'choice' as const,name:'outcome',instructions:'Synthetic choice',choices:[{value:'yes'}]}]
test('an API key without trusted execution scope cannot send or spend',async()=>{
  scope=undefined
  assert.equal(await invoke('fixture','test',questions),null)
  assert.equal(sends,0);assert.equal(reservations,0)
  assert.deepEqual(logs,[['Decision unavailable',{purpose:'fixture',reason:'billing_scope_missing'}]])
})
test('policy and zero balance refusals happen before any provider request',async()=>{
  const diagnostics:{reason?:DecisionFailureReason}={}
  deniedAt='prepare';await assert.rejects(decisionFailureScope.run(diagnostics,()=>invoke('triage','test',questions)),/modelRouteDenied/)
  assert.equal(diagnostics.reason,'admission_refused')
  assert.equal(sends,0);assert.equal(reservations,0)
  deniedAt=null;checks=0;balance=false
  await assert.rejects(decisionFailureScope.run(diagnostics,()=>invoke('triage','test',questions)),/points_exhausted/)
  assert.equal(diagnostics.reason,'billing_refused')
  assert.deepEqual(logs,[['Decision unavailable',{purpose:'triage',reason:'admission_refused'}],['Decision unavailable',{purpose:'triage',reason:'billing_refused'}]])
  assert.equal(sends,0);assert.equal(reservations,0)
})
test('revocation after admission releases a provably unused call with zero cost',async()=>{
  deniedAt='send'
  assert.equal(await invoke('fixture','test',questions),null)
  assert.equal(sends,0);assert.equal(reservations,1);assert.deepEqual(settlements,[0])
  assert.deepEqual(logs[0],['Decision unavailable',{purpose:'fixture',reason:'admission_refused'}])
})
test('an allowed scoped call sends once and settles only the returned actual cost',async()=>{
  assert.ok(await invoke('fixture','test',questions))
  assert.equal(sends,1);assert.equal(checks,2);assert.deepEqual(settlements,[1])
  assert.deepEqual(logs,[])
})

test('missing configuration retains the purpose and reports only a closed reason',async()=>{
  delete process.env.MIKKA_LITELLM_MASTER_KEY
  const diagnostics:{reason?:DecisionFailureReason}={}
  assert.equal(await decisionFailureScope.run(diagnostics,()=>invoke('triage','PRIVATE_INPUT',questions)),null)
  assert.equal(diagnostics.reason,'litellm_not_configured')
  assert.deepEqual(logs,[['Decision unavailable',{purpose:'triage',reason:'litellm_not_configured'}]])
  assert.equal(sends,0);assert.equal(reservations,0)
})

test('an already-cancelled call is observable without admission or spend',async()=>{
  const controller=new AbortController();controller.abort()
  assert.equal(await invoke('triage','PRIVATE_INPUT',questions,controller.signal),null)
  assert.deepEqual(logs,[['Decision unavailable',{purpose:'triage',reason:'cancelled'}]])
  assert.equal(sends,0);assert.equal(checks,0);assert.equal(reservations,0)
})

test('invalid input before fetch reports preparation failure without leaking input',async()=>{
  const diagnostics:{reason?:DecisionFailureReason}={}
  assert.equal(await decisionFailureScope.run(diagnostics,()=>invoke('triage',{text:'PRIVATE_INPUT',requiresVisual:true},questions)),null)
  assert.equal(diagnostics.reason,'preparation_failed')
  assert.deepEqual(logs[0],['Decision unavailable',{purpose:'triage',reason:'preparation_failed'}])
  assert.doesNotMatch(JSON.stringify(logs),/PRIVATE_INPUT/)
  assert.equal(sends,0);assert.deepEqual(settlements,[0])
})

test('decision failure diagnostics are isolated per concurrent call',async t=>{
  const captured:unknown[][]=[]
  t.mock.method(console,'error',(...args:unknown[])=>{captured.push(args)})
  const first:{reason?:DecisionFailureReason}={},second:{reason?:DecisionFailureReason}={}
  await Promise.all([
    decisionFailureScope.run(first,async()=>{await Promise.resolve();recordDecisionFailure('triage\n!','admission_refused')}),
    decisionFailureScope.run(second,async()=>{recordDecisionFailure('triage','billing_refused');await Promise.resolve()}),
  ])
  assert.equal(first.reason,'admission_refused');assert.equal(second.reason,'billing_refused')
  assert.equal(decisionFailureScope.getStore(),undefined)
  assert.deepEqual(captured,[['Decision unavailable',{purpose:'triage',reason:'billing_refused'}],['Decision unavailable',{purpose:'triage',reason:'admission_refused'}]])
})
