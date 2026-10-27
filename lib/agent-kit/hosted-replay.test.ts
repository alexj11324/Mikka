import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Pool } from 'pg'
import { AgentKitStore } from './store'
import { DEFAULT_AGENT_DEFINITION } from './builtin'

const id = (n:number) => `10000000-0000-4000-8000-${String(n).padStart(12,'0')}`
const scope = {ownerId:'alice',botId:id(1),workspaceId:id(2)}
function fakeRepository() {
  const executions = new Map<string,unknown>()
  const evaluations = new Map<string,Record<string,unknown>>()
  const definition = {...DEFAULT_AGENT_DEFINITION,modelSelection:{type:'subscription' as const,bindingId:id(3)}}
  const version = { id:id(10),version:1,definition,digest:'fixture',source:'user',base_version:null }
  const client = { release() {}, async query(sql:string, args:unknown[]=[]) {
    if (['begin','commit','rollback'].includes(sql)) return {rows:[]}
    if(sql.startsWith('select id from bots'))return {rows:[{id:scope.botId}],rowCount:1}
    if(sql.startsWith('insert into agent_kit_heads'))return {rows:[]}
    if(sql.startsWith('select active_version'))return {rows:[{active_version:version.id,workspace_id:scope.workspaceId}]}
    if(sql.startsWith('select id,version,definition'))return {rows:[{...version,id:args[2]}]}
    if(sql.startsWith('select id,snapshot,status from agent_kit_executions'))return {rows:executions.has(String(args[2]))?[executions.get(String(args[2]))]:[]}
    if(sql.startsWith('insert into agent_kit_executions')) { executions.set(String(args[3]),{id:args[0],snapshot:JSON.parse(String(args[5])),status:'running'});return {rows:[]} }
    if(sql.startsWith('select * from agent_kit_proposals'))return {rows:[{id:id(20),baseline_id:id(10),candidate_id:id(11),status:'proposed',evidence:[]}]}
    if(sql.startsWith('select * from agent_kit_evaluations'))return {rows:evaluations.has(String(args[2]))?[evaluations.get(String(args[2]))]:[]}
    if(sql.startsWith('insert into agent_kit_evaluations')) {evaluations.set(String(args[4]),{id:args[0],proposal_id:args[3],mode:args[5],model:args[6],status:'running',reports:null});return {rows:[]} }
    throw new Error(`Unexpected isolated query: ${sql}`)
  } }
  return {store:new AgentKitStore({connect:async()=>client} as unknown as Pool),executions,version}
}
const runtime = {harness:'ai_sdk',model:'saved-model',modelSelection:{type:'subscription' as const,bindingId:id(3),ownerId:'alice',consumerId:id(1),workspaceId:id(2),connectionId:id(4),connectionRevision:7,modelId:'saved-model',route:'claude_cpa' as const}}
test('execution replay returns stored model selection before evaluating any new binding resolver',async()=>{
  const f=fakeRepository();let resolutions=0
  const first=await f.store.beginExecution(scope,'turn:0','saved instructions',async()=>{resolutions++;return runtime},DEFAULT_AGENT_DEFINITION)
  f.version.definition.modelSelection.bindingId=id(99)
  const replay=await f.store.beginExecution(scope,'turn:0','new instructions',async()=>{throw new Error('must not resolve latest binding')},DEFAULT_AGENT_DEFINITION)
  assert.deepEqual(replay,first)
  assert.equal(resolutions,1)
  assert.deepEqual(replay.snapshot.runtime,runtime)
  assert.equal(replay.snapshot.hostInstructions,'saved instructions')
})
test('live evaluation persists the same runtime snapshot for both definitions and replay never resolves again',async()=>{
  const f=fakeRepository();let resolutions=0
  const first=await f.store.beginEvaluation(scope,id(20),id(21),'live',null,{hostInstructions:'saved instructions',resolveRuntime:async()=>{resolutions++;return runtime}})
  assert.equal(first.replayed,false)
  if(first.replayed)throw new Error('unexpected replay')
  assert.deepEqual(first.execution?.snapshot.runtime,runtime)
  assert.equal(first.evaluation.model,'saved-model')
  assert.equal(f.executions.size,1)
  const replay=await f.store.beginEvaluation(scope,id(20),id(21),'live',null,{hostInstructions:'changed',resolveRuntime:async()=>{throw new Error('must not resolve')}})
  assert.equal(replay.replayed,true)
  assert.equal(replay.evaluation.model,'saved-model')
  assert.equal(resolutions,1)
})
