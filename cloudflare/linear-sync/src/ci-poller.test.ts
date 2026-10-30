import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { pollActiveCi, type CiPollAdapter, type CiPollLease, type CiPollResult } from './ci-poller'
import type { Observation } from '../../../lib/github/ci/observation'
import type { Snapshot } from '../../../lib/github/ci/snapshot'

test('multiple workflows and missing required checks create one final callback, not intermediate callbacks', async () => {
  let now=1_000_000, observation:Observation|null=null, head='a'.repeat(40), completed=0, retry=0
  let snapshot:Snapshot = { checks:[{id:'1',name:'build',status:'in_progress',conclusion:null}], statuses:[], workflows:[{id:'1',attempt:1,name:'build',status:'in_progress',conclusion:null}] }
  const outputs:CiPollResult[]=[]
  const adapter:CiPollAdapter = {
    async lease() { return [{id:'fixture',generation:'1',attempt:0,observation}] },
    async authorize(){return {async check(){},async close(){}}},
    async read() { return {head,open:true,snapshot} },
    async readFresh() {return {head,open:true,snapshot}},
    async pending(_lease,state) { observation=state },
    async close() { throw Error('not closed') },
    async complete(_lease,state,result) { completed++; outputs.push(result); observation={...state,deliveredFingerprint:result.fingerprint} },
    async retry() { retry++ },
  }
  const poll = () => pollActiveCi(adapter,{now:()=>now,random:()=>0,deadline:now+30000})
  await poll(); assert.equal(completed,0)
  snapshot={checks:[{id:'1',name:'build',status:'completed',conclusion:'success'}],statuses:[],requiredChecks:[{context:'test',appId:null}],workflows:[{id:'1',attempt:1,name:'build',status:'completed',conclusion:'success'},{id:'2',attempt:1,name:'test',status:'in_progress',conclusion:null}]}
  await poll(); assert.equal(completed,0)
  snapshot={...snapshot,checks:[...snapshot.checks,{id:'2',name:'test',status:'completed',conclusion:'failure'}],workflows:[{id:'1',attempt:1,name:'build',status:'completed',conclusion:'success'},{id:'2',attempt:1,name:'test',status:'completed',conclusion:'failure'}]}
  await poll(); assert.equal(completed,0)
  now+=120_000; await poll(); assert.equal(completed,1); assert.equal(outputs[0].outcome,'failure')
  snapshot={...snapshot,checks:snapshot.checks.map(c=>({...c,conclusion:'success'})),workflows:snapshot.workflows!.map(w=>({...w,attempt:2,conclusion:'success'}))}
  now+=120_000; await poll(); now+=120_000; await poll(); assert.equal(completed,1)
  head='b'.repeat(40); await poll(); now+=120_000; await poll(); assert.equal(completed,2)
  assert.equal(outputs[1].outcome,'success'); assert.equal(retry,0)
})

test('failed provider reads back off and do not emit a final result', async () => {
  let due=0, code=''
  const lease:CiPollLease={id:'fixture',generation:'1',attempt:2,observation:null}
  const adapter:CiPollAdapter={async lease(){return [lease]},async authorize(){return {async check(){},async close(){}}},async read(){throw Error('offline')},async readFresh(){throw Error('unexpected')},async pending(){throw Error('unexpected')},async close(){throw Error('unexpected')},async complete(){throw Error('unexpected')},async retry(_lease,next,reason){due=next;code=reason}}
  const result=await pollActiveCi(adapter,{now:()=>1000,random:()=>0,deadline:31000})
  assert.equal(result.failed,1); assert.equal(result.completed,0); assert.ok(due>1000); assert.equal(code,'unavailable')
})

test('fresh branch rules can block a result that appeared complete from cache',async()=>{
  const head='a'.repeat(40),snapshot:Snapshot={checks:[{id:'1',name:'build',status:'completed',conclusion:'success'}],statuses:[]}
  const {summarize}=await import('../../../lib/github/ci/snapshot')
  const result=summarize(snapshot);if(result.kind!=='complete')throw Error('fixture')
  let completed=0,pending=0
  const adapter:CiPollAdapter={async lease(){return [{id:'x',generation:'1',attempt:0,observation:{head,fingerprint:result.fingerprint,firstSeenAt:1,deliveredFingerprint:null}}]},async authorize(){return {async check(){},async close(){}}},async read(){return {head,open:true,snapshot}},async readFresh(){return {head,open:true,snapshot:{...snapshot,requiredChecks:[{context:'new-required',appId:null}]}}},async pending(){pending++},async close(){throw Error('unexpected')},async complete(){completed++},async retry(){throw Error('unexpected')}}
  await pollActiveCi(adapter,{now:()=>200000,deadline:230000,random:()=>0})
  assert.equal(completed,0);assert.equal(pending,1)
})
