import assert from 'node:assert/strict'
import test from 'node:test'
import { runtimeForWritePlanning, supportsWritePlanning } from './write-planning-model'

test('write planning uses only the documented image and tool capable Gateway route',()=>{
 assert.equal(supportsWritePlanning({harness:'ai_sdk',model:'openai/gpt-6-luna'}),true)
 for (const runtime of [{harness:'ai_sdk',model:'nvidia/nemotron-3.5-lightning-free'},{harness:'codex',model:'openai/gpt-6-luna'},{harness:'ai_sdk',model:'openai/gpt-6-luna-decisions'},{harness:'ai_sdk',model:null}]) assert.equal(supportsWritePlanning(runtime),false)
})

test('existing image parts on a trusted user message remain image parts in the model prompt',async()=>{
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
