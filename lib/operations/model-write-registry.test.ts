import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mock, test } from 'node:test'
import { makeSnapshot } from '@/lib/agent-kit/definition'
import { DEFAULT_AGENT_DEFINITION } from '@/lib/agent-kit/builtin'

const dispatch=mock.fn(async () => ({ status:'awaiting_approval',actionId:'fixture' }))
const stub=(path:string,exports:Record<string,unknown>)=>mock.module(new URL(path,import.meta.url).href,{exports})
stub('../../workflows/coordinator/steps.ts',{personalWrite:dispatch})
stub('../../workflows/coordinator/agent-kit-steps.ts',{beforeAgentTool:async()=>{},afterAgentTool:async()=>{}})
stub('../composio-actions.ts',{createComposioAITools:()=>({}),createGoogleAITools:()=>({})})

test('registered model tool binds host owner, bot, execution and native call scope',async()=>{
 const { coordinatorTools }=await import('../../workflows/coordinator/tools')
 const owner='owner',botId=randomUUID(),id=randomUUID(),scope={holder:'holder',turnId:'turn',callId:'native-call'}
 const execution={id,status:'running' as const,snapshot:makeSnapshot(randomUUID(),1,{...DEFAULT_AGENT_DEFINITION,tools:['append_notion_paragraph']},'host',{harness:'ai_sdk',model:'openai/gpt-6-luna'})}
 assert.equal(coordinatorTools(owner,botId,scope,{execution}).append_notion_paragraph,undefined)
 const tools=coordinatorTools(owner,botId,scope,{execution,writeEnabled:true})
 const execute=tools.append_notion_paragraph.execute as unknown as (input:unknown,options:{toolCallId:string;messages:[]})=>Promise<unknown>
 const input={page_id:randomUUID(),text:'fixture'}
 assert.deepEqual(await execute(input,{toolCallId:'model-call',messages:[]}),{status:'awaiting_approval',actionId:'fixture'})
 assert.deepEqual(dispatch.mock.calls[0].arguments,[owner,botId,id,{action:'append_notion_paragraph',input,toolCallId:'model-call'},scope])
 await assert.rejects(execute({...input,allowed:true},{toolCallId:'model-call-2',messages:[]}))
 assert.equal(dispatch.mock.callCount(),1)
})

test('the default text-only route is not given effectful model tools',async()=>{
 const { coordinatorTools }=await import('../../workflows/coordinator/tools')
 const execution={id:randomUUID(),status:'running' as const,snapshot:makeSnapshot(randomUUID(),1,{...DEFAULT_AGENT_DEFINITION,tools:['append_notion_paragraph']},'host',{harness:'ai_sdk',model:'nvidia/nemotron-3.5-lightning-free'})}
 assert.equal(coordinatorTools('owner',null,undefined,{execution,writeEnabled:true}).append_notion_paragraph,undefined)
})
