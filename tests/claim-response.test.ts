import assert from 'node:assert/strict'
import test from 'node:test'
import { defaultRunPolicy } from '@mikka/protocol/agent-policy'
import { DAEMON_PROTOCOL_VERSION } from '@mikka/protocol/daemon'
import { REPO_ORIGIN_HEADER } from '@mikka/protocol/device'
import { normalizeRepository } from '@mikka/protocol/repository'
import { SKILL_ARTIFACT_HEADER } from '@mikka/protocol/skill'
import { POST } from '../app/v1/devices/[deviceId]/runs/[runId]/claim/route'

function fixture() {
  const repository = normalizeRepository('https://github.com/synthetic/claim-fixture.git')
  const probe = {
    run: { id:'run',userId:'member',issueId:'issue',agentId:'agent',deviceId:'device',deviceRepoId:'repo',status:'queued',prompt:'private claim instructions',kind:'implement',retryOf:null as string|null,stopReason:null as string|null,stopRequestedAt:null as Date|null,leaseExpiresAt:null as Date|null },
    issue: {id:'issue',userId:'owner',scope:'workspace',content:{type:'doc'}},
    device: {id:'device',ownerId:'member',enabled:true,kind:'local',protocolVersion:DAEMON_PROTOCOL_VERSION,harnesses:[{harness:'codex',installed:true,toolApproval:true}]},
    agent: {id:'agent',userId:'member',deviceId:'device',harness:'codex'},
    repo: {id:'repo',userId:'member',deviceId:'device',baseBranch:'main',repoPath:repository.key,remoteUrl:repository.remoteUrl},
    cliPolicy: {revision:'a'.repeat(64),policy:defaultRunPolicy()},
    publication: {pushBranch:'synthetic-claim-branch',policy:defaultRunPolicy()},
    preparation:[] as string[],
    memberAllowed:true,questionRetryBlocked:false,tokenError:false,locks:[] as string[],transactions:0,transactionErrors:[] as Error[],beforeToken:undefined as (()=>Promise<void>)|undefined,
  }
  Object.assign(globalThis,{claimResponseProbe:probe})
  return probe
}
async function claim(probe: ReturnType<typeof fixture>, preparation = ['skill-preflight','policy','publication','claim','skill-claim','benchmark-claim','token','settings']) {
  try { return await POST(new Request('http://127.0.0.1/claim',{method:'POST',headers:{[REPO_ORIGIN_HEADER]:'1',[SKILL_ARTIFACT_HEADER]:'1'}}),{params:Promise.resolve({deviceId:'device',runId:'run'})}) }
  finally {
    // Trace the intended gate: an unrelated failed prerequisite must not
    // masquerade as a successful lineage, scope or lease rejection.
    assert.deepEqual(probe.preparation,preparation)
  }
}

test('historical question retries stop before publication, leases or worker credentials',async()=>{
  const probe=fixture();probe.run.retryOf='strict-question-parent';probe.questionRetryBlocked=true
  const response=await claim(probe,['question-retry'])
  assert.equal(response.status,409)
  assert.equal(probe.run.status,'failed');assert.equal(probe.run.stopReason,'blocked')
  assert.equal(probe.run.leaseExpiresAt,null)
  const body=await response.json()
  for(const field of ['prompt','mcp','skills','skillReceipt'])assert.equal(Object.hasOwn(body,field),false)
})

test('ordinary retries retain the normal claim path after question lineage validation',async()=>{
  const probe=fixture();probe.run.retryOf='ordinary-parent'
  const response=await claim(probe,['question-retry','skill-preflight','policy','publication','claim','skill-claim','benchmark-claim','token','checkpoint','settings'])
  assert.equal(response.status,200)
  assert.equal(probe.run.status,'preparing')
  assert.equal((await response.json()).continuesRunId,'ordinary-parent')
})

test('claim committed before retirement cannot return its old prompt when token issuance fails',async()=>{
  const probe=fixture()
  probe.beforeToken=async()=>{
    probe.issue.scope='personal';probe.memberAllowed=false
    probe.run.status='cancelled';probe.run.stopRequestedAt=new Date();probe.run.leaseExpiresAt=null
    probe.tokenError=true
  }
  const response=await claim(probe)
  assert.equal(response.status,409)
  const body=await response.text()
  for(const privateField of ['private claim instructions','prompt','subscriptionBinding','synthetic-only'])assert.equal(body.includes(privateField),false)
  assert.deepEqual(probe.locks,['issues','agent_runs'])
})

test('token provisioning failure alone still permits a currently authorized claim',async()=>{
  const probe=fixture();probe.tokenError=true
  const response=await claim(probe)
  assert.equal(response.status,200)
  const body=await response.json()
  assert.equal(body.prompt,probe.run.prompt);assert.equal(body.mcp,undefined)
  assert.equal(body.policyRevision,probe.cliPolicy.revision)
  assert.equal(body.pushBranch,probe.publication.pushBranch)
  assert.deepEqual(probe.locks,['issues','agent_runs'])
})

test('a successful token does not override membership revocation or a superseded claim lease',async()=>{
  for(const change of ['membership','lease']){
    const probe=fixture()
    probe.beforeToken=async()=>{
      if(change==='membership')probe.memberAllowed=false
      else probe.run.leaseExpiresAt=new Date(Date.now()+600_000)
    }
    const response=await claim(probe)
    assert.equal(response.status,409)
    assert.equal((await response.text()).includes('prompt'),false)
  }
})

test('authorized response uses the locked run rather than the initial snapshot',async()=>{
  const probe=fixture()
  probe.beforeToken=async()=>{probe.run.prompt='current authorized instructions'}
  const response=await claim(probe)
  assert.equal(response.status,200)
  assert.equal((await response.json()).prompt,'current authorized instructions')
})

test('an owner STOP during token preparation fences the response even while its lease remains live',async()=>{
  const probe=fixture()
  probe.beforeToken=async()=>{probe.run.stopRequestedAt=new Date()}
  const response=await claim(probe)
  assert.equal(response.status,409)
  const body=await response.text()
  for(const field of ['private claim instructions','prompt','synthetic-only'])assert.equal(body.includes(field),false)
  assert.equal(probe.run.status,'preparing')
  assert.ok(probe.run.leaseExpiresAt)
  assert.deepEqual(probe.locks,['issues','agent_runs'])
})

test('response authorization retries only rolled-back serialization or deadlock failures, with a bound',async()=>{
  for(const code of ['40P01','40001']){
    const probe=fixture()
    probe.transactionErrors.push(new Error('wrapped DB failure',{cause:{code}}))
    assert.equal((await claim(probe)).status,200)
    assert.equal(probe.transactions,2)
  }
  const exhausted=fixture(),deadlock=Object.assign(new Error('synthetic deadlock'),{code:'40P01'})
  exhausted.transactionErrors.push(deadlock,deadlock,deadlock)
  await assert.rejects(claim(exhausted),error=>error===deadlock)
  assert.equal(exhausted.transactions,3)
  const unexpected=fixture(),unknown=new Error('unexpected transaction failure')
  unexpected.transactionErrors.push(unknown)
  await assert.rejects(claim(unexpected),error=>error===unknown)
  assert.equal(unexpected.transactions,1)
})

test('4e3: a cloud claim reads the task secrets (workspace + repo scope) before the claim',async()=>{
  const saved={...process.env}
  Object.assign(process.env,{MIKKA_CLOUD_COMPUTER_TASKS:'1',MIKKA_BYOS_ENABLED:'1',MIKKA_BYO_E2B_KEY:'1'})
  try{
    const probe=fixture()
    Object.assign(probe,{caller:{userId:'member',scopeDeviceId:'device',scopeWorkspaceId:'ws'},cloud:{subscription:{id:'binding',workspaceId:'ws'}}})
    Object.assign(probe.device,{kind:'cloud',harnesses:[{harness:'codex',installed:true,toolApproval:true,computerBroker:true,subscriptionBroker:true}]})
    const response=await claim(probe,['skill-preflight','policy','secrets','claim','skill-claim','benchmark-claim','token'])
    assert.equal(response.status,200)
  } finally { for(const key of ['MIKKA_CLOUD_COMPUTER_TASKS','MIKKA_BYOS_ENABLED','MIKKA_BYO_E2B_KEY'])if(saved[key]===undefined)delete process.env[key];else process.env[key]=saved[key] }
})
