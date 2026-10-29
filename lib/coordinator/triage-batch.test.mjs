// Retention-safe offline scheduling regression: only Node built-ins and the
// production type-stripped scheduler. No tsx/esbuild, filesystem fixture, DB,
// process kill, network, provider, resource creation or teardown callback.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runTriageBatch, TRIAGE_ATTEMPTS_PER_WAKE, TRIAGE_MODEL_CALLS_PER_WAKE } from './triage-batch.ts'

const receipt = Object.freeze({
  executionId:'synthetic-host-execution',providerGenerationId:'synthetic-provider-generation',
  modelId:'openai/gpt-6-luna-decisions',requestDigest:'a'.repeat(64),imageDigests:[],
  startedAt:'2026-10-28T22:00:00Z',completedAt:'2026-10-28T22:00:00Z',vision:'no-image-input',
})
const judgment = () => ({tier:'result',execution:receipt})
const event = id => ({id,kind:'run_report',lastTriageAttemptAt:null})
const pending = () => ({tier:null,execution:null})
function fixture(overrides={}) {
  const trace=[]
  const dependencies={
    claim:async item=>{trace.push(`claim:${item.id}`);return new Date('2026-10-28T22:00:00Z')},
    deliverUser:async item=>{trace.push(`user:${item.id}`);return true},
    classify:async item=>{trace.push(`model:${item.id}`);return judgment()},
    complete:async(item,attemptedAt,result)=>{assert.equal(result.execution,receipt);assert.equal(attemptedAt.toISOString(),'2026-10-28T22:00:00.000Z');trace.push(`complete:${item.id}`);return true},
    observe:(item,result,application)=>{assert.equal(result.execution,receipt);trace.push(`observed:${item.id}:${application}`)},
    ...overrides,
  }
  return {trace,dependencies}
}
test('the production scheduler claims before inference and records only a winning CAS',async()=>{
  const {trace,dependencies}=fixture()
  const result=await runTriageBatch([event('one')],dependencies,new AbortController().signal)
  assert.deepEqual(trace,['claim:one','model:one','observed:one:received','complete:one','observed:one:applied'])
  assert.deepEqual(result,{classified:['one'],pending:[],stale:[],unattempted:[]})
})
test('model failures stay pending after exactly the bounded attempts and never persist a tier',async()=>{
  let calls=0
  const {trace,dependencies}=fixture({classify:async()=>{calls++;throw Error('synthetic transport failure')}})
  const result=await runTriageBatch([event('unknown')],dependencies,new AbortController().signal)
  assert.equal(calls,TRIAGE_ATTEMPTS_PER_WAKE);assert.deepEqual(trace,['claim:unknown'])
  assert.deepEqual(result.pending,['unknown']);assert.deepEqual(result.classified,[])
})
test('a missing host receipt or invalid tier cannot become a persisted model result',async()=>{
  for(const value of [{tier:'result',execution:null},{tier:'result',execution:{}},{tier:'forged',execution:receipt}]){
    const {trace,dependencies}=fixture({classify:async()=>value})
    const result=await runTriageBatch([event('invalid')],dependencies,new AbortController().signal)
    assert.deepEqual(result.pending,['invalid']);assert.equal(trace[0],'claim:invalid');assert.equal(trace.some(step=>step.startsWith('complete:')),false)
  }
})
test('a cancelled wake does not invoke runtime models but still delivers actual user input',async()=>{
  const controller=new AbortController();controller.abort()
  const {trace,dependencies}=fixture()
  const result=await runTriageBatch([event('runtime'),{...event('human'),kind:'user_message'}],dependencies,controller.signal)
  assert.deepEqual(trace,['user:human']);assert.deepEqual(result.unattempted,['runtime']);assert.deepEqual(result.classified,['human'])
})
test('cancellation while the model is in flight cannot persist its late result',async()=>{
  const controller=new AbortController()
  const {trace,dependencies}=fixture({classify:async()=>{controller.abort();return judgment()}})
  const result=await runTriageBatch([event('late')],dependencies,controller.signal)
  assert.deepEqual(trace,['claim:late','observed:late:received']);assert.deepEqual(result.pending,['late'])
})
test('losing an attempt claim skips inference; losing completion preserves the stale outcome',async()=>{
  const claimed=fixture({claim:async()=>null})
  assert.deepEqual((await runTriageBatch([event('claimed')],claimed.dependencies,new AbortController().signal)).stale,['claimed'])
  assert.deepEqual(claimed.trace,[])
  const complete=fixture({complete:async()=>false})
  const result=await runTriageBatch([event('stale')],complete.dependencies,new AbortController().signal)
  assert.deepEqual(result.stale,['stale']);assert.deepEqual(result.classified,[])
  assert.deepEqual(complete.trace,['claim:stale','model:stale','observed:stale:received','observed:stale:stale'])
})
test('a slow first attempt does not prevent a later eligible event on the next wake',async()=>{
  const first=event('slow'),second=event('ready'),controller=new AbortController()
  const attempted=new Set()
  const firstWake=fixture({claim:async item=>{attempted.add(item.id);return new Date()},classify:async()=>{controller.abort();return pending()}})
  const before=await runTriageBatch([first,second],firstWake.dependencies,controller.signal)
  assert.deepEqual([...attempted],['slow']);assert.deepEqual(before.unattempted,['ready'])
  const secondWake=fixture({claim:async item=>attempted.has(item.id)?null:new Date('2026-10-28T22:00:00Z')})
  const after=await runTriageBatch([first,second],secondWake.dependencies,new AbortController().signal)
  assert.deepEqual(after.classified,['ready']);assert.deepEqual(after.stale,['slow'])
})

test('fast unavailable responses cannot consume an unbounded number of model requests',async()=>{
  let calls=0
  const {dependencies}=fixture({classify:async()=>{calls++;return pending()}})
  const result=await runTriageBatch(Array.from({length:50},(_,index)=>event(String(index))),dependencies,new AbortController().signal)
  assert.equal(calls,TRIAGE_MODEL_CALLS_PER_WAKE)
  assert.equal(result.pending.length,TRIAGE_MODEL_CALLS_PER_WAKE/TRIAGE_ATTEMPTS_PER_WAKE)
  assert.equal(result.pending.length+result.unattempted.length,50)
})

test('an uncertain database write is observed separately and never blindly retried',async()=>{
  const lost=Error('synthetic lost acknowledgment')
  const {trace,dependencies}=fixture({complete:async()=>{throw lost}})
  await assert.rejects(runTriageBatch([event('uncertain'),event('later')],dependencies,new AbortController().signal),error=>error===lost)
  assert.deepEqual(trace,['claim:uncertain','model:uncertain','observed:uncertain:received','observed:uncertain:write-unknown'])
})
