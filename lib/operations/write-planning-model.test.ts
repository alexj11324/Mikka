import assert from 'node:assert/strict'
import test from 'node:test'
import { runtimeForWritePlanning, supportsWritePlanning } from './write-planning-model'

test('write planning uses only the documented image and tool capable Gateway route',()=>{
 assert.equal(supportsWritePlanning({harness:'ai_sdk',model:'openai/gpt-6-luna'}),true)
 for (const runtime of [{harness:'ai_sdk',model:'nvidia/nemotron-3.5-lightning-free'},{harness:'codex',model:'openai/gpt-6-luna'},{harness:'ai_sdk',model:'openai/gpt-6-luna-decisions'},{harness:'ai_sdk',model:null}]) assert.equal(supportsWritePlanning(runtime),false)
})

test('a synthetic prebuilt image message retains its image part in prompt projection',async()=>{
 const { promptMessages }=await import('@/lib/coordinator/context')
 const message={ role:'user' as const, content:[{type:'text' as const,text:'Please use this image'}, {type:'image' as const,image:new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=', 'base64'))}], mikkaUserEvent:{id:'fixture',sentAt:null} }
 const prompt=promptMessages(null,[{position:1,message}])
 assert.deepEqual(prompt[0].content,message.content)
})

test('new write-enabled gateway runs select the documented planner without replacing subscriptions or unrelated runs',()=>{
 const base={harness:'ai_sdk',model:'nvidia/nemotron-3.5-lightning-free'}
 assert.equal(runtimeForWritePlanning(base,['append_notion_paragraph'],true,false).model,'openai/gpt-6-luna')
 assert.equal(runtimeForWritePlanning(base,['append_notion_paragraph'],false,false),base)
 assert.equal(runtimeForWritePlanning(base,['append_notion_paragraph'],true,true),base)
 assert.equal(runtimeForWritePlanning(base,['web_search'],true,false),base)
})

// Exercises the real current text ingress. Image ingestion is separately owned
// by #331; this does not assert that an attachment reaches the model.
test('real text event reaches the prompt without requiring an image',async()=>{
 const { userMessageEvent }=await import('@/lib/coordinator-events')
 const { eventPrompt,promptMessages }=await import('@/lib/coordinator/context')
 const { sourcedEventMessage }=await import('@/lib/coordinator/message-safety')
 const event=userMessageEvent('owner','Cancel the calendar event I identified',{botId:'c0000000-0000-4000-8000-0000000c0de9'})
 const message=sourcedEventMessage({...event,id:'fixture'},eventPrompt(event))
 const prompt=promptMessages(null,[{position:1,message}])
 assert.equal(prompt[0].role,'user')
 assert.equal(prompt[0].content,'Cancel the calendar event I identified')
})
