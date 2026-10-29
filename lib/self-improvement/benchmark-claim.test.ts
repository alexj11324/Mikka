import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import { transpileModule, ModuleKind } from 'typescript'

// Execute the actual route in memory, with its database/auth boundaries replaced.
async function routeFixture(unavailable=false,stopped=false) {
  const calls:string[]=[]
  const run={id:'run',userId:'owner',issueId:'issue',agentId:'agent',deviceRepoId:'repo',deviceId:'device',status:'queued',kind:'implement',baseBranch:'frozen-sha',prompt:'frozen task',attempt:1}
  const agent={id:'agent',harness:'codex'},repo={id:'repo',verifyCommand:'mutable-repo-command'}
  const selections=[run,agent,repo]
  class ImprovementError extends Error {constructor(public code:string){super(code)}}
  class FactoryError extends Error {}
  const db={select:()=>({from:()=>({where:()=>({limit:async()=>[selections.shift()]})})}),update:()=>({set:(values:object)=>({where:async()=>{calls.push('block');Object.assign(run,values)}})})}
  const benchmark={harness:'codex',model:'actual-observed-model',verifyCommand:'git diff --exit-code HEAD --',policy:{readOnly:true},benchmark:{caseId:'case',benchmarkDigest:'digest',sourceCommit:'frozen-sha'}}
  const modules:Record<string,unknown>={
    'next/server':{NextResponse:class extends Response {static json(body:unknown,init?:ResponseInit){return Response.json(body,init)}}},
    'drizzle-orm':{and:(...args:unknown[])=>args,eq:(...args:unknown[])=>args,isNull:(value:unknown)=>value},
    '@mikka/protocol/device':{RUN_LEASE_MS:60000},
    '@/lib/db':{db,pool:{}},'@/lib/db/schema':{agentRuns:{},agents:{},deviceRepos:{}},
    '@/lib/device-link':{authenticateDevice:async()=>({userId:'owner'}),ownedDevice:async()=>({enabled:true})},
    '@/lib/base-path':{withBasePath:(path:string)=>path},'@/lib/mcp/resource':{},
    '@/lib/mcp/worker':{issueRunToken:async()=>{calls.push('token');return {token:'synthetic-test-token'}}},
    '@/lib/run-leases':{},'@/lib/run-retry':{},
    '@/lib/factory/checks':{isFactoryCheckRun:async()=>false},
    '@/lib/factory/server':{guardExecutionRun:async()=>{calls.push('guard');if(stopped)throw new FactoryError('stopped')}},
    '@/lib/computer/claim':{claimLocalRun:async(_pool:unknown,_runId:string,_deviceId:string,_lease:Date,_subscription:unknown,guard:(tx:object)=>Promise<void>)=>{await guard({});calls.push('claim');run.status='preparing';return 'claimed'}},
    '@/lib/subscription-runtime':{},
    '@/lib/personal-mailbox-config':{personalMailboxEnabled:()=>false},
    '@/lib/factory/questions/retry':{},'@mikka/protocol/skill':{SKILL_ARTIFACT_HEADER:'x-mikka-skill-artifacts'},
    '@/lib/self-improvement/contract':{ImprovementError},'@/lib/factory/contract':{FactoryError},
    '@/lib/self-improvement/server':{
      skillAssignments:{preflight:async()=>{calls.push('preflight');assert.equal(run.status,'queued')},recordClaim:async()=>{calls.push('receipt');assert.equal(run.status,'preparing');return {skills:[],skillReceipt:{id:'receipt'}}}},
      claimBenchmarkAssignment:async()=>{calls.push('benchmark');assert.equal(run.status,'preparing');if(unavailable)throw new ImprovementError('runUnavailable');return benchmark},
    },
  }
  const source=await readFile(new URL('../../app/v1/devices/[deviceId]/runs/[runId]/claim/route.ts',import.meta.url),'utf8')
  const exports:Record<string,unknown>={}
  runInNewContext(transpileModule(source,{compilerOptions:{module:ModuleKind.CommonJS}}).outputText,
    {exports,require:(name:string)=>{if(!Object.hasOwn(modules,name))throw Error(`Unexpected import ${name}`);return modules[name]},Response,URL,Date,process:{env:{MIKKA_BYOS_ENABLED:'0'}}})
  return {calls,run,benchmark,post:exports.POST as (request:Request,context:{params:Promise<{deviceId:string;runId:string}>})=>Promise<Response>}
}

test('actual claim route resolves frozen benchmark exactly once after claim and receipt and overrides mutable config',async()=>{
  const {post,calls,benchmark}=await routeFixture()
  const response=await post(new Request('https://fixture.invalid/v1/claim'),{params:Promise.resolve({deviceId:'device',runId:'run'})})
  assert.equal(response.status,200)
  const assignment=await response.json()
  assert.deepEqual(calls,['preflight','guard','claim','receipt','benchmark','token'])
  assert.equal(assignment.verifyCommand,benchmark.verifyCommand)
  assert.equal(assignment.model,benchmark.model)
  assert.deepEqual(assignment.benchmark,benchmark.benchmark)
  assert.deepEqual(assignment.policy,{readOnly:true})
})

test('actual claim route withholds all assignment bytes when frozen configuration becomes unavailable after claim',async()=>{
  const {post,calls,run}=await routeFixture(true)
  const response=await post(new Request('https://fixture.invalid/v1/claim'),{params:Promise.resolve({deviceId:'device',runId:'run'})})
  assert.equal(response.status,409)
  assert.deepEqual(await response.json(),{error:'runUnavailable'})
  assert.deepEqual(calls,['preflight','guard','claim','receipt','benchmark','block'])
  assert.equal(run.status,'failed')
})


test('actual claim route refuses a stopped Factory before receipt, benchmark or token issuance',async()=>{
  const {post,calls,run}=await routeFixture(false,true)
  const response=await post(new Request('https://fixture.invalid/v1/claim'),{params:Promise.resolve({deviceId:'device',runId:'run'})})
  assert.equal(response.status,409)
  assert.deepEqual(await response.json(),{error:'Execution binding is unavailable or stale.'})
  assert.deepEqual(calls,['preflight','guard'])
  assert.equal(run.status,'queued')
})
