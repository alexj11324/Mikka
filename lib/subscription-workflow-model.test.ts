import assert from 'node:assert/strict'
import { test } from 'node:test'
import { WORKFLOW_SERIALIZE, WORKFLOW_DESERIALIZE } from '@workflow/serde'
import { SubscriptionWorkflowModel } from './subscription-workflow-model'
const id=(n:number)=>`10000000-0000-4000-8000-${String(n).padStart(12,'0')}`
const selection={type:'subscription' as const,bindingId:id(3),ownerId:'alice',consumerId:id(1),workspaceId:id(2),connectionId:id(4),connectionRevision:7,modelId:'saved-model',route:'claude_cpa' as const}
test('Workflow serde carries only the fixed non-secret binding descriptor',()=>{
  const first=new SubscriptionWorkflowModel(selection)
  const serialized=SubscriptionWorkflowModel[WORKFLOW_SERIALIZE](first)
  assert.deepEqual(serialized,selection)
  const restored=SubscriptionWorkflowModel[WORKFLOW_DESERIALIZE](JSON.parse(JSON.stringify(serialized)))
  assert.equal(restored.modelId,'saved-model')
  assert.deepEqual(SubscriptionWorkflowModel[WORKFLOW_SERIALIZE](restored),selection)
  assert.throws(()=>SubscriptionWorkflowModel[WORKFLOW_DESERIALIZE]({...selection,accessToken:'synthetic-canary'}))
})
test('unsupported non-streaming invocation refuses rather than calling a default provider',async()=>{
  await assert.rejects(new SubscriptionWorkflowModel(selection).doGenerate({prompt:[]}),/subscription_stream_required/)
})
