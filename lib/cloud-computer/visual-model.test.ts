import assert from 'node:assert/strict'
import { before, mock, test } from 'node:test'
import { createHash } from 'node:crypto'
import type { VisualObservation } from './visual-contract'
let choose:typeof import('./visual-model').chooseVisualBrowserStep
let judge:typeof import('./visual-model').judgeVisualBrowserAction
before(async()=>{
 mock.module('@/lib/coordinator/decide',{namedExports:{invokeDecision:async()=>null}})
 const implementation=await import('./visual-model');choose=implementation.chooseVisualBrowserStep;judge=implementation.judgeVisualBrowserAction
})
const bytes=Buffer.from([0xff,0xd8,0xff,...Array.from({length:40},()=>0),0xff,0xd9])
const observation=():VisualObservation=>({observationId:'a'.repeat(32),loaderId:'live-document',origin:'https://example.com',observedAt:Date.now(),screenshot:'data:image/jpeg;base64,'+bytes.toString('base64'),width:1280,height:800,observation:{url:'https://example.com/',title:'Synthetic visual fixture',text:'Continue',elements:[],needsLogin:false}})
const next={action:'click' as const,x:100,y:200,step:'Open details',summary:'Open the item details'}
test('the actual planner request forwards original pixels as an image part, not as JSON prose',async()=>{
 const source=observation();let seen:any
 const result=await choose('Open item details','Observing',source,(async (request:unknown)=>{seen=request;return {toolCalls:[{toolName:'choose_browser_action',input:next}]}}) as never)
 assert.deepEqual(result.next,next)
 assert.equal(seen.messages[0].content[1].type,'image')
 assert.equal(seen.messages[0].content[1].image,source.screenshot)
 assert.ok(!seen.messages[0].content[0].text.includes(source.screenshot))
 assert.equal(seen.maxRetries,0)
 assert.equal(seen.toolChoice.toolName,'choose_browser_action')
})
test('a stale screenshot or malformed/ambiguous model action cannot execute',async()=>{
 const source=observation();source.observedAt-=100_000
 let calls=0
 await assert.rejects(choose('Task','State',source,(async()=>{calls++;return {toolCalls:[]}}) as never))
 assert.equal(calls,0)
 await assert.rejects(choose('Task','State',observation(),(async()=>({toolCalls:[{toolName:'choose_browser_action',input:next},{toolName:'choose_browser_action',input:next}]})) as never))
})
test('Decisions receives the same pixels and only a bound successful provider receipt is accepted',async()=>{
 const source=observation();let seen:any
 const execution={executionId:'32000000-0000-4000-8000-000000000003',modelId:'synthetic',providerGenerationId:'fixture',startedAt:new Date().toISOString(),completedAt:new Date().toISOString(),requestDigest:'b'.repeat(64),imageDigests:[createHash('sha256').update(bytes).digest('hex')],vision:'image-input-submitted'}
 const answers=new Map([['scope',{type:'choice',name:'scope',choice:'within_task'}],['effect',{type:'choice',name:'effect',choice:'browse'}]])
 const invoke=(async(_purpose:unknown,input:unknown)=>{seen=input;return {answers,execution}}) as never
 assert.equal((await judge('Task',next,source,invoke)).effect,'browse')
 assert.equal(seen.requiresVisual,true)
 assert.equal(seen.images[0].dataUrl,source.screenshot)
 execution.imageDigests=['0'.repeat(64)]
 await assert.rejects(judge('Task',next,source,invoke))
 await assert.rejects(judge('Task',next,source,(async()=>null) as never))
})
