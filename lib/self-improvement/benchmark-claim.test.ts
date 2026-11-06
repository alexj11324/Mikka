import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import { transpileModule, ModuleKind } from 'typescript'
import * as codedErrorProtocol from '@mikka/protocol/coded-error'
import * as daemonProtocol from '@mikka/protocol/daemon'
import * as deviceProtocol from '@mikka/protocol/device'
import * as harnessProtocol from '@mikka/protocol/harness'
import * as policySnapshotProtocol from '@mikka/protocol/policy-snapshot'
import * as repositoryProtocol from '@mikka/protocol/repository'
import { defaultRunPolicy } from '@mikka/protocol/agent-policy'
import { constrainedAssignmentPolicy, intersectRunPolicy } from '../run-assignment-policy'
import { ModelAdmissionError } from '../model-admission/contract'
import * as startupTracing from '../computer/startup-tracing'
import { deploymentSwitch, type DeploymentSwitch } from '@/lib/deployment-switches'
import messages from '@/messages/zh-CN.json'
const fixtureEnv={MIKKA_BYOS_ENABLED:'0',MIKKA_FACTORY_ROUTING_ENABLED:'1',MIKKA_FACTORY_LIFECYCLE_ENABLED:'1'}

// Execute the actual route in memory, with its database/auth boundaries replaced.
async function routeFixture(unavailable=false,stopped=false,modelDenied=false,issueDenied=false) {
  const calls:string[]=[]
  const admissionScopes:string[]=[]
  const workspaceIds=['bot-workspace','task-workspace']
  const run={id:'run',userId:'owner',issueId:'issue',agentId:'agent',deviceRepoId:'repo',deviceId:'device',deviceTokenId:null as string|null,status:'queued',kind:'implement',baseBranch:'frozen-sha',prompt:'frozen task',attempt:1,agentDefinition:undefined as {agentProfile?:unknown}|undefined}
  const agent={id:'agent',userId:'owner',harness:'codex'},repo={id:'repo',userId:'owner',deviceId:'device',repoPath:'v2/github.com/mikka-ci/benchmark-claim',remoteUrl:'https://github.com/mikka-ci/benchmark-claim.git',verifyCommand:'mutable-repo-command'}
  const selections=[run,agent,repo]
  // This benchmark fixture has no Profile. Real Profile admission and native
  // continuation use PostgreSQL coverage; never silently admit one here.
  const assertNoProfile=(definition:{agentProfile?:unknown}|null|undefined)=>{
    assert.equal(definition?.agentProfile,undefined,'benchmark fixture does not authorize Agent Profiles')
  }
  class ImprovementError extends Error {constructor(public code:string){super(code)}}
  class FactoryError extends Error {}
  const db={select:()=>({from:()=>({where:()=>({limit:async()=>[selections.shift()]})})}),update:()=>({set:(values:object)=>({where:()=>({returning:async()=>{calls.push('block');Object.assign(run,values);return [{id:run.id}]}})})})}
  const benchmark={harness:'codex',model:'actual-observed-model',verifyCommand:'git diff --exit-code HEAD --',policy:{readOnly:true,networkAllow:[],permissions:{install_dependency:'deny',write_outside_repo:'deny',git_push:'deny',network:'ask'}},benchmark:{caseId:'case',benchmarkDigest:'digest',sourceCommit:'frozen-sha'}}
  const modules:Record<string,unknown>={
    // This VM owns frozen benchmark composition, not credential admission;
    // the actual route/fence and token revocation have real PostgreSQL tests.
    '@/lib/issue-access':{issueForUser:async(userId:string,id:string)=>{assert.equal(userId,'owner');assert.equal(id,'issue');return issueDenied?null:{id,userId,scope:'personal',content:{type:'doc'}}}},
    '@/lib/device-route':{withDeviceRoute:<T>(handler:T)=>handler},
    '@/lib/computer/startup-tracing':startupTracing,
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
    '@mikka/protocol/policy-snapshot':policySnapshotProtocol,
    '@/messages/zh-CN.json':{default:messages},
    // This legacy-capability fixture has no managed organization policy.
    '@/lib/agent-tool-approval/policy-distribution':{},
    '@/lib/agent-tool-approval/local-cloud-issuer':{},
    '@/lib/device-agents':{localExecutionHarnesses:()=>['codex']},
    '@/lib/device-repositories':{readRepositorySettings:async()=>({verifyCommand:repo.verifyCommand})},
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
    '@/lib/run-claim-response':{authorizedClaimResponse:async(_user:string,_run:unknown,_lease:string,respond:(current:typeof run)=>Response)=>respond(run)},
    '@/lib/run-publications':{prepareRunPublication:async()=>({policy:{...defaultRunPolicy(),permissions:{...defaultRunPolicy().permissions,git_push:'allow'}}}),persistRunCompletion:async()=>{assert.equal(issueDenied,true);calls.push('rejectPublication')}},
    '@/lib/run-publication-result':{PublicationError:class extends Error {}},
    // No linked GitHub account in this fixture: the claim attaches no GitHub credential endpoint.
    '@/lib/github/repository-installation':{linkedGitHubAccountId:async()=>null},
    '@/lib/db':{db,pool:{},withDatabaseClient:async(_tx:unknown,fn:()=>Promise<unknown>)=>fn()},'@/lib/db/schema':{agentRuns:{},agents:{},deviceRepos:{}},
    '@/lib/device-link':{authenticateDevice:async()=>({userId:'owner',tokenId:'synthetic-device-token'}),ownedDevice:async()=>({enabled:true,kind:'local',protocolVersion:daemonProtocol.DAEMON_PROTOCOL_VERSION,harnesses:[{harness:'codex',installed:true,toolApproval:true}]}),ownedDeviceWithReport:async()=>({enabled:true,kind:'local',protocolVersion:daemonProtocol.DAEMON_PROTOCOL_VERSION,harnesses:[{harness:'codex',installed:true,toolApproval:true}]})},
    '@/lib/base-path':{withBasePath:(path:string)=>path},'@/lib/mcp/resource':{},
    '@/lib/mcp/worker':{issueRunToken:async()=>{calls.push('token');return {token:'synthetic-test-token'}}},
    '@/lib/run-leases':{failRunForDaemonUpgrade:async()=>false,failQueuedSubscriptionRuntime:async()=>{throw Error('A benchmark without subscriptions must not fail a subscription runtime')}},'@/lib/daemon-release':{daemonTooOld:()=>false},'@/lib/run-retry':{},
    '@/lib/thread-continuation':{continuationFollowUp:()=>null},
    '@/lib/run-completion-effects':{afterRunEnded:async()=>{calls.push('runEnded');return 0}},
    '@/lib/factory/checks':{isFactoryCheckRun:async()=>false},
    '@/lib/factory/profile-admission':{AgentProfileAdmissionError:class extends Error {}},
    '@/lib/factory/profile-native-session':{profileNativeSessionMatches:(before:{agentProfile?:unknown}|null|undefined,after:{agentProfile?:unknown}|null|undefined)=>{
      assertNoProfile(before);assertNoProfile(after);return true
    }},
    '@/lib/factory/runtime':{guardFactoryClaim:async()=>{calls.push('guard');if(stopped)throw new FactoryError('stopped');return {preserveQuestionWorktree:true}}},
    '@mikka/protocol/agent-policy':{defaultRunPolicy},
    '@/lib/computer/local-authority':{localComputerAuthority:async()=>null},
    '@/lib/computer/claim':{claimLocalRun:async(_pool:unknown,_runId:string,_deviceId:string,_lease:Date,_subscription:unknown,guard:(tx:object)=>Promise<boolean>,after:(tx:object)=>Promise<void>)=>{
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
    '@/lib/deployment-switches':{deploymentSwitch:(name:DeploymentSwitch)=>deploymentSwitch(name,fixtureEnv)},
    '@/lib/computer/native-run-binding':{},
    '@/lib/personal-policy':{sharedNativeBinding:async()=>null},
    '@/lib/secrets/flag':{byoE2BKeyEnabled:()=>false},
    '@/lib/secrets/runtime':{taskSecretInjection:async()=>({env:{},secretNames:[]}),remoteRepositoryRef:()=>null},
    '@/lib/personal-mailbox-config':{personalMailboxEnabled:()=>false},
    '@/lib/factory/questions/retry':{},'@mikka/protocol/skill':{SKILL_ARTIFACT_HEADER:'x-mikka-skill-artifacts'},
    '@/lib/self-improvement/contract':{ImprovementError},'@/lib/factory/contract':{FactoryError},
    '@/lib/self-improvement/server':{
      skillAssignments:{preflight:async(_user:string,_run:string,supportsArtifacts:boolean)=>{calls.push('preflight');assert.equal(supportsArtifacts,true);assert.equal(run.status,'queued')},recordClaim:async(_user:string,_device:string,_run:string,_lease:string,supportsArtifacts:boolean)=>{calls.push('receipt');assert.equal(supportsArtifacts,true);assert.equal(run.status,'preparing');return {skills:[],skillReceipt:{id:'receipt'}}}},
      claimBenchmarkAssignment:async()=>{calls.push('benchmark');assert.equal(run.status,'preparing');if(unavailable)throw new ImprovementError('runUnavailable');return benchmark},
    },
  }
  const source=await readFile(new URL('../../app/v1/devices/[deviceId]/runs/[runId]/claim/route.ts',import.meta.url),'utf8')
  const exports:Record<string,unknown>={}
  runInNewContext(transpileModule(source,{compilerOptions:{module:ModuleKind.CommonJS}}).outputText,
    {exports,require:(name:string)=>{if(!Object.hasOwn(modules,name))throw Error(`Unexpected import ${name}`);return modules[name]},Response,URL,Date,process:{env:fixtureEnv}})
  return {calls,admissionScopes,run,benchmark,post:exports.POST as (request:Request,context:{params:Promise<{deviceId:string;runId:string}>})=>Promise<Response>}
}

const claimRequest=()=>new Request('https://fixture.invalid/v1/claim',{headers:{[deviceProtocol.REPO_ORIGIN_HEADER]:'1','x-mikka-skill-artifacts':'1'}})

test('actual claim route resolves frozen benchmark exactly once after claim and receipt and overrides mutable config',async()=>{
  const {post,calls,admissionScopes,benchmark,run}=await routeFixture()
  const response=await post(claimRequest(),{params:Promise.resolve({deviceId:'device',runId:'run'})})
  assert.equal(response.status,200)
  const assignment=await response.json()
  assert.deepEqual(calls,['preflight','guard','claim','token','receipt','benchmark'])
  assert.deepEqual(admissionScopes,['bot-workspace','task-workspace'])
  assert.equal(assignment.verifyCommand,benchmark.verifyCommand)
  assert.equal(assignment.model,benchmark.model)
  assert.equal(assignment.remoteUrl,'https://github.com/mikka-ci/benchmark-claim.git')
  assert.equal(assignment.expectedRepoRemote,assignment.remoteUrl)
  assert.equal(assignment.policyRevision,'synthetic-current-policy')
  assert.deepEqual(assignment.benchmark,benchmark.benchmark)
  assert.deepEqual(assignment.policy,benchmark.policy)
  assert.equal(run.deviceTokenId,'synthetic-device-token')
})

test('actual claim route withholds all assignment bytes when frozen configuration becomes unavailable after claim',async()=>{
  const {post,calls,run}=await routeFixture(true)
  const response=await post(claimRequest(),{params:Promise.resolve({deviceId:'device',runId:'run'})})
  assert.equal(response.status,409)
  assert.deepEqual(await response.json(),{error:'runUnavailable'})
  assert.deepEqual(calls,['preflight','guard','claim','token','receipt','benchmark','block','listChanged','runEnded'])
  assert.equal(run.status,'failed')
})


test('actual claim route refuses a stopped Factory before receipt, benchmark or token issuance',async()=>{
  const {post,calls,run}=await routeFixture(false,true)
  const response=await post(claimRequest(),{params:Promise.resolve({deviceId:'device',runId:'run'})})
  assert.equal(response.status,409)
  assert.deepEqual(await response.json(),{error:'Run is no longer queued for this device.'})
  assert.deepEqual(calls,['preflight','guard'])
  assert.equal(run.status,'queued')
})

test('benchmark claim cannot bypass its task workspace model rule through the Bot namespace',async()=>{
  const {post,calls,admissionScopes,run}=await routeFixture(false,false,true)
  const response=await post(claimRequest(),{params:Promise.resolve({deviceId:'device',runId:'run'})})
  assert.equal(response.status,409)
  assert.deepEqual(await response.json(),{error:'modelRouteDenied'})
  assert.deepEqual(admissionScopes,['bot-workspace','task-workspace'])
  assert.deepEqual(calls,['preflight'])
  assert.equal(run.status,'queued')
})


test('task access denial withholds assignment and credentials before claim preparation',async()=>{
  const {post,calls,run}=await routeFixture(false,false,false,true)
  const response=await post(claimRequest(),{params:Promise.resolve({deviceId:'device',runId:'run'})})
  assert.equal(response.status,409)
  assert.deepEqual(calls,['rejectPublication','wakeScheduled'])
  assert.equal(run.status,'queued')
})
