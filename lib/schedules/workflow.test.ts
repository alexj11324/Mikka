import assert from 'node:assert/strict'
import { before, beforeEach, mock, test } from 'node:test'
import type { NativeToolScope } from '../../workflows/coordinator/tool-scope'

const calls:Array<{name:string;args:unknown[]}>=[]
const record=(name:string)=>(...args:unknown[])=>{calls.push({name,args})}
let taken=false,denied=false,native=false
const scheduledRead={occurrenceId:'f2000000-0000-4000-8000-000000000001',leaseToken:'f2000000-0000-4000-8000-000000000002',allowedActions:['get_issue'],prompt:'Read the task status'}
const result={text:'Actual task status is todo',finishReason:'stop',responseMessages:[{role:'assistant',content:'Actual task status is todo'}]}
const stub=(path:string,exports:Record<string,unknown>)=>mock.module(new URL(path,import.meta.url).href,{namedExports:exports})
const writable=new WritableStream()
mock.module('workflow',{namedExports:{getWorkflowMetadata:()=>({workflowRunId:'existing-workflow'}),getWritable:()=>writable}})
stub('../coordinator/model.ts',{coordinatorStep:()=>({}),turnWarning:()=>null})
stub('../attention/handoff.ts',{QUIET_REPLY:'__quiet__'})
stub('../subscription-workflow-turn.ts',{runHostedWorkflowTurn:async(...args:unknown[])=>{record('hosted')(...args);return result}})
stub('../../workflows/coordinator/native-steps.ts',{runtime:async()=>({harness:native?'codex':'ai_sdk'})})
stub('../../workflows/coordinator/native-turn.ts',{nativeCoordinatorTurn:async(...args:unknown[])=>{
 record('native')(...args)
 const create=args[4] as (scope?:NativeToolScope)=>unknown
 create();create({holder:'holder',turnId:'turn',callId:'call'})
 return result
}})
stub('../../workflows/coordinator/tools.ts',{coordinatorTools:(...args:unknown[])=>{record('tools')(...args);return{}}})
stub('../../workflows/coordinator/agent-kit-steps.ts',{beginAgentExecution:async()=>null,botRuntime:async()=>({harness:'ai_sdk',model:'existing-configured-model'}),finishAgentExecution:async()=>{}})
stub('../../workflows/coordinator/steps.ts',{
 computerToolsEnabled:async()=>false,personalWriteToolsEnabled:async()=>false,mailboxToolsEnabled:async()=>false,
 takeInbox:async()=>{const added=!taken;taken=true;return{held:true,added,handoffOnly:false,handoffMatterIds:[],telegramTargets:[],scheduledRead}},
 releaseLease:async()=>false,
 preparePrompt:async()=>({instructions:'Existing host policy',messages:[{role:'user',content:'A stored read-only schedule is due'}]}),
 assertScheduleRead:async(...args:unknown[])=>{record('authorize')(...args);if(denied)throw new Error('scheduleReadAuthorityLost')},
 completeScheduleRead:async(...args:unknown[])=>{record('complete')(...args);return 7},
 writeStreamPart:async(...args:unknown[])=>{record('stream')(...args)},
 failScheduleRead:async(...args:unknown[])=>{record('scheduleFailed')(...args)},
 appendMessages:async()=>{throw new Error('Scheduled results must use fenced occurrence publication')},
 failTurn:async()=>{},
})
let coordinatorTurn:typeof import('../../workflows/coordinator/workflow').coordinatorTurn
before(async()=>{({coordinatorTurn}=await import('../../workflows/coordinator/workflow'))})
beforeEach(()=>{calls.length=0;taken=false;denied=false;native=false})
test('scheduled SDK turn uses the existing runtime with host-only scope and read catalog',async()=>{
 await coordinatorTurn('owner',null)
 const toolCall=calls.find(c=>c.name==='tools')!
 assert.deepEqual(toolCall.args[2],{scheduledRead:{botId:null,occurrence:scheduledRead}})
 assert.deepEqual((toolCall.args[3] as {readToolIds:string[]}).readToolIds,['get_issue'])
 assert.equal((toolCall.args[3] as {readOnly:boolean}).readOnly,true)
 assert.equal(calls.find(c=>c.name==='hosted')?.args[0] && (calls.find(c=>c.name==='hosted')!.args[0] as {model:string}).model,'existing-configured-model')
 assert.deepEqual(calls.find(c=>c.name==='complete')?.args,['owner',null,scheduledRead,result.text,'existing-workflow:0'])
 const hosted=calls.find(c=>c.name==='hosted')!.args[2] as {writable:unknown;preventClose:boolean}
 assert.equal(hosted.writable,writable);assert.equal(hosted.preventClose,true)
 assert.deepEqual(calls.filter(c=>c.name==='stream').map(c=>c.args[1]),[{type:'coordinator-turn-start',id:'existing-workflow:0',quietEligible:false},{type:'coordinator-turn-committed',id:'existing-workflow:0',through:7,quiet:false}])
 assert.ok(calls.findIndex(c=>c.name==='complete') < calls.findIndex(c=>c.name==='stream' && (c.args[1] as {type:string}).type==='coordinator-turn-committed'))
 assert.ok(!JSON.stringify(calls.find(c=>c.name==='hosted')!.args[2]).includes(scheduledRead.leaseToken))
})
test('scheduled native relay preserves actual native identity alongside the occurrence scope',async()=>{
 native=true;await coordinatorTurn('owner',null)
 assert.equal(calls.some(c=>c.name==='hosted'),false)
 const scoped=calls.filter(c=>c.name==='tools').at(-1)!
 assert.deepEqual(scoped.args[2],{holder:'holder',turnId:'turn',callId:'call',scheduledRead:{botId:null,occurrence:scheduledRead}})
 assert.equal((scoped.args[3] as {readOnly:boolean}).readOnly,true)
 assert.equal(calls.filter(c=>c.name==='complete').length,1)
})
test('a cancelled or stale scheduled turn starts no model and records bounded failure',async()=>{
 denied=true;await assert.rejects(coordinatorTurn('owner',null),/scheduleReadAuthorityLost/)
 assert.equal(calls.some(c=>c.name==='hosted'||c.name==='native'||c.name==='complete'),false)
 assert.deepEqual(calls.find(c=>c.name==='scheduleFailed')?.args,[scheduledRead,true])
})
