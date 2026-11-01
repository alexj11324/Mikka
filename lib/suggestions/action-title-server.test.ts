import assert from 'node:assert/strict'
import { after,before,beforeEach,mock,test } from 'node:test'
import type { ActionTitleInput } from './action-title'
const savedKey=process.env.DECISION_GATEWAY_API_KEY
let allowed=true
const providers=new WeakSet<object>(),keys:string[]=[],writes:unknown[]=[]
const generateText=mock.fn(async()=>({text:JSON.stringify({titles:[{id:'item',title:'Review the change'}]})}))
mock.module('ai',{namedExports:{generateText}})
mock.module(new URL('../db/index.ts',import.meta.url).href,{namedExports:{db:{
  select:()=>({from:()=>({where:()=>({limit:async()=>[{locale:'en'}]})})}),
  update:()=>({set:(value:unknown)=>({where:async()=>{writes.push(value)}})}),
}}})
mock.module(new URL('../execution-settings.ts',import.meta.url).href,{namedExports:{executionWorkspace:async()=> 'fixture-workspace'}})
mock.module(new URL('../model-admission/runtime.ts',import.meta.url).href,{namedExports:{modelAdmission:{gateway:async()=>{if(!allowed)throw new Error('modelRouteDenied');return null}}}})
mock.module(new URL('../abuse/model.ts',import.meta.url).href,{namedExports:{
  createTrustedGatewayModel:async(modelId:string,key:string)=>{keys.push(key);const model={modelId};providers.add(model);return model},
  hostedModel:async(workspace:string,_id:string,provider:object,owner:string)=>{assert.equal(workspace,'fixture-workspace');assert.equal(owner,'owner');assert.ok(providers.has(provider));return provider},
}})
let writeActionTitles:typeof import('./action-title-server').writeActionTitles
before(async()=>{writeActionTitles=(await import('./action-title-server')).writeActionTitles})
beforeEach(()=>{process.env.DECISION_GATEWAY_API_KEY='synthetic-action-key';allowed=true;keys.length=0;writes.length=0;generateText.mock.resetCalls()})
after(()=>{if(savedKey===undefined)delete process.env.DECISION_GATEWAY_API_KEY;else process.env.DECISION_GATEWAY_API_KEY=savedKey})
const items:ActionTitleInput[]=[{id:'item',source:'github',action:'review',title:'Change',actor:null,excerpt:'Review the change'}]
test('an allowed action-title route uses the trusted fixed-endpoint model and preserves its dedicated key',async()=>{
  await writeActionTitles('owner',items)
  assert.deepEqual(keys,['synthetic-action-key'])
  assert.equal(generateText.mock.callCount(),1)
  assert.deepEqual(writes,[{actionTitle:'Review the change'}])
})
test('a denied action-title route cannot generate or update titles',async t=>{
  t.mock.method(console,'error',()=>{});allowed=false
  await writeActionTitles('owner',items)
  assert.equal(generateText.mock.callCount(),0);assert.equal(keys.length,0);assert.equal(writes.length,0)
})
