import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {before, beforeEach, mock, test} from 'node:test'
import {freezeWorkerDefinition, retryWorkerDefinition} from './worker'
import {DEFAULT_AGENT_DEFINITION} from './builtin'
import {makeSnapshot} from './definition'

const owner=randomUUID(),workspace=randomUUID(),agentId=randomUUID(),deviceId=randomUUID(),repoId=randomUUID(),botId=randomUUID(),issueId=randomUUID()
const binding={id:randomUUID(),ownerId:owner,workspaceId:workspace,consumerId:agentId,connectionId:randomUUID(),connectionRevision:1,route:'codex_cli',modelId:'frozen-model'}
const frozen=()=>freezeWorkerDefinition({harness:'codex',instructions:'Review only',prompt:'task',parent:null,executionId:null,subscription:binding})
let definition: ReturnType<typeof frozen>|null=null
let subscription: typeof binding|null=binding
let missing=false
const bindingById=mock.fn(async()=>{if(missing)throw Error('missing binding');return subscription})
const latestBinding=mock.fn(async()=>subscription)
const claimed=mock.fn(async()=> 'claimed')
const cloudClaimed=mock.fn(async()=>({botId,ownerId:owner,display:':3',policyVersion:1}))
const stub=(path:string,namedExports:Record<string,unknown>)=>mock.module(new URL(path,import.meta.url).href,{namedExports})
let selectIndex=0
const db={select:()=>({from:()=>({where:()=>({limit:async()=>[[{id:randomUUID(),userId:owner,agentId,deviceId,deviceRepoId:repoId,issueId,kind:'implement',prompt:'task',agentDefinition:definition}],[{id:agentId,userId:owner,harness:'claude_code'}],[{id:repoId,userId:owner,baseBranch:'main'}]][selectIndex++]})})})}
let cloud=false
stub('../db/index.ts',{db,pool:{}})
stub('../device-link.ts',{authenticateDevice:async()=>({userId:owner,scopeDeviceId:deviceId,scopeWorkspaceId:workspace}),ownedDevice:async()=>({enabled:true,kind:cloud?'cloud':'local',harnesses:[{harness:'codex',installed:true,subscriptionBroker:true,computerBroker:true}]})})
stub('../mcp/worker.ts',{issueRunToken:async()=>({token:'synthetic-only'})})
stub('../mcp/resource.ts',{mcpResourceURL:null})
stub('../run-leases.ts',{latestCheckpoint:async()=>null})
stub('../computer/claim.ts',{claimLocalRun:claimed,claimCloudRun:cloudClaimed})
stub('../subscription-runtime.ts',{subscriptionRuntime:()=>({repository:{binding:bindingById,nativeBinding:latestBinding}})})
let claim: typeof import('../../app/v1/devices/[deviceId]/runs/[runId]/claim/route').POST
let queue: typeof import('../computer/queue-run').queueCloudRun
before(async()=>{claim=(await import('../../app/v1/devices/[deviceId]/runs/[runId]/claim/route')).POST;queue=(await import('../computer/queue-run')).queueCloudRun})
beforeEach(()=>{definition=frozen();subscription={...binding};missing=false;cloud=false;selectIndex=0;process.env.MIKKA_BYOS_ENABLED='1';process.env.MIKKA_AGENT_KIT='1';process.env.MIKKA_CLOUD_COMPUTER_TASKS='1';for(const fn of [bindingById,latestBinding,claimed,cloudClaimed])fn.mock.resetCalls()})
const request=()=>claim(new Request('https://example.test/v1/devices/'+deviceId+'/runs/'+randomUUID()+'/claim',{method:'POST'}),{params:Promise.resolve({deviceId,runId:randomUUID()})})
test('local claim uses frozen harness and exact subscription despite Agent edits',async()=>{
 const response=await request();assert.equal(response.status,200);const body=await response.json();assert.equal(body.harness,'codex');assert.equal(body.model,'frozen-model');assert.deepEqual(bindingById.mock.calls[0].arguments,[owner,binding.id]);assert.equal(latestBinding.mock.callCount(),0);assert.equal(claimed.mock.callCount(),1)
})
test('cloud claim preserves main scoped claim and frozen subscription',async()=>{
 cloud=true;const response=await request();assert.equal(response.status,200);assert.equal(cloudClaimed.mock.callCount(),1);assert.equal(claimed.mock.callCount(),0);assert.equal((await response.json()).computer.botId,botId)
})
test('missing, substituted or disabled pinned subscription refuses before claim without fallback',async()=>{
 for(const change of ['missing','model','consumer','disabled']){
  selectIndex=0;missing=change==='missing';subscription={...binding, ...(change==='model'?{modelId:'different'}:{}),...(change==='consumer'?{consumerId:randomUUID()}: {})};process.env.MIKKA_BYOS_ENABLED=change==='disabled'?'0':'1'
  assert.equal((await request()).status,409)
 }
 assert.equal(claimed.mock.callCount(),0);assert.equal(cloudClaimed.mock.callCount(),0);assert.equal(latestBinding.mock.callCount(),0)
})
test('a frozen native-default selection cannot become a later subscription',async()=>{
 definition=freezeWorkerDefinition({harness:'codex',instructions:'Review',prompt:'task',parent:null,executionId:null});assert.equal((await request()).status,200);assert.equal(bindingById.mock.callCount(),0);assert.equal(latestBinding.mock.callCount(),0)
})
test('subscription provenance is copied across retries and participates in the definition hash',()=>{
 const first=frozen(),retry=retryWorkerDefinition(first,'retry')!;assert.deepEqual(retry.subscription,first.subscription);assert.equal(first.definitionDigest,retry.definitionDigest);retry.subscription!.modelId='mutated';assert.equal(first.subscription!.modelId,'frozen-model');assert.notEqual(freezeWorkerDefinition({harness:'codex',instructions:'Review only',prompt:'task',parent:null,executionId:null,subscription:{...binding,modelId:'other'}}).definitionDigest,first.definitionDigest)
})
test('cloud queue captures exact worker and parent snapshot in the same transaction as binding',async()=>{
 const calls:{sql:string,args:unknown[]}[]=[]
 const client={release(){},async query(sql:string,args:unknown[]=[]){calls.push({sql,args});if(sql.startsWith('SELECT m.'))return {rows:[{deviceId,instructions:'Cloud review',harness:'codex',baseBranch:'main'}]};if(sql.startsWith('select id from byos_bindings'))return {rows:[{id:binding.id}]};if(sql.startsWith('select id,"ownerId"'))return {rows:[binding]};return {rows:[]}}}
 const parent={id:randomUUID(),status:'running' as const,snapshot:makeSnapshot(randomUUID(),2,DEFAULT_AGENT_DEFINITION,'HOST',{harness:'codex',model:null})}
 await queue({connect:async()=>client} as unknown as Parameters<typeof queue>[0],{userId:owner,workspaceId:workspace},{botId,issueId,agentId,deviceRepoId:repoId,title:'Review',body:'synthetic',execution:parent})
 const insert=calls.find(c=>c.sql.startsWith('INSERT INTO agent_runs'))!;const snapshot=JSON.parse(insert.args[9] as string);assert.equal(snapshot.harness,'codex');assert.equal(snapshot.subscription.bindingId,binding.id);assert.equal(snapshot.parent.executionId,parent.id);assert.equal(calls.at(-1)!.sql,'COMMIT');assert.ok(calls.some(c=>c.sql.startsWith('INSERT INTO computer_run_bindings')))
})
