import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MockLanguageModelV4 } from 'ai/test'
import type { SubscriptionService } from './subscription-service'
import { freezeHostedModelSelection, resolveFrozenHostedModel, type HostedRuntimeSnapshot } from './subscription-model-snapshot'

const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12,'0')}`
const scope = { ownerId:'alice',botId:id(1),workspaceId:id(2) }
function fixture() {
  const binding = { id:id(3),ownerId:'alice',consumerId:id(1),workspaceId:id(2),connectionId:id(4),connectionRevision:7,modelId:'fixture-model',route:'claude_cpa' as const }
  const connection = { id:id(4),ownerId:'alice',workspaceId:id(2),epoch:'7',state:'connected' }
  let calls = 0
  const model = new MockLanguageModelV4({ doGenerate:async () => { calls++; throw new Error('synthetic model invoked') } })
  const service = { repository:{ binding:async (_owner:string,key:string) => { assert.equal(key,id(3));return { ...binding } },connection:async () => ({ ...connection }) },model:async () => model } as unknown as SubscriptionService
  const deps = { service:() => service,workspace:async () => {} }
  return { binding,connection,deps,calls:() => calls }
}
test('first selection freezes authoritative model, route, owner, consumer, workspace, connection and epoch', async () => {
  const f=fixture()
  const result=await freezeHostedModelSelection(scope,{harness:'ai_sdk',model:'default'}, {type:'subscription',bindingId:id(3)},f.deps)
  assert.deepEqual(result,{harness:'ai_sdk',model:'fixture-model',modelSelection:{type:'subscription',bindingId:id(3),ownerId:'alice',consumerId:id(1),workspaceId:id(2),connectionId:id(4),connectionRevision:7,modelId:'fixture-model',route:'claude_cpa'}})
})
test('default stays frozen and never constructs a subscription backend', async () => {
  const f=fixture();f.deps.service=() => {throw new Error('backend called')}
  const frozen=await freezeHostedModelSelection(scope,{harness:'ai_sdk',model:'original-default'},undefined,f.deps)
  assert.equal(await resolveFrozenHostedModel(scope,frozen,f.deps),'original-default')
})
test('internal coordinator key, foreign scope and native route cannot become a hosted subscription selection', async () => {
  for(const changed of [{...scope,botId:null,workspaceId:null},{...scope,botId:'coordinator'},{...scope,ownerId:'other'}]) {
    await assert.rejects(freezeHostedModelSelection(changed,{harness:'ai_sdk',model:'default'},{type:'subscription',bindingId:id(3)},fixture().deps))
  }
  await assert.rejects(freezeHostedModelSelection(scope,{harness:'codex',model:'default'},{type:'subscription',bindingId:id(3)},fixture().deps))
})
test('replay verifies the saved binding and refuses changed model, epoch, route, consumer or connection instead of reselecting', async () => {
  for(const mutation of ['modelId','connectionRevision','consumerId','connectionId','route'] as const) {
    const f=fixture();const frozen=await freezeHostedModelSelection(scope,{harness:'ai_sdk',model:'default'},{type:'subscription',bindingId:id(3)},f.deps)
    Object.assign(f.binding,{[mutation]:mutation==='connectionRevision'?8:'changed'})
    await assert.rejects(resolveFrozenHostedModel(scope,frozen,f.deps))
    assert.equal(f.calls(),0)
  }
})
test('each cached model call rechecks saved authority after disconnect or reconnect', async () => {
  for(const mode of ['disconnect','reconnect']) {
    const f=fixture();const frozen=await freezeHostedModelSelection(scope,{harness:'ai_sdk',model:'default'},{type:'subscription',bindingId:id(3)},f.deps)
    const model=await resolveFrozenHostedModel(scope,frozen,f.deps)
    assert.notEqual(typeof model,'string')
    if(mode==='disconnect')f.connection.state='disconnected';else f.connection.epoch='8'
    await assert.rejects(async () => (model as MockLanguageModelV4).doGenerate({prompt:[]}))
    assert.equal(f.calls(),0)
  }
})
test('abort and malformed explicit snapshot fail closed without provider calls', async () => {
  const f=fixture();const frozen=await freezeHostedModelSelection(scope,{harness:'ai_sdk',model:'default'},{type:'subscription',bindingId:id(3)},f.deps)
  const controller=new AbortController();controller.abort()
  await assert.rejects(resolveFrozenHostedModel(scope,frozen,f.deps,controller.signal),{name:'AbortError'})
  await assert.rejects(resolveFrozenHostedModel(scope,{...frozen,modelSelection:null} as unknown as HostedRuntimeSnapshot,f.deps))
  assert.equal(f.calls(),0)
})
test('Coordinator freezes an owned connected binding with distinct replay identity',async()=>{
  const f=fixture(),coordinatorScope={...scope,botId:null}
  const frozen=await freezeHostedModelSelection(coordinatorScope,{harness:'ai_sdk',model:null},{type:'subscription',bindingId:id(3)},f.deps)
  assert.equal(frozen.modelSelection?.coordinator,true)
  assert.notEqual(typeof await resolveFrozenHostedModel(coordinatorScope,frozen,f.deps),'string')
  await assert.rejects(resolveFrozenHostedModel(scope,frozen,f.deps))
  await assert.rejects(resolveFrozenHostedModel({...coordinatorScope,workspaceId:id(99)},frozen,f.deps))
})
