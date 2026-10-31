import assert from 'node:assert/strict'
import { test } from 'node:test'
import { WorkflowAgent } from '@ai-sdk/workflow'
import type { ModelCallStreamPart } from '@ai-sdk/workflow'
import { runHostedWorkflowTurn } from './subscription-workflow-turn'
const id=(n:number)=>`10000000-0000-4000-8000-${String(n).padStart(12,'0')}`
const runtime={harness:'ai_sdk',model:'saved-model',modelSelection:{type:'subscription' as const,bindingId:id(3),ownerId:'alice',consumerId:id(1),workspaceId:id(2),connectionId:id(4),connectionRevision:7,modelId:'saved-model',route:'claude_cpa' as const}}
test('hosted subscription uses Workflow streaming, zero retry and returns tool-loop messages',async t=>{
  let calls=0
  const writable=new WritableStream<ModelCallStreamPart>()
  t.mock.method(WorkflowAgent.prototype,'generate',()=>{throw new Error('paid fallback')})
  t.mock.method(WorkflowAgent.prototype,'stream',async (options: {maxRetries:number;writable:unknown;preventClose:boolean})=>{
    calls++;assert.equal(options.maxRetries,0);assert.equal(options.writable,writable);assert.equal(options.preventClose,true)
    return {steps:[{text:'working',response:{messages:[{role:'assistant',content:'tool call'},{role:'tool',content:'tool result'}]}},{text:'done',response:{messages:[{role:'assistant',content:'done'}]}}],finishReason:'stop'}
  })
  const result=await runHostedWorkflowTurn(runtime,{}, {prompt:'synthetic',maxRetries:9,writable,preventClose:true})
  assert.equal(calls,1);assert.equal(result.text,'done')
  assert.deepEqual(result.responseMessages,[{role:'assistant',content:'tool call'},{role:'tool',content:'tool result'},{role:'assistant',content:'done'}])
})
test('stream refusal does not invoke generate or retry',async t=>{
  let calls=0
  t.mock.method(WorkflowAgent.prototype,'generate',()=>{throw new Error('paid fallback')})
  t.mock.method(WorkflowAgent.prototype,'stream',async ()=>{calls++;throw new Error('synthetic refusal')})
  await assert.rejects(runHostedWorkflowTurn(runtime,{}, {prompt:'synthetic'}),/synthetic refusal/)
  assert.equal(calls,1)
})
test('default snapshot streams with zero retry and malformed subscription never falls back',async t=>{
  let streamed=0
  const writable=new WritableStream<ModelCallStreamPart>()
  t.mock.method(WorkflowAgent.prototype,'generate',()=>{throw new Error('unexpected generate')})
  t.mock.method(WorkflowAgent.prototype,'stream',async (options:{maxRetries:number;writable:unknown;preventClose:boolean})=>{
    streamed++;assert.equal(options.maxRetries,0);assert.equal(options.writable,writable);assert.equal(options.preventClose,true)
    return {steps:[{text:'default',response:{messages:[]}}],finishReason:'stop'}
  })
  const result=await runHostedWorkflowTurn({harness:'ai_sdk',model:'saved-default'}, {}, {prompt:'synthetic',writable,preventClose:true}, {ownerId:'alice',botId:null})
  assert.equal(result.text,'default');assert.equal(streamed,1)
  await assert.rejects(runHostedWorkflowTurn({...runtime,model:'different'}, {}, {prompt:'synthetic'}),/subscription_model_unavailable/)
  await assert.rejects(runHostedWorkflowTurn({harness:'ai_sdk',model:'saved-default'}, {}, {prompt:'synthetic'}),/verification_required/)
  assert.equal(streamed,1)
})
test('malformed explicit frozen selection never invokes the default model',async t=>{
  let generated=0
  t.mock.method(WorkflowAgent.prototype,'generate',async ()=>{generated++;return {text:'default',responseMessages:[],finishReason:'stop'}})
  t.mock.method(WorkflowAgent.prototype,'stream',()=>{throw new Error('unexpected stream')})
  for(const modelSelection of [null,false,0,'']) {
    const invalid={...runtime,modelSelection} as unknown as Parameters<typeof runHostedWorkflowTurn>[0]
    await assert.rejects(runHostedWorkflowTurn(invalid,{}, {prompt:'synthetic'}))
  }
  assert.equal(generated,0)
})
