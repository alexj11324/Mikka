import assert from 'node:assert/strict'
import { before, beforeEach, mock, test } from 'node:test'
import type { HostedRuntimeSnapshot } from '../subscription-model-snapshot'
const selection = { type:'subscription' as const,bindingId:'00000000-0000-4000-8000-000000000001',ownerId:'owner',consumerId:'00000000-0000-4000-8000-000000000002',workspaceId:'00000000-0000-4000-8000-000000000003',connectionId:'00000000-0000-4000-8000-000000000004',connectionRevision:1,modelId:'frozen-subscription-model',route:'codex_cpa' as const }
const scope={ownerId:'owner',botId:selection.consumerId,workspaceId:selection.workspaceId}
const calls: Array<{kind:string;options:Record<string,unknown>}>=[]
const resolutions: HostedRuntimeSnapshot[]=[]
let refuse=false,reply='synthetic compressed text'
mock.module(new URL('../subscription-model-snapshot.ts',import.meta.url).href,{namedExports:{resolveFrozenHostedModel:async(actualScope:unknown,runtime:HostedRuntimeSnapshot,_dependencies:unknown,signal:AbortSignal)=>{
 signal.throwIfAborted();assert.deepEqual(actualScope,scope);resolutions.push(runtime);if(refuse)throw Error('binding_mismatch');return runtime.modelSelection?{provider:'synthetic-stream-only'}:runtime.model
}}})
mock.module('ai',{namedExports:{
 generateText:async(options:Record<string,unknown>)=>{calls.push({kind:'generate',options});return {text:reply}},
 streamText:(options:Record<string,unknown>)=>{calls.push({kind:'stream',options});return {text:Promise.resolve(reply)}},
 pruneMessages:({messages}:{messages:unknown[]})=>messages,
}})
let compact:typeof import('./compaction-model')
before(async()=>{compact=await import('./compaction-model')})
beforeEach(()=>{calls.length=0;resolutions.length=0;refuse=false;reply='synthetic compressed text'})
const dependencies={service:()=>{throw Error('No real service')},workspace:async()=>{}}
test('compaction consumes the exact frozen default or subscription selection with no SDK retries',async()=>{
 for(const runtime of [{harness:'ai_sdk',model:'frozen-default'},{harness:'ai_sdk',model:selection.modelId,modelSelection:selection}]){
  const original=JSON.stringify(runtime)
  assert.equal(await compact.compactWithFrozenModel(scope,runtime,[{role:'user',content:'retained messages'}],dependencies),reply)
  assert.equal(resolutions.at(-1),runtime);assert.equal(JSON.stringify(runtime),original)
  const call=calls.at(-1)!;assert.equal(call.kind,runtime.modelSelection?'stream':'generate');assert.equal(call.options.maxRetries,0)
  assert.equal(call.options.model,runtime.modelSelection?call.options.model:'frozen-default')
 }
})
test('binding refusal, cancellation and empty output cannot produce a default-model summary',async()=>{
 const runtime={harness:'ai_sdk',model:selection.modelId,modelSelection:selection}
 refuse=true;await assert.rejects(compact.compactWithFrozenModel(scope,runtime,[],dependencies),/binding_mismatch/);assert.equal(calls.length,0)
 refuse=false;const controller=new AbortController();controller.abort();await assert.rejects(compact.compactWithFrozenModel(scope,runtime,[],dependencies,controller.signal));assert.equal(calls.length,0)
 reply=' ';await assert.rejects(compact.compactWithFrozenModel(scope,runtime,[],dependencies),/compactionModelUnavailable/);assert.equal(calls.length,1);assert.equal(calls[0].kind,'stream')
})
