import assert from 'node:assert/strict'
import { before,beforeEach,mock,test } from 'node:test'
import type { ActionTitleInput } from './action-title'
let allowed=true, available=true
const admitted:unknown[]=[],writes:unknown[]=[]
const generateText=mock.fn(async()=>({text:JSON.stringify({titles:[{id:'item',title:'Review the change'}]})}))
mock.module(new URL('../default-model.ts', import.meta.url).href, { namedExports: { defaultModelAvailable: async () => available } })
mock.module('ai',{namedExports:{generateText}})
mock.module(new URL('../db/index.ts',import.meta.url).href,{namedExports:{db:{
  select:()=>({from:()=>({where:()=>({limit:async()=>[{locale:'en'}]})})}),
  update:()=>({set:(value:unknown)=>({where:async()=>{writes.push(value)}})}),
}}})
mock.module(new URL('../execution-settings.ts',import.meta.url).href,{namedExports:{executionWorkspace:async()=> 'fixture-workspace'}})
mock.module(new URL('../abuse/model.ts',import.meta.url).href,{namedExports:{
  admitHostedModel:async(scope:unknown,modelId:string)=>{if(!allowed)throw new Error('modelRouteDenied');admitted.push({scope,modelId});return null},
  hostedModel:async(workspace:string,modelId:string,provider:unknown,owner:string)=>{assert.equal(workspace,'fixture-workspace');assert.equal(owner,'owner');assert.equal(provider,undefined);return {modelId}},
}})
let writeActionTitles:typeof import('./action-title-server').writeActionTitles
before(async()=>{writeActionTitles=(await import('./action-title-server')).writeActionTitles})
beforeEach(()=>{allowed=true;available=true;admitted.length=0;writes.length=0;generateText.mock.resetCalls()})
const items:ActionTitleInput[]=[{id:'item',source:'github',action:'review',title:'Change',actor:null,excerpt:'Review the change'}]
test('an allowed action-title route uses the managed title alias',async()=>{
  await writeActionTitles('owner',items)
  assert.deepEqual(admitted,[{scope:{workspaceId:'fixture-workspace',ownerId:'owner'},modelId:'mikka-title'}])
  assert.equal(generateText.mock.callCount(),1)
  assert.deepEqual(writes,[{actionTitle:'Review the change'}])
})
test('a denied action-title route cannot generate or update titles',async t=>{
  t.mock.method(console,'error',()=>{});allowed=false
  await writeActionTitles('owner',items)
  assert.equal(generateText.mock.callCount(),0);assert.equal(writes.length,0)
})
test('without LiteLLM no action title is written',async()=>{
  available=false
  await writeActionTitles('owner',items)
  assert.equal(generateText.mock.callCount(),0);assert.equal(admitted.length,0);assert.equal(writes.length,0)
})
