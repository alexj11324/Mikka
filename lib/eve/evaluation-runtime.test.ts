import assert from 'node:assert/strict'
import {test} from 'node:test'
import {MockLanguageModelV4} from 'ai/test'
import {evaluationModelBudget} from './evaluation-runtime'

test('native evaluation preserves the response budget without adding calls or changing model identity',async()=>{
 const calls:Array<{maxOutputTokens?:number;abortSignal?:AbortSignal}>=[]
 const model=new MockLanguageModelV4({modelId:'frozen-model',provider:'frozen-provider',doStream:async options=>{calls.push(options);return{stream:new ReadableStream({start(controller){controller.close()}})}},doGenerate:async options=>{calls.push(options);throw Error('fixture terminal failure')}})
 const wrapped=evaluationModelBudget(model),signal=new AbortController().signal
 assert.equal(wrapped.modelId,model.modelId);assert.equal(wrapped.provider,model.provider)
 for(const maxOutputTokens of [undefined,5000,700])await wrapped.doStream({prompt:[],maxOutputTokens,abortSignal:signal})
 await assert.rejects(Promise.resolve(wrapped.doGenerate({prompt:[],maxOutputTokens:5000,abortSignal:signal})),/fixture terminal failure/)
 assert.deepEqual(calls.map(call=>call.maxOutputTokens),[1400,1400,700,1400])
 assert.ok(calls.every(call=>call.abortSignal===signal))
})
