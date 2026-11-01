import assert from 'node:assert/strict'
import { before, beforeEach, mock, test } from 'node:test'
import { NativeCoordinatorError } from '../lib/coordinator/native-store'
import type { RunDetail } from '../lib/agent-runs'
import { workspaceRunView } from '../lib/run-visibility'
import { FactoryError } from '../lib/factory/contract'

let appAllowed = true
const policyChecks = mock.fn(async () => appAllowed)
let revoked = false
let uncertain = false
const checks = mock.fn(async () => { if (revoked) throw new NativeCoordinatorError(409,'coordinatorExpiredOrLeaseLost') })
const effect = mock.fn(async () => { if (uncertain) throw new Error('retryable transport failure'); return {ok:true} })
let runDetail: RunDetail | null = null
const readRunResult = mock.fn(async (_userId: string, _runId: string) => runDetail)
let questionReadError: Error | null = null
let revokeDuringQuestionRead = false
let revokeDuringEventRead = false
const hostQuestionReference = {
  questionId:'question',questionRevision:4,
  binding:{taskId:'task',issueId:'issue',attemptId:'original-attempt',revision:6,candidateId:null as string | null},
  originRunId:'original-run',originSessionId:'original-session',
}
const questionView = () => ({id:'question',kind:'context',question:'Which source?',reference:structuredClone(hostQuestionReference)})
const readQuestion = mock.fn(async (_userId: string, _questionId: string) => {
  if (questionReadError) throw questionReadError
  if (revokeDuringQuestionRead) revoked=true
  return questionView()
})
const escalateQuestion = mock.fn(async (_userId: string, _input: unknown) => questionView())
const eventText = 'Actual authenticated browser reply'
const readUserEvent = mock.fn(async () => {
  if (revokeDuringEventRead) revoked=true
  return [{payload:{text:eventText}}]
})
const stub = (path: string, namedExports: Record<string,unknown>) => mock.module(new URL(path,import.meta.url).href,{namedExports})
stub('../lib/coordinator/native.ts',{nativeCoordinatorStore:{assertToolActive:checks}})
stub('../lib/coordinator/store.ts',{editMemory:effect})
stub('../lib/coordinator/issue-create.ts',{createIssueFromRequest:effect})
stub('../lib/issue-visibility.ts',{issueVisibility:effect})
stub('../lib/agent-runs.ts',{addRunMessage:effect,queueRun:effect,readRun:readRunResult,requestRunStop:effect,visibleRuns:effect})
stub('../lib/db/index.ts',{db:{select:()=>({from:()=>({where:()=>({limit:readUserEvent})})})},pool:null})
stub('../lib/mcp/actions.ts',{listAgents:effect})
stub('../lib/search/index.ts',{webSearch:effect})
stub('../lib/device-link.ts',{DEVICE_ONLINE_WINDOW_MS:60_000})
stub('../lib/composio.ts',{runComposioAction:effect})
stub('../lib/app-policy/store.ts',{botMayUseApp:policyChecks})
stub('../lib/composio-actions.ts',{COMPOSIO_ACTIONS:{fetch_recent_gmail:{toolkit:'gmail'},send_email:{toolkit:'gmail'}}})
stub('../lib/operations/write-runtime.ts',{personalWriteFromRun:effect})
stub('../lib/pending-action-store.ts',{writeAccountAction:effect,proposeRepositoryPush:effect})
stub('../lib/issue-access.ts',{issueForUser:effect})
stub('../lib/telegram/client.ts',{postTelegramText:effect})
stub('../lib/attention/store.ts',{recordDecision:effect,settleTurn:effect})
stub('../lib/factory/server.ts',{dispatchFactoryRun:effect,factoryMonitor:{reconcile:effect},factoryStore:{read:async()=>({contractVersion:1,task:{id:'task',revision:99},attempts:[],candidates:[]})},factoryQuestions:{read:readQuestion,answer:effect,escalate:escalateQuestion,list:async()=>[questionView()],pending:async()=>[questionView()]},reconcileFactoryRuns:effect})
stub('../lib/self-improvement/source.ts',{readCommittedSkill:async()=>{revoked=true;return 'source bytes'}})
stub('../lib/self-improvement/server.ts',{improvementStore:{},skillAssignments:{},improvementFactory:{},skillEvaluations:{freezeBenchmark:effect,dispatchNext:effect,beginEvaluation:effect,compare:effect},skillRegistry:{
  registerCandidate:async(_user:unknown,_input:unknown,readSource:(source:unknown)=>Promise<string>)=>{
    await readSource({repository:'https://github.com/example/public',sha:'a'.repeat(40),baseSha:'b'.repeat(40)})
    return effect()
  },
}})
let steps: typeof import('../workflows/coordinator/steps')
before(async()=>{steps=await import('../workflows/coordinator/steps')})
const scope={holder:'holder',turnId:'turn',callId:'call'}
/** The person's Coordinator: an ordinary bot row. */
const COORDINATOR_BOT='40000000-0000-4000-8000-0000000c0de1'
const user='host-owned-user'

beforeEach(()=>{
  appAllowed=true;policyChecks.mock.resetCalls()
  revoked=false;uncertain=false;runDetail=null;questionReadError=null;revokeDuringQuestionRead=false;revokeDuringEventRead=false
  hostQuestionReference.binding.candidateId=null
  for (const fn of [checks,effect,readRunResult,readQuestion,escalateQuestion,readUserEvent]) fn.mock.resetCalls()
})

const binding={taskId:'task',issueId:'issue',attemptId:'attempt',revision:1,candidateId:null}
const reference={questionId:'question',questionRevision:1,binding,originRunId:'run',originSessionId:'session'}
const calls = {
  freezeSkillBenchmark:()=>steps.skillEvaluation(user,{action:'freeze_benchmark',sourceRunId:'run'},scope),
  dispatchSkillTraining:()=>steps.skillEvaluation(user,{action:'dispatch_training',instanceId:'instance'},scope),
  beginSkillEvaluation:()=>steps.skillEvaluation(user,{action:'begin_evaluation',instanceId:'instance',proposalId:'proposal',candidateVersionId:'version'},scope),
  dispatchSkillEvaluation:()=>steps.skillEvaluation(user,{action:'dispatch_evaluation',evaluationId:'evaluation'},scope),
  compareSkillEvaluation:()=>steps.skillEvaluation(user,{action:'compare_evaluation',evaluationId:'evaluation'},scope),
  selectActiveSkill:()=>steps.selectActiveSkill(user,{runId:'run'},scope),
  registerSkillCandidate:()=>steps.registerSkillCandidate(user,{proposalId:'proposal',binding},scope),
  selectBaselineSkill:()=>steps.selectBaselineSkill(user,{runId:'run'},scope),
  dispatchBaselineRehearsal:()=>steps.dispatchBaselineRehearsal(user,{binding,agentId:'agent',deviceRepoId:'repo'},scope),
  recordRunFeedback:()=>steps.recordRunFeedback(user,{eventId:'event',runId:'run',verdict:'negative',note:'feedback'},scope),
  proposeSkillImprovement:()=>steps.proposeSkillImprovement(user,{runId:'run'},scope),
  readRunImprovements:()=>steps.readRunImprovements(user,{runId:'run'},scope),
  handoffSkillImprovement:()=>steps.handoffSkillImprovement(user,{proposalId:'proposal',binding,agentId:'agent',deviceRepoId:'repo'},scope),
  getSkillImprovementFactory:()=>steps.getSkillImprovementFactory(user,{proposalId:'proposal'},scope),
  listFactoryRequests:()=>steps.listFactoryRequests(user,scope),
  createIssueFromRequestStep:()=>steps.createIssueFromRequestStep(user,{sourceEventId:'event',title:'Requested task'},scope),
  routeFactoryTask:()=>steps.routeFactoryTask(user,{issueId:'issue',sourceEventId:'event',rationale:'task',missingInformation:[],missingPermissions:[],needsSpec:false},scope),
  getFactoryTask:()=>steps.getFactoryTask(user,{taskId:'task'},scope),
  listFactoryQuestions:()=>steps.listFactoryQuestions(user,{},scope),
  getFactoryQuestion:()=>steps.getFactoryQuestion(user,{questionId:'question'},scope),
  answerFactoryContext:()=>steps.answerFactoryContext(user,{reference,answerId:'answer',facts:[{kind:'issue',quote:'fact'}]},scope),
  escalateFactoryQuestion:()=>steps.escalateFactoryQuestion(user,{reference,eventId:'event',reason:'question'},scope),
  answerFactoryQuestionFromUser:()=>steps.answerFactoryQuestionFromUser(user,{reference,answerId:'answer',sourceEventId:'event'},scope),
  resolveFactoryTask:()=>steps.resolveFactoryTask(user,{binding,sourceEventId:'event',rationale:'resolution',missingInformation:[],missingPermissions:[],needsSpec:false},scope),
  stopFactoryTask:()=>steps.stopFactoryTask(user,{binding,reason:'cancel',action:'cancel'},scope),
  remember:()=>steps.remember(user,{note:'preference'},scope,COORDINATOR_BOT),
  forget:()=>steps.forget(user,{text:'preference'},scope,COORDINATOR_BOT),
  composioAction:()=>steps.composioAction(user,'fetch_recent_gmail',{query:'is:unread'},scope),
  accountWrite:()=>steps.accountWrite(user,'send_email',{},scope),
  proposeRepositoryPushApproval:()=>steps.proposeRepositoryPushApproval(user,{repo:'owner/repo'},scope,{botId:COORDINATOR_BOT}),
  listIssues:()=>steps.listIssues(user,{},scope),
  getIssue:()=>steps.getIssue(user,{issueId:'issue'},scope,COORDINATOR_BOT),
  createIssue:()=>steps.createIssue(user,{title:'Task'},'tool-call',scope,COORDINATOR_BOT),
  updateIssue:()=>steps.updateIssue(user,{issueId:'issue',title:'Updated'},'tool-call',scope,COORDINATOR_BOT),
  listAgents:()=>steps.listAgents(user,scope),
  dispatchRun:()=>steps.dispatchRun(user,{issueId:'issue',agentId:'agent',repo:'owner/repo'},scope,COORDINATOR_BOT),
  listComputerWorkspaces:()=>steps.listComputerWorkspaces(user,scope),
  createComputerBot:()=>steps.createComputerBot(user,{workspaceId:'workspace',name:'Bot'},'tool-call',scope),
  listComputerBots:()=>steps.listComputerBots(user,scope),
  wakeComputerBot:()=>steps.wakeComputerBot(user,{botId:'bot'},scope),
  listBotSubscriptions:()=>steps.listBotSubscriptions(user,{botId:'bot'},scope),
  bindComputerSubscription:()=>steps.bindComputerSubscription(user,{botId:'bot',connectionId:'connection',revision:1,harness:'codex',modelId:'model'},'tool-call',scope),
  dispatchComputerTask:()=>steps.dispatchComputerTask(user,{botId:'bot',issueId:'issue',harness:'codex'},'tool-call',scope),
  listRuns:()=>steps.listRuns(user,{},scope),
  getRun:()=>steps.getRun(user,{runId:'run'},scope),
  sendToRun:()=>steps.sendToRun(user,{runId:'run',text:'message'},scope),
  stopRun:()=>steps.stopRun(user,{runId:'run'},scope),
  webSearchStep:()=>steps.webSearchStep(user,{query:'query'},scope),
  recordAttention:()=>steps.recordAttention(user,{matterId:'matter',decision:'notify'},scope),
}
for (const [name,call] of Object.entries(calls)) {
  test(`${name} checks current native authorization inside the business step`,async()=>{
    revoked=true
    await assert.rejects(call(),/coordinatorExpiredOrLeaseLost/)
    assert.deepEqual(checks.mock.calls.map(call=>call.arguments),[[user,scope.holder,scope.turnId,scope.callId]])
    assert.equal(effect.mock.callCount(),0)
    assert.equal(readRunResult.mock.callCount(),0)
    assert.equal(readQuestion.mock.callCount()+escalateQuestion.mock.callCount()+readUserEvent.mock.callCount(),0)
  })
}
const questionActions = {
  context: (reference: {questionId:string;questionRevision:number}) => steps.answerFactoryContext(user,{reference,answerId:'answer',facts:[{kind:'issue',quote:'fact'}]},scope),
  escalation: (reference: {questionId:string;questionRevision:number}) => steps.escalateFactoryQuestion(user,{reference,eventId:'event',reason:'question'},scope),
  humanEvent: (reference: {questionId:string;questionRevision:number}) => steps.answerFactoryQuestionFromUser(user,{reference,answerId:'answer',sourceEventId:'event'},scope),
}
for (const [name,action] of Object.entries(questionActions)) {
  test(`${name} resolves the owned persisted question binding and retains the caller revision for replay`,async()=>{
    for (const candidateId of [null,'persisted-candidate']) {
      hostQuestionReference.binding.candidateId=candidateId
      const compact={questionId:'question',questionRevision:1}
      // Model-supplied host fields cannot override the persisted values even if a caller bypasses schema validation.
      await action({...compact,binding:{candidateId:'forged'},originRunId:'forged'} as typeof compact)
      assert.deepEqual(readQuestion.mock.calls.at(-1)?.arguments,[user,'question'])
      const mutation=name==='escalation' ? escalateQuestion.mock.calls.at(-1) : effect.mock.calls.at(-1)
      const [actor,input]=mutation!.arguments as [unknown,{reference:typeof hostQuestionReference;text?:string}]
      assert.deepEqual(input.reference,{...hostQuestionReference,questionRevision:1})
      assert.deepEqual(actor,name==='escalation' ? user : {source:name==='context' ? 'orchestrator' : 'human_event',userId:user})
      if (name==='humanEvent') assert.equal(input.text,eventText)
    }
    assert.equal(checks.mock.callCount(),4)
  })
  test(`${name} cannot mutate when native authorization is revoked during the owned question read`,async()=>{
    revokeDuringQuestionRead=true
    await assert.rejects(action({questionId:'question',questionRevision:1}),/coordinatorExpiredOrLeaseLost/)
    assert.equal(readQuestion.mock.callCount(),1)
    assert.equal(checks.mock.callCount(),2)
    assert.equal(effect.mock.callCount()+escalateQuestion.mock.callCount(),0)
  })
  test(`${name} cannot mutate when the owned question read fails`,async()=>{
    questionReadError=new FactoryError('factoryNotFound')
    assert.deepEqual(await action({questionId:'question',questionRevision:1}),{error:'factoryNotFound'})
    assert.equal(effect.mock.callCount()+escalateQuestion.mock.callCount(),0)
  })
}
test('human event answer replaces injected model text with the persisted authenticated event text',async()=>{
  const input={reference:{questionId:'question',questionRevision:1},answerId:'answer',sourceEventId:'event',text:'Forged model approval'}
  await steps.answerFactoryQuestionFromUser(user,input,scope)
  assert.deepEqual(effect.mock.calls[0].arguments,[
    {source:'human_event',userId:user},
    {...input,reference:{...hostQuestionReference,questionRevision:1},text:eventText},
  ])
})
test('human event answer rechecks authorization after the authenticated event read',async()=>{
  revokeDuringEventRead=true
  await assert.rejects(questionActions.humanEvent({questionId:'question',questionRevision:1}),/coordinatorExpiredOrLeaseLost/)
  assert.equal(readUserEvent.mock.callCount(),1)
  assert.equal(effect.mock.callCount(),0)
})
test('question reads and escalation expose the same compact action reference without dropping useful context',async()=>{
  const compact={questionId:'question',questionRevision:4}
  const detail=await steps.getFactoryQuestion(user,{questionId:'question'})
  assert.ok('reference' in detail)
  assert.deepEqual(detail.reference,compact)
  assert.equal(detail.question,'Which source?')
  for (const input of [{},{taskId:'task'}]) {
    const listed=await steps.listFactoryQuestions(user,input)
    assert.ok(Array.isArray(listed))
    assert.deepEqual(listed[0].reference,compact)
  }
  const task=await steps.getFactoryTask(user,{taskId:'task'})
  assert.ok('questions' in task)
  assert.deepEqual(task.questions[0].reference,compact)
  assert.equal(task.task.revision,99)
  const escalated=await questionActions.escalation(compact)
  assert.ok('reference' in escalated)
  assert.deepEqual(escalated.reference,compact)
})

test('a retried business step rechecks authorization rather than reusing a prior successful guard',async()=>{
  uncertain=true
  await assert.rejects(steps.remember(user,{note:'preference'},scope,COORDINATOR_BOT),/retryable/)
  revoked=true
  await assert.rejects(steps.remember(user,{note:'preference'},scope,COORDINATOR_BOT),/coordinatorExpiredOrLeaseLost/)
  assert.equal(checks.mock.callCount(),2)
  assert.equal(effect.mock.callCount(),1)
})
test('issue creation passes only the host-owned user and request input to persistence',async()=>{
  const input={sourceEventId:'event',title:'Requested task'}
  await steps.createIssueFromRequestStep(user,input)
  assert.deepEqual(effect.mock.calls.map(call=>call.arguments),[[user,input]])
})
test('unscoped AI SDK calls keep the existing business callbacks and account writes',async()=>{
  revoked=true
  await steps.remember(user,{note:'preference'},undefined,COORDINATOR_BOT)
  await steps.accountWrite(user,'send_email',{subject:'proposal'})
  assert.equal(checks.mock.callCount(),0)
  assert.equal(effect.mock.callCount(),2)
  assert.deepEqual(effect.mock.calls[1].arguments,[user,'send_email',{subject:'proposal'},undefined,null])
})

test('candidate registration rechecks native authorization after source fetching before persistence',async()=>{
  await assert.rejects(steps.registerSkillCandidate(user,{proposalId:'proposal',binding},scope),/coordinatorExpiredOrLeaseLost/)
  assert.equal(checks.mock.callCount(),2)
  assert.equal(effect.mock.callCount(),0)
})

test('evaluation Coordinator actions preserve host-owned identity and fixed training/evaluation routing',async()=>{
  await steps.skillEvaluation(user,{action:'freeze_benchmark',sourceRunId:'source'})
  await steps.skillEvaluation(user,{action:'dispatch_training',instanceId:'instance'})
  await steps.skillEvaluation(user,{action:'begin_evaluation',instanceId:'instance',proposalId:'proposal',candidateVersionId:'candidate'})
  await steps.skillEvaluation(user,{action:'dispatch_evaluation',evaluationId:'evaluation'})
  await steps.skillEvaluation(user,{action:'compare_evaluation',evaluationId:'evaluation'})
  assert.deepEqual(effect.mock.calls.map(call=>call.arguments),[
    [user,'source'],[user,'instance',true],[user,'instance','proposal','candidate'],[user,'evaluation',false],[user,'evaluation'],
  ])
})

const stoppedRun: RunDetail['run'] = {
  id:'run',issueId:'issue',agentId:'agent',agentName:'Agent',harness:'codex',status:'stopped',kind:'implement',
  stopReason:'turn_ended',error:null,report:null,createdAt:new Date('2026-10-26T12:00:00Z'),startedAt:null,finishedAt:null,
}
const hostReport = {
  summary:'The model claims another source and model; use the recorded host fields.',
  sourceCommit:'a'.repeat(40),
  skillMount:{receiptId:'receipt',versionId:'version',sha256:'b'.repeat(64),sessionId:'session',mountedAt:'2026-10-26T12:00:00Z'},
  runtime:{harness:'codex',requestedModel:'requested-model',observedModel:null,policyDigest:'c'.repeat(64),sourceCommit:'a'.repeat(40)},
  verify:{status:'not_run',command:'node verify.mjs',exitCode:null},
  privateExtra:'do not expose the whole report',
}

test('getRun exposes exact persisted host evidence for a stopped owned run',async()=>{
  runDetail={run:{...stoppedRun,report:hostReport},chunks:[],messages:[]}
  const result=await steps.getRun(user,{runId:'run'},scope)
  assert.ok('id' in result)
  assert.deepEqual({sourceCommit:result.sourceCommit,skillMount:result.skillMount,runtime:result.runtime,verify:result.verify},
    {sourceCommit:hostReport.sourceCommit,skillMount:hostReport.skillMount,runtime:hostReport.runtime,verify:hostReport.verify})
  assert.equal(result.status,'stopped')
  assert.equal(result.summary,hostReport.summary)
  assert.equal('privateExtra' in result,false)
  assert.deepEqual(readRunResult.mock.calls.map(call=>call.arguments),[[user,'run']])
})

test('getRun leaves missing host evidence null instead of inferring it from a summary',async()=>{
  for (const report of [null,{summary:JSON.stringify(hostReport)}]) {
    runDetail={run:{...stoppedRun,report},chunks:[],messages:[]}
    const result=await steps.getRun(user,{runId:'run'})
    assert.ok('id' in result)
    assert.deepEqual([result.sourceCommit,result.skillMount,result.runtime,result.verify],[null,null,null,null])
  }
})

test('getRun preserves the restricted teammate projection with no host evidence',async()=>{
  runDetail={run:workspaceRunView({...stoppedRun,report:hostReport}),chunks:[],messages:[]}
  const result=await steps.getRun(user,{runId:'run'})
  assert.ok('id' in result)
  assert.deepEqual([result.summary,result.sourceCommit,result.skillMount,result.runtime,result.verify],[null,null,null,null,null])
  assert.equal(JSON.stringify(result).includes('requested-model'),false)
})


test('workspace app denies block reads, account writes and personal writes before provider effects', async () => {
  appAllowed=false
  const calls = [
    () => steps.composioAction(user,'fetch_recent_gmail',{query:'is:unread'},scope,undefined,'owned-bot'),
    () => steps.accountWrite(user,'send_email',{},scope,undefined,'owned-bot'),
    () => steps.personalWrite(user,'owned-bot','execution',{action:'send_slack_message',input:{},toolCallId:'call'},scope),
  ]
  for(const call of calls) assert.deepEqual(await call(),{error:'integrationBlockedByWorkspace'})
  assert.equal(effect.mock.callCount(),0)
  assert.equal(checks.mock.callCount(),3)
  appAllowed=true
  for(const call of calls) await call()
  assert.equal(effect.mock.callCount(),3)
})

// The Coordinator's own exemption is botMayUseApp's (tests/coordinator-bot.db.test.ts); here, work with no bot.
test('work with no bot of its own stays outside workspace app policy and revoked native calls never check policy', async () => {
  appAllowed=false
  await steps.composioAction(user,'fetch_recent_gmail',{query:'is:unread'},scope,undefined,undefined)
  assert.equal(effect.mock.callCount(),1)
  assert.equal(policyChecks.mock.callCount(),0)
  revoked=true
  await assert.rejects(steps.composioAction(user,'fetch_recent_gmail',{},scope,undefined,'owned-bot'),/coordinatorExpiredOrLeaseLost/)
  assert.equal(policyChecks.mock.callCount(),0)
  assert.equal(effect.mock.callCount(),1)
})
