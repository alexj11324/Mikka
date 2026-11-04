import assert from 'node:assert/strict'
import test from 'node:test'
import {runPolicyPreflight} from './group-policy-preflight.mjs'
const id = suffix => `00000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`
const receipt = { executionId: 'synthetic-execution', providerGenerationId: 'synthetic-generation', modelId: 'openai/gpt-6-luna-decisions',
  requestDigest: 'a'.repeat(64), startedAt: '2026-11-03T00:00:00Z', completedAt: '2026-11-03T00:00:00.100Z', imageDigests: [], vision: 'no-image-input' }
const replayContract = { caseIds: Array.from({ length: 12 }, (_, i) => `case-${i}`), datasetDigest: 'b'.repeat(64),
  baselinePolicy: 'group-route-v0', candidatePolicy: 'group-contribution-v3', comparisonVersion: 'group-decision-comparison-v2' }
const replay = () => {
  let serial = 100
  const rows = (policyVersion, count) => replayContract.caseIds.map(caseId => {
    const decisions = Array.from({ length: count }, (_, index) => {
      serial++
      return { id: id(serial), policyVersion, phase: count === 2 && index === 0 ? 'intent' : 'responder', index, status: 'complete', failure: null,
        receipt: { ...receipt, executionId: `execution-${serial}`, providerGenerationId: `generation-${serial}` }, decisionCostUsd: null }
    })
    return { schemaVersion: 1, caseId, policyVersion, datasetDigest: replayContract.datasetDigest, inputDigest: 'c'.repeat(64),
      evidenceKind: 'actual-decision-inference', status: 'complete', receipt: decisions[0].receipt,
      route: { by: 'model', action: 'reply', reason: 'useful_answer', responders: [id(10)] },
      projection: { intervention: true, selectedResponderCount: 1, delegationOperation: null, reportTiming: null }, decisionProtocol: 'group-sequential-v1',
      decisions, failureReason: null, decisionCalls: { attempted: count, receipted: count, unreceipted: 0 },
      decisionCost: { knownUsd: 0, knownCalls: 0, unknownCalls: count, omittedCalls: 0 }, decisionCostUsd: null,
      costScope: 'routing-decision-chain', executionPerformed: false, policyChanged: false }
  })
  return refreshReplaySummaries({ status: 'comparison_ready', comparisonVersion: replayContract.comparisonVersion, collectionComplete: true, qualityAccepted: true,
    baseline: rows(replayContract.baselinePolicy, 1), candidate: rows(replayContract.candidatePolicy, 2),
    comparison: { baselineClassifiable: true, decisionReviewReady: true, requiresHumanReview: true, executionAcceptanceRequired: true } })
}

function refreshReplaySummaries(value) {
  for (const label of ['baseline', 'candidate']) {
    const rows = value[label], measured = rows.filter(row => row.status === 'complete').length
    const abstentions = rows.filter(row => row.status === 'invalid_decision' && row.failureReason === 'uncertain').length
    const steps = rows.flatMap(row => row.decisions), receipted = steps.filter(step => step.receipt).length
    const known = steps.filter(step => step.receipt && typeof step.decisionCostUsd === 'number')
    const knownUsd = known.reduce((total, step) => total + step.decisionCostUsd, 0), unknownCalls = steps.length - known.length
    value.comparison[label] = { cases: 12, logicalReplays: rows.length, observed: rows.length, observationCoverage: rows.length / 12,
      measured, coverage: measured / 12, accuracyDenominator: 12, actionAccuracy: measured / 12, responderAccuracy: measured / 12,
      abstentions, unresolvedPositive: 0, unresolvedNegative: abstentions, intentionalNonIntervention: 0, missingCaseIds: [],
      falseIntervention: 0, missedIntervention: 0, failures: rows.filter(row => row.status !== 'complete').map(row => ({ caseId: row.caseId, reason: 'invalid_decision' })),
      decisionCalls: { attempted: steps.length, receipted, unreceipted: steps.length - receipted },
      cost: { scope: 'routing-decision-chain', knownUsd, knownCalls: known.length, unknownCalls, omittedCalls: 0,
        completeTotalUsd: unknownCalls ? null : knownUsd, knownObservations: known.length, unknownObservations: unknownCalls },
      decisionLatency: { scope: 'provider-request', samples: receipted, p50Ms: 100, p95Ms: 100 }, runtimeCasesExcluded: [] }
  }
  return value
}
function abstain(row, reason = 'uncertain') {
  row.status = 'invalid_decision'; row.failureReason = reason; row.route = null; row.projection = null
  row.decisions.at(-1).status = 'invalid_decision'; row.decisions.at(-1).failure = reason
  return row
}

const OWNER='cL1NXe1mr7WuIS8xWhU37v0p7kNoUMY3',WORKSPACE='0f877068-66a0-4893-8801-9a14eb3116b3',GROUP='f197747b-64af-42c3-9ac4-8ff335610324'
const email='alexjiang20232024+mikka-smoke-owner@gmail.com'
const env={GROUP_REPLAY_REVISION:'a'.repeat(40),GROUP_REPLAY_DEPLOYMENT:'dpl_fixture',SMOKE_OWNER_EMAIL:email,SMOKE_OWNER_PASSWORD:'synthetic-password-only',VERCEL_DEPLOY_TOKEN:'synthetic-vercel-only'}
function scenario({wrongOwner=false,foreignGroup=false,memberLeft=false,logoutUnknown=false,drift=false,expire=false,mutate=value=>value,unexpectedPath=false}={}){
  const calls=[],counts={replay:0,logout:0,version:0};let elapsed=0
  const fetchImpl=async(url,options={})=>{
    const path=new URL(url).pathname;calls.push(path)
    assert.equal(options.redirect,'error')
    if(new URL(url).origin==='https://api.vercel.com') {
      assert.equal(options.method,'GET');assert.equal(options.headers.authorization,'Bearer synthetic-vercel-only');assert.equal(options.headers.cookie,undefined)
      if(path.startsWith('/v4/aliases/'))return Response.json({alias:'app.aspectlylabs.com',projectId:'prj_VdNz3P0FmuRbZKeI40hbCqwR0NVH',deploymentId:'dpl_fixture'})
      if(path.startsWith('/v13/deployments/'))return Response.json({id:'dpl_fixture',projectId:'prj_VdNz3P0FmuRbZKeI40hbCqwR0NVH',target:'production',readyState:'READY',meta:{githubCommitSha:env.GROUP_REPLAY_REVISION}})
      throw Error('unexpected_vercel_path')
    }
    if(path.endsWith('/api/version')){counts.version++;return Response.json({build:drift&&counts.version>=3?'b'.repeat(40):env.GROUP_REPLAY_REVISION})}
    if(path.endsWith('/sign-in/email')){assert.deepEqual(JSON.parse(options.body),{email,password:env.SMOKE_OWNER_PASSWORD});return Response.json({}, {headers:{'set-cookie':'synthetic-session=value; HttpOnly'}})}
    assert.equal(options.headers.cookie,'synthetic-session=value')
    if(path.endsWith('/get-session'))return Response.json({user:{id:wrongOwner?'foreign-owner':OWNER,email},session:{userId:wrongOwner?'foreign-owner':OWNER,token:'PRIVATE_SESSION'}})
    if(path.endsWith('/sign-out')){counts.logout++;if(logoutUnknown)throw Error('PRIVATE logout body');return Response.json({success:true})}
    if(path.endsWith('/api/conversations'))return Response.json({conversations:[{id:GROUP,workspaceId:WORKSPACE,createdBy:foreignGroup?'foreign-owner':OWNER,kind:'group',title:'PRIVATE_GROUP'}]})
    if(path.endsWith('/members'))return Response.json({members:[{id:OWNER,memberType:'user',leftAt:memberLeft?'2026-01-01':null,private:'PRIVATE_MEMBER'}]})
    throw Error('unexpected_mock_path')
  }
  const dependencies={livePolicy:'group-contribution-v1',contract:replayContract,runReplay:async({env:received,fetchImpl:transport})=>{
    counts.replay++;assert.equal(received.GROUP_REPLAY_COOKIE,'synthetic-session=value')
    assert.equal(received.GROUP_REPLAY_CONVERSATION,GROUP);assert.equal(received.GROUP_REPLAY_TOKEN,undefined)
    if(unexpectedPath)await transport('https://app.aspectlylabs.com/mikka/api/bots',{method:'POST',body:'{}'})
    if(expire)elapsed=8*60_000+1
    return mutate(replay())
  }}
  return {calls,counts,run:(extra={})=>runPolicyPreflight({env,dependencies,fetchImpl,now:()=>elapsed,verifySource:()=>env.GROUP_REPLAY_REVISION,...extra})}
}
test('release, origin, account and staged policy contracts fail before normal login',async()=>{
  for(const extra of [
    {env:{...env,GROUP_REPLAY_REVISION:'invalid'}},
    {env:{...env,GROUP_REPLAY_ORIGIN:'https://foreign.invalid'}},
    {env:{...env,SMOKE_OWNER_EMAIL:'other@example.invalid'}},
    {verifySource:()=> 'b'.repeat(40)},
    {dependencies:{livePolicy:'group-contribution-v2',contract:replayContract}},
    {dependencies:{livePolicy:'group-contribution-v3',contract:replayContract}},
    {dependencies:{livePolicy:'group-contribution-v1',contract:{...replayContract,candidatePolicy:'group-contribution-v2'}}},
    {dependencies:{livePolicy:'group-contribution-v1',contract:{...replayContract,comparisonVersion:'group-decision-comparison-v3'}}},
  ]){const f=scenario();await assert.rejects(f.run(extra));assert.equal(f.calls.length,0)}
})
test('normal owner proof precedes the fixed synthetic replay and one acknowledged signout',async()=>{
  const f=scenario(),result=await f.run()
  assert.equal(result.status,'passed');assert.equal(result.scopeConfirmed,true)
  assert.equal(result.livePolicy,'group-contribution-v1');assert.equal(result.candidatePolicy,'group-contribution-v3')
  assert.equal(result.accounting.logicalReplays,24);assert.equal(result.accounting.candidateCompleted,12)
  assert.equal(result.policyChanged,false);assert.equal(result.executionPerformed,false);assert.equal(result.productionAccepted,false)
  assert.equal(result.releasePins.before.deploymentId,env.GROUP_REPLAY_DEPLOYMENT);assert.equal(result.releasePins.after.revision,env.GROUP_REPLAY_REVISION)
  assert.deepEqual(result.modelScope,{expectedDecisionModel:'openai/gpt-6-luna-decisions',observedDecisionModels:['openai/gpt-6-luna-decisions'],workerModel:null,workerExecutionPerformed:false})
  assert.equal(f.counts.replay,1);assert.equal(f.counts.logout,1)
  assert.ok(f.calls.indexOf('/mikka/api/conversations/'+GROUP+'/members')>=0)
  assert.doesNotMatch(JSON.stringify(result),/PRIVATE|synthetic-session|synthetic-password-only|synthetic-vercel-only/)
})
test('a different owner, foreign fixture or departed member prevents all paid replay',async()=>{
  for(const option of [{wrongOwner:true},{foreignGroup:true},{memberLeft:true}]){
    const f=scenario(option),result=await f.run()
    assert.equal(result.status,'failed');assert.equal(f.counts.replay,0);assert.equal(f.counts.logout,1)
    assert.equal(result.session.logoutAcknowledged,true)
  }
})
test('real candidate uncertainty stays a failed comparison with original receipts and no retry',async()=>{
  const f=scenario({mutate:value=>{abstain(value.candidate[0]);return refreshReplaySummaries(value)}}),result=await f.run()
  assert.equal(result.status,'failed');assert.equal(result.error,'preflight_candidate_rejected')
  assert.equal(result.accounting.logicalReplays,24);assert.equal(result.accounting.candidateCompleted,11)
  assert.equal(result.replay.candidate[0].failureReason,'uncertain')
  assert.equal(f.counts.replay,1);assert.equal(f.counts.logout,1)
})
test('unknown signout cannot become success and is never repeated',async()=>{
  const f=scenario({logoutUnknown:true}),result=await f.run()
  assert.equal(result.status,'failed');assert.equal(result.accounting.qualityAccepted,true)
  assert.equal(result.session.logoutAcknowledged,false);assert.equal(f.counts.logout,1)
  assert.doesNotMatch(JSON.stringify(result),/PRIVATE/)
})
test('deployment drift or deadline after comparison retains evidence and still signs out once',async()=>{
  for(const option of [{drift:true},{expire:true}]){
    const f=scenario(option),result=await f.run()
    assert.equal(result.status,'failed');assert.equal(result.accounting.qualityAccepted,true)
    assert.equal(f.counts.replay,1);assert.equal(f.counts.logout,1);assert.equal(result.session.logoutAcknowledged,true)
  }
})
test('the replay transport cannot create Bots, tasks or change policy',async()=>{
  const f=scenario({unexpectedPath:true}),result=await f.run()
  assert.equal(result.status,'failed');assert.equal(result.error,'preflight_request_scope')
  assert.equal(f.counts.logout,1);assert.ok(!f.calls.some(path=>path.endsWith('/api/bots')))
})
