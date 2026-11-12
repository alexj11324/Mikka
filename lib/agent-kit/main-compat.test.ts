import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {afterEach, before, beforeEach, mock, test} from 'node:test'
import type { SQL } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import {defaultRunPolicy} from '@mikka/protocol/agent-policy'
import {REPO_ORIGIN_HEADER} from '@mikka/protocol/device'
import {freezeWorkerDefinition, retryWorkerDefinition} from './worker'
import {runPrompt} from '../run-prompt'
import {DEFAULT_AGENT_DEFINITION} from './builtin'
import {makeSnapshot} from './definition'
import { overrideDeploymentSwitch } from '../deployment-switches'

const owner=randomUUID(),workspace=randomUUID(),agentId=randomUUID(),deviceId=randomUUID(),repoId=randomUUID(),botId=randomUUID(),issueId=randomUUID()
const otherWorkspace=randomUUID()
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
const compactSql = (sql: string) => sql.replace(/\s+/g, ' ').trim()
const fixtureRows = <T>(rows: T[]) => ({ rows, rowCount: rows.length })
// Keep real identity freezing. Every storage response names its exact query,
// owner and tenant; the queue fixture rejects anything not listed here.
function identityFixtureQuery(raw: string, args: unknown[]) {
 const sql = compactSql(raw)
 if(sql==='SELECT "ownerId","workspaceId" FROM bots WHERE id=$1 AND "archivedAt" IS NULL') {
  assert.deepEqual(args, [botId]); return fixtureRows([{ ownerId: owner, workspaceId: workspace }])
 }
 if(sql==='SELECT "ownerId",kind,enabled FROM devices WHERE id=$1') {
  assert.deepEqual(args, [deviceId]); return fixtureRows([{ ownerId: owner, kind: 'cloud', enabled: true }])
 }
 if(sql===compactSql(`SELECT b."ownerId",b."workspaceId",b."connectionRevision"::text AS revision,b."modelId",b.route,
      EXISTS (SELECT 1 FROM workspace_subscription_shares s WHERE s."ownerId"=b."ownerId" AND s."workspaceId"=$2 AND s."allowOthers"
      AND NOT EXISTS (SELECT 1 FROM workspace_personal_policies p WHERE p."workspaceId"=$2 AND NOT p.subscriptions)) AS shared
      FROM byos_bindings b JOIN byos_connections c ON c.id=b."connectionId" AND c."ownerId"=b."ownerId"
      AND c.state='connected' AND NOT c.paused AND c.epoch=b."connectionRevision" WHERE b.id=$1`)) {
  assert.deepEqual(args, [binding.id, workspace]); return fixtureRows([{ ownerId: owner, workspaceId: workspace, revision: String(binding.connectionRevision), modelId: binding.modelId, route: binding.route, shared: false }])
 }
 if(sql==='SELECT 1 FROM user_e2b_keys WHERE "userId"=$1 UNION ALL SELECT 1 FROM workspace_e2b_keys WHERE "createdBy"=$1 LIMIT 1') {
  assert.deepEqual(args, [owner]); return fixtureRows([{}])
 }
 return null
}

// This suite substitutes device authentication and DB IO to test only claim
// snapshot composition. Real credential admission is covered by revocation DB tests.
stub('../device-route.ts',{withDeviceRoute:<T>(handler:T)=>handler})
let selectIndex=0
let mismatch: string|undefined
let currentRun: {id:string;userId:string;workspaceId:string|null;agentId:string;deviceId:string;deviceRepoId:string;issueId:string;baseBranch:null;kind:string;prompt:string;agentDefinition:ReturnType<typeof frozen>|null;status:string;stopRequestedAt:Date|null;leaseExpiresAt:Date|null}
let requestedRunId=randomUUID()
let stopDuringToken=false,revokeDuringToken=false,memberActive=true,memberLease=false,applicationLease=false
let repositoryDenied=false
let requireResourceLease: typeof import('../project-resources/store').requireProjectResourceLease
const resourceReads:string[]=[]
const lockOrder:string[]=[]
const tableName=(value:Record<symbol,unknown>)=>String(value[Object.getOwnPropertySymbols(value).find(key=>key.description==='drizzle:Name')!])
const issueFixture=()=>({id:issueId,userId:owner,workspaceId:mismatch==='issue-workspace'?otherWorkspace:workspace,ownershipState:mismatch==='unresolved-issue'?'unresolved':'bound',scope:'personal',content:{type:'doc'}})
const tx={select(){let table='';const query={from(value:Record<symbol,unknown>){table=tableName(value);return query},innerJoin(){return query},where(){return query},async for(){lockOrder.push(table);if(table==='issues')return [issueFixture()];if(table==='agent_runs')return [{run:{...currentRun},enabled:true}];throw new Error(`Unexpected claim response lock: ${table}`)}};return query}}
const db={select:()=>{let table='';const query={from(value:Record<symbol,unknown>){table=tableName(value);return query},where(){return query},async limit(){
 if(selectIndex++===0)currentRun={id:requestedRunId,userId:mismatch==='run'?'other-owner':owner,workspaceId:mismatch==='unresolved-run'?null:mismatch==='run-workspace'?otherWorkspace:workspace,agentId,deviceId,deviceRepoId:repoId,issueId,baseBranch:null,kind:'implement',prompt:'task',agentDefinition:definition,status:'queued',stopRequestedAt:null,leaseExpiresAt:null}
 if(table==='agent_runs')return [{...currentRun}]
 if(table==='agents')return [{id:agentId,userId:mismatch==='agent'?'other-owner':owner,deviceId:randomUUID(),harness:'claude_code'}]
 if(table==='device_repos')return [{id:repoId,userId:mismatch==='repo'?'other-owner':owner,deviceId:mismatch==='device'?randomUUID():deviceId,baseBranch:'main',repoPath:mismatch==='legacy-key'?'github.com/example/repo':'v2/github.com/example/repo',remoteUrl:mismatch==='repo-url'?'https://github.com:8443/example/repo.git':'https://github.com/example/repo.git'}]
 throw new Error(`Unexpected compatibility read: ${table}`)
 }};return query},update:()=>({set:()=>({where:async()=>undefined})}),transaction:async<T>(run:(value:typeof tx)=>Promise<T>)=>{assert.equal(memberLease,true,'claim response locks workspace/member before APP rows');assert.equal(applicationLease,true,'claim response uses its checked-out APP client');return run(tx)}}
// Keep the real withTaskWorkspace/requireTaskWorkspace/claim-response code.
// This fixture supplies their small DB projections and checks selected ids;
// PostgreSQL row-lock and revocation behavior belongs to the DB suites.
type SqlChunk={queryChunks?:SqlChunk[];table?:Record<symbol,unknown>;name?:string;value?:unknown}
function equalities(node:SqlChunk,found:[string,string,unknown][]=[]){
 const chunks=node.queryChunks??[]
 chunks.forEach((chunk,index)=>{
  if(chunk.queryChunks)equalities(chunk,found)
  else if(chunk.table&&chunk.name&&String((chunks[index+1] as {value?:unknown[]})?.value?.[0]).trim()==='=')found.push([tableName(chunk.table),chunk.name,chunks[index+2]?.value])
 })
 return found
}
function workspaceSelect(columns?:Record<string,unknown>){
 let table='',filters:[string,string,unknown][]=[],organizationJoin=false
 let condition:ReturnType<PgDialect['sqlToQuery']>|undefined
 const organizations=()=>{
  assert.equal(table,'mikka_organization_workspaces')
  assert.deepEqual(condition?.params,[workspace])
  assert.ok(condition?.sql==='"mikka_organization_workspaces"."workspaceId" = $1'||condition?.sql==='"mikka_organization_workspaces"."workspaceId" in ($1)')
  if(columns!==undefined)assert.deepEqual(Object.keys(columns),['organizationId'])
  // An exact non-Organization projection, not a replacement authorization.
  return []
 }
 const matches=(source:string,column:string,value:unknown)=>filters.some(([name,key,expected])=>name===source&&key===column&&expected===value)
 const query={from(value:Record<symbol,unknown>){table=tableName(value);return query},innerJoin(){return query},
  leftJoin(value:Record<symbol,unknown>,predicate:Parameters<PgDialect['sqlToQuery']>[0]){
   assert.equal(tableName(value),'mikka_organization_workspaces')
   const join=new PgDialect().sqlToQuery(predicate)
   assert.deepEqual(join.params,[])
   if(table==='mikka_workspaces'){
    assert.equal(join.sql,'"mikka_organization_workspaces"."workspaceId" = "mikka_workspaces"."id"')
    assert.deepEqual(Object.keys(columns!),['id','kind','organizationId'])
   }else{
    assert.equal(table,'mikka_workspace_members')
    assert.equal(join.sql,'"mikka_organization_workspaces"."workspaceId" = "mikka_workspace_members"."workspaceId"')
    assert.deepEqual(Object.keys(columns!),['id','organizationId'])
   }
   organizationJoin=true;return query
  },
  where(predicate:SqlChunk){filters=equalities(predicate);condition=new PgDialect().sqlToQuery(predicate as unknown as Parameters<PgDialect['sqlToQuery']>[0]);return query},
  async for(strength:string,options?:{of?:Record<symbol,unknown>}){
   lockOrder.push(table)
   if(table==='mikka_workspaces')return matches(table,'id',workspace)?[{id:workspace,kind:'team',ownerId:owner}]:[]
   if(table==='mikka_workspace_members'){
    assert.equal(organizationJoin,true);assert.equal(strength,'share')
    assert.ok(options?.of);assert.equal(tableName(options.of),'mikka_workspace_members')
    memberLease=memberActive&&matches(table,'workspaceId',workspace)&&matches(table,'userId',owner)&&matches(table,'status','active')
    return memberLease?[{id:owner,organizationId:null}]:[]
   }
   throw new Error(`Unexpected workspace lock: ${table}`)
  },
  async limit(value:number){assert.equal(value,1);return organizations()},
  async orderBy(){return memberActive&&matches('mikka_workspaces','id',workspace)&&matches('mikka_workspace_members','userId',owner)&&matches('mikka_workspace_members','status','active')?[{id:workspace,kind:'team',...(organizationJoin?{organizationId:null}:{})}]:[]},
  // oxlint-disable-next-line unicorn/no-thenable -- Match an awaited Drizzle selection.
  then(resolve:(rows:unknown)=>unknown,reject:(error:unknown)=>unknown){return (table==='mikka_organization_workspaces'?Promise.resolve().then(organizations):query.orderBy()).then(resolve,reject)},
 }
 return query
}
const dialect=new PgDialect()
function workspaceResourceExecutor() {
 let relationLocked=false,resourceLocked=false
 return async (statement:SQL) => {
  const query=dialect.sqlToQuery(statement),sql=compactSql(query.sql),args=query.params
  assert.equal(memberLease,true,'resource SQL runs only after the exact Workspace/member lock')
  if(sql==="select pg_advisory_xact_lock_shared(hashtextextended('mikka-team-relations',0))") {
   assert.deepEqual(args,[]);assert.equal(relationLocked,false);relationLocked=true
   return fixtureRows([])
  }
  if(sql==='select pg_advisory_xact_lock_shared(hashtextextended($1,0))') {
   assert.equal(relationLocked,true,'relation lock precedes the resource lock')
   assert.equal(resourceLocked,false);assert.deepEqual(args,[`project-resources:${workspace}`]);resourceLocked=true
   return fixtureRows([])
  }
  assert.equal(resourceLocked,true,'resource reads hold both shared locks')
  requireResourceLease(owner,workspace)
  if(sql==='select mode,"repositoryKeys",revision from workspace_repository_policies where "workspaceId"=$1') {
   assert.deepEqual(args,[workspace]);resourceReads.push('policy')
   return fixtureRows(repositoryDenied?[{mode:'restricted',repositoryKeys:[],revision:1}]:[])
  }
  if(sql==='select p.id,p.revision,p."archivedAt" from workspace_project_tasks t join workspace_projects p on p.id=t."projectId" and p."workspaceId"=t."workspaceId" where t."issueId"=$1 and t."workspaceId"=$2') {
   assert.deepEqual(args,[issueId,workspace]);resourceReads.push('project')
   return fixtureRows([]) // This legacy Task has no canonical Project or Environment.
  }
  throw new Error(`Unexpected Workspace resource SQL: ${sql}`)
 }
}
const workspaceFixture={select:workspaceSelect,transaction:async<T>(operation:(value:{select:typeof workspaceSelect;execute:ReturnType<typeof workspaceResourceExecutor>})=>Promise<T>)=>{
 const parentMemberLease=memberLease
 try{return await operation({select:workspaceSelect,execute:workspaceResourceExecutor()})}finally{memberLease=parentMemberLease}
}}
let cloud=false,localCapable=false
let protocolVersion=3
const applicationClient={release(){assert.equal(applicationLease,true,'release the checked-out claim client exactly once');applicationLease=false}}
stub('../db/index.ts',{
 db,
 pool:{connect:async()=>{
  assert.equal(memberLease,true,'claim checks out APP only after the Workspace lease')
  requireResourceLease(owner,workspace)
  assert.equal(applicationLease,false,'claim cannot check out a second APP client')
  applicationLease=true
  return applicationClient
 }},
 withDatabaseClient:async<T>(client:typeof applicationClient,operation:()=>Promise<T>)=>{
  assert.equal(client,applicationClient)
  assert.equal(applicationLease,true,'bind only the checked-out claim client')
  return operation()
 },
})
afterEach(()=>{assert.equal(applicationLease,false,'claim always releases its APP client');assert.equal(memberLease,false,'the outer Workspace lease always closes')})
const cliPolicy: ReturnType<typeof defaultRunPolicy>={...defaultRunPolicy(),permissions:{...defaultRunPolicy().permissions,network:'deny',install_dependency:'deny',git_push:'deny'},networkAllow:['cli-policy.invalid']}
let cliReadOnly=false
stub('../device-link.ts',{authenticateDevice:async()=>({userId:owner,scopeDeviceId:deviceId,scopeWorkspaceId:workspace}),ownedDevice:async()=>({enabled:true,protocolVersion,kind:cloud?'cloud':'local',computerUse:{installed:localCapable,version:null},harnesses:[{harness:'codex',installed:true,toolApproval:true,subscriptionBroker:true,computerBroker:true}]}),ownedDeviceWithReport:async()=>({enabled:true,protocolVersion,kind:cloud?'cloud':'local',computerUse:{installed:localCapable,version:null},harnesses:[{harness:'codex',installed:true,toolApproval:true,subscriptionBroker:true,computerBroker:true}]})})
const modelAdmissionCheck=mock.fn(async(_scope:{workspaceId:string;ownerId:string},_model:string,_signal?:AbortSignal)=>undefined)
stub('../model-admission/runtime.ts',{assertUnmanagedModelTransport:modelAdmissionCheck,assertSubscriptionModelTransport:modelAdmissionCheck})
stub('../agent-tool-approval/policy-store.ts',{readCliRunPolicy:async()=>({policy:{...cliPolicy,...(cliReadOnly?{readOnly:true}:{})},revision:'a'.repeat(64),workspaceIds:[workspace]})})
stub('../mcp/worker.ts',{issueRunToken:async()=>{if(stopDuringToken)currentRun.stopRequestedAt=new Date();if(revokeDuringToken)memberActive=false;return {token:'synthetic-only'}}})
stub('../personal-mailbox-runtime.ts',{personalWorkerMailboxAdvertised:async()=>[]})
stub('../app-tools-server.ts',{runAppToolkits:async()=>[]})
// Task visibility is a separate boundary; do not initialize auth/MCP services
// in the claim snapshot fixture. Revoked access has source and PG regressions.
stub('../issue-access.ts',{issueForUser:async(userId:string,id:string)=>userId===owner&&id===issueId?issueFixture():null})
stub('../issue-team-access.ts',{issueTeamAccess:async()=>{throw Error('owner claim must not query team membership')}})
stub('../mcp/resource.ts',{mcpResourceURL:null})
stub('../device-repositories.ts',{readRepositorySettings:async()=>null})
stub('../run-publications.ts',{prepareRunPublication:prepared,persistRunCompletion:completed})
stub('../run-leases.ts',{latestCheckpoint:async()=>null,failRunForDaemonUpgrade:async()=>false,failQueuedSubscriptionRuntime:async()=>{throw Error('Healthy claim fixture must not fail its subscription runtime')}})
let githubAccount:string|null=null
stub('../github/repository-installation.ts',{linkedGitHubAccountId:async()=>githubAccount})
// This legacy daemon fixture receives only the existing credential endpoint.
// Keep the current machine boundary isolated from real auth/cloud providers;
// native token issuance is covered by the GitHub credential suites.
const githubConfigured=mock.fn(async(userId:string)=>{assert.equal(userId,owner);return Boolean(githubAccount)})
const githubCredential=mock.fn(async()=>{throw Error('Legacy claim fixture must not read native GitHub credentials')})
stub('../github/machine-credential.ts',{githubMachineConfigured:githubConfigured,githubMachineCredential:githubCredential})
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
before(async()=>{
 const workspaceModule = await import('../workspace-db')
 stub('../workspace-db.ts', { ...workspaceModule, workspaceDb:workspaceFixture, workspacePool: { query: async (sql:string,args:unknown[]) => {
  assert.equal(compactSql(sql),`SELECT "userId" FROM mikka_workspace_members WHERE "workspaceId"=$1 AND "userId"=ANY($2::text[]) AND status='active'`)
  assert.deepEqual(args,[workspace,[owner]]);assert.equal(memberLease,true)
  return fixtureRows(memberActive?[{userId:owner}]:[])
 } } })
 requireResourceLease=(await import('../project-resources/store')).requireProjectResourceLease
 claim=(await import('../../app/v1/devices/[deviceId]/runs/[runId]/claim/route')).POST
 queue=(await import('../computer/queue-run')).queueCloudRun
})
beforeEach(()=>{definition=frozen();subscription={...binding};missing=false;cloud=false;localCapable=false;cliReadOnly=false;cliPolicy.permissions.git_push='deny';publicationPolicy.permissions.git_push='allow';computerPermission='ask';mismatch=undefined;protocolVersion=3;selectIndex=0;stopDuringToken=false;githubAccount=null;revokeDuringToken=false;memberActive=true;memberLease=false;repositoryDenied=false;resourceReads.length=0;lockOrder.length=0;process.env.MIKKA_BYOS_ENABLED='1';process.env.MIKKA_AGENT_KIT='1';process.env.MIKKA_CLOUD_COMPUTER_TASKS='1';for(const fn of [modelAdmissionCheck,bindingById,latestBinding,scopedBinding,claimed,cloudClaimed,prepared,completed,githubConfigured,githubCredential])fn.mock.resetCalls()})
const request=()=>{requestedRunId=randomUUID();return claim(new Request('https://example.test/v1/devices/'+deviceId+'/runs/'+requestedRunId+'/claim',{method:'POST',headers:{[REPO_ORIGIN_HEADER]:'1'}}),{params:Promise.resolve({deviceId,runId:requestedRunId})})}
const assertCliPolicy=(body:{policy:ReturnType<typeof defaultRunPolicy>;policyRevision:string})=>{assert.equal(body.policy.permissions.network,'deny');assert.equal(body.policy.permissions.install_dependency,'deny');assert.deepEqual(body.policy.networkAllow,['cli-policy.invalid']);assert.equal(body.policyRevision,'a'.repeat(64))}
// A non-GitHub repository keeps these queue cases focused on frozen worker
// selection. GitHub publication admission is covered by the claim cases below.
const queueRepository={repoPath:'v2/gitlab.com/example/repo',remoteUrl:'https://gitlab.com/example/repo.git',baseBranch:'main'}
function cloudQueueFixture(instructions='Review',priorRun?:Record<string,unknown>) {
 const calls:{sql:string;args:unknown[]}[]=[]
 let connected=false,transactionOpen=false,insertedRunId:string|undefined,connections=0,releases=0
 const client={
  release(){assert.equal(connected,true);assert.equal(transactionOpen,false);connected=false;releases++},
  async query(raw:string,args:unknown[]=[]){
   const sql=compactSql(raw);calls.push({sql:raw,args})
   assert.equal(connected,true);assert.equal(memberLease,true);requireResourceLease(owner,workspace)
   if(sql==='BEGIN'){assert.deepEqual(args,[]);assert.equal(transactionOpen,false);transactionOpen=true;return fixtureRows([])}
   assert.equal(transactionOpen,true,'every queue read/write uses the same APP transaction')
   if(sql==='COMMIT'||sql==='ROLLBACK'){assert.deepEqual(args,[]);transactionOpen=false;return fixtureRows([])}
   if(sql==='SELECT pg_advisory_xact_lock(hashtextextended($1,0))'){
    assert.equal(args.length,1)
    assert.ok(args[0]===`computer-policy:${workspace}`||(priorRun&&typeof args[0]==='string'&&/^computer-task:[0-9a-f]{64}$/.test(args[0])))
    return fixtureRows([])
   }
   if(sql===compactSql(`SELECT m."deviceId",a.instructions,a.harness,repo."baseBranch" FROM bots b
    JOIN bot_desktops desktop ON desktop."botId"=b.id AND desktop."ownerId"=b."ownerId" AND desktop."workspaceId"=b."workspaceId"
    JOIN cloud_machines m ON m."workspaceId"=b."workspaceId" AND m."ownerId"=b."ownerId"
    JOIN devices dev ON dev.id=m."deviceId" AND dev."ownerId"=b."ownerId" AND dev.kind='cloud' AND dev.enabled=true
    JOIN agents a ON a.id=$4 AND a."userId"=b."ownerId" AND a."deviceId"=dev.id
    JOIN bot_cloud_runtimes runtime ON runtime."botId"=b.id AND runtime."ownerId"=b."ownerId" AND runtime."workspaceId"=b."workspaceId"
      AND runtime."agentId"=a.id AND runtime.harness=a.harness
    JOIN device_repos repo ON repo.id=$5 AND repo."deviceId"=dev.id AND repo."userId"=b."ownerId"
    WHERE b.id=$1 AND b."ownerId"=$2 AND b."workspaceId"=$3 AND b."archivedAt" IS NULL
      AND (repo."remoteUrl" IS NOT NULL OR repo.id=runtime."repoId")
      AND (repo."remoteUrl" IS NOT NULL OR NOT EXISTS (SELECT 1 FROM workspace_computer_policies p WHERE p."workspaceId"=b."workspaceId" AND p.permission='deny'))
    FOR SHARE OF b,desktop,m,dev,a,runtime,repo`)){
    assert.deepEqual(args,[botId,owner,workspace,agentId,repoId])
    return fixtureRows([{deviceId,instructions,harness:'codex',baseBranch:queueRepository.baseBranch}])
   }
   if(sql==='SELECT "repoPath","remoteUrl" FROM device_repos WHERE id=$1 AND "userId"=$2 AND "deviceId"=$3 FOR SHARE'){
    assert.deepEqual(args,[repoId,owner,deviceId]);return fixtureRows([{...queueRepository}])
   }
   if(sql===compactSql(`SELECT r."userId",r."issueId",r."agentId",r."deviceId",r."deviceRepoId",r.prompt,r."agentDefinition",r."dispatchFingerprint",r."botId" AS "runBotId",b."botId",b."workspaceId"
        FROM agent_runs r LEFT JOIN computer_run_bindings b ON b."runId"=r.id WHERE r.id=$1`)){
    assert.ok(priorRun);assert.equal(args.length,1);assert.match(String(args[0]),/^[0-9a-f-]{36}$/)
    return fixtureRows([priorRun])
   }
   if(sql==='SELECT subscriptions FROM workspace_personal_policies WHERE "workspaceId"=$1'){
    assert.deepEqual(args,[workspace]);return fixtureRows([])
   }
   const keyColumns='id,"ownerId",provider,name,"baseUrl",protocol,last4,models,"modelsError","responsesApi"'
   if(sql===`SELECT ${keyColumns},to_jsonb(model_api_keys)->'modelSettings' AS "modelSettings" FROM model_api_keys WHERE "ownerId"=$1 ORDER BY "createdAt",id`){
    assert.deepEqual(args,[owner]);return fixtureRows([])
   }
   if(sql===`SELECT ${keyColumns.split(',').map(column=>`k.${column}`).join(',')},to_jsonb(k)->'modelSettings' AS "modelSettings" FROM model_api_key_shares s JOIN model_api_keys k ON k.id=s."keyId" WHERE s."workspaceId"=$1 AND k."ownerId"<>$2 ORDER BY s."createdAt",k.id`){
    assert.deepEqual(args,[workspace,owner]);return fixtureRows([])
   }
   const identity=identityFixtureQuery(sql,args);if(identity)return identity
   if(sql==='SELECT 1 FROM device_repos WHERE id=$1 AND "userId"=$2 AND "repoPath" LIKE \'v2/github.com/%\''){
    assert.deepEqual(args,[repoId,owner]);assert.equal(queueRepository.repoPath.startsWith('v2/github.com/'),false)
    return fixtureRows([])
   }
   if(sql===compactSql(`INSERT INTO agent_runs (id,"userId","issueId","agentId","deviceId","deviceRepoId",status,kind,"baseBranch",prompt,"botId","agentDefinition","dispatchFingerprint","promptTaskStart","promptTaskLength","workspaceId",origin,"originRef")
      VALUES ($1,$2,$3,$4,$5,$6,'queued','implement',$7,$8,$9,$10,$11,0,$12,$13,$14,$15)`)){
    assert.equal(insertedRunId,undefined);assert.equal(args.length,15);assert.match(String(args[0]),/^[0-9a-f-]{36}$/)
    assert.deepEqual(args.slice(1,7),[owner,issueId,agentId,deviceId,repoId,queueRepository.baseBranch])
    assert.equal(args[8],botId);assert.equal(args[12],workspace)
    // M0 provenance rides on the same insert; these fixtures name no entry, so the
    // helper default applies and no ref is written.
    assert.equal(args[13],'web');assert.equal(args[14],null)
    insertedRunId=String(args[0]);return fixtureRows([])
   }
   if(sql==='INSERT INTO computer_run_bindings ("runId","botId","workspaceId","ownerId") VALUES ($1,$2,$3,$4)'){
    assert.ok(insertedRunId);assert.deepEqual(args,[insertedRunId,botId,workspace,owner]);return fixtureRows([])
   }
   if(sql===`INSERT INTO thread_machines ("runId","workspaceId","ownerId","botId","snapshotId","operationId",state,"issueId") VALUES ($1,$2,$3,$4,$5,$6,'starting',$7) ON CONFLICT DO NOTHING`){
    assert.ok(insertedRunId);assert.equal(args.length,7);assert.deepEqual(args.slice(0,5),[insertedRunId,workspace,owner,botId,'pending']);assert.match(String(args[5]),/^[0-9a-f-]{36}$/);assert.equal(args[6],null)
    return fixtureRows([])
   }
   throw new Error(`Unexpected cloud queue SQL: ${sql}`)
  },
 }
 const pool={
  connect:async()=>{assert.equal(connected,false);assert.equal(memberLease,true);requireResourceLease(owner,workspace);connected=true;connections++;return client},
  query:async(raw:string,args:unknown[])=>{
   calls.push({sql:raw,args});assert.equal(memberLease,false);assert.equal(connected,false)
   assert.equal(compactSql(raw),compactSql(`SELECT repo."repoPath",repo."remoteUrl",a.harness,
        CASE WHEN source.id IS NULL THEN repo."baseBranch"
          WHEN source."agentDefinition"->'projectExecution' IS NOT NULL THEN source."agentDefinition"->'projectExecution'->>'baseBranch'
          ELSE source."baseBranch" END AS "baseBranch"
      FROM device_repos repo JOIN agents a ON a.id=$2 AND a."userId"=$3
      JOIN issues i ON i.id=$4 AND i."workspaceId"=$5 AND i."ownershipState"='bound'
      LEFT JOIN agent_runs source ON source.id=$6 AND source."userId"=$3 AND source."issueId"=i.id AND source."workspaceId"=i."workspaceId"
      WHERE repo.id=$1 AND repo."userId"=$3`))
   assert.deepEqual(args,[repoId,agentId,owner,issueId,workspace,null])
   return fixtureRows([{...queueRepository,harness:'codex'}])
  },
 } as unknown as Parameters<typeof queue>[0]
 return {pool,calls,assertClosed(){assert.equal(connected,false);assert.equal(transactionOpen,false);assert.equal(connections,releases)},connections:()=>connections}
}
test('local claim uses frozen harness and exact subscription despite Agent edits',async()=>{
 definition={...frozen(),model:'frozen-model',cliModelSelection:'explicit'}
 const response=await request();assert.equal(response.status,200);const body=await response.json();assert.equal(body.harness,'codex');assert.equal(body.model,'frozen-model');assert.equal(body.remoteUrl,'https://github.com/example/repo.git');assert.equal(body.baseBranch,undefined);assert.deepEqual(scopedBinding.mock.calls[0].arguments.slice(1),[owner,agentId,'codex',undefined,binding.id]);assert.equal(bindingById.mock.callCount(),0,'pinned lookup uses the owner/share-aware scope gate');assert.equal(latestBinding.mock.callCount(),0);assert.equal(claimed.mock.callCount(),1);assert.equal(typeof (claimed.mock.calls[0].arguments as unknown[])[5],'function','Factory lineage guard remains attached')
 assert.deepEqual(modelAdmissionCheck.mock.calls[0].arguments.slice(0,2),[{workspaceId:workspace,ownerId:owner},'frozen-model'])
 assert.equal(modelAdmissionCheck.mock.calls[0].arguments[2],binding.route)
 assert.equal(prepared.mock.callCount(),1)
 assert.equal(body.mcp.token,'synthetic-only','a successful response includes the prepared credential before testing final-fence denials')
 assert.equal(body.policy.permissions.git_push,'allow','a stored CLI git_push deny no longer withholds the task branch push (decision 2026-11-02-1600)')
 const [run,remoteUrl]=prepared.mock.calls[0].arguments
 assert.equal(run.userId,owner);assert.equal(run.issueId,issueId);assert.equal(run.baseBranch,null);assert.equal(remoteUrl,'https://github.com/example/repo.git')
 assert.equal(body.pushBranch,publicationAssignment.pushBranch);assertCliPolicy(body);assert.equal(completed.mock.callCount(),0)
})
test('auto model is omitted from a subscription assignment; historical snapshots retain their saved binding model',async()=>{
 let response=await request();assert.equal(response.status,200);assert.equal(Object.hasOwn(await response.json(),'model'),false)
 definition=frozen();delete definition.cliModelSelection;selectIndex=0
 response=await request();assert.equal(response.status,200);assert.equal((await response.json()).model,'frozen-model')
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
 assert.equal(githubConfigured.mock.callCount(),0);assert.equal(githubCredential.mock.callCount(),0)
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
 for(const cloudRun of [false,true]){
  cloud=cloudRun;selectIndex=0;stopDuringToken=true;lockOrder.length=0;resourceReads.length=0
  const response=await request();assert.equal(response.status,409)
  const text=await response.text();for(const field of ['prompt','synthetic-only','subscriptionBinding'])assert.equal(text.includes(field),false)
  // Resource admission surrounds the original final-response fence. The
  // second membership check still precedes issue -> Run locks and sees STOP.
  assert.deepEqual([...lockOrder],['mikka_workspaces','mikka_workspace_members','mikka_workspaces','mikka_workspace_members','issues','agent_runs'])
  assert.deepEqual(resourceReads,['policy','project'])
 }
})
test('local and cloud claim responses withhold secrets when owner membership is revoked during token preparation',async()=>{
 for(const cloudRun of [false,true]){
  cloud=cloudRun;selectIndex=0;memberActive=true;revokeDuringToken=true;lockOrder.length=0;resourceReads.length=0
  const response=await request();assert.equal(response.status,409)
  const text=await response.text();for(const field of ['prompt','synthetic-only','subscriptionBinding'])assert.equal(text.includes(field),false)
  assert.deepEqual([...lockOrder],['mikka_workspaces','mikka_workspace_members','mikka_workspaces','mikka_workspace_members'])
  assert.deepEqual(resourceReads,['policy','project']);assert.equal(memberLease,false)
 }
})
test('claim responses require a resolved run tenant and the same bound issue tenant',async()=>{
 for(const target of ['unresolved-run','run-workspace','issue-workspace','unresolved-issue']){mismatch=target;selectIndex=0;const response=await request();assert.equal(response.status,409,target);const text=await response.text();for(const field of ['prompt','synthetic-only','subscriptionBinding'])assert.equal(text.includes(field),false,`${target}: ${field}`)}
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
 const fixture=cloudQueueFixture('Cloud review'),{calls}=fixture
 const parent={id:randomUUID(),status:'running' as const,snapshot:makeSnapshot(randomUUID(),2,DEFAULT_AGENT_DEFINITION,'HOST',{harness:'codex',model:null})}
 await queue(fixture.pool,{userId:owner,workspaceId:workspace},{botId,issueId,agentId,deviceRepoId:repoId,title:'Review',body:'synthetic',model:binding.modelId,execution:parent})
 const insert=calls.find(c=>c.sql.startsWith('INSERT INTO agent_runs'))!;const snapshot=JSON.parse(insert.args[9] as string);assert.equal(snapshot.harness,'codex');assert.equal(snapshot.subscription.bindingId,binding.id);assert.equal(snapshot.parent.executionId,parent.id);assert.equal(calls.at(-1)!.sql,'COMMIT');assert.ok(calls.some(c=>c.sql.startsWith('INSERT INTO computer_run_bindings')))
 assert.deepEqual(snapshot.projectExecution,{version:1,workspaceId:workspace,projectId:null,projectRevision:null,policyRevision:0,repositoryKey:queueRepository.repoPath,baseBranch:queueRepository.baseBranch,environment:null})
 assert.deepEqual(resourceReads,['policy','project']);fixture.assertClosed()
})


test('with versioned definitions off, a cloud run still freezes its Agent and credential source',async()=>{
 // Every cloud run freezes its definition when it is queued (orchestration.md § 5), with the model its caller chose.
 process.env.MIKKA_AGENT_KIT='0'
 const fixture=cloudQueueFixture(),{calls}=fixture
 await queue(fixture.pool,{userId:owner,workspaceId:workspace},{botId,issueId,agentId,deviceRepoId:repoId,title:'Review',body:'',model:binding.modelId})
 const insert=calls.find(c=>c.sql.startsWith('INSERT INTO agent_runs'))!;const snapshot=JSON.parse(insert.args[9] as string)
 assert.equal(snapshot.harness,'codex');assert.equal(snapshot.subscription.bindingId,binding.id);assert.equal(calls.at(-1)!.sql,'COMMIT');fixture.assertClosed()
})
// The hosted runner starts a subscription run only on that subscription's own model: a cloud subscription run
// is frozen with that model, explicitly, and one queued without it (or with 'auto') fails before anything is written.
test('a cloud subscription run must name its model explicitly with versioned definitions disabled',async()=>{
 process.env.MIKKA_AGENT_KIT='0'
 const fixture=cloudQueueFixture(),{calls,pool}=fixture
 for(const model of ['auto','',undefined]){
  await assert.rejects(queue(pool,{userId:owner,workspaceId:workspace},{botId,issueId,agentId,deviceRepoId:repoId,title:'Review',body:'',model:model as string,threadRunId:'previous-run'}),/Run model missing \(run .+, thread previous-run\)/)
 }
 assert.equal(calls.length,0,'nothing is read or written for a run without its model')
 await queue(pool,{userId:owner,workspaceId:workspace},{botId,issueId,agentId,deviceRepoId:repoId,title:'Review',body:'',model:binding.modelId})
 const insert=calls.find(call=>call.sql.startsWith('INSERT INTO agent_runs'))!
 const snapshot=JSON.parse(insert.args[9] as string)
 assert.equal(snapshot.cliModelSelection,'explicit');assert.equal(snapshot.model,binding.modelId);assert.equal(snapshot.subscription.modelId,binding.modelId)
 assert.equal(snapshot.subscription.bindingId,binding.id);assert.equal(calls.at(-1)!.sql,'COMMIT');fixture.assertClosed()
})
test('cloud request replay cannot substitute another parent execution',async()=>{
 const fixture=cloudQueueFixture('Review',{userId:owner,issueId,agentId,deviceId,deviceRepoId:repoId,runBotId:botId,botId,workspaceId:workspace,prompt:runPrompt('Review','','Review'),agentDefinition:{harness:'codex',parent:{executionId:randomUUID()}}})
 const parent={id:randomUUID(),status:'running' as const,snapshot:makeSnapshot(randomUUID(),2,DEFAULT_AGENT_DEFINITION,'HOST',{harness:'codex',model:null})}
 await assert.rejects(queue(fixture.pool,{userId:owner,workspaceId:workspace},{botId,issueId,agentId,deviceRepoId:repoId,title:'Review',body:'',model:binding.modelId,execution:parent,idempotencyKey:'same-call'}),/Task request changed/)
 assert.equal(fixture.calls.some(call=>call.sql.startsWith('INSERT INTO ')),false);assert.equal(fixture.calls.at(-1)?.sql,'ROLLBACK');fixture.assertClosed()
})

test('current Workspace repository refusal blocks local/cloud claims before credentials or leases',async()=>{
 repositoryDenied=true
 for(const hosted of [false,true]){
  cloud=hosted;selectIndex=0
  const response=await request();assert.equal(response.status,409);assert.equal((await response.json()).code,'projectRepositoryDenied')
 }
 assert.deepEqual(resourceReads,['policy','policy'])
 for(const boundary of [modelAdmissionCheck,scopedBinding,claimed,cloudClaimed,prepared,githubConfigured,githubCredential])assert.equal(boundary.mock.callCount(),0)
 assert.equal(memberLease,false);assert.equal(applicationLease,false)
})

test('current Workspace repository refusal blocks cloud queue before any APP transaction or credential choice',async()=>{
 repositoryDenied=true
 const fixture=cloudQueueFixture()
 await assert.rejects(queue(fixture.pool,{userId:owner,workspaceId:workspace},{botId,issueId,agentId,deviceRepoId:repoId,title:'Review',body:'',model:binding.modelId}),{code:'projectRepositoryDenied'})
 assert.equal(fixture.calls.length,1,'only the scoped repository/Task preflight is read')
 assert.deepEqual(resourceReads,['policy']);assert.equal(scopedBinding.mock.callCount(),0);assert.equal(fixture.connections(),0);fixture.assertClosed()
 assert.equal(memberLease,false)
})

test('local assignment receives only persisted server computer authority',async()=>{localCapable=true;const response=await request();assert.equal(response.status,200);const body=await response.json();assert.equal(body.localComputer.workspaceId,workspace);assert.equal(body.localComputer.ownerId,owner);assert.equal(body.localComputer.policyVersion,3);assert.equal(body.policy.permissions.computer_use,'allow');assert.equal(body.computer,undefined);assertCliPolicy(body)})

test('persisted computer grants retain the trusted CLI read-only restriction',async()=>{
 cliReadOnly=true;computerPermission='allow'
 for(const hosted of [true,false]){cloud=hosted;localCapable=!hosted;selectIndex=0;const response=await request();assert.equal(response.status,200);const body=await response.json();assert.equal(body.policy.readOnly,true);assert.equal(body.policy.permissions.computer_use,'deny');assertCliPolicy(body)}
})

test('a scoped device credential cannot claim a different device even for the same owner',async()=>{
 const otherDevice=randomUUID();const response=await claim(new Request('https://example.test/claim',{method:'POST'}),{params:Promise.resolve({deviceId:otherDevice,runId:randomUUID()})});assert.equal(response.status,404);assert.equal(selectIndex,0);assert.equal(claimed.mock.callCount(),0);assert.equal(cloudClaimed.mock.callCount(),0)
 assert.equal(githubConfigured.mock.callCount(),0);assert.equal(githubCredential.mock.callCount(),0)
})


test('repository push approval composes with CLI limits without broadening unrelated actions', async () => {
 cliPolicy.permissions.git_push='allow'
 const approved=await request();assert.equal(approved.status,200);const accepted=await approved.json()
 assert.equal(accepted.policy.permissions.git_push,'allow');assert.equal(accepted.policy.permissions.network,'deny');assert.equal(accepted.policy.permissions.install_dependency,'deny');assert.equal(accepted.policyRevision,'a'.repeat(64))
 selectIndex=0;cliPolicy.permissions.git_push='allow';publicationPolicy.permissions.git_push='deny'
 const pending=await request();assert.equal(pending.status,200);assert.equal((await pending.json()).policy.permissions.git_push,'deny','a local run never receives ask: no push card')
})

test('a cloud claim without a push admission denies the push, never asks', async () => {
 cloud=true;cliPolicy.permissions.git_push='allow'
 const response=await request();assert.equal(response.status,200);const body=await response.json()
 assert.equal(prepared.mock.callCount(),0)
 assert.equal(body.policy.permissions.git_push,'deny');assert.equal(body.policy.permissions.network,'deny');assert.equal(body.policy.permissions.install_dependency,'deny')
 assert.equal(cliPolicy.permissions.git_push,'allow','the stored CLI policy is unchanged')
})

test('a cloud run admitted with the GitHub App grant gets its publication and allow, like a local run', async () => {
 cloud=true;cliPolicy.permissions.git_push='allow'
 definition={...frozen(),repositoryAdmission:{userId:owner,issueId,deviceId,agentId,remoteKey:'v2/github.com/example/repo',remoteUrl:'https://github.com/example/repo.git',permission:'push_to_origin',targetBranch:'mikka/mik-1',authority:'github_app',approvedAt:'2026-11-01T00:00:00Z',acceptedAt:'2026-11-01T00:00:00Z'}}
 const response=await request();assert.equal(response.status,200);const body=await response.json()
 assert.equal(prepared.mock.callCount(),1,'the admitted cloud run reserves its publication before the lease')
 assert.equal(body.pushBranch,publicationAssignment.pushBranch)
 assert.equal(body.policy.permissions.git_push,'allow')
})

test('a read-only local run gets no push branch and a read-only policy, but the owner\'s GitHub credential like any run', async () => {
 definition={...frozen(),readOnly:true};cliPolicy.permissions.git_push='allow'
 const response=await request();assert.equal(response.status,200);const body=await response.json()
 assert.equal(prepared.mock.callCount(),0,'a read-only run reserves no publication')
 assert.equal(body.pushBranch,undefined);assert.equal(body.github,undefined,'no GitHub connection: nothing to give')
 assert.equal(body.policy.readOnly,true);assert.equal(body.policy.permissions.git_push,'deny')
 selectIndex=0;githubAccount='123'
 overrideDeploymentSwitch('personalMailbox', false)
 try {
  const connected=await (await request()).json()
  assert.ok(connected.mcp,'the run token is issued')
  assert.equal(connected.github?.repository,'example/repo');assert.equal(connected.github?.branch,undefined)
  assert.equal(githubConfigured.mock.callCount(),2);assert.equal(githubCredential.mock.callCount(),0)
 } finally { githubAccount=null;overrideDeploymentSwitch('personalMailbox', undefined) }
})
