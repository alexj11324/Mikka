import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {before, beforeEach, mock, test} from 'node:test'
import {defaultRunPolicy} from '@mikka/protocol/agent-policy'
import {REPO_ORIGIN_HEADER} from '@mikka/protocol/device'
import {freezeWorkerDefinition, retryWorkerDefinition} from './worker'
import {runPrompt} from '../run-prompt'
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
const scopedBinding=mock.fn(async()=>{if(missing)throw Error('missing binding');return subscription})
const claimed=mock.fn(async(_pool:unknown,_run:string,_device:string,lease:Date)=>{currentRun.status='preparing';currentRun.leaseExpiresAt=lease;return 'claimed'})
let computerPermission: 'ask' | 'allow' = 'ask'
const cloudClaimed=mock.fn(async(_pool:unknown,_owner:unknown,_run:string,_device:string,lease:Date)=>{currentRun.status='preparing';currentRun.leaseExpiresAt=lease;return {botId,ownerId:owner,display:':3',policyVersion:1,permission:computerPermission}})
const publicationPolicy=defaultRunPolicy()
publicationPolicy.permissions.git_push='allow'
const publicationAssignment={pushBranch:'mikka/mik-42',policy:publicationPolicy}
// This suite owns claim routing and snapshot compatibility. Publication's real
// ownership/approval/transaction behavior is exercised by its CI DB suite.
const prepared=mock.fn(async(..._args:Parameters<typeof import('../run-publications').prepareRunPublication>)=>structuredClone(publicationAssignment))
const completed=mock.fn(async()=>{throw Error('Claim unexpectedly completed a run')})
const stub=(path:string,namedExports:Record<string,unknown>)=>mock.module(new URL(path,import.meta.url).href,{namedExports})
// This suite substitutes device authentication and DB IO to test only claim
// snapshot composition. Real credential admission is covered by revocation DB tests.
stub('../device-route.ts',{withDeviceRoute:<T>(handler:T)=>handler})
let selectIndex=0
let mismatch: string|undefined
let currentRun: {id:string;userId:string;agentId:string;deviceId:string;deviceRepoId:string;issueId:string;baseBranch:null;kind:string;prompt:string;agentDefinition:ReturnType<typeof frozen>|null;status:string;stopRequestedAt:Date|null;leaseExpiresAt:Date|null}
let stopDuringToken=false
const lockOrder:string[]=[]
const tx={select(){let table='';const query={from(value:Record<symbol,unknown>){table=String(value[Object.getOwnPropertySymbols(value).find(key=>key.description==='drizzle:Name')!]);return query},innerJoin(){return query},where(){return query},async for(){lockOrder.push(table);return table==='issues'?[{id:issueId,userId:owner,scope:'personal',content:{type:'doc'}}]:[{run:{...currentRun},enabled:true}]}};return query}}
const db={select:()=>({from:()=>({where:()=>({limit:async()=>{
 if(selectIndex++===0){currentRun={id:randomUUID(),userId:mismatch==='run'?'other-owner':owner,agentId,deviceId,deviceRepoId:repoId,issueId,baseBranch:null,kind:'implement',prompt:'task',agentDefinition:definition,status:'queued',stopRequestedAt:null,leaseExpiresAt:null};return [{...currentRun}]}
 return selectIndex===2?[{id:agentId,userId:mismatch==='agent'?'other-owner':owner,deviceId:randomUUID(),harness:'claude_code'}]:[{id:repoId,userId:mismatch==='repo'?'other-owner':owner,deviceId:mismatch==='device'?randomUUID():deviceId,baseBranch:'main',repoPath:mismatch==='legacy-key'?'github.com/example/repo':'v2/github.com/example/repo',remoteUrl:mismatch==='repo-url'?'https://github.com:8443/example/repo.git':'https://github.com/example/repo.git'}]
}})})}),transaction:async<T>(run:(value:typeof tx)=>Promise<T>)=>run(tx)}
let cloud=false,localCapable=false
let protocolVersion=3
stub('../db/index.ts',{db,pool:{}})
const cliPolicy: ReturnType<typeof defaultRunPolicy>={...defaultRunPolicy(),permissions:{...defaultRunPolicy().permissions,network:'deny',install_dependency:'deny',git_push:'deny'},networkAllow:['cli-policy.invalid']}
let cliReadOnly=false
stub('../device-link.ts',{authenticateDevice:async()=>({userId:owner,scopeDeviceId:deviceId,scopeWorkspaceId:workspace}),ownedDevice:async()=>({enabled:true,protocolVersion,kind:cloud?'cloud':'local',computerUse:{installed:localCapable,version:null},harnesses:[{harness:'codex',installed:true,toolApproval:true,subscriptionBroker:true,computerBroker:true}]})})
stub('../agent-tool-approval/policy-store.ts',{readCliRunPolicy:async()=>({policy:{...cliPolicy,...(cliReadOnly?{readOnly:true}:{})},revision:'a'.repeat(64)})})
stub('../mcp/worker.ts',{issueRunToken:async()=>{if(stopDuringToken)currentRun.stopRequestedAt=new Date();return {token:'synthetic-only'}}})
stub('../issue-team-access.ts',{issueTeamAccess:async()=>{throw Error('owner claim must not query team membership')}})
stub('../mcp/resource.ts',{mcpResourceURL:null})
stub('../device-repositories.ts',{readRepositorySettings:async()=>null})
stub('../run-publications.ts',{prepareRunPublication:prepared,persistRunCompletion:completed})
stub('../run-leases.ts',{latestCheckpoint:async()=>null})
stub('../computer/local-authority.ts',{localComputerAuthority:async()=>({botId,ownerId:owner,workspaceId:workspace,policyVersion:3,permission:'allow'})})
stub('../computer/claim.ts',{claimLocalRun:claimed,claimCloudRun:cloudClaimed})
stub('../computer/native-run-binding.ts',{nativeRunBinding:scopedBinding})
// This fixture covers ordinary Agent-kit subscription snapshots. Factory and
// Skill assignment SQL, terminal fences and native binding CAS have their own
// PostgreSQL composition regressions; do not initialize auth/provider services here.
stub('../factory/server.ts',{
 guardExecutionRun:async()=>{throw Error('Mocked ordinary claim must not execute a transaction callback')},
 claimFactoryCheckRun:async()=>{throw Error('No Factory check in this fixture')},factoryQuestions:{},
})
stub('../self-improvement/server.ts',{
 skillAssignments:{preflight:async()=>undefined,recordClaim:async()=>undefined},
 claimBenchmarkAssignment:async()=>undefined,
})
stub('../subscription-runtime.ts',{subscriptionRuntime:()=>({repository:{binding:bindingById,nativeBinding:latestBinding}})})
let claim: typeof import('../../app/v1/devices/[deviceId]/runs/[runId]/claim/route').POST
let queue: typeof import('../computer/queue-run').queueCloudRun
before(async()=>{claim=(await import('../../app/v1/devices/[deviceId]/runs/[runId]/claim/route')).POST;queue=(await import('../computer/queue-run')).queueCloudRun})
beforeEach(()=>{definition=frozen();subscription={...binding};missing=false;cloud=false;localCapable=false;cliReadOnly=false;cliPolicy.permissions.git_push='deny';publicationPolicy.permissions.git_push='allow';computerPermission='ask';mismatch=undefined;protocolVersion=3;selectIndex=0;stopDuringToken=false;lockOrder.length=0;process.env.MIKKA_BYOS_ENABLED='1';process.env.MIKKA_AGENT_KIT='1';process.env.MIKKA_CLOUD_COMPUTER_TASKS='1';for(const fn of [bindingById,latestBinding,scopedBinding,claimed,cloudClaimed,prepared,completed])fn.mock.resetCalls()})
const request=()=>claim(new Request('https://example.test/v1/devices/'+deviceId+'/runs/'+randomUUID()+'/claim',{method:'POST',headers:{[REPO_ORIGIN_HEADER]:'1'}}),{params:Promise.resolve({deviceId,runId:randomUUID()})})
const assertCliPolicy=(body:{policy:ReturnType<typeof defaultRunPolicy>;policyRevision:string})=>{assert.equal(body.policy.permissions.network,'deny');assert.equal(body.policy.permissions.install_dependency,'deny');assert.equal(body.policy.permissions.git_push,'deny');assert.deepEqual(body.policy.networkAllow,['cli-policy.invalid']);assert.equal(body.policyRevision,'a'.repeat(64))}
test('local claim uses frozen harness and exact subscription despite Agent edits',async()=>{
 const response=await request();assert.equal(response.status,200);const body=await response.json();assert.equal(body.harness,'codex');assert.equal(body.model,'frozen-model');assert.equal(body.remoteUrl,'https://github.com/example/repo.git');assert.equal(body.baseBranch,undefined);assert.deepEqual(bindingById.mock.calls[0].arguments,[owner,binding.id]);assert.equal(latestBinding.mock.callCount(),0);assert.equal(claimed.mock.callCount(),1);assert.equal(typeof (claimed.mock.calls[0].arguments as unknown[])[5],'function','Factory lineage guard remains attached')
 assert.equal(prepared.mock.callCount(),1)
 const [run,remoteUrl]=prepared.mock.calls[0].arguments
 assert.equal(run.userId,owner);assert.equal(run.issueId,issueId);assert.equal(run.baseBranch,null);assert.equal(remoteUrl,'https://github.com/example/repo.git')
 assert.equal(body.pushBranch,publicationAssignment.pushBranch);assertCliPolicy(body);assert.equal(completed.mock.callCount(),0)
})
test('an old local daemon gets an upgrade response without consuming the queued run',async()=>{
 protocolVersion=2;const response=await request();assert.equal(response.status,409);assert.equal((await response.json()).code,'daemonUpgradeRequired');assert.equal(selectIndex,0);assert.equal(claimed.mock.callCount(),0)
 assert.equal(prepared.mock.callCount(),0)
})
test('claim refuses cross-owner or cross-device records even without a subscription',async()=>{
 process.env.MIKKA_BYOS_ENABLED='0';definition=null
 for(const target of ['run','agent','repo','device']){mismatch=target;selectIndex=0;assert.equal((await request()).status,409)}
 assert.equal(claimed.mock.callCount(),0);assert.equal(cloudClaimed.mock.callCount(),0)
 assert.equal(prepared.mock.callCount(),0)
})
test('claim refuses legacy or endpoint-mismatched repository bindings before taking a lease',async()=>{
 for(const target of ['legacy-key','repo-url']){mismatch=target;selectIndex=0;assert.equal((await request()).status,409)}
 assert.equal(claimed.mock.callCount(),0);assert.equal(cloudClaimed.mock.callCount(),0)
})
test('cloud claim preserves main scoped claim and frozen subscription',async()=>{
 cloud=true;const response=await request();assert.equal(response.status,200);assert.equal(cloudClaimed.mock.callCount(),1);assert.equal(claimed.mock.callCount(),0);assert.equal(typeof (cloudClaimed.mock.calls[0].arguments as unknown[])[6],'function');assert.deepEqual(scopedBinding.mock.calls[0].arguments.slice(1),[owner,agentId,'codex',workspace,binding.id])
 const body=await response.json();assert.equal(body.computer.botId,botId);assert.equal(body.pushBranch,undefined);assert.equal(body.policy.permissions.computer_use,'ask');assert.equal(prepared.mock.callCount(),0);assert.equal(completed.mock.callCount(),0)
})
test('claim refuses legacy or endpoint-mismatched bindings before approval, token or lease creation',async()=>{
 for(const target of ['legacy-key','repo-url']){mismatch=target;selectIndex=0;assert.equal((await request()).status,409)}
 assert.equal(claimed.mock.callCount(),0);assert.equal(prepared.mock.callCount(),0);assert.equal(cloudClaimed.mock.callCount(),0)
})
test('cloud assignment takes computer allow from trusted claim, never a request field',async()=>{
 cloud=true;computerPermission='allow';const response=await request();assert.equal(response.status,200);const body=await response.json();assert.equal(body.policy.permissions.computer_use,'allow');assert.equal(body.computer.ownerId,owner);assert.equal(body.computer.policyVersion,1);assertCliPolicy(body)
})
test('frozen local and cloud claims still withhold credentials and prompt after owner STOP',async()=>{
 for(const cloudRun of [false,true]){cloud=cloudRun;selectIndex=0;stopDuringToken=true;lockOrder.length=0;const response=await request();assert.equal(response.status,409);const text=await response.text();for(const field of ['prompt','synthetic-only','subscriptionBinding'])assert.equal(text.includes(field),false);assert.deepEqual(lockOrder,['issues','agent_runs'])}
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


test('feature-off cloud queue keeps the existing main SQL path without snapshot or binding lookup',async()=>{
 process.env.MIKKA_AGENT_KIT='0'
 const calls:{sql:string,args:unknown[]}[]=[]
 const client={release(){},async query(sql:string,args:unknown[]=[]){calls.push({sql,args});return {rows:sql.startsWith('SELECT m.')?[{deviceId,instructions:'Review',harness:'codex',baseBranch:'main'}]:[]}}}
 await queue({connect:async()=>client} as unknown as Parameters<typeof queue>[0],{userId:owner,workspaceId:workspace},{botId,issueId,agentId,deviceRepoId:repoId,title:'Review',body:''})
 assert.ok(!calls.some(c=>c.sql.includes('agentDefinition')||c.sql.startsWith('select id from byos_bindings')));assert.equal(calls.at(-1)!.sql,'COMMIT')
})
test('cloud request replay cannot substitute another parent execution',async()=>{
 const client={release(){},async query(sql:string){if(sql.startsWith('SELECT m.'))return {rows:[{deviceId,instructions:'Review',harness:'codex',baseBranch:'main'}]};if(sql.startsWith('SELECT r.'))return {rows:[{userId:owner,issueId,agentId,deviceId,deviceRepoId:repoId,runBotId:botId,botId,workspaceId:workspace,prompt:runPrompt('Review','','Review'),agentDefinition:{harness:'codex',parent:{executionId:randomUUID()}}}]};return {rows:[]}}}
 const parent={id:randomUUID(),status:'running' as const,snapshot:makeSnapshot(randomUUID(),2,DEFAULT_AGENT_DEFINITION,'HOST',{harness:'codex',model:null})}
 await assert.rejects(queue({connect:async()=>client} as unknown as Parameters<typeof queue>[0],{userId:owner,workspaceId:workspace},{botId,issueId,agentId,deviceRepoId:repoId,title:'Review',body:'',execution:parent,idempotencyKey:'same-call'}),/Task request changed/)
})

test('local assignment receives only persisted server computer authority',async()=>{localCapable=true;const response=await request();assert.equal(response.status,200);const body=await response.json();assert.equal(body.localComputer.workspaceId,workspace);assert.equal(body.localComputer.ownerId,owner);assert.equal(body.localComputer.policyVersion,3);assert.equal(body.policy.permissions.computer_use,'allow');assert.equal(body.computer,undefined);assertCliPolicy(body)})

test('persisted computer grants retain the trusted CLI read-only restriction',async()=>{
 cliReadOnly=true;computerPermission='allow'
 for(const hosted of [true,false]){cloud=hosted;localCapable=!hosted;selectIndex=0;const response=await request();assert.equal(response.status,200);const body=await response.json();assert.equal(body.policy.readOnly,true);assert.equal(body.policy.permissions.computer_use,'deny');assertCliPolicy(body)}
})

test('a scoped device credential cannot claim a different device even for the same owner',async()=>{
 const otherDevice=randomUUID();const response=await claim(new Request('https://example.test/claim',{method:'POST'}),{params:Promise.resolve({deviceId:otherDevice,runId:randomUUID()})});assert.equal(response.status,404);assert.equal(selectIndex,0);assert.equal(claimed.mock.callCount(),0);assert.equal(cloudClaimed.mock.callCount(),0)
})


test('repository push approval composes with CLI limits without broadening unrelated actions', async () => {
 cliPolicy.permissions.git_push='ask'
 const approved=await request();assert.equal(approved.status,200);const accepted=await approved.json()
 assert.equal(accepted.policy.permissions.git_push,'allow');assert.equal(accepted.policy.permissions.network,'deny');assert.equal(accepted.policy.permissions.install_dependency,'deny');assert.equal(accepted.policyRevision,'a'.repeat(64))
 selectIndex=0;cliPolicy.permissions.git_push='allow';publicationPolicy.permissions.git_push='ask'
 const pending=await request();assert.equal(pending.status,200);assert.equal((await pending.json()).policy.permissions.git_push,'ask')
})
