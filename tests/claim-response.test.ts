import assert from 'node:assert/strict'
import test from 'node:test'
import { POST } from '../app/v1/devices/[deviceId]/runs/[runId]/claim/route'

function fixture() {
  const probe = {
    run: { id:'run',userId:'member',issueId:'issue',agentId:'agent',deviceId:'device',deviceRepoId:'repo',status:'queued',prompt:'private claim instructions',kind:'implement',retryOf:null,stopRequestedAt:null as Date|null,leaseExpiresAt:null as Date|null },
    issue: {id:'issue',userId:'owner',scope:'workspace',content:{type:'doc'}},
    agent: {id:'agent',harness:'codex'}, repo: {id:'repo',baseBranch:'main'},
    memberAllowed:true,tokenError:false,locks:[] as string[],transactions:0,transactionErrors:[] as Error[],beforeToken:undefined as (()=>Promise<void>)|undefined,
  }
  Object.assign(globalThis,{claimResponseProbe:probe})
  return probe
}
const claim = () => POST(new Request('http://127.0.0.1/claim',{method:'POST'}),{params:Promise.resolve({deviceId:'device',runId:'run'})})

test('claim committed before retirement cannot return its old prompt when token issuance fails',async()=>{
  const probe=fixture()
  probe.beforeToken=async()=>{
    probe.issue.scope='personal';probe.memberAllowed=false
    probe.run.status='cancelled';probe.run.stopRequestedAt=new Date();probe.run.leaseExpiresAt=null
    probe.tokenError=true
  }
  const response=await claim()
  assert.equal(response.status,409)
  const body=await response.text()
  for(const privateField of ['private claim instructions','prompt','subscriptionBinding','synthetic-only'])assert.equal(body.includes(privateField),false)
  assert.deepEqual(probe.locks,['issues','agent_runs'])
})

test('token provisioning failure alone still permits a currently authorized claim',async()=>{
  const probe=fixture();probe.tokenError=true
  const response=await claim()
  assert.equal(response.status,200)
  const body=await response.json()
  assert.equal(body.prompt,probe.run.prompt);assert.equal(body.mcp,undefined)
  assert.deepEqual(probe.locks,['issues','agent_runs'])
})

test('a successful token does not override membership revocation or a superseded claim lease',async()=>{
  for(const change of ['membership','lease']){
    const probe=fixture()
    probe.beforeToken=async()=>{
      if(change==='membership')probe.memberAllowed=false
      else probe.run.leaseExpiresAt=new Date(Date.now()+600_000)
    }
    const response=await claim()
    assert.equal(response.status,409)
    assert.equal((await response.text()).includes('prompt'),false)
  }
})

test('authorized response uses the locked run rather than the initial snapshot',async()=>{
  const probe=fixture()
  probe.beforeToken=async()=>{probe.run.prompt='current authorized instructions'}
  const response=await claim()
  assert.equal(response.status,200)
  assert.equal((await response.json()).prompt,'current authorized instructions')
})

test('response authorization retries only rolled-back serialization or deadlock failures, with a bound',async()=>{
  for(const code of ['40P01','40001']){
    const probe=fixture()
    probe.transactionErrors.push(new Error('wrapped DB failure',{cause:{code}}))
    assert.equal((await claim()).status,200)
    assert.equal(probe.transactions,2)
  }
  const exhausted=fixture(),deadlock=Object.assign(new Error('synthetic deadlock'),{code:'40P01'})
  exhausted.transactionErrors.push(deadlock,deadlock,deadlock)
  await assert.rejects(claim(),error=>error===deadlock)
  assert.equal(exhausted.transactions,3)
  const unexpected=fixture(),unknown=new Error('unexpected transaction failure')
  unexpected.transactionErrors.push(unknown)
  await assert.rejects(claim(),error=>error===unknown)
  assert.equal(unexpected.transactions,1)
})
