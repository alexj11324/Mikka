import assert from 'node:assert/strict'
import { before, mock, test } from 'node:test'
import { MockLanguageModelV4 } from 'ai/test'
let compactWithFrozenModel: typeof import('./compaction-model').compactWithFrozenModel
import type { SubscriptionService } from '../subscription-service'

const id=(n:number)=>`10000000-0000-4000-8000-${String(n).padStart(12,'0')}`
const scope={ownerId:'synthetic-owner',botId:id(1),workspaceId:id(2)}
const selection={type:'subscription' as const,bindingId:id(3),ownerId:scope.ownerId,consumerId:scope.botId,workspaceId:scope.workspaceId,connectionId:id(4),connectionRevision:1,modelId:'synthetic-stream-model',route:'claude_cpa' as const}

mock.module(new URL('../model-admission/runtime.ts', import.meta.url).href, { namedExports: {
 assertSubscriptionModelTransport: async (actualScope: {workspaceId:string;ownerId:string}, modelId: string, route: string) => {
  assert.deepEqual(actualScope, {workspaceId:scope.workspaceId,ownerId:scope.ownerId})
  assert.equal(modelId, selection.modelId)
  assert.equal(route, selection.route)
 },
} })
before(async () => { compactWithFrozenModel = (await import('./compaction-model')).compactWithFrozenModel })

test('actual SDK partial-error or unterminated streams cannot become successful compaction text',async()=>{
 const originalFetch=globalThis.fetch,originalError=console.error
 let network=0
 globalThis.fetch=async()=>{network++;throw Error('External network forbidden in offline SDK test')}
 console.error=()=>{}
 try{
  for(const outcome of ['stop','error','missing-finish']){
   let streams=0
   const model=new MockLanguageModelV4({doStream:async()=>{
    streams++
    return {stream:new ReadableStream({start(controller){
     controller.enqueue({type:'stream-start',warnings:[]})
     controller.enqueue({type:'text-start',id:'text'})
     controller.enqueue({type:'text-delta',id:'text',delta:'Synthetic partial summary'})
     controller.enqueue({type:'text-end',id:'text'})
     if(outcome==='error')controller.enqueue({type:'error',error:new Error('Synthetic error after partial output')})
     if(outcome==='stop')controller.enqueue({type:'finish',finishReason:{unified:'stop',raw:'stop'},usage:{inputTokens:{total:1,noCache:1,cacheRead:0,cacheWrite:0},outputTokens:{total:1,text:1,reasoning:0}}})
     controller.close()
    }})}
   }})
   const service={repository:{binding:async()=>({id:selection.bindingId,...selection}),connection:async()=>({id:selection.connectionId,ownerId:scope.ownerId,workspaceId:scope.workspaceId,epoch:1,state:'connected'})},model:async()=>model} as unknown as SubscriptionService
   const operation=()=>compactWithFrozenModel(scope,{harness:'ai_sdk',model:selection.modelId,modelSelection:selection},[{role:'user',content:'Synthetic retained pending context'}],{service:()=>service,workspace:async()=>{}})
   if(outcome==='stop')assert.equal(await operation(),'Synthetic partial summary')
   else await assert.rejects(operation)
   assert.equal(streams,1)
  }
  assert.equal(network,0)
 }finally{globalThis.fetch=originalFetch;console.error=originalError}
})
