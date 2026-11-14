import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import { transpileModule, ModuleKind } from 'typescript'
import { TASK_MCP_HEADER, TASK_MCP_VERSION } from '@mikka/protocol'
import * as codedErrorProtocol from '@mikka/protocol/coded-error'
import * as daemonProtocol from '@mikka/protocol/daemon'
import * as deviceProtocol from '@mikka/protocol/device'
import * as harnessProtocol from '@mikka/protocol/harness'
import * as policySnapshotProtocol from '@mikka/protocol/policy-snapshot'
import * as repositoryProtocol from '@mikka/protocol/repository'
import * as subscriptionProtocol from '@mikka/protocol/subscription'
import * as taskSecretsProtocol from '@mikka/protocol/task-secrets'
import { defaultRunPolicy } from '@mikka/protocol/agent-policy'
import { constrainedAssignmentPolicy, intersectRunPolicy } from '../run-assignment-policy'
import { serverRunFailure } from '../run-failure-details'
import { ModelAdmissionError } from '../model-admission/contract'
import { ActionFailureError } from '../action-error'
import { PublicationError } from '../run-publication-result'
import * as startupTracing from '../computer/startup-tracing'
import * as startupDiagnostics from '../computer/startup-diagnostics'
import * as questionDeliveryContext from '../factory/questions/continuation-delivery-context'
import * as decisionMcpTool from '../project-map/mcp-tool'
import { issueTaskSecretAccess } from '../secrets/task-access'
import { deploymentSwitch, type DeploymentSwitch } from '@/lib/deployment-switches'
import messages from '@/messages/zh-CN.json'
const fixtureEnv={MIKKA_BYOS_ENABLED:'0',MIKKA_FACTORY_ROUTING_ENABLED:'1',MIKKA_FACTORY_LIFECYCLE_ENABLED:'1'}

// Execute the actual route in memory, with its database/auth boundaries replaced.
async function routeFixture(unavailable=false,stopped=false,modelDenied=false,issueDenied=false,projectDenied=false,options:{cloud?:boolean;finalDenied?:boolean;finalState?:Record<string,unknown>;settings?:unknown}={}) {
  const env={...fixtureEnv,MIKKA_BYOS_ENABLED:options.cloud?'1':'0'}
  const repositoryReads:unknown[][]=[];let selectionsRead=0,responseCalls=0
  const calls:string[]=[]
  const credentialChecks:string[]=[]
  const admissionScopes:string[]=[]
  const projectLease={active:false,guards:0,releases:0}
  const resourceFenceChecks:boolean[]=[]
  const workspaceIds=['bot-workspace','task-workspace']
  const run={id:'run',userId:'owner',workspaceId:'task-workspace' as string|null,issueId:'issue',agentId:'agent',deviceRepoId:'repo',deviceId:'device',deviceTokenId:null as string|null,status:'queued',kind:'implement',baseBranch:'frozen-sha',prompt:'frozen task',attempt:1,agentDefinition:undefined as {agentProfile?:unknown}|undefined}
  const agent={id:'agent',userId:'owner',harness:'codex'},repo={id:'repo',userId:'owner',deviceId:'device',repoPath:'v2/github.com/mikka-ci/benchmark-claim',remoteUrl:'https://github.com/mikka-ci/benchmark-claim.git',verifyCommand:'mutable-repo-command'}
  const selections=[run,agent,repo]
  // This benchmark fixture has no Profile. Real Profile admission and native
  // continuation use PostgreSQL coverage; never silently admit one here.
  const assertNoProfile=(definition:{agentProfile?:unknown}|null|undefined)=>{
    assert.equal(definition?.agentProfile,undefined,'benchmark fixture does not authorize Agent Profiles')
  }
  class ImprovementError extends Error {constructor(public code:string){super(code)}}
  class FactoryError extends Error {}
  const db={select:()=>{selectionsRead++;return {from:()=>({where:()=>({limit:async()=>[selections.shift()]})})}},update:()=>({set:(values:object)=>({where:()=>({returning:async()=>{calls.push('block');Object.assign(run,values);return [{id:run.id}]}})})})}
  const benchmark={harness:'codex',model:'actual-observed-model',verifyCommand:'git diff --exit-code HEAD --',policy:{readOnly:true,networkAllow:[],permissions:{install_dependency:'deny',write_outside_repo:'deny',git_push:'deny',network:'ask'}},benchmark:{caseId:'case',benchmarkDigest:'digest',sourceCommit:'frozen-sha'}}
  const modules:Record<string,unknown>={
    '@mikka/protocol':{TASK_MCP_HEADER,TASK_MCP_VERSION},
    // This VM owns frozen benchmark composition, not credential admission;
    // the actual route/fence and token revocation have real PostgreSQL tests.
    '@/lib/issue-access':{issueForUser:async(userId:string,id:string)=>{assert.equal(projectLease.active,true);assert.equal(userId,'owner');assert.equal(id,'issue');return issueDenied?null:{id,userId,workspaceId:run.workspaceId,ownershipState:'bound',scope:'personal',content:{type:'doc'}}}},
    '@/lib/action-error':{ActionFailureError},
    // Repository/Environment admission has real PostgreSQL coverage. This
    // benchmark fixture authorizes only its exact legacy, no-Environment
    // placement, and keeps that boundary held through the final response.
    '@/lib/project-resources/run-lease':{withRunProjectExecution:async(input:Record<string,unknown>,frozen:unknown,operation:()=>Promise<unknown>)=>{
      projectLease.guards++
      assert.deepEqual({...input},{userId:'owner',workspaceId:'task-workspace',issueId:'issue',repositoryKey:repo.repoPath,baseBranch:'frozen-sha',runtime:options.cloud?'cloud':'local',harness:'codex'})
      assert.equal(frozen,undefined,'this benchmark fixture cannot silently authorize a Project or Environment snapshot')
      if(projectDenied)throw new ActionFailureError('projectRepositoryDenied')
      assert.equal(projectLease.active,false)
      projectLease.active=true
      try{return await operation()}finally{projectLease.active=false;projectLease.releases++}
    }},
    '@/lib/device-route':{withDeviceRoute:<T>(handler:T)=>handler},
    '@/lib/computer/startup-tracing':startupTracing,
    '@/lib/computer/startup-diagnostics':startupDiagnostics,
    '@/lib/project-map/mcp-tool':decisionMcpTool,
    '@/lib/live/lists':{runListChanged:async(executor:unknown,runId:string)=>{
      assert.equal(executor,db);assert.equal(runId,run.id);assert.equal(run.status,'failed');calls.push('listChanged')
    }},
    '@/lib/cloud-computer-flag':{cloudComputerTasksEnabled:()=>true},
    '@/lib/background':{afterJob:()=>{calls.push('wakeScheduled')}},
    'next/server':{NextResponse:class extends Response {static json(body:unknown,init?:ResponseInit){return Response.json(body,init)}}},
    'drizzle-orm':{and:(...args:unknown[])=>args,eq:(...args:unknown[])=>args,isNull:(value:unknown)=>value},
    '@mikka/protocol/coded-error':codedErrorProtocol,
    '@mikka/protocol/device':deviceProtocol,
    '@mikka/protocol/harness':harnessProtocol,
    '@mikka/protocol/daemon':daemonProtocol,
    '@mikka/protocol/repository':repositoryProtocol,
    '@mikka/protocol/subscription':subscriptionProtocol,
    '@mikka/protocol/task-secrets':taskSecretsProtocol,
    '@mikka/protocol/policy-snapshot':policySnapshotProtocol,
    '@/messages/zh-CN.json':{default:messages},
    // This legacy-capability fixture has no managed organization policy.
    '@/lib/agent-tool-approval/policy-distribution':{},
    '@/lib/agent-tool-approval/local-cloud-issuer':{},
    '@/lib/device-agents':{localExecutionHarnesses:()=>['codex']},
    '@/lib/device-repositories':{readRepositorySettings:async(user:string,remote:string)=>{repositoryReads.push([user,remote]);return options.settings===undefined?{verifyCommand:repo.verifyCommand}:options.settings}},
    '@/lib/run-test-fixture':{runTestFixture:()=>undefined},
    '@/lib/live/panels':{runChanged:async(_executor:unknown,id:string)=>{assert.equal(id,'run');assert.equal(run.status,'failed')}},
    '@/lib/agent-tool-approval/policy-store':{readCliRunPolicy:async()=>({policy:defaultRunPolicy(),revision:'synthetic-current-policy',workspaceIds})},
    '@/lib/model-admission/contract':{ModelAdmissionError},
    '@/lib/model-admission/runtime':{assertUnmanagedModelTransport:async(scope:{workspaceId:string;ownerId:string},model:string)=>{
      assert.deepEqual(Object.keys(scope).sort(),['ownerId','workspaceId'])
      assert.equal(scope.ownerId,'owner');assert.ok(workspaceIds.includes(scope.workspaceId));assert.equal(model,'native-default')
      admissionScopes.push(scope.workspaceId)
      // These ordinary benchmark namespaces have no organization model rule.
      // The explicit rejection case proves the route still consults both scopes.
      if(modelDenied&&scope.workspaceId==='task-workspace')throw new ModelAdmissionError('modelRouteDenied')
    }},
    '@/lib/run-assignment-policy':{constrainedAssignmentPolicy,intersectRunPolicy},
    '@/lib/run-failure-details':{serverRunFailure},
    '@/lib/run-claim-response':{authorizedClaimResponse:async(_user:string,_run:unknown,_lease:string,respond:(current:typeof run)=>Response,authorizeResources:(current:typeof run,tx:typeof db)=>Promise<boolean>)=>{
      assert.equal(projectLease.active,true,'the Project resource lease covers the final Secret fence')
      responseCalls++
      assert.equal(typeof authorizeResources,'function','the actual claim must supply its final resource fence')
      if(options.finalDenied)return null
      const current={...run,...options.finalState}
      const allowed=await authorizeResources(current,db)
      resourceFenceChecks.push(allowed)
      return allowed?respond(current):null
    }},
    '@/lib/run-publications':{prepareRunPublication:async()=>({policy:{...defaultRunPolicy(),permissions:{...defaultRunPolicy().permissions,git_push:'allow'}}}),persistRunCompletion:async()=>{assert.equal(issueDenied,true);calls.push('rejectPublication')}},
    '@/lib/run-publication-result':{PublicationError},
    // No linked GitHub account in this fixture: the claim attaches no GitHub credential endpoint.
    '@/lib/github/machine-credential':{
      githubMachineConfigured:async(userId:string)=>{assert.equal(userId,'owner');credentialChecks.push('configured');return false},
      githubMachineCredential:async()=>{credentialChecks.push('credential');throw new Error('This benchmark fixture must not open GitHub credentials')},
    },
    '@/lib/db':{db,pool:{},withDatabaseClient:async(_tx:unknown,fn:()=>Promise<unknown>)=>fn()},'@/lib/db/schema':{agentRuns:{},agents:{},deviceRepos:{}},
    '@/lib/device-link':{authenticateDevice:async()=>({userId:'owner',tokenId:'synthetic-device-token',...(options.cloud?{scopeDeviceId:'device',scopeWorkspaceId:'task-workspace'}:{})}),ownedDevice:async()=>({enabled:true,kind:options.cloud?'cloud':'local',protocolVersion:daemonProtocol.DAEMON_PROTOCOL_VERSION,harnesses:[{harness:'codex',installed:true,toolApproval:true,subscriptionBroker:true}]}),ownedDeviceWithReport:async()=>({enabled:true,kind:options.cloud?'cloud':'local',protocolVersion:daemonProtocol.DAEMON_PROTOCOL_VERSION,harnesses:[{harness:'codex',installed:true,toolApproval:true,subscriptionBroker:true}]})},
    '@/lib/base-path':{withBasePath:(path:string)=>path},'@/lib/mcp/resource':{},
    '@/lib/mcp/worker':{issueRunToken:async()=>{assert.equal(projectLease.active,true);calls.push('token');return {token:'synthetic-test-token'}}},
    // This fixture has no connected apps; retain the actual canonical MCP metadata.
    '@/lib/app-tools-server':{runAppToolkits:async()=>[]},
    '@/lib/run-leases':{failRunForDaemonUpgrade:async()=>false,failQueuedSubscriptionRuntime:async()=>{throw Error('A benchmark without subscriptions must not fail a subscription runtime')}},'@/lib/daemon-release':{daemonTooOld:()=>false},'@/lib/run-retry':{},
    '@/lib/thread-continuation':{continuationFollowUp:()=>null},
    '@/lib/run-completion-effects':{afterRunEnded:async()=>{calls.push('runEnded');return 0}},
    '@/lib/factory/profile-admission':{AgentProfileAdmissionError:class extends Error {}},
    '@/lib/factory/profile-native-session':{profileNativeSessionMatches:(before:{agentProfile?:unknown}|null|undefined,after:{agentProfile?:unknown}|null|undefined)=>{
      assertNoProfile(before);assertNoProfile(after);return true
    }},
    '@/lib/factory/runtime':{guardFactoryClaim:async()=>{calls.push('guard');if(stopped)throw new FactoryError('stopped');return {preserveQuestionWorktree:true}}},
    '@mikka/protocol/agent-policy':{defaultRunPolicy},
    '@/lib/computer/local-authority':{localComputerAuthority:async()=>null},
    '@/lib/computer/claim':{claimLocalRun:async(_pool:unknown,_runId:string,_deviceId:string,_lease:Date,_subscription:unknown,guard:(tx:object)=>Promise<boolean>,after:(tx:object)=>Promise<void>)=>{
      assert.equal(projectLease.active,true)
      assertNoProfile(run.agentDefinition)
      const tx={query:async(statement:string,args:unknown[])=>{
        assert.ok(statement.startsWith('UPDATE agent_runs SET "deviceTokenId"=$2'))
        assert.deepEqual(Array.from(args),['run','synthetic-device-token','owner',false])
        run.deviceTokenId=String(args[1]);return {rows:[],rowCount:1}
      }}
      if(!await guard(tx))return 'unavailable';calls.push('claim');run.status='preparing';await after(tx);return 'claimed'
    }},
    '@/lib/subscription-runtime':{},
    '@/lib/subscription-native-device':{},
    // The real switch, read against this fixture's environment rather than the test process's.
    '@/lib/deployment-switches':{deploymentSwitch:(name:DeploymentSwitch)=>deploymentSwitch(name,env)},
    '@/lib/computer/native-run-binding':{nativeRunBinding:async()=>({id:'subscription',ownerId:'owner',consumerId:'agent',workspaceId:'task-workspace',modelId:'native-default',route:'codex_cli'})},
    '@/lib/personal-policy':{sharedNativeBinding:async()=>null},
    '@/lib/secrets/flag':{byoE2BKeyEnabled:()=>false},
    '@/lib/secrets/runtime':{
      taskSecretInjection:async(workspaceId:string|null,repository:string|null,runtimeEnv:unknown,executor:unknown,ownerId:string)=>{
        assert.equal(projectLease.active,true)
        assert.equal(workspaceId,'task-workspace');assert.equal(workspaceId,run.workspaceId)
        assert.equal(repository,null);assert.equal(runtimeEnv,env);assert.equal(executor,undefined);assert.equal(ownerId,'owner')
        return {env:{},secretNames:[],protectedSecrets:[],unavailable:[]}
      },
      taskSecretSnapshot:async()=>{throw Error('This benchmark fixture has no prepared Secret snapshot to revalidate')},
      environmentSecretInjection:async()=>{throw Error('This benchmark fixture has no selected Environment')},
      environmentSecretSnapshot:async()=>{throw Error('This benchmark fixture has no selected Environment snapshot')},
      remoteRepositoryRef:()=>null,
    },
    '@/lib/secrets/task-access':{issueTaskSecretAccess},
    '@/lib/execution-identity':{executionMembersActive:async()=>{throw Error('This benchmark fixture has no frozen workspace Secret authority')}},
    '@/lib/personal-mailbox-config':{personalMailboxEnabled:()=>false},
    '@/lib/factory/questions/continuation-delivery-context':questionDeliveryContext,
    '@/lib/factory/questions/retry':{},'@mikka/protocol/skill':{SKILL_ARTIFACT_HEADER:'x-mikka-skill-artifacts'},
    // This fixture's runs carry no Profile, so an empty assignment is exact.
    '@/lib/factory/agent-profile-skills':{profileSkillRunAssignment:()=>({})},
    '@/lib/self-improvement/contract':{ImprovementError},'@/lib/factory/contract':{FactoryError},
    '@/lib/self-improvement/server':{
      skillAssignments:{preflight:async(_user:string,_run:string,supportsArtifacts:boolean)=>{calls.push('preflight');assert.equal(supportsArtifacts,true);assert.equal(run.status,'queued')},recordClaim:async(_user:string,_device:string,_run:string,_lease:string,supportsArtifacts:boolean)=>{calls.push('receipt');assert.equal(supportsArtifacts,true);assert.equal(run.status,'preparing');return {skills:[],skillReceipt:{id:'receipt'}}}},
      claimBenchmarkAssignment:async()=>{calls.push('benchmark');assert.equal(run.status,'preparing');if(unavailable)throw new ImprovementError('runUnavailable');return benchmark},
    },
  }
  const admission=modules['@/lib/model-admission/runtime'] as {assertUnmanagedModelTransport:(scope:{workspaceId:string;ownerId:string},model:string)=>Promise<void>;assertSubscriptionModelTransport?:unknown}
  admission.assertSubscriptionModelTransport=admission.assertUnmanagedModelTransport
  const claims=modules['@/lib/computer/claim'] as {claimLocalRun:(...args:unknown[])=>Promise<string>;claimCloudRun?:unknown}
  claims.claimCloudRun=async(_pool:unknown,_scope:unknown,runId:unknown,deviceId:unknown,lease:unknown,binding:unknown,guard:unknown,after:unknown)=>
    await claims.claimLocalRun(_pool,runId,deviceId,lease,binding,guard,after)==='claimed'?{}:null
  const source=await readFile(new URL('../../app/v1/devices/[deviceId]/runs/[runId]/claim/route.ts',import.meta.url),'utf8')
  const exports:Record<string,unknown>={}
  runInNewContext(transpileModule(source,{compilerOptions:{module:ModuleKind.CommonJS}}).outputText,
    {exports,require:(name:string)=>{if(!Object.hasOwn(modules,name))throw Error(`Unexpected import ${name}`);return modules[name]},Response,URL,Date,process:{env}})
  return {calls,credentialChecks,admissionScopes,projectLease,resourceFenceChecks,run,benchmark,repositoryReads,selectCount:()=>selectionsRead,finalResponseCalls:()=>responseCalls,post:exports.POST as (request:Request,context:{params:Promise<{deviceId:string;runId:string}>})=>Promise<Response>}
}

const claimRequest=()=>new Request('https://fixture.invalid/v1/claim',{headers:{[deviceProtocol.REPO_ORIGIN_HEADER]:'1','x-mikka-skill-artifacts':'1'}})

test('actual claim route resolves frozen benchmark exactly once after claim and receipt and overrides mutable config',async()=>{
  const {post,calls,credentialChecks,admissionScopes,projectLease,resourceFenceChecks,benchmark,run}=await routeFixture()
  const response=await post(claimRequest(),{params:Promise.resolve({deviceId:'device',runId:'run'})})
  assert.equal(response.status,200)
  const assignment=await response.json()
  assert.deepEqual(calls,['preflight','guard','claim','token','receipt','benchmark'])
  assert.deepEqual(admissionScopes,['bot-workspace','task-workspace'])
  assert.equal(assignment.verifyCommand,benchmark.verifyCommand)
  assert.equal(assignment.model,benchmark.model)
  assert.equal(assignment.remoteUrl,'https://github.com/mikka-ci/benchmark-claim.git')
  assert.equal(assignment.expectedRepoRemote,assignment.remoteUrl)
  assert.deepEqual(assignment.mcp.decisionCatalogue,decisionMcpTool.RUN_DECISION_CATALOGUE)
  assert.equal(assignment.policyRevision,'synthetic-current-policy')
  assert.deepEqual(assignment.benchmark,benchmark.benchmark)
  assert.deepEqual(assignment.policy,benchmark.policy)
  assert.equal(run.deviceTokenId,'synthetic-device-token')
  assert.deepEqual(credentialChecks,['configured'])
  assert.deepEqual(resourceFenceChecks,[true])
  assert.equal(assignment.github,undefined)
  assert.deepEqual(projectLease,{active:false,guards:1,releases:1})
  assert.equal(assignment.taskSecrets,undefined)
})

test('actual claim route withholds all assignment bytes when frozen configuration becomes unavailable after claim',async()=>{
  const {post,calls,credentialChecks,run}=await routeFixture(true)
  const response=await post(claimRequest(),{params:Promise.resolve({deviceId:'device',runId:'run'})})
  assert.equal(response.status,409)
  assert.deepEqual(await response.json(),{error:'runUnavailable'})
  assert.deepEqual(calls,['preflight','guard','claim','token','receipt','benchmark','block','listChanged','runEnded'])
  assert.equal(run.status,'failed')
  assert.deepEqual(credentialChecks,[])
})


test('actual claim route refuses a stopped Factory before receipt, benchmark or token issuance',async()=>{
  const {post,calls,credentialChecks,run}=await routeFixture(false,true)
  const response=await post(claimRequest(),{params:Promise.resolve({deviceId:'device',runId:'run'})})
  assert.equal(response.status,409)
  assert.deepEqual(await response.json(),{error:'Run is no longer queued for this device.'})
  assert.deepEqual(calls,['preflight','guard'])
  assert.equal(run.status,'queued')
  assert.deepEqual(credentialChecks,[])
})

test('benchmark claim cannot bypass its task workspace model rule through the Bot namespace',async()=>{
  const {post,calls,credentialChecks,admissionScopes,run}=await routeFixture(false,false,true)
  const response=await post(claimRequest(),{params:Promise.resolve({deviceId:'device',runId:'run'})})
  assert.equal(response.status,409)
  assert.deepEqual(await response.json(),{error:'modelRouteDenied'})
  assert.deepEqual(admissionScopes,['bot-workspace','task-workspace'])
  assert.deepEqual(calls,['preflight'])
  assert.equal(run.status,'queued')
  assert.deepEqual(credentialChecks,[])
})


test('task access denial withholds assignment and credentials before claim preparation',async()=>{
  const {post,calls,credentialChecks,run}=await routeFixture(false,false,false,true)
  const response=await post(claimRequest(),{params:Promise.resolve({deviceId:'device',runId:'run'})})
  assert.equal(response.status,409)
  assert.deepEqual(calls,['rejectPublication','wakeScheduled'])
  assert.equal(run.status,'queued')
  assert.deepEqual(credentialChecks,[])
})

test('Project resource denial precedes claim preparation, receipts and credential issuance',async()=>{
  const {post,calls,credentialChecks,admissionScopes,projectLease,run}=await routeFixture(false,false,false,false,true)
  const response=await post(claimRequest(),{params:Promise.resolve({deviceId:'device',runId:'run'})})
  assert.equal(response.status,409)
  assert.deepEqual(await response.json(),{error:'projectRepositoryDenied',code:'projectRepositoryDenied'})
  assert.deepEqual(calls,[])
  assert.deepEqual(credentialChecks,[])
  assert.deepEqual(admissionScopes,[])
  assert.deepEqual(projectLease,{active:false,guards:1,releases:0})
  assert.equal(run.status,'queued')
})

test('an unbound legacy Run cannot bypass Project admission or receive benchmark bytes',async()=>{
  const {post,calls,credentialChecks,projectLease,run}=await routeFixture()
  run.workspaceId=null
  const response=await post(claimRequest(),{params:Promise.resolve({deviceId:'device',runId:'run'})})
  assert.equal(response.status,409)
  assert.deepEqual(await response.json(),{error:'Run ownership unavailable.'})
  assert.equal(response.headers.get('cache-control'),'private, no-store')
  assert.deepEqual(calls,[])
  assert.deepEqual(credentialChecks,[])
  assert.deepEqual(projectLease,{active:false,guards:0,releases:0})
  assert.equal(run.status,'queued')
})

test('initial cloud repository projection reuses the existing read after the final response fence',async()=>{
  const settings={verifyCommand:'git diff --exit-code',setup:{approved:true,copyFiles:['.env.local'],command:'npm ci'},networkAllow:['registry.npmjs.org']}
  const f=await routeFixture(false,false,false,false,false,{cloud:true,settings})
  const response=await f.post(new Request('https://fixture.invalid/v1/claim',{headers:{[deviceProtocol.REPO_ORIGIN_HEADER]:'1','x-mikka-skill-artifacts':'1','x-mikka-initial-repository':'1'}}),{params:Promise.resolve({deviceId:'device',runId:'run'})})
  assert.equal(response.status,200)
  const assignment=await response.json()
  assert.deepEqual(assignment.repo,{repoId:'repo',name:'benchmark-claim',path:'v2/github.com/mikka-ci/benchmark-claim',remoteUrl:'https://github.com/mikka-ci/benchmark-claim.git',setup:settings.setup,networkAllow:settings.networkAllow})
  assert.deepEqual(f.repositoryReads,[['owner','https://github.com/mikka-ci/benchmark-claim.git']])
  assert.equal(f.selectCount(),3)
  assert.equal(f.finalResponseCalls(),1)
})

test('claim repository projection is optional, cloud-only and evaluated inside the final fresh response',async t=>{
  for(const mode of ['old-client','local','final-denied','retry','continuation','session','malformed','missing'] as const)await t.test(mode,async()=>{
    const f=await routeFixture(false,false,false,false,false,{cloud:mode!=='local',finalDenied:mode==='final-denied',
      finalState:mode==='retry'?{retryOf:'prior'}:mode==='continuation'?{continuesRunId:'prior'}:mode==='session'?{sessionId:'prior'}:{},
      settings:mode==='malformed'?{setup:{approved:'invalid'}}:mode==='missing'?null:{setup:{approved:false,copyFiles:[]},networkAllow:[]}})
    const headers:Record<string,string>={[deviceProtocol.REPO_ORIGIN_HEADER]:'1','x-mikka-skill-artifacts':'1'}
    if(mode!=='old-client')headers['x-mikka-initial-repository']='1'
    const response=await f.post(new Request('https://fixture.invalid/v1/claim',{headers}),{params:Promise.resolve({deviceId:'device',runId:'run'})})
    assert.equal(response.status,mode==='final-denied'?409:200)
    const assignment=await response.json()
    if(mode==='missing')assert.deepEqual(assignment.repo,{repoId:'repo',name:'benchmark-claim',path:'v2/github.com/mikka-ci/benchmark-claim',remoteUrl:'https://github.com/mikka-ci/benchmark-claim.git'})
    else assert.equal(assignment.repo,undefined)
    assert.equal(f.repositoryReads.length,1)
    assert.equal(f.selectCount(),3)
  })
})
