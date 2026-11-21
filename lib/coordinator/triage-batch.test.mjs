// Retention-safe offline scheduling regression: only Node built-ins and the
// production type-stripped scheduler. No tsx/esbuild, filesystem fixture, DB,
// process kill, network, provider, resource creation or teardown callback.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runTriageBatch, triageDecisionReceipt, TRIAGE_ATTEMPTS_PER_WAKE, TRIAGE_MODEL_CALLS_PER_WAKE } from './triage-batch.ts'

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

test('every failed classification records the last closed reason against its claimed attempt',async()=>{
  const failures=[]
  let calls=0
  const {dependencies}=fixture({
    classify:async()=>{if(calls++===0)return {...pending(),errorReason:'litellm_not_configured'};throw Error('PRIVATE_PROVIDER_TEXT')},
    recordFailure:async(item,attemptedAt,reason)=>failures.push({id:item.id,at:attemptedAt.toISOString(),reason}),
  })
  const outcome=await runTriageBatch([event('pending')],dependencies,new AbortController().signal)
  assert.deepEqual(failures,[
    {id:'pending',at:'2026-10-28T22:00:00.000Z',reason:'litellm_not_configured'},
    {id:'pending',at:'2026-10-28T22:00:00.000Z',reason:'classification_failed'},
  ])
  assert.deepEqual(outcome.pending,['pending'])
})

const failedRun=()=>({...event('failed'),kind:'run_finished',runId:'run',observedRun:{id:'run',status:'failed',finishedAt:'2026-10-28T21:59:00Z'}})
test('an undelivered host-verified failed completion falls back after one failed model attempt',async()=>{
  for(const throws of [false,true]){
    let calls=0
    const receipts=[]
    const {dependencies}=fixture({
      deliverCompletion:async()=>false,
      classify:async()=>{calls++;if(throws)throw Error('PRIVATE_FAILURE');return {...pending(),errorReason:'billing_refused'}},
      complete:async(item,at,choice)=>{receipts.push(triageDecisionReceipt(item,at,choice));return true},
    })
    const outcome=await runTriageBatch([failedRun()],dependencies,new AbortController().signal)
    assert.equal(calls,1)
    assert.deepEqual(outcome.classified,['failed']);assert.deepEqual(outcome.pending,[])
    assert.deepEqual(receipts,[{version:1,eventId:'failed',eventKind:'run_finished',attemptedAt:'2026-10-28T22:00:00.000Z',
      chosenTier:'result',observedRun:failedRun().observedRun,method:'rule',reason:'failed_run_completion',lastErrorReason:throws?'classification_failed':'billing_refused'}])
    assert.equal('execution' in receipts[0],false)
  }
})

test('unverified, mismatched, unfinished and non-failed runs never get the rule fallback',async()=>{
  for(const item of [
    {...failedRun(),observedRun:null,payload:{status:'failed'}},
    {...failedRun(),observedRun:{...failedRun().observedRun,id:'other'}},
    {...failedRun(),observedRun:{...failedRun().observedRun,finishedAt:null}},
    ...['running','succeeded','cancelled','stopped'].map(status=>({...failedRun(),observedRun:{...failedRun().observedRun,status}})),
    {...failedRun(),kind:'run_report'},
  ]){
    const {dependencies}=fixture({deliverCompletion:async()=>false,classify:async()=>pending()})
    const outcome=await runTriageBatch([item],dependencies,new AbortController().signal)
    assert.deepEqual(outcome.pending,[item.id]);assert.deepEqual(outcome.classified,[])
  }
})

test('successful delivery and successful model judgments retain their existing behavior',async()=>{
  const delivered=fixture({deliverCompletion:async()=>true,classify:async()=>assert.fail('no model call')})
  assert.deepEqual((await runTriageBatch([failedRun()],delivered.dependencies,new AbortController().signal)).classified,['failed'])
  assert.deepEqual(delivered.trace,[])
  const modeled=fixture({deliverCompletion:async()=>false})
  assert.deepEqual((await runTriageBatch([failedRun()],modeled.dependencies,new AbortController().signal)).classified,['failed'])
  assert.ok(modeled.trace.includes('complete:failed'))
})

test('rule fallback survives an attempted model timeout but respects pre-attempt cancellation and CAS',async()=>{
  const controller=new AbortController()
  const timedOut=fixture({deliverCompletion:async()=>false,classify:async()=>{controller.abort();return pending()},complete:async(item,at,choice)=>{assert.equal(choice.method,'rule');return true}})
  assert.deepEqual((await runTriageBatch([failedRun()],timedOut.dependencies,controller.signal)).classified,['failed'])
  const cancelled=fixture({deliverCompletion:async()=>false,classify:async()=>assert.fail('no attempt')})
  assert.deepEqual((await runTriageBatch([failedRun()],cancelled.dependencies,controller.signal)).unattempted,['failed'])
  assert.deepEqual(cancelled.trace,[])
  const stale=fixture({deliverCompletion:async()=>false,classify:async()=>pending(),complete:async()=>false})
  assert.deepEqual((await runTriageBatch([failedRun()],stale.dependencies,new AbortController().signal)).stale,['failed'])
  const lost=Error('lost acknowledgment')
  const uncertain=fixture({deliverCompletion:async()=>false,classify:async()=>pending(),complete:async()=>{throw lost}})
  await assert.rejects(runTriageBatch([failedRun()],uncertain.dependencies,new AbortController().signal),error=>error===lost)
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

test('source-verified CI result reaches Eve without spending a model triage call', async () => {
  const { trace, dependencies } = fixture({
    deliverCiSuite: async item => { trace.push(`ci:${item.id}`); return item.id === 'verified' },
  })
  const outcome = await runTriageBatch(
    [event('verified'), event('untrusted')],
    dependencies,
    new AbortController().signal,
  )
  assert.deepEqual(trace, [
    'ci:verified',
    'ci:untrusted', 'claim:untrusted', 'model:untrusted',
    'observed:untrusted:received', 'complete:untrusted', 'observed:untrusted:applied',
  ])
  assert.deepEqual(outcome.classified, ['verified', 'untrusted'])
})
