import assert from 'node:assert/strict'
import { test } from 'node:test'
import { WorkflowAgent } from '@ai-sdk/workflow'
import { runHostedWorkflowTurn } from './subscription-workflow-turn'
const id=(n:number)=>`10000000-0000-4000-8000-${String(n).padStart(12,'0')}`
const runtime={harness:'ai_sdk',model:'saved-model',modelSelection:{type:'subscription' as const,bindingId:id(3),ownerId:'alice',consumerId:id(1),workspaceId:id(2),connectionId:id(4),connectionRevision:7,modelId:'saved-model',route:'claude_cpa' as const}}
test('hosted subscription uses Workflow streaming, zero retry and returns tool-loop messages',async t=>{
  let calls=0
  t.mock.method(WorkflowAgent.prototype,'generate',()=>{throw new Error('paid fallback')})
  t.mock.method(WorkflowAgent.prototype,'stream',async (options: {maxRetries:number})=>{
    calls++;assert.equal(options.maxRetries,0)
    return {steps:[{text:'done',response:{messages:[{role:'assistant',content:'done'}]}}],finishReason:'stop'}
  })
  const result=await runHostedWorkflowTurn(runtime,{}, {prompt:'synthetic',maxRetries:9})
  assert.equal(calls,1);assert.equal(result.text,'done')
  assert.deepEqual(result.responseMessages,[{role:'assistant',content:'done'}])
})
test('stream refusal does not invoke generate or retry',async t=>{
  let calls=0
  t.mock.method(WorkflowAgent.prototype,'generate',()=>{throw new Error('paid fallback')})
  t.mock.method(WorkflowAgent.prototype,'stream',async ()=>{calls++;throw new Error('synthetic refusal')})
  await assert.rejects(runHostedWorkflowTurn(runtime,{}, {prompt:'synthetic'}),/synthetic refusal/)
  assert.equal(calls,1)
})
test('default snapshot retains generate mode and malformed subscription never falls back',async t=>{
  let generated=0
  t.mock.method(WorkflowAgent.prototype,'generate',async ()=>{generated++;return {text:'default',responseMessages:[],finishReason:'stop'}})
  t.mock.method(WorkflowAgent.prototype,'stream',()=>{throw new Error('unexpected stream')})
  const result=await runHostedWorkflowTurn({harness:'ai_sdk',model:'saved-default'}, {}, {prompt:'synthetic'})
  assert.equal(result.text,'default');assert.equal(generated,1)
  await assert.rejects(runHostedWorkflowTurn({...runtime,model:'different'}, {}, {prompt:'synthetic'}),/subscription_model_unavailable/)
  assert.equal(generated,1)
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
