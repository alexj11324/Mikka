import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {before, beforeEach, mock, test} from 'node:test'
import {makeSnapshot} from './definition'
import {SubscriptionService} from '../subscription-service'
import type {SubscriptionRepository} from '../subscription-repository'
import {freezeWorkerDefinition} from './worker'
import {DEFAULT_AGENT_DEFINITION} from './builtin'
import type {AgentExecution} from './store'
const owner=randomUUID(),botId=randomUUID(),issueId=randomUUID()
const dispatched=mock.fn(async()=>({status:'queued'}))
const beforeCall=mock.fn(async()=>{})
const afterCall=mock.fn(async()=>{})
const stub=(path:string,namedExports:Record<string,unknown>)=>mock.module(new URL(path,import.meta.url).href,{namedExports})
stub('../../workflows/coordinator/steps.ts',{dispatchComputerTask:dispatched,dispatchRun:dispatched})
stub('../../workflows/coordinator/agent-kit-steps.ts',{beforeAgentTool:beforeCall,afterAgentTool:afterCall,loadAgentSkill:async()=>({error:'notAssigned'})})
stub('../composio-actions.ts',{createComposioAITools:()=>({}),createGoogleAITools:()=>({})})
let registry: typeof import('../../workflows/coordinator/tools')
before(async()=>{registry=await import('../../workflows/coordinator/tools')})
beforeEach(()=>{for(const fn of [dispatched,beforeCall,afterCall])fn.mock.resetCalls()})
const context={toolCallId:'synthetic-call',messages:[]}
const execution=():AgentExecution=>({id:randomUUID(),status:'running',snapshot:makeSnapshot(randomUUID(),1,{...DEFAULT_AGENT_DEFINITION,tools:['dispatch_bot_computer']},'HOST',{harness:'ai_sdk',model:'synthetic'})})
test('feature-off catalog omits cloud tools; only named options can enable the computer',()=>{
 const off=registry.coordinatorTools(owner,botId)
 assert.equal(off.dispatch_bot_computer,undefined);assert.equal(off.start_web_subagent,undefined);assert.equal(off.load_skill,undefined);assert.ok(off.record_attention)
 assert.ok(registry.coordinatorTools(owner,botId,undefined,{computerEnabled:true}).dispatch_bot_computer)
 assert.ok(registry.coordinatorTools(owner,botId,undefined,{computerEnabled:true}).start_web_subagent)
 assert.throws(()=>registry.coordinatorTools(owner,botId,undefined,true as unknown as NonNullable<Parameters<typeof registry.coordinatorTools>[3]>),/agentToolOptionsInvalid/)
 assert.throws(()=>registry.coordinatorTools(owner,botId,undefined,{execution:execution(),computerEnabled:false}),/agentToolUnavailable/)
})
test('versioned cloud tool keeps host owner, native scope and parent execution',async()=>{
 const run=execution(),scope={holder:'holder',turnId:'turn',callId:'call'}
 const tools=registry.coordinatorTools(owner,botId,scope,{execution:run,computerEnabled:true})
 const execute=tools.dispatch_bot_computer.execute as unknown as (input:unknown,options:typeof context)=>Promise<unknown>
 await execute({issueId,harness:'codex'},context)
 const args=dispatched.mock.calls[0].arguments as unknown[]
 assert.equal(args[0],owner);assert.deepEqual(args[1],{issueId,harness:'codex',botId});assert.equal(args[2],context.toolCallId);assert.deepEqual(args[3],scope);assert.equal(args[4],run)
 assert.equal(beforeCall.mock.callCount(),1);assert.equal(afterCall.mock.callCount(),1)
})
test('a named Bot cannot redirect its cloud tool to another Bot',async()=>{
 const tools=registry.coordinatorTools(owner,botId,undefined,{execution:execution(),computerEnabled:true})
 const execute=tools.dispatch_bot_computer.execute as unknown as (input:unknown,options:typeof context)=>Promise<unknown>
 assert.deepEqual(await execute({botId:randomUUID(),issueId,harness:'codex'},context),{error:'botMismatch'});assert.equal(dispatched.mock.callCount(),0)
})


test('native subscription requests retain the run snapshot after Agent harness/device edits',async()=>{
 const binding={id:randomUUID(),modelId:'frozen-model',route:'codex_cli'}
 const snapshot=freezeWorkerDefinition({harness:'codex',instructions:'Review',prompt:'task',parent:null,executionId:null,subscription:binding})
 let row={...binding,workspaceId:randomUUID(),consumerId:randomUUID(),harness:'claude_code',agentDefinition:snapshot}
 const requests:unknown[][]=[]
 const repository={pool:{query:async(_sql:string,args:unknown[])=>{requests.push(args);return {rows:[row]}}}} as unknown as SubscriptionRepository
 const service=new SubscriptionService(repository,()=>{throw Error('No worker/provider request is allowed in this unit test')},{ready:()=>false,nativeIsolation:'none'})
 const device=randomUUID(),run=randomUUID()
 const use=await service.nativeRun(owner,device,run);assert.equal(use.bindingId,binding.id);assert.deepEqual(requests[0],[run,owner,device])
 for(const patch of [{modelId:'changed'},{id:randomUUID()},{route:'claude_code_cli'}]) {
  row={...row,...patch};await assert.rejects(service.nativeRun(owner,device,run),{code:'binding_mismatch'});row={...row,...binding}
 }
 row={...row,agentDefinition:freezeWorkerDefinition({harness:'codex',instructions:'Review',prompt:'task',parent:null,executionId:null})}
 await assert.rejects(service.nativeRun(owner,device,run),{code:'binding_mismatch'})
})
