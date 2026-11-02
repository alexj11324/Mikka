import assert from 'node:assert/strict'
import { before, mock, test } from 'node:test'
import { makeSnapshot } from './definition'
import { DEFAULT_AGENT_DEFINITION } from './builtin'
import type { AgentExecution } from './store'

const owner='synthetic-owner',bot='10000000-0000-4000-8000-000000000001'
const calls: {name:string;args:unknown[]}[]=[]
let execution:AgentExecution|null=null
let inboxTaken=false
let mailboxEnabled=false
let taskEventId:string|undefined
const record=(name:string)=>(...args:unknown[])=>{calls.push({name,args})}
const stub=(path:string,namedExports:Record<string,unknown>)=>mock.module(new URL(path,import.meta.url).href,{namedExports})
const writable=new WritableStream()
// 停止 reaches the workflow through its hook; `stopNow` delivers one stop to it.
let stopNow=()=>{}
let stopDuringTurn=false
// A tool's finish record the model call started and the round has not awaited yet: 'slow' settles after the model, 'fail' rejects.
let pendingAudit:'slow'|'fail'|null=null
mock.module('workflow',{namedExports:{getWorkflowMetadata:()=>({workflowRunId:'synthetic-workflow'}),getWritable:()=>writable,
  createHook:()=>({[Symbol.asyncIterator]:()=>({next:()=>new Promise(resolve=>{stopNow=()=>resolve({value:{},done:false})})})})}})
stub('../coordinator/model.ts',{COORDINATOR_MODEL:'current-default',coordinatorStep:()=>({}),turnWarning:(_reason:string,text:string)=>text})
stub('../attention/handoff.ts',{QUIET_REPLY:'__quiet__'})
stub('../subscription-workflow-turn.ts',{runHostedWorkflowTurn:async(...args:unknown[])=>{
  record('hosted')(...args)
  if(pendingAudit){
    const audits=(calls.find(c=>c.name==='tools')!.args[3] as {audits:Promise<unknown>[]}).audits
    const failing=pendingAudit==='fail'
    const record_=new Promise((resolve,reject)=>setTimeout(()=>{record('audit')();if(failing)reject(new Error('agentExecutionClosed'));else resolve(undefined)},5))
    record_.catch(()=>{});audits.push(record_)
  }
  if(!stopDuringTurn)return {text:'grounded reply',finishReason:'stop',responseMessages:[]}
  // The person presses 停止 while the second model call streams; the agent ends with the first call only.
  stopNow();await new Promise(resolve=>setImmediate(resolve))
  assert.equal((args[2] as {abortSignal?:AbortSignal}).abortSignal?.aborted,true)
  return {text:'Looking it up.',finishReason:'tool-calls',responseMessages:[{role:'assistant',content:'Looking it up.'}]}
}})
stub('../../workflows/coordinator/native-steps.ts',{runtime:async()=>({harness:'ai_sdk'})})
stub('../../workflows/coordinator/native-turn.ts',{nativeCoordinatorTurn:()=>{throw new Error('unexpected native dispatch')}})
stub('../../workflows/coordinator/tools.ts',{coordinatorTools:(...args:unknown[])=>{record('tools')(...args);return {}}})
stub('../../workflows/coordinator/agent-kit-steps.ts',{
  botRuntime:async()=>({harness:'ai_sdk',model:'connected-account-default'}),
  beginAgentExecution:async(...args:unknown[])=>{record('begin')(...args);await new Promise(resolve=>setTimeout(resolve,2));record('begun')();return execution},
  finishAgentExecution:async(...args:unknown[])=>{record('finish')(...args)},
})
const switches={issueTools:true,factoryRouting:false,factoryLifecycle:false}
// The real turnSettings and prepareTurn compose these same reads in one step each (workflows/coordinator/steps.ts).
const mailboxCatalogue=async(...args:unknown[])=>{record('mailboxCatalogue')(...args);return ['mailbox_inbox']}
const noteQuotaSwitch=async(...args:unknown[])=>{record('quotaSwitch')(...args)}
let preparedPrompt:Record<string,unknown>|null=null
const preparePrompt=async(...args:unknown[])=>{record('prompt')(...args);return preparedPrompt ?? {prompt:'synthetic request'}}
stub('../../workflows/coordinator/steps.ts',{
  turnSettings:async()=>({computerEnabled:false,mailboxEnabled,writeEnabled:false,switches,coordinator:false,runtime:{harness:'ai_sdk'}}),
  prepareTurn:async(userId:string,botId:string,holder:string,input:{snapshot?:unknown;executionId?:string;mailboxEnabled:boolean;runtime:unknown}) => {
    const mailboxTools=input.mailboxEnabled ? await mailboxCatalogue(userId,botId,input.executionId) : []
    if (input.runtime) await noteQuotaSwitch(userId,holder,input.runtime,botId)
    return {mailboxTools,prompt:await preparePrompt(userId,botId,input.snapshot,mailboxTools)}
  },
  computerToolsEnabled:async()=>false,
  personalWriteToolsEnabled:async()=>false,
  coordinatorSwitches:async()=>switches,
  isCoordinatorChat:async()=>false,
  mailboxToolsEnabled:async()=>mailboxEnabled,
  mailboxCatalogue,
  takeInbox:async()=>{const added=!inboxTaken;inboxTaken=true;return {held:true,added,handoffOnly:false,handoffMatterIds:[],telegramTargets:[],...(taskEventId ? {taskEventId} : {})}},
  releaseLease:async()=>false,
  preparePrompt,
  appendMessages:async(...args:unknown[])=>{record('append')(...args);return 3},
  noteQuotaSwitch,
  writeStreamPart:async(...args:unknown[])=>{record('stream')(...args)},
  logTurnTiming:async(...args:unknown[])=>{record('timing')(...args)},
  stoppedStepText:async(...args:unknown[])=>{record('stoppedText')(...args);return 'The task is'},
  settleAttention:async()=>{throw new Error('unexpected attention action')},
  telegramReplyThreads:async()=>{throw new Error('unexpected external message')},
  sendTelegramChunk:async()=>{throw new Error('unexpected external message')},
  failTurn:async(...args:unknown[])=>{record('failed')(...args)},
})
let coordinatorTurn:typeof import('../../workflows/coordinator/workflow').coordinatorTurn
before(async()=>{({coordinatorTurn}=await import('../../workflows/coordinator/workflow'))})
function reset(harness?:string){
  calls.length=0;stopDuringTurn=false;inboxTaken=false;mailboxEnabled=false;taskEventId=undefined
  execution=harness?{id:'10000000-0000-4000-8000-000000000002',status:'running',snapshot:makeSnapshot('10000000-0000-4000-8000-000000000003',1,DEFAULT_AGENT_DEFINITION,'saved host',{harness,model:'saved-model'})}:null
}
test('real workflow entry uses the returned execution snapshot for model, prompt and tool registry',async()=>{
  reset('ai_sdk')
  await coordinatorTurn(owner,bot)
  assert.deepEqual(calls.find(c=>c.name==='begin')?.args,[owner,bot,'synthetic-workflow',0,{harness:'ai_sdk'}])
  assert.deepEqual(calls.find(c=>c.name==='hosted')?.args[0],execution!.snapshot.runtime)
  assert.equal(calls.find(c=>c.name==='prompt')?.args[2],execution!.snapshot)
  assert.deepEqual(calls.find(c=>c.name==='tools')?.args,[owner,bot,undefined,{switches,coordinator:false,execution,audits:[],writeEnabled:false,computerEnabled:false,mailboxEnabled:false,mailboxTools:[]}])
  assert.equal(calls.filter(c=>c.name==='hosted').length,1)
  const hosted=calls.find(c=>c.name==='hosted')!.args[2] as {writable:unknown;preventClose:boolean}
  assert.equal(hosted.writable,writable);assert.equal(hosted.preventClose,true)
  assert.equal(calls.find(c=>c.name==='append')?.args[5],'synthetic-workflow:0')
  assert.deepEqual(calls.filter(c=>c.name==='stream').map(c=>c.args[1]),[{type:'coordinator-turn-start',id:'synthetic-workflow:0',quietEligible:false},{type:'coordinator-turn-committed',id:'synthetic-workflow:0',through:3,quiet:false}])
  assert.ok(calls.findIndex(c=>c.name==='append') < calls.findIndex(c=>c.name==='stream' && (c.args[1] as {type:string}).type==='coordinator-turn-committed'))
  assert.equal(calls.filter(c=>c.name==='failed').length,0)
  assert.equal(calls.filter(c=>c.name==='mailboxCatalogue').length,0, 'flag-off never resolves mailbox persistence')
})
test('disabled Agent Kit still resolves the connected account model without inventing a definition snapshot',async()=>{
  reset()
  await coordinatorTurn(owner,bot)
  assert.deepEqual(calls.find(c=>c.name==='hosted')?.args[0],{harness:'ai_sdk',model:'connected-account-default'})
  assert.equal(calls.find(c=>c.name==='prompt')?.args[2],undefined)
})
test('a replayed harness mismatch fails before hosted or native dispatch',async()=>{
  reset('codex')
  await assert.rejects(coordinatorTurn(owner,bot),/agent_runtime_changed/)
  assert.equal(calls.filter(c=>c.name==='hosted').length,0)
  assert.deepEqual(calls.find(c=>c.name==='finish')?.args,[owner,bot,execution!.id,'turn_failed'])
  assert.equal(calls.filter(c=>c.name==='failed').length,1)
})

test('real workflow carries the host catalogue into named options and prompt without changing its frozen execution',async()=>{
  reset('ai_sdk');mailboxEnabled=true
  const snapshot=execution!.snapshot, before=JSON.stringify(snapshot)
  await coordinatorTurn(owner,bot)
  assert.deepEqual(calls.find(c=>c.name==='mailboxCatalogue')?.args,[owner,bot,execution!.id])
  assert.deepEqual(calls.find(c=>c.name==='tools')?.args,[owner,bot,undefined,{switches,coordinator:false,execution,audits:[],writeEnabled:false,computerEnabled:false,mailboxEnabled:true,mailboxTools:['mailbox_inbox']}])
  assert.deepEqual(calls.find(c=>c.name==='prompt')?.args,[owner,bot,snapshot,['mailbox_inbox']])
  assert.equal(JSON.stringify(snapshot),before)
})

test('real workflow forwards a host task event without changing the frozen execution',async()=>{
  reset('ai_sdk');taskEventId='10000000-0000-4000-8000-000000000004'
  const before=JSON.stringify(execution!.snapshot)
  await coordinatorTurn(owner,bot)
  assert.deepEqual(calls.find(c=>c.name==='tools')?.args,[owner,bot,undefined,{switches,coordinator:false,execution,audits:[],writeEnabled:false,computerEnabled:false,mailboxEnabled:false,mailboxTools:[],taskEventId}])
  assert.equal(JSON.stringify(execution!.snapshot),before)
})

test('停止 aborts the model call in flight and keeps what the reply had said, marked stopped',async()=>{
  reset('ai_sdk');stopDuringTurn=true
  await coordinatorTurn(owner,bot)
  assert.deepEqual(calls.find(c=>c.name==='stoppedText')?.args,['synthetic-workflow','synthetic-workflow:0'])
  assert.deepEqual(calls.find(c=>c.name==='append')?.args,[owner,'synthetic-workflow',[{role:'assistant',content:'Looking it up.'},{role:'assistant',content:'The task is'}],null,bot,'synthetic-workflow:0',true])
  assert.deepEqual(calls.filter(c=>c.name==='stream').map(c=>(c.args[1] as {type:string}).type),['coordinator-turn-start','coordinator-turn-stopped','coordinator-turn-committed'])
  assert.deepEqual(calls.find(c=>c.name==='finish')?.args,[owner,bot,execution!.id])
  assert.equal(calls.filter(c=>c.name==='failed').length,0,'a stop is not a failed turn')
})

test('a tool finish record does not hold up the model; the round stores its reply only after every record, and a failed record fails the turn',async()=>{
  reset('ai_sdk');pendingAudit='slow'
  try{
    await coordinatorTurn(owner,bot)
    const names=calls.map(c=>c.name)
    assert.ok(names.indexOf('hosted')<names.indexOf('audit'),'the model call returned before the record settled')
    assert.ok(names.indexOf('audit')<names.indexOf('append'),'the reply is stored after the record')
    reset('ai_sdk');pendingAudit='fail'
    await assert.rejects(coordinatorTurn(owner,bot),/agentExecutionClosed/)
    assert.equal(calls.filter(c=>c.name==='append').length,0,'no reply is stored without its records')
    assert.equal(calls.filter(c=>c.name==='failed').length,1)
  }finally{pendingAudit=null}
})

test('the run reads its settings in one step and starts the execution beside the stream, then prepares the round in one step',async()=>{
  reset('ai_sdk')
  await coordinatorTurn(owner,bot)
  const names=calls.map(c=>c.name)
  // The stream's start is issued while the execution is still starting; the prompt waits for both.
  assert.ok(names.indexOf('stream')<names.indexOf('begun'),'the two run side by side')
  assert.ok(names.indexOf('begun')<names.indexOf('prompt') && names.indexOf('stream')<names.indexOf('prompt'))
  assert.deepEqual(calls.filter(c=>c.name==='prompt').length,1)
})

test('the prepared prompt reaches the model with its stable rules as their own system message, ready for a cache breakpoint',async()=>{
  reset('ai_sdk');preparedPrompt={instructions:'RULES and catalogmemory, GitHub, computers',stable:'RULES and catalog'.length,messages:[]}
  try{
    await coordinatorTurn(owner,bot)
    const options=calls.find(c=>c.name==='hosted')?.args[2] as {instructions:unknown;stable?:unknown}
    assert.deepEqual(options.instructions,[{role:'system',content:'RULES and catalog'},{role:'system',content:'memory, GitHub, computers'}])
    assert.equal('stable' in options,false,'stable is never a model option')
  }finally{preparedPrompt=null}
})
