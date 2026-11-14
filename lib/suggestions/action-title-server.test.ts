import assert from 'node:assert/strict'
import { after,before,beforeEach,mock,test } from 'node:test'
import type { ActionTitleInput } from './action-title'
const saved={key:process.env.ZEROCAT_API_KEY,url:process.env.ZEROCAT_BASE_URL,gateway:process.env.AI_GATEWAY_API_KEY}
let allowed=true
const admitted:unknown[]=[],writes:unknown[]=[]
const generateText=mock.fn(async()=>({text:JSON.stringify({titles:[{id:'item',title:'Review the change'}]})}))
// This installation has no linked Cloud model service. The configured provider still runs through admission.
mock.module(new URL('../cloud-services/runtime.ts', import.meta.url).href, { namedExports: { cloudClient: {
  capability: async (userId: string, capability: string) => {
    assert.equal(userId, 'owner')
    assert.equal(capability, 'models')
    return null
  },
} } })
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
beforeEach(()=>{delete process.env.AI_GATEWAY_API_KEY;process.env.ZEROCAT_API_KEY='synthetic-action-key';process.env.ZEROCAT_BASE_URL='https://zero.cat/v1';allowed=true;admitted.length=0;writes.length=0;generateText.mock.resetCalls()})
after(()=>{for(const [name,value] of [['ZEROCAT_API_KEY',saved.key],['ZEROCAT_BASE_URL',saved.url],['AI_GATEWAY_API_KEY',saved.gateway]] as const){if(value===undefined)delete process.env[name];else process.env[name]=value}})
const items:ActionTitleInput[]=[{id:'item',source:'github',action:'review',title:'Change',actor:null,excerpt:'Review the change'}]
test('an allowed action-title route uses the default model on its server-owned ZeroCat transport',async()=>{
  await writeActionTitles('owner',items)
  assert.deepEqual(admitted,[{scope:{workspaceId:'fixture-workspace',ownerId:'owner'},modelId:'deepseek/deepseek-v4.1-flash'}])
  assert.equal(generateText.mock.callCount(),1)
  assert.deepEqual(writes,[{actionTitle:'Review the change'}])
})
test('a denied action-title route cannot generate or update titles',async t=>{
  t.mock.method(console,'error',()=>{});allowed=false
  await writeActionTitles('owner',items)
  assert.equal(generateText.mock.callCount(),0);assert.equal(writes.length,0)
})
test('with neither ZeroCat nor a gateway credential no action title is written',async()=>{
  delete process.env.ZEROCAT_API_KEY
  await writeActionTitles('owner',items)
  assert.equal(generateText.mock.callCount(),0);assert.equal(admitted.length,0);assert.equal(writes.length,0)
})
test('without ZeroCat the default model still writes titles through its gateway fallback',async()=>{
  delete process.env.ZEROCAT_API_KEY;process.env.AI_GATEWAY_API_KEY='synthetic-gateway-key'
  await writeActionTitles('owner',items)
  assert.equal(generateText.mock.callCount(),1);assert.deepEqual(writes,[{actionTitle:'Review the change'}])
})
