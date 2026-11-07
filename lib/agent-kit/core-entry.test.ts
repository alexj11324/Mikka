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
// 停止 while a tool call runs: the agent never returns (the tool step is still running) after one finished model call.
let stopDuringTool=false
let stopAt:'settings'|'inbox'|'prepare'|null=null
let extraInbox=false
const deliverEarlyStop=async(stage:typeof stopAt)=>{
  if(stopAt!==stage)return
  stopAt=null;stopNow()
  await Promise.resolve();await Promise.resolve()
}
// A tool's finish record the model call started and the round has not awaited yet: 'slow' settles after the model, 'fail' rejects.
let pendingAudit:'slow'|'fail'|null=null
let hostedError:Error|null=null
let hostedCompleted:unknown[]=[]
let receiptPersistenceError:Error|null=null
mock.module('workflow',{namedExports:{getWorkflowMetadata:()=>({workflowRunId:'synthetic-workflow'}),getWritable:()=>writable,
  createHook:()=>({[Symbol.asyncIterator]:()=>({next:()=>new Promise(resolve=>{stopNow=()=>resolve({value:{},done:false})})})})}})
stub('../coordinator/model.ts',{COORDINATOR_MODEL:'current-default',coordinatorStep:()=>({}),turnWarning:(_reason:string,text:string)=>text})
stub('../attention/handoff.ts',{QUIET_REPLY:'__quiet__'})
stub('../subscription-workflow-turn.ts',{runHostedWorkflowTurn:async(...args:unknown[])=>{
  record('hosted')(...args)
  if(hostedError){
    if(hostedCompleted.length) (args[2] as {onStepEnd?:(step:unknown)=>void}).onStepEnd?.({response:{messages:hostedCompleted}})
    throw hostedError
  }
  if(pendingAudit){
    const audits=(calls.find(c=>c.name==='tools')!.args[3] as {audits:Promise<unknown>[]}).audits
    const failing=pendingAudit==='fail'
    const record_=new Promise((resolve,reject)=>setTimeout(()=>{record('audit')();if(failing)reject(new Error('agentExecutionClosed'));else resolve(undefined)},5))
    record_.catch(()=>{});audits.push(record_)
  }
  const options=args[2] as {abortSignal?:AbortSignal;onStepEnd?:(step:{response:{messages:unknown[]}})=>void}
  if(stopDuringTool){
    options.onStepEnd?.({response:{messages:[{role:'assistant',content:[{type:'text',text:'Creating it.'}]},{role:'tool',content:[]}]}})
    stopNow()
    return new Promise(()=>{})
  }
  if(!stopDuringTurn)return {text:'grounded reply',finishReason:'stop',responseMessages:[]}
  // The person presses 停止 while the second model call streams; the agent ends with the first call only.
  options.onStepEnd?.({response:{messages:[{role:'assistant',content:'Looking it up.'}]}})
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
let contextMs:{execution:number;personal:number;github:number}|undefined
const preparePrompt=async(...args:unknown[])=>{record('prompt')(...args);return preparedPrompt ?? {prompt:'synthetic request'}}
stub('../../workflows/coordinator/steps.ts',{
  turnSettings:async()=>{await deliverEarlyStop('settings');return {computerEnabled:false,mailboxEnabled,writeEnabled:false,switches,coordinator:false,runtime:{harness:'ai_sdk'}}},
  prepareTurn:async(userId:string,botId:string,holder:string,input:{snapshot?:unknown;executionId?:string;mailboxEnabled:boolean;runtime:unknown}) => {
    const mailboxTools=input.mailboxEnabled ? await mailboxCatalogue(userId,botId,input.executionId) : []
    if (input.runtime) await noteQuotaSwitch(userId,holder,input.runtime,botId)
    const prompt=await preparePrompt(userId,botId,input.snapshot,mailboxTools)
    await deliverEarlyStop('prepare')
    return {mailboxTools,prompt,...(contextMs ? {contextMs} : {})}
  },
  computerToolsEnabled:async()=>false,
  personalWriteToolsEnabled:async()=>false,
  coordinatorSwitches:async()=>switches,
  isCoordinatorChat:async()=>false,
  mailboxToolsEnabled:async()=>mailboxEnabled,
  mailboxCatalogue,
  takeInbox:async()=>{await deliverEarlyStop('inbox');const added=!inboxTaken || extraInbox;if(inboxTaken)extraInbox=false;inboxTaken=true;return {held:true,added,handoffOnly:false,handoffMatterIds:[],telegramTargets:[],...(taskEventId ? {taskEventId} : {})}},
  releaseLease:async()=>false,
  preparePrompt,
  appendMessages:async(...args:unknown[])=>{record('append')(...args);return 3},
  noteQuotaSwitch,
  writeStreamPart:async(...args:unknown[])=>{record('stream')(...args)},
  logTurnTiming:async(...args:unknown[])=>{record('timing')(...args)},
  markStopped:async(...args:unknown[])=>{record('stream')(args[0],{type:'coordinator-turn-stopped',id:args[2]});record('stoppedText')(...args.slice(1));return !calls.some(c=>c.name==='hosted') ? '' : stopDuringTool ? 'Creating it.' : 'The task is'},
  settleAttention:async()=>{throw new Error('unexpected attention action')},
  telegramReplyThreads:async()=>{throw new Error('unexpected external message')},
  sendTelegramChunk:async()=>{throw new Error('unexpected external message')},
  failTurn:async(...args:unknown[])=>{record('failed')(...args);if(args[4]&&receiptPersistenceError)throw receiptPersistenceError},
})
let coordinatorTurn:typeof import('../../workflows/coordinator/workflow').coordinatorTurn
before(async()=>{({coordinatorTurn}=await import('../../workflows/coordinator/workflow'))})
function reset(harness?:string){
  calls.length=0;stopDuringTurn=false;stopDuringTool=false;stopAt=null;extraInbox=false;inboxTaken=false;mailboxEnabled=false;taskEventId=undefined;hostedError=null;hostedCompleted=[];receiptPersistenceError=null
  contextMs=undefined
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
test('normal completion reports fixed preparation timings only in the existing post-commit turn log',async()=>{
  reset('ai_sdk')
  contextMs={execution:13,personal:5,github:21}
  await coordinatorTurn(owner,bot)
  const timings=calls.filter(call=>call.name==='timing')
  assert.equal(timings.length,1)
  const line=timings[0].args[0] as {phaseMs:Record<string,number>}
  assert.deepEqual(Object.keys(line.phaseMs).sort(),['begin','execution','github','inbox','personal','prepare','settings'])
  assert.ok(Object.values(line.phaseMs).every(value=>Number.isFinite(value)&&value>=0))
  assert.deepEqual([line.phaseMs.execution,line.phaseMs.personal,line.phaseMs.github],[13,5,21])
  const committed=calls.findIndex(call=>call.name==='stream'&&(call.args[1] as {type:string}).type==='coordinator-turn-committed')
  assert.ok(committed<calls.findIndex(call=>call.name==='timing'))
  const options=calls.find(call=>call.name==='hosted')!.args[2] as Record<string,unknown>
  assert.ok(!('contextMs' in options)&&!('phaseMs' in options))
  assert.doesNotMatch(JSON.stringify(line.phaseMs),/synthetic|grounded|reply/)

  reset('ai_sdk')
  await coordinatorTurn(owner,bot)
  const older=(calls.find(call=>call.name==='timing')!.args[0] as {phaseMs:Record<string,number>}).phaseMs
  assert.deepEqual([older.execution,older.personal,older.github],[0,0,0], 'recorded prepare results from an earlier deployment remain readable')
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

test('停止 while a tool call runs ends the turn at once: the finished call is kept and nothing waits for the tool',async()=>{
  reset('ai_sdk');stopDuringTool=true
  await coordinatorTurn(owner,bot)
  // The words of the finished call are already in its messages: they are not stored a second time.
  assert.deepEqual(calls.find(c=>c.name==='append')?.args,[owner,'synthetic-workflow',[{role:'assistant',content:[{type:'text',text:'Creating it.'}]},{role:'tool',content:[]},{role:'assistant',content:''}],null,bot,'synthetic-workflow:0',true])
  assert.deepEqual(calls.filter(c=>c.name==='stream').map(c=>(c.args[1] as {type:string}).type),['coordinator-turn-start','coordinator-turn-stopped','coordinator-turn-committed'])
  assert.equal(calls.filter(c=>c.name==='failed').length,0)
})

for(const stage of ['settings','inbox','prepare'] as const)test(`停止 during ${stage} keeps the stop and never starts the model or tools`,async()=>{
  reset('ai_sdk');stopAt=stage
  await coordinatorTurn(owner,bot)
  assert.equal(calls.filter(c=>c.name==='hosted').length,0)
  assert.equal(calls.filter(c=>c.name==='tools').length,0)
  assert.deepEqual(calls.find(c=>c.name==='append')?.args,[owner,'synthetic-workflow',[{role:'assistant',content:''}],null,bot,'synthetic-workflow:0',true])
  assert.equal(calls.filter(c=>c.name==='failed').length,0)
})

test('a message taken after the stopped round gets a fresh signal and runs normally',async()=>{
  reset('ai_sdk');stopAt='settings';extraInbox=true
  await coordinatorTurn(owner,bot)
  const hosted=calls.filter(c=>c.name==='hosted')
  assert.equal(hosted.length,1,'the stopped first round never starts the model')
  assert.equal((hosted[0].args[2] as {abortSignal:AbortSignal}).abortSignal.aborted,false)
  assert.deepEqual(calls.filter(c=>c.name==='append').map(c=>[c.args[5],c.args[6]===true]),[['synthetic-workflow:0',true],['synthetic-workflow:1',false]])
  assert.equal(calls.filter(c=>c.name==='failed').length,0)
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

test('welcome-only workflow passes no executable tools; a later or coalesced user request keeps tools',async()=>{
  for(const messages of [
    [{role:'user',content:'[Welcome] Reply with a greeting only.'}],
    [{role:'user',content:'[Welcome] Reply with a greeting only.'},{role:'assistant',content:'Hello'},{role:'user',content:'Choose D and find my repository'}],
    [{role:'user',content:'[Welcome] Reply with a greeting only.'},{role:'user',content:'A real task queued beside the welcome'}],
  ]){
    reset('ai_sdk');preparedPrompt={instructions:'RULES',messages}
    try{
      await coordinatorTurn(owner,bot)
      const [,,options]=calls.find(call=>call.name==='hosted')!.args as [unknown,unknown,{toolChoice?:string;activeTools?:string[]}]
      if(messages.length===1){
        assert.equal(calls.some(call=>call.name==='tools'),false,'welcome never constructs the executable registry')
        assert.deepEqual(calls.find(call=>call.name==='hosted')!.args[1],{})
        assert.equal(options.toolChoice,'none');assert.deepEqual(options.activeTools,[])
      }else{
        assert.equal(calls.filter(call=>call.name==='tools').length,1)
        assert.equal(options.toolChoice,undefined);assert.equal(options.activeTools,undefined)
      }
    }finally{preparedPrompt=null}
  }
})

test('exhausted invalid-tool recovery fails the execution and turn without a success commit',async()=>{
  reset('ai_sdk');hostedError=new Error('model_tool_unavailable')
  try{
    await assert.rejects(coordinatorTurn(owner,bot),{message:'model_tool_unavailable'})
    assert.deepEqual(calls.find(call=>call.name==='finish')?.args,[owner,bot,execution!.id,'turn_failed'])
    assert.deepEqual(calls.find(call=>call.name==='failed')?.args,[owner,'synthetic-workflow','model_tool_unavailable',bot,undefined])
    assert.equal(calls.some(call=>call.name==='append'),false)
    assert.equal(calls.some(call=>call.name==='stream' && (call.args[1] as {type:string}).type==='coordinator-turn-committed'),false)
  }finally{hostedError=null}
})

test('invalid-tool failure hands finished receipts to the atomic failure step, without replay or a success commit',async()=>{
  reset('ai_sdk');hostedError=new Error('model_tool_unavailable')
  hostedCompleted=[{role:'assistant',content:[{type:'tool-call',toolCallId:'done',toolName:'registered',input:{}}]},
    {role:'tool',content:[{type:'tool-result',toolCallId:'done',toolName:'registered',output:{type:'json',value:{receipt:'completed'}}}]}]
  try{
    await assert.rejects(coordinatorTurn(owner,bot),{message:'model_tool_unavailable'})
    assert.deepEqual(calls.find(call=>call.name==='failed')?.args,[owner,'synthetic-workflow','model_tool_unavailable',bot,{messages:hostedCompleted,streamId:'synthetic-workflow:0'}])
    assert.equal(calls.filter(call=>call.name==='hosted').length,1)
    assert.equal(calls.some(call=>call.name==='append'),false,'only the atomic failure step persists these receipts')
    assert.deepEqual(calls.find(call=>call.name==='finish')?.args,[owner,bot,execution!.id,'turn_failed'])
  }finally{hostedError=null;hostedCompleted=[]}
})

test('a rejected receipt still releases the failed lease once and retains both failure causes',async()=>{
  reset('ai_sdk');hostedError=new Error('model_tool_unavailable')
  hostedCompleted=[{role:'assistant',content:'Synthetic blocked receipt'}]
  receiptPersistenceError=new Error('credential_secret_detected')
  try{
    await assert.rejects(coordinatorTurn(owner,bot),(error:unknown)=>{
      assert.ok(error instanceof AggregateError)
      assert.equal(error.message,'model_tool_unavailable')
      assert.deepEqual(error.errors,[hostedError,receiptPersistenceError])
      assert.equal(error.cause,receiptPersistenceError)
      return true
    })
    const failures=calls.filter(call=>call.name==='failed')
    assert.equal(failures.length,2)
    assert.deepEqual(failures[1].args,[owner,'synthetic-workflow','model_tool_unavailable',bot])
    assert.equal(calls.filter(call=>call.name==='hosted').length,1)
    assert.equal(calls.some(call=>call.name==='append'),false)
  }finally{hostedError=null;hostedCompleted=[];receiptPersistenceError=null}
})
