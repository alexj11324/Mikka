import test from 'node:test'
import assert from 'node:assert/strict'
import { aggregate, sha256, PRODUCER, extractRecords } from './aggregate.mjs'
const APP='a'.repeat(40), DEPLOY='dpl_fixture'
const run=(kind,index)=>'wrun_'+kind+'_'+index
const artifact=(value,extra={})=>{const text=JSON.stringify(value);return {...extra,text,sha256:sha256(text)}}
function wrapper(kind,phase,observation) {
  return {schemaVersion:1,phase:'alex-continuation',case:phase,fixtureKey:kind,
    applicationSha:APP,status:'observed',attempted:true,
    before:{build:APP,matches:true},after:{build:APP,matches:true},observation}
}
function input() {
  return {schemaVersion:1,expectedSha:APP,deploymentId:DEPLOY,producerSourceCommit:PRODUCER,phase:'cache',
    cacheReceipts:['haiku','luna'].map(kind=>artifact(wrapper(kind,'cache',{
      applicationSha:APP,status:'observed',turns:[1,2,3].map(index=>({index,status:'observed',
        messageSendAttempted:true,workflowRunId:run(kind,index),metrics:{firstTextMs:index===1?9000:3000}}))
    }),{kind})),stopKinds:[],stopReceipts:[],captures:[]}
}
function reviseReceipt(i,kind,mutate) {
  const n=i.cacheReceipts.findIndex(x=>x.kind===kind),w=JSON.parse(i.cacheReceipts[n].text)
  mutate(w);i.cacheReceipts[n]=artifact(w,{kind})
}
function capture(id,records,extra={}) {
  return artifact({records},{workflowRunId:id,applicationSha:APP,deploymentId:DEPLOY,
    since:'2026-11-07T19:00:00Z',until:'2026-11-07T19:01:00Z',complete:true,...extra})
}
function model(id,attempt=1,fields={}) {
  return {msg:'model_call_timing',workflowRunId:id,stepId:'step_call',attempt,firstTextMs:2200,...fields}
}
test('six fixed slots, exactly four warm slots, each must pass; fast averages cannot rescue one slow or failed slot',()=>{
  const i=input(),out=aggregate(i)
  assert.equal(out.cache.length,6);assert.equal(out.warmAcceptance.denominator,4);assert.equal(out.warmAcceptance.passed,true)
  reviseReceipt(i,'haiku',w=>{w.observation.turns[1].metrics.firstTextMs=3000.01})
  assert.equal(aggregate(i).warmAcceptance.passed,false)
  reviseReceipt(i,'haiku',w=>{w.observation.turns[1].metrics.firstTextMs=1;w.observation.turns[1].status='failed'})
  assert.equal(aggregate(i).warmAcceptance.passed,false)
  i.cacheReceipts=[]
  const missing=aggregate(i)
  assert.equal(missing.cache.length,6);assert.equal(missing.warmAcceptance.passed,false)
  assert.equal(missing.runtimeCompleteness,false)
})
test('version failures and unsent rows cannot become a passing warm sample',()=>{
  const i=input()
  reviseReceipt(i,'luna',w=>{w.after={build:'b'.repeat(40),matches:false}})
  assert.equal(aggregate(i).warmAcceptance.passed,false)
  reviseReceipt(i,'luna',w=>{w.after={build:APP,matches:true};w.observation.turns[2].messageSendAttempted=false})
  assert.equal(aggregate(i).warmAcceptance.passed,false)
})
test('preserve every retry and multiple usage records; duplicated events are annotated, never silently selected away',()=>{
  const i=input(),id=run('haiku',2)
  const failed=model(id,1,{interrupted:true,cacheReadTokens:null})
  i.captures=[capture(id,[failed,model(id,2,{cacheReadTokens:500}),model(id,2,{cacheReadTokens:700}),failed])]
  const rows=aggregate(i).cache[1].runtime.model
  assert.equal(rows.length,4)
  assert.deepEqual(rows.map(r=>r.attempt.value),[1,2,2,1])
  assert.equal(rows[0].interrupted.value,true)
  assert.equal(rows[1].cacheReadTokens.value,500);assert.equal(rows[2].cacheReadTokens.value,700)
  assert.equal(rows[3].duplicateOf,1)
})
test('missing, null, invalid, numeric zero, worker overflow and partial outcomes remain distinct; unknown contents do not escape',()=>{
  const i=input(),id=run('haiku',2)
  i.captures=[capture(id,[model(id,1,{
    firstTextMs:null,durationMs:'0',cacheReadTokens:0,
    rawCache:{read:{state:'missing',tokens:null},write:{state:'null',tokens:null},creation:{state:'number',tokens:0}},
    subscriptionStages:{version:1,firstIpcChunkMs:null,workers:[{
      ordinal:1,method:'prepare',outcome:'pending',identityMode:'unobserved',identityMs:'0',identityLoginCalls:1000001,
      goState:'missing',password:'DO_NOT_EXPORT'}],overflow:2},
    message:'DO_NOT_EXPORT'
  })])]
  const result=aggregate(i),row=result.cache[1].runtime.model[0]
  assert.equal(row.setupMs.state,'missing');assert.equal(row.firstTextMs.state,'null')
  assert.equal(row.durationMs.state,'invalid');assert.equal(row.cacheReadTokens.value,0)
  assert.deepEqual(row.rawCache,{read:{state:'missing'},write:{state:'null'},creation:{state:'number',tokens:0}})
  assert.equal(row.subscriptionStages.overflow.value,2)
  assert.equal(row.subscriptionStages.workers[0].outcome.value,'pending')
  assert.equal(row.subscriptionStages.workers[0].identityLoginCalls.state,'invalid')
  assert.equal(row.subscriptionStages.workers[0].go.state,'missing')
  assert.equal(JSON.stringify(result).includes('DO_NOT_EXPORT'),false)
})
test('one capture per exact run; wrong or unbound run, byte hash and deployment fail closed',()=>{
  const id=run('haiku',2),c=capture(id,[model(id)]),i=input()
  i.captures=[c,c]
  assert.throws(()=>aggregate(i),/duplicate_or_invalid_capture_run/)
  i.captures=[capture(id,[model(id+'_wrong')])]
  assert.throws(()=>aggregate(i),/record_run_scope_mismatch/)
  i.captures=[capture('wrun_unknown',[model('wrun_unknown')])]
  assert.throws(()=>aggregate(i),/unbound_capture_run/)
  i.captures=[{...c,sha256:'0'.repeat(64)}]
  assert.throws(()=>aggregate(i),/artifact_sha_mismatch/)
  i.captures=[{...c,deploymentId:'dpl_wrong'}]
  assert.throws(()=>aggregate(i),/capture_source_scope/)
})
test('a run reused by two receipt slots is ambiguous; no duplication of one run into two successes',()=>{
  const i=input()
  reviseReceipt(i,'haiku',w=>{w.observation.turns[2].workflowRunId=run('haiku',2)})
  assert.throws(()=>aggregate(i),/ambiguous_run_across_slots/)
})
test('projection association requires the full scoped stream id; multiple HTTP observations stay distinct',()=>{
  const i=input(),id=run('haiku',2)
  const p={msg:'coordinator_stream_projection_timing',streamId:id+':0',firstRawTextMs:1,firstEmittedTextMs:1000,committedMs:1500}
  i.captures=[capture(id,[{requestId:'request-a',message:p},{requestId:'request-b',message:p}])]
  const result=aggregate(i).cache[1].runtime
  assert.equal(result.projection.length,2)
  assert.equal(result.projectionAssociation,'multiple_or_unidentified_http')
  assert.equal(result.projection[0].firstEmittedTextMs.value,1000)
  assert.equal(result.projection[0].emissionDelayMs,undefined)
  i.captures=[capture(id,[{...p,streamId:id+':0:other'}])]
  assert.throws(()=>aggregate(i),/record_run_scope_mismatch/)
  i.captures=[capture(id,[{...p,streamId:id+'other:0'}])]
  assert.throws(()=>aggregate(i),/record_run_scope_mismatch/)
})
test('only explicit JSON envelopes are decoded; unsupported Markdown never invents values or completeness',()=>{
  const id=run('haiku',2),m=model(id),text='Runtime logs\n\n\`\`\`json\n'+JSON.stringify(m)+'\n\`\`\`'
  assert.equal(extractRecords(text).records.length,1)
  const envelope={structuredContent:{content:text},content:[{type:'text',text}]}
  assert.equal(extractRecords(JSON.stringify(envelope)).records.length,1)
  const i=input(),raw='| Message | Duration |\n| unknown format | 0 |'
  i.captures=[{...capture(id,[]),text:raw,sha256:sha256(raw)}]
  const result=aggregate(i).cache[1].runtime
  assert.equal(result.parseState,'unsupported_or_empty');assert.equal(result.complete,false)
})
test('two ordinary Stop receipts have a separate denominator and never affect the four warm target slots',()=>{
  const i=input()
  i.stopKinds=['haiku','luna']
  i.stopReceipts=i.stopKinds.map(kind=>artifact(wrapper(kind,'ordinary-stop',{
    applicationSha:APP,status:'failed',workflowRunId:run(kind,'stop'),streamId:run(kind,'stop')+':0',
    metrics:{firstTextMs:7000},stop:{requested:true,acknowledged:true},
    textConsistency:{matches:false,liveCharacters:5,persistedCharacters:3}
  }),{kind}))
  const result=aggregate(i)
  assert.equal(result.cache.length,6);assert.equal(result.ordinaryStop.length,2)
  assert.equal(result.warmAcceptance.passed,true)
  assert.equal(result.ordinaryStop[0].textConsistency.matches.value,false)
})

test('one valid record never hides a damaged JSONL candidate, another fence, or an unclosed fence',()=>{
  const id=run('haiku',2),valid=JSON.stringify(model(id)),bad='{"msg":"model_call_timing","workflowRunId":'
  const cases=[
    valid+'\n'+bad,
    '\`\`\`json\n'+valid+'\n\`\`\`\n'+bad,
    '\`\`\`json\n'+bad+'\n\`\`\`\n\`\`\`json\n'+valid+'\n\`\`\`',
    '\`\`\`jsonl\n'+valid+'\n'+bad+'\n\`\`\`',
    '\`\`\`json\n'+valid,
    valid+'\n[{"msg":'
  ]
  for(const raw of cases) {
    const parsed=extractRecords(raw)
    assert.equal(parsed.records.length,1)
    assert.ok(parsed.unsupported>=1)
    const i=input()
    i.captures=[{...capture(id,[]),text:raw,sha256:sha256(raw)}]
    const runtime=aggregate(i).cache[1].runtime
    assert.equal(runtime.model.length,1)
    assert.equal(runtime.complete,false)
  }
})
test('retain producer prefix and closed model metadata without leaking invalid hashes or arbitrary strings',()=>{
  const id=run('haiku',2),i=input()
  const secret='PRIVATE_BODY_NOT_A_PREFIX'
  const rows=[
    model(id,1,{route:'subscription',model:'claude-haiku-5-5',finishReason:'stop',
      prefix:{tools:'012345abcdef',system:['abcdef123456','000000000000']}}),
    model(id,2,{route:secret,model:secret,finishReason:secret,
      prefix:{tools:secret,system:['abcdef123456',secret,'a'.repeat(64),null]}}),
    model(id,3,{route:null,model:null,finishReason:null,prefix:null}),
    model(id,4,{}),
    model(id,5,{prefix:{system:secret}}),
    model(id,6,{prefix:{tools:null}})
  ]
  i.captures=[capture(id,rows)]
  const out=aggregate(i),r=out.cache[1].runtime.model
  assert.equal(r.length,6)
  assert.equal(r[0].route.value,'subscription')
  assert.equal(r[0].model.value,'claude-haiku-5-5')
  assert.equal(r[0].finishReason.value,'stop')
  assert.equal(r[0].prefix.tools.value,'012345abcdef')
  assert.deepEqual(r[0].prefix.system.values.map(x=>x.value),['abcdef123456','000000000000'])
  assert.equal(r[1].route.state,'invalid')
  assert.equal(r[1].model.state,'invalid')
  assert.equal(r[1].finishReason.state,'invalid')
  assert.equal(r[1].prefix.tools.state,'invalid')
  assert.deepEqual(r[1].prefix.system.values.map(x=>x.state),['value','invalid','invalid','null'])
  assert.equal(r[2].prefix.state,'null');assert.equal(r[3].prefix.state,'missing')
  assert.equal(r[4].prefix.tools.state,'missing');assert.equal(r[4].prefix.system.state,'invalid')
  assert.equal(r[5].prefix.tools.state,'null');assert.equal(r[5].prefix.system.state,'missing')
  assert.equal(JSON.stringify(out).includes(secret),false)
  assert.equal(JSON.stringify(out).includes('a'.repeat(64)),false)
})
