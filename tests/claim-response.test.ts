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
    run: { id:'run',userId:'member',issueId:'issue',agentId:'agent',deviceId:'device',deviceRepoId:'repo',status:'queued',prompt:'private claim instructions',kind:'implement',retryOf:null,stopRequestedAt:null as Date|null,leaseExpiresAt:null as Date|null },
    issue: {id:'issue',userId:'owner',scope:'workspace',content:{type:'doc'}},
    device: {id:'device',ownerId:'member',enabled:true,kind:'local',protocolVersion:DAEMON_PROTOCOL_VERSION,harnesses:[{harness:'codex',installed:true,toolApproval:true}]},
    agent: {id:'agent',userId:'member',deviceId:'device',harness:'codex'},
    repo: {id:'repo',userId:'member',deviceId:'device',baseBranch:'main',repoPath:repository.key,remoteUrl:repository.remoteUrl},
    cliPolicy: {revision:'a'.repeat(64),policy:defaultRunPolicy()},
    publication: {pushBranch:'synthetic-claim-branch',policy:defaultRunPolicy()},
    preparation:[] as string[],
    memberAllowed:true,tokenError:false,locks:[] as string[],transactions:0,transactionErrors:[] as Error[],beforeToken:undefined as (()=>Promise<void>)|undefined,
  }
  Object.assign(globalThis,{claimResponseProbe:probe})
  return probe
}
async function claim(probe: ReturnType<typeof fixture>) {
  try { return await POST(new Request('http://127.0.0.1/claim',{method:'POST',headers:{[REPO_ORIGIN_HEADER]:'1',[SKILL_ARTIFACT_HEADER]:'1'}}),{params:Promise.resolve({deviceId:'device',runId:'run'})}) }
  finally {
    // Every scenario must reach the response fence, including its 409 paths.
    // A failed prerequisite must not masquerade as successful revocation.
    assert.deepEqual(probe.preparation,['skill-preflight','policy','publication','claim','skill-claim','benchmark-claim','token','settings'])
  }
}

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
