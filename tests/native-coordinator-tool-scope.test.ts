import assert from 'node:assert/strict'
import { before, beforeEach, mock, test } from 'node:test'
import { NativeCoordinatorError } from '../lib/coordinator/native-store'

let revoked = false
let uncertain = false
const checks = mock.fn(async () => { if (revoked) throw new NativeCoordinatorError(409,'coordinatorExpiredOrLeaseLost') })
const effect = mock.fn(async () => { if (uncertain) throw new Error('retryable transport failure'); return {ok:true} })
const stub = (path: string, namedExports: Record<string,unknown>) => mock.module(new URL(path,import.meta.url).href,{namedExports})
stub('../lib/coordinator/native.ts',{nativeCoordinatorStore:{assertToolActive:checks}})
stub('../lib/coordinator/store.ts',{editMemory:effect})
stub('../lib/coordinator/issue-create.ts',{createIssueFromRequest:effect})
stub('../lib/issue-visibility.ts',{issueVisibility:effect})
stub('../lib/agent-runs.ts',{addRunMessage:effect,queueRun:effect,readRun:effect,requestRunStop:effect,visibleRuns:effect})
stub('../lib/db/index.ts',{db:null})
stub('../lib/search/index.ts',{webSearch:effect})
stub('../lib/device-link.ts',{DEVICE_ONLINE_WINDOW_MS:60_000})
stub('../lib/composio.ts',{runComposioAction:effect})
stub('../lib/pending-action-store.ts',{proposeAction:effect})
stub('../lib/issue-access.ts',{issueForUser:effect})
stub('../lib/telegram/client.ts',{postTelegramText:effect})
stub('../lib/factory/server.ts',{dispatchFactoryRun:effect,factoryMonitor:{reconcile:effect},factoryStore:{},factoryQuestions:{},reconcileFactoryRuns:effect})
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
const user='host-owned-user'

beforeEach(()=>{revoked=false;uncertain=false;checks.mock.resetCalls();effect.mock.resetCalls()})

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
  remember:()=>steps.remember(user,{note:'preference'},scope),
  forget:()=>steps.forget(user,{text:'preference'},scope),
  composioAction:()=>steps.composioAction(user,'fetch_recent_gmail',{query:'is:unread'},scope),
  proposeAccountAction:()=>steps.proposeAccountAction(user,'send_email',{},scope),
  listIssues:()=>steps.listIssues(user,{},scope),
  getIssue:()=>steps.getIssue(user,{issueId:'issue'},scope),
  listAgents:()=>steps.listAgents(user,scope),
  dispatchRun:()=>steps.dispatchRun(user,{binding:{taskId:'task',issueId:'issue',attemptId:'attempt',revision:1,candidateId:null},agentId:'agent',deviceRepoId:'repo'},scope),
  listRuns:()=>steps.listRuns(user,{},scope),
  getRun:()=>steps.getRun(user,{runId:'run'},scope),
  sendToRun:()=>steps.sendToRun(user,{runId:'run',text:'message'},scope),
  stopRun:()=>steps.stopRun(user,{runId:'run'},scope),
  webSearchStep:()=>steps.webSearchStep(user,{query:'query'},scope),
}
for (const [name,call] of Object.entries(calls)) {
  test(`${name} checks current native authorization inside the business step`,async()=>{
    revoked=true
    await assert.rejects(call(),/coordinatorExpiredOrLeaseLost/)
    assert.deepEqual(checks.mock.calls.map(call=>call.arguments),[[user,scope.holder,scope.turnId,scope.callId]])
    assert.equal(effect.mock.callCount(),0)
  })
}
test('a retried business step rechecks authorization rather than reusing a prior successful guard',async()=>{
  uncertain=true
  await assert.rejects(steps.remember(user,{note:'preference'},scope),/retryable/)
  revoked=true
  await assert.rejects(steps.remember(user,{note:'preference'},scope),/coordinatorExpiredOrLeaseLost/)
  assert.equal(checks.mock.callCount(),2)
  assert.equal(effect.mock.callCount(),1)
})
test('issue creation passes only the host-owned user and request input to persistence',async()=>{
  const input={sourceEventId:'event',title:'Requested task'}
  await steps.createIssueFromRequestStep(user,input)
  assert.deepEqual(effect.mock.calls.map(call=>call.arguments),[[user,input]])
})
test('unscoped AI SDK calls keep the existing business callbacks and account approval proposals',async()=>{
  revoked=true
  await steps.remember(user,{note:'preference'})
  await steps.proposeAccountAction(user,'send_email',{subject:'proposal'})
  assert.equal(checks.mock.callCount(),0)
  assert.equal(effect.mock.callCount(),2)
  assert.deepEqual(effect.mock.calls[1].arguments,[user,'send_email',{subject:'proposal'}])
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
