import assert from 'node:assert/strict'
import test from 'node:test'
import { streamText } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import { completedEvaluationReply } from './eval-generation'

test('actual SDK parseable JSON cannot pass completion checks after error, truncation, filter, missing finish or cancellation',async()=>{
  const originalFetch=globalThis.fetch
  let network=0
  globalThis.fetch=async()=>{network++;throw new Error('No external transport in offline SDK test')}
  try{
    for(const outcome of ['stop','error','error-then-stop','length','content-filter','other','missing-finish','cancelled']){
      let calls=0,failed=false
      const model=new MockLanguageModelV4({doStream:async()=>{
        calls++
        return {stream:new ReadableStream({start(controller){
          controller.enqueue({type:'stream-start',warnings:[]})
          controller.enqueue({type:'text-start',id:'reply'})
          controller.enqueue({type:'text-delta',id:'reply',delta:'{"text":"Synthetic complete-looking JSON","outcome":"answered"}'})
          controller.enqueue({type:'text-end',id:'reply'})
          if(outcome.startsWith('error'))controller.enqueue({type:'error',error:new Error('Synthetic error after JSON')})
          if(!['error','missing-finish'].includes(outcome))controller.enqueue({type:'finish',finishReason:{unified:['cancelled','error-then-stop'].includes(outcome)?'stop':outcome as 'stop'|'length'|'content-filter'|'other',raw:outcome},usage:{inputTokens:{total:1,noCache:1,cacheRead:0,cacheWrite:0},outputTokens:{total:1,text:1,reasoning:0}}})
          controller.close()
        }})}
      }})
      const signal=new AbortController()
      const result=streamText({model,prompt:'Inert offline case',maxRetries:0,onError:()=>{failed=true}})
      // Reproduce the reported failure: the SDK exposes parseable JSON even
      // when its stream subsequently fails. Completion checks must still win.
      assert.equal(JSON.parse(await result.text).outcome,'answered')
      if(outcome==='cancelled')signal.abort()
      if(outcome==='stop')assert.equal((await completedEvaluationReply(result,signal.signal,()=>failed)).outcome,'answered')
      else await assert.rejects(completedEvaluationReply(result,signal.signal,()=>failed))
      if(outcome.startsWith('error'))assert.equal(failed,true)
      assert.equal(calls,1,'failed generation cannot invoke fallback or retry')
    }
    assert.equal(network,0)
  }finally{globalThis.fetch=originalFetch}
})
