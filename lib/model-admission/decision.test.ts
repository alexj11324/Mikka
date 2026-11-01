import assert from 'node:assert/strict'
import { before, beforeEach, after, mock, test } from 'node:test'
let scope: { workspaceId: string; ownerId: string } | undefined
let balance = true, deniedAt: 'prepare' | 'send' | null = null, checks = 0, sends = 0, reservations = 0
const settlements: Array<number | null> = []
const original = { fetch: globalThis.fetch, key: process.env.DECISION_GATEWAY_API_KEY, error: console.error }
mock.module(new URL('../abuse/context.ts',import.meta.url).href,{namedExports:{hostedBillingScope:{getStore:()=>scope}}})
mock.module(new URL('../abuse/runtime.ts',import.meta.url).href,{namedExports:{
  canUseMikkaPaid:async()=>{if(!balance)throw new Error('points_exhausted')},
  hostedUsage:{reserve:async()=>{reservations++},settle:async(_id:string,cost:number|null)=>{settlements.push(cost)}},
}})
mock.module(new URL('../abuse/alerts.ts',import.meta.url).href,{namedExports:{checkAbuseAlerts:async()=>{}}})
mock.module(new URL('./runtime.ts',import.meta.url).href,{namedExports:{assertUnmanagedModelTransport:async(identity:unknown)=>{
  assert.deepEqual(identity,scope);checks++
  if(deniedAt===(checks===1?'prepare':'send'))throw new Error('modelRouteDenied')
}}})
let invoke:typeof import('../coordinator/decide').invokeDecision
before(async()=>{invoke=(await import('../coordinator/decide')).invokeDecision})
beforeEach(()=>{
  process.env.DECISION_GATEWAY_API_KEY='synthetic-test-only';console.error=()=>{}
  scope={workspaceId:'fixture-workspace',ownerId:'fixture-owner'}
  balance=true;deniedAt=null;checks=0;sends=0;reservations=0;settlements.length=0
  globalThis.fetch=async(_url,init)=>{
    sends++;assert.equal(init?.redirect,'error')
    return Response.json({model:'openai/gpt-6-luna-decisions',provider_metadata:{gateway:{generationId:'synthetic',cost:'0.000001'}},
      answers:[{type:'choice',name:'outcome',choice:'yes'}]})
  }
})
after(()=>{globalThis.fetch=original.fetch;console.error=original.error;if(original.key===undefined)delete process.env.DECISION_GATEWAY_API_KEY;else process.env.DECISION_GATEWAY_API_KEY=original.key})
const questions=[{type:'choice' as const,name:'outcome',instructions:'Synthetic choice',choices:[{value:'yes'}]}]
test('an API key without trusted execution scope cannot send or spend',async()=>{
  scope=undefined
  assert.equal(await invoke('fixture','test',questions),null)
  assert.equal(sends,0);assert.equal(reservations,0)
})
test('policy and zero balance refusals happen before any provider request',async()=>{
  deniedAt='prepare';await assert.rejects(invoke('fixture','test',questions),/modelRouteDenied/)
  assert.equal(sends,0);assert.equal(reservations,0)
  deniedAt=null;checks=0;balance=false
  await assert.rejects(invoke('fixture','test',questions),/points_exhausted/)
  assert.equal(sends,0);assert.equal(reservations,0)
})
test('revocation after admission releases a provably unused call with zero cost',async()=>{
  deniedAt='send'
  assert.equal(await invoke('fixture','test',questions),null)
  assert.equal(sends,0);assert.equal(reservations,1);assert.deepEqual(settlements,[0])
})
test('an allowed scoped call sends once and settles only the returned actual cost',async()=>{
  assert.ok(await invoke('fixture','test',questions))
  assert.equal(sends,1);assert.equal(checks,2);assert.deepEqual(settlements,[1])
})
