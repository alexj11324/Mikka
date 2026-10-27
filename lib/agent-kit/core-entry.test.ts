import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { makeSnapshot } from './definition'
import { DEFAULT_AGENT_DEFINITION } from './builtin'
import type { AgentExecution } from './store'

const owner='synthetic-owner',bot='10000000-0000-4000-8000-000000000001'
const calls: {name:string;args:unknown[]}[]=[]
let execution:AgentExecution|null=null
let inboxTaken=false
const record=(name:string)=>(...args:unknown[])=>{calls.push({name,args})}
const stub=(path:string,namedExports:Record<string,unknown>)=>mock.module(new URL(path,import.meta.url).href,{namedExports})
mock.module('workflow',{namedExports:{getWorkflowMetadata:()=>({workflowRunId:'synthetic-workflow'})}})
stub('../coordinator/model.ts',{COORDINATOR_MODEL:'current-default',coordinatorStep:()=>({}),turnWarning:(_reason:string,text:string)=>text})
stub('../attention/handoff.ts',{QUIET_REPLY:'__quiet__'})
stub('../subscription-workflow-turn.ts',{runHostedWorkflowTurn:async(...args:unknown[])=>{record('hosted')(...args);return {text:'grounded reply',finishReason:'stop',responseMessages:[]}}})
stub('../../workflows/coordinator/native-steps.ts',{runtime:async()=>({harness:'ai_sdk'})})
stub('../../workflows/coordinator/native-turn.ts',{nativeCoordinatorTurn:()=>{throw new Error('unexpected native dispatch')}})
stub('../../workflows/coordinator/tools.ts',{coordinatorTools:(...args:unknown[])=>{record('tools')(...args);return {}}})
stub('../../workflows/coordinator/agent-kit-steps.ts',{
  beginAgentExecution:async(...args:unknown[])=>{record('begin')(...args);return execution},
  finishAgentExecution:async(...args:unknown[])=>{record('finish')(...args)},
})
stub('../../workflows/coordinator/steps.ts',{
  computerToolsEnabled:async()=>false,
  takeInbox:async()=>{const added=!inboxTaken;inboxTaken=true;return {held:true,added,handoffOnly:false,handoffMatterIds:[],telegramTargets:[]}},
  releaseLease:async()=>false,
  preparePrompt:async(...args:unknown[])=>{record('prompt')(...args);return {prompt:'synthetic request'}},
  appendMessages:async(...args:unknown[])=>{record('append')(...args)},
  settleAttention:async()=>{throw new Error('unexpected attention action')},
  telegramReplyThreads:async()=>{throw new Error('unexpected external message')},
  sendTelegramChunk:async()=>{throw new Error('unexpected external message')},
  failTurn:async(...args:unknown[])=>{record('failed')(...args)},
})
const {coordinatorTurn}=await import('../../workflows/coordinator/workflow')
function reset(harness?:string){
  calls.length=0;inboxTaken=false
  execution=harness?{id:'10000000-0000-4000-8000-000000000002',status:'running',snapshot:makeSnapshot('10000000-0000-4000-8000-000000000003',1,DEFAULT_AGENT_DEFINITION,'saved host',{harness,model:'saved-model'})}:null
}
test('real workflow entry uses the returned execution snapshot for model, prompt and tool registry',async()=>{
  reset('ai_sdk')
  await coordinatorTurn(owner,bot)
  assert.deepEqual(calls.find(c=>c.name==='begin')?.args,[owner,bot,'synthetic-workflow',0,{harness:'ai_sdk'}])
  assert.deepEqual(calls.find(c=>c.name==='hosted')?.args[0],execution!.snapshot.runtime)
  assert.equal(calls.find(c=>c.name==='prompt')?.args[2],execution!.snapshot)
  assert.deepEqual(calls.find(c=>c.name==='tools')?.args,[owner,bot,undefined,{execution,computerEnabled:false}])
  assert.equal(calls.filter(c=>c.name==='hosted').length,1)
  assert.equal(calls.filter(c=>c.name==='failed').length,0)
})
test('disabled Agent Kit retains the existing default model entry without inventing a snapshot',async()=>{
  reset()
  await coordinatorTurn(owner,bot)
  assert.deepEqual(calls.find(c=>c.name==='hosted')?.args[0],{harness:'ai_sdk',model:'current-default'})
  assert.equal(calls.find(c=>c.name==='prompt')?.args[2],undefined)
})
test('a replayed harness mismatch fails before hosted or native dispatch',async()=>{
  reset('codex')
  await assert.rejects(coordinatorTurn(owner,bot),/agent_runtime_changed/)
  assert.equal(calls.filter(c=>c.name==='hosted').length,0)
  assert.deepEqual(calls.find(c=>c.name==='finish')?.args,[owner,bot,execution!.id,'turn_failed'])
  assert.equal(calls.filter(c=>c.name==='failed').length,1)
})
