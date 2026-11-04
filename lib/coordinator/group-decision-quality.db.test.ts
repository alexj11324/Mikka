import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { Pool } from 'pg'
import { disposableDatabase } from '../../tests/helpers/e2e-target.mjs'
import { handleGroupDecisionQuality } from './group-decision-feedback'
import { initializeGroupDecisionTrace, recordGroupDecisionRoute, recordGroupDecisionSteps, recordGroupTraceEvent, finishGroupDecisionTrace } from './group-decision-trace'
import { DECISION_MODEL } from './decision'
import type { DecisionExecution, invokeDecision } from './decide'
import { handleGroupDecisionReplay } from './group-decision-replay-api'
import { hostedBillingScope } from '@/lib/abuse/context'
import { GROUP_BASELINE_VERSION, GROUP_POLICY_VERSION, GROUP_PREVIOUS_POLICY_VERSION, type GroupPolicyVersion } from './group-decision-policy'
import { createGroupJudgment } from './group-judgment'
import { GroupJudgmentPendingError } from './group-correction'
import { overrideDeploymentSwitch } from '../deployment-switches'

const target = disposableDatabase() ? process.env.E2E_DATABASE_URL : undefined
test('PG: scoped decision traces, exact event counting, human feedback, revoked memberships and privacy', { skip: !target }, async t => {
  const admin = new Pool({ connectionString: target })
  const schema = `decision_quality_${randomUUID().replaceAll('-', '')}`
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: target, options: `-c search_path=${schema}` })
  t.after(async () => { await pool.end(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end() })
  for (const name of ['20261023213851_group_conversations.sql','20261029043634_group_turns.sql','20261031153511_group_bot_members.sql','20261103220300_group_decision_quality.sql']) await pool.query(await readFile(new URL(`../../drizzle/${name}`, import.meta.url), 'utf8'))
  await pool.query('CREATE TABLE hosted_usage ("generationId" text,model text,state text,"costMicroUsd" bigint)')
  await pool.query('CREATE TABLE message_reactions ("messageId" uuid,"userId" text,emoji text,"createdAt" timestamptz DEFAULT now())')
  const group = randomUUID(), foreign = randomUUID(), workspace = randomUUID(), message = randomUUID(), foreignMessage = randomUUID(), member = randomUUID()
  for (const id of [group, foreign]) await pool.query(`INSERT INTO conversations (id,"workspaceId",kind,title,"createdBy") VALUES ($1,$2,'group','Synthetic decision fixture','owner')`, [id, workspace])
  await pool.query(`INSERT INTO conversation_members ("conversationId","memberType","memberId",role) VALUES ($1,'user','owner','owner'),($1,'bot',$2,'member')`, [group, member])
  for (const [id, conversationId] of [[message, group], [foreignMessage, foreign]]) {
    await pool.query(`INSERT INTO conversation_messages (id,"conversationId",position,"authorType","authorId",body) VALUES ($1,$2,1,'user','owner','private fixture content')`, [id, conversationId])
    await pool.query('INSERT INTO group_turns ("messageId","conversationId","userId") VALUES ($1,$2,\'owner\')', [id, conversationId])
  }
  const client = await pool.connect()
  try {
    await initializeGroupDecisionTrace(client, message, [{ id: member, name: 'UI', description: 'public role', memberType: 'bot' }], [])
    await recordGroupDecisionRoute(client, message, { by: 'mention', responders: [member] })
    const event = { id: 'generation-1', type: 'generate' as const, memberId: member }
    await recordGroupTraceEvent(client, message, event); await recordGroupTraceEvent(client, message, event)
    await finishGroupDecisionTrace(client, message, 'complete')
  } finally { client.release() }
  let authorized = true
  const directory = async (id: string, userId: string) => authorized && id === workspace && userId === 'owner'
  const req = { userId: 'owner', conversationId: group, method: 'GET', origin: 'http://localhost', host: 'localhost' }
  const read = await handleGroupDecisionQuality(pool, directory, req)
  assert.equal(read.status, 200)
  assert.ok(!JSON.stringify(read.body).includes('private fixture content'))
  const turns = (read.body as { turns: { trace: { events: unknown[] }; decisionCostUsd: number | null }[] }).turns
  assert.equal(turns[0].trace.events.length, 1); assert.equal(turns[0].decisionCostUsd, null)
  assert.equal((read.body as {costScope:string}).costScope,'routing-decision-chain')
  // Only the exact provider generation/model and settled ledger row count.
  // This is a synthetic receipt fixture, not evidence of a real provider call.
  const receipt:DecisionExecution={executionId:randomUUID(),modelId:DECISION_MODEL,providerGenerationId:'fixture-generation',startedAt:'2026-11-03T00:00:00.000Z',completedAt:'2026-11-03T00:00:00.100Z',requestDigest:'a'.repeat(64),imageDigests:[],vision:'no-image-input'}
  await recordGroupDecisionRoute(pool,message,{by:'model',action:'reply',responders:[member],execution:receipt})
  await pool.query(`INSERT INTO hosted_usage VALUES ('fixture-generation',$1,'settled',1250),('fixture-generation','another-model','settled',99000),('unsettled-generation',$1,'unknown',99000),('unrelated-generation',$1,'settled',99000)`,[DECISION_MODEL])
  const billed=await handleGroupDecisionQuality(pool,directory,req)
  assert.equal((billed.body as {turns:{decisionCostUsd:number|null}[]}).turns[0].decisionCostUsd,0.00125)
  let replayCalls=0
  const replayReq={...req,method:'POST',body:JSON.stringify({caseId:'small-talk',policyVersion:GROUP_BASELINE_VERSION})}
  const invoke:typeof invokeDecision=async(_purpose,_input,questions)=>{
    replayCalls++;assert.deepEqual(hostedBillingScope.getStore(),{workspaceId:workspace,ownerId:'owner'});assert.equal(questions.length,1)
    const name=questions[0].name
    const execution={...receipt,executionId:`replay-${replayCalls}`,providerGenerationId:`fixture-replay-${replayCalls}`}
    await pool.query(`INSERT INTO hosted_usage VALUES ($1,$2,'settled',$3)`,[execution.providerGenerationId,DECISION_MODEL,replayCalls===1?500:750])
    return {execution,answers:new Map([[name,{name,type:'choice' as const,choice:name==='responder_0'?'00000000-0000-4000-8000-000000000001':'end'}]])}
  }
  const replay=await handleGroupDecisionReplay(pool,directory,replayReq,invoke)
  assert.equal(replay.status,200);assert.equal(replayCalls,2)
  assert.equal((replay.body as {decisionCostUsd:number}).decisionCostUsd,0.00125)
  assert.equal((replay.body as {executionPerformed:boolean}).executionPerformed,false)
  assert.ok(!JSON.stringify(replay.body).includes('private fixture content'))
  assert.equal((await pool.query('SELECT count(*)::int n FROM conversation_messages')).rows[0].n,2,'replay does not post group messages')
  assert.equal((await pool.query('SELECT count(*)::int n FROM group_turns')).rows[0].n,2,'replay does not enqueue work')
  for(const [overrides,status] of [[{userId:null},401],[{conversationId:foreign},404],[{origin:'https://foreign.invalid'},403],[{method:'GET'},405],
    [{body:JSON.stringify({caseId:'small-talk',policyVersion:GROUP_POLICY_VERSION,prompt:'private override'})},422],
    [{body:JSON.stringify({caseId:'decision-outage',policyVersion:GROUP_POLICY_VERSION})},422]] as const) {
    assert.equal((await handleGroupDecisionReplay(pool,directory,{...replayReq,...overrides},invoke)).status,status)
  }
  assert.equal(replayCalls,2,'denied requests must not incur provider calls')
  authorized=false
  assert.equal((await handleGroupDecisionReplay(pool,directory,replayReq,invoke)).status,404)
  authorized=true
  const unavailable=await handleGroupDecisionReplay(pool,directory,replayReq,async()=>null)
  assert.equal(unavailable.status,503);assert.equal((unavailable.body as {receipt:unknown}).receipt,null)
  // Failed, paid phases survive a retry; a NULL component never disappears
  // inside SQL sum, and repeated trace persistence is idempotent.
  const failedMessage=randomUUID()
  await pool.query(`INSERT INTO conversation_messages (id,"conversationId",position,"authorType","authorId",body) VALUES ($1,$2,100,'user','owner','private retry fixture')`,[failedMessage,group])
  await pool.query(`INSERT INTO group_turns ("messageId","conversationId","userId") VALUES ($1,$2,'owner')`,[failedMessage,group])
  const first={policyVersion:GROUP_PREVIOUS_POLICY_VERSION,id:randomUUID(),phase:'intent' as const,index:0,status:'complete' as const,failure:null,receipt:{...receipt,executionId:randomUUID(),providerGenerationId:'partial-first'}}
  const second={policyVersion:GROUP_PREVIOUS_POLICY_VERSION,id:randomUUID(),phase:'responder' as const,index:1,status:'invalid_decision' as const,failure:'uncertain' as const,receipt:{...receipt,executionId:randomUUID(),providerGenerationId:'partial-second'}}
  await initializeGroupDecisionTrace(pool,failedMessage,[{id:member,name:'UI',description:'public'}],[])
  await recordGroupDecisionSteps(pool,failedMessage,[first,second],'uncertain')
  await recordGroupDecisionSteps(pool,failedMessage,[first,second],'uncertain')
  await finishGroupDecisionTrace(pool,failedMessage,'blocked')
  await pool.query(`INSERT INTO hosted_usage VALUES ('partial-first',$1,'settled',138),('partial-second',$1,'settled',20),('partial-second',$1,'settled',NULL)`,[DECISION_MODEL])
  const partial=(await handleGroupDecisionQuality(pool,directory,req)).body as any
  const partialTurn=partial.turns.find((turn:any)=>turn.messageId===failedMessage)
  assert.equal(partialTurn.trace.decisions.length,2);assert.equal(partialTurn.decisionCost.knownUsd,0.000138)
  assert.equal(partialTurn.decisionCost.knownCalls,1);assert.equal(partialTurn.decisionCost.unknownCalls,1);assert.equal(partialTurn.decisionCostUsd,null)
  await initializeGroupDecisionTrace(pool,failedMessage,[{id:member,name:'UI',description:'public'}],[])
  const recovery={...first,policyVersion:GROUP_POLICY_VERSION,id:randomUUID(),receipt:{...receipt,executionId:randomUUID(),providerGenerationId:'partial-recovery'}}
  await recordGroupDecisionRoute(pool,failedMessage,{by:'model',action:'observe',responders:[],execution:recovery.receipt,decisions:[recovery]})
  await finishGroupDecisionTrace(pool,failedMessage,'complete')
  await pool.query(`INSERT INTO hosted_usage VALUES ('partial-recovery',$1,'settled',100)`,[DECISION_MODEL])
  const recovered=((await handleGroupDecisionQuality(pool,directory,req)).body as any).turns.find((turn:any)=>turn.messageId===failedMessage)
  assert.equal(recovered.trace.decisions.length,3);assert.equal(recovered.trace.decisions[1].status,'invalid_decision')
  assert.deepEqual(recovered.trace.decisions.map((step:any)=>step.policyVersion),[GROUP_PREVIOUS_POLICY_VERSION,GROUP_PREVIOUS_POLICY_VERSION,GROUP_POLICY_VERSION])
  assert.equal(recovered.decisionCost.knownCalls,2);assert.equal(recovered.decisionCost.unknownCalls,1);assert.equal(recovered.decisionCostUsd,null)
  assert.equal(recovered.trace.execution.providerGenerationId,'partial-recovery')
  for(let attempt=0;attempt<17;attempt++) {
    const steps=Array.from({length:4},(_,index)=>({...first,id:randomUUID(),index,receipt:{...receipt,executionId:randomUUID(),providerGenerationId:`retained-${attempt}-${index}`}}))
    await recordGroupDecisionSteps(pool,failedMessage,steps)
  }
  const bounded=(await pool.query('SELECT trace FROM group_turns WHERE "messageId"=$1',[failedMessage])).rows[0].trace
  assert.equal(bounded.decisions.length,64);assert.equal(bounded.decisionsOmitted,7)
  const limited=((await handleGroupDecisionQuality(pool,directory,req)).body as any).turns.find((turn:any)=>turn.messageId===failedMessage)
  assert.equal(limited.decisionCost.omittedCalls,7);assert.equal(limited.decisionCostUsd,null)
  await t.test('live rollback freezes each routing attempt and retains failed candidate receipts across a baseline retry',async()=>{
    const policyMessage=randomUUID()
    await pool.query(`INSERT INTO conversation_messages (id,"conversationId",position,"authorType","authorId",body) VALUES ($1,$2,101,'user','owner','private policy fixture')`,[policyMessage,group])
    await pool.query(`INSERT INTO group_turns ("messageId","conversationId","userId") VALUES ($1,$2,'owner')`,[policyMessage,group])
    const policyMembers=[{id:member,name:'UI',description:'private role fixture'}]
    const readTrace=async()=>(await pool.query('SELECT trace FROM group_turns WHERE "messageId"=$1',[policyMessage])).rows[0].trace
    let calls=0
    const fakeProvider:typeof invokeDecision=async(_purpose,input,questions)=>{
      calls++
      assert.ok(typeof input!=='string');assert.equal(questions.length,1)
      const expected=calls<=2?GROUP_POLICY_VERSION:GROUP_BASELINE_VERSION
      assert.equal(JSON.parse(input.text).policyVersion,expected)
      assert.equal((await readTrace()).policyVersion,expected,'the chosen version is persisted before the provider boundary')
      if(calls===1)overrideDeploymentSwitch('groupContribution',false)
      if(calls===3)overrideDeploymentSwitch('groupContribution',true)
      const name=questions[0].name
      const value=calls===1?'reply_useful_answer':calls===2?'uncertain':member
      return {answers:new Map([[name,{name,type:'choice' as const,choice:value}]]),execution:{...receipt,executionId:randomUUID(),providerGenerationId:`policy-fixture-${calls}`}}
    }
    const judgment=createGroupJudgment(fakeProvider)
    const retain=async(steps:Parameters<typeof recordGroupDecisionSteps>[2],version?:GroupPolicyVersion)=>{
      await recordGroupDecisionSteps(pool,policyMessage,steps,undefined,version)
    }
    try {
      overrideDeploymentSwitch('groupContribution',false)
      await initializeGroupDecisionTrace(pool,policyMessage,policyMembers,[])
      assert.equal((await readTrace()).policyVersion,GROUP_BASELINE_VERSION)
      overrideDeploymentSwitch('groupContribution',true)
      let failedJudgment:GroupJudgmentPendingError|undefined
      await assert.rejects(judgment.route({text:'private policy fixture',mentions:[]},policyMembers,null,[],retain),(error:unknown)=>{
        assert.ok(error instanceof GroupJudgmentPendingError)
        failedJudgment=error
        assert.equal(error.decisionFailure,'uncertain')
        return true
      })
      assert.ok(failedJudgment)
      await recordGroupDecisionSteps(pool,policyMessage,failedJudgment.decisions,failedJudgment.decisionFailure)
      const failed=await readTrace()
      assert.equal(failed.policyVersion,GROUP_POLICY_VERSION)
      assert.deepEqual(failed.decisions.map((step:any)=>step.policyVersion),[GROUP_POLICY_VERSION,GROUP_POLICY_VERSION])
      assert.equal(failed.decisions[1].status,'invalid_decision')
      await initializeGroupDecisionTrace(pool,policyMessage,policyMembers,[])
      const baseline=await judgment.route({text:'private retry fixture',mentions:[]},policyMembers,null,[],retain)
      await recordGroupDecisionRoute(pool,policyMessage,baseline)
      const recovered=await readTrace()
      assert.equal(calls,3);assert.equal(recovered.policyVersion,GROUP_BASELINE_VERSION)
      assert.deepEqual(recovered.decisions.map((step:any)=>step.policyVersion),[GROUP_POLICY_VERSION,GROUP_POLICY_VERSION,GROUP_BASELINE_VERSION])
      assert.equal(new Set(recovered.decisions.map((step:any)=>step.receipt.providerGenerationId)).size,3)
      assert.equal(recovered.execution.providerGenerationId,'policy-fixture-3')
      assert.ok(!JSON.stringify(recovered).includes('private policy fixture'))
      assert.ok(!JSON.stringify(recovered).includes('private role fixture'))
    } finally { overrideDeploymentSwitch('groupContribution',undefined) }
  })
  const body = JSON.stringify({ messageId: message, kind: 'wrong_member', targetId: member })
  for (let attempt = 0; attempt < 2; attempt++) assert.equal((await handleGroupDecisionQuality(pool, directory, { ...req, method: 'POST', body })).status, 201)
  assert.equal((await pool.query('SELECT count(*)::int n FROM group_decision_feedback')).rows[0].n, 1)
  assert.equal((await pool.query('SELECT source FROM group_decision_feedback')).rows[0].source, 'human_explicit')
  const reply = randomUUID()
  await pool.query(`INSERT INTO conversation_messages (id,"conversationId",position,"authorType","authorId",body,"replyToId") VALUES ($1,$2,2,'bot',$3,'Private reply fixture',$4)`, [reply, group, member, message])
  await pool.query(`INSERT INTO message_reactions ("messageId","userId",emoji) VALUES ($1,'owner','👎')`, [reply])
  const withReaction = await handleGroupDecisionQuality(pool, directory, req)
  assert.ok(JSON.stringify(withReaction.body).includes('human_reaction'))
  assert.ok(JSON.stringify(withReaction.body).includes('reaction_negative'))
  assert.ok(!JSON.stringify(withReaction.body).includes('Private reply fixture'))
  assert.equal((withReaction.body as { feedbackIsGroundTruth: boolean }).feedbackIsGroundTruth, false)
  assert.equal((await handleGroupDecisionQuality(pool, directory, { ...req, method: 'POST', body: JSON.stringify({ messageId: foreignMessage, kind: 'unhelpful' }) })).status, 404)
  assert.equal((await handleGroupDecisionQuality(pool, directory, { ...req, method: 'POST', body: JSON.stringify({ messageId: message, kind: 'helpful', source: 'agent_evaluation' }) })).status, 422)
  assert.equal((await handleGroupDecisionQuality(pool, directory, { ...req, origin: 'https://foreign.invalid' })).status, 403)
  assert.equal((await handleGroupDecisionQuality(pool, directory, { ...req, userId: null })).status, 401)
  authorized = false
  assert.equal((await handleGroupDecisionQuality(pool, directory, req)).status, 404)
  authorized = true
  await pool.query('UPDATE conversation_members SET "leftAt"=now() WHERE "conversationId"=$1 AND "memberId"=\'owner\'', [group])
  assert.equal((await handleGroupDecisionQuality(pool, directory, { ...req, method: 'POST', body })).status, 404)
  assert.equal((await handleGroupDecisionReplay(pool,directory,replayReq,invoke)).status,404)
  assert.equal(replayCalls,2)
})
