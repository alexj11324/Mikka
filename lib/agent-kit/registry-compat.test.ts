import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {before, beforeEach, mock, test} from 'node:test'
import {makeSnapshot} from './definition'
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
test('feature-off catalog omits cloud tools; legacy boolean feature-on call remains compatible',()=>{
 const off=registry.coordinatorTools(owner,botId)
 assert.equal(off.dispatch_bot_computer,undefined);assert.equal(off.load_skill,undefined);assert.ok(off.record_attention)
 assert.ok(registry.coordinatorTools(owner,botId,undefined,true).dispatch_bot_computer)
 assert.throws(()=>registry.coordinatorTools(owner,botId,undefined,execution(),false),/agentToolUnavailable/)
})
test('versioned cloud tool keeps host owner, native scope and parent execution',async()=>{
 const run=execution(),scope={holder:'holder',turnId:'turn',callId:'call'}
 const tools=registry.coordinatorTools(owner,botId,scope,run,true)
 const execute=tools.dispatch_bot_computer.execute as (input:unknown,options:typeof context)=>Promise<unknown>
 await execute({issueId,harness:'codex'},context)
 const args=dispatched.mock.calls[0].arguments as unknown[]
 assert.equal(args[0],owner);assert.deepEqual(args[1],{issueId,harness:'codex',botId});assert.equal(args[2],context.toolCallId);assert.deepEqual(args[3],scope);assert.equal(args[4],run)
 assert.equal(beforeCall.mock.callCount(),1);assert.equal(afterCall.mock.callCount(),1)
})
test('a named Bot cannot redirect its cloud tool to another Bot',async()=>{
 const tools=registry.coordinatorTools(owner,botId,undefined,execution(),true)
 const execute=tools.dispatch_bot_computer.execute as (input:unknown,options:typeof context)=>Promise<unknown>
 assert.deepEqual(await execute({botId:randomUUID(),issueId,harness:'codex'},context),{error:'botMismatch'});assert.equal(dispatched.mock.callCount(),0)
})
