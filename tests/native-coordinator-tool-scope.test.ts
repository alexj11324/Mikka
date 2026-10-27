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
stub('../lib/issue-visibility.ts',{issueVisibility:effect})
stub('../lib/agent-runs.ts',{addRunMessage:effect,queueRun:effect,readRun:effect,requestRunStop:effect,visibleRuns:effect})
stub('../lib/db/index.ts',{db:null,pool:null})
stub('../lib/search/index.ts',{webSearch:effect})
stub('../lib/device-link.ts',{DEVICE_ONLINE_WINDOW_MS:60_000})
stub('../lib/composio.ts',{runComposioAction:effect})
stub('../lib/pending-action-store.ts',{proposeAction:effect})
stub('../lib/issue-access.ts',{issueForUser:effect})
stub('../lib/telegram/client.ts',{postTelegramText:effect})
stub('../lib/mobile-push.ts',{pushReply:effect})
stub('../lib/attention/store.ts',{recordDecision:effect,settleTurn:effect})
let steps: typeof import('../workflows/coordinator/steps')
before(async()=>{steps=await import('../workflows/coordinator/steps')})
const scope={holder:'holder',turnId:'turn',callId:'call'}
const user='host-owned-user'

beforeEach(()=>{revoked=false;uncertain=false;checks.mock.resetCalls();effect.mock.resetCalls()})

const calls = {
  remember:()=>steps.remember(user,{note:'preference'},scope),
  forget:()=>steps.forget(user,{text:'preference'},scope),
  composioAction:()=>steps.composioAction(user,'fetch_recent_gmail',{query:'is:unread'},scope),
  proposeAccountAction:()=>steps.proposeAccountAction(user,'send_email',{},scope),
  listIssues:()=>steps.listIssues(user,{},scope),
  getIssue:()=>steps.getIssue(user,{issueId:'issue'},scope),
  listAgents:()=>steps.listAgents(user,scope),
  dispatchRun:()=>steps.dispatchRun(user,{issueId:'issue',agentId:'agent',deviceRepoId:'repo'},scope),
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
test('unscoped AI SDK calls keep the existing business callbacks and account approval proposals',async()=>{
  revoked=true
  await steps.remember(user,{note:'preference'})
  await steps.proposeAccountAction(user,'send_email',{subject:'proposal'})
  assert.equal(checks.mock.callCount(),0)
  assert.equal(effect.mock.callCount(),2)
  assert.deepEqual(effect.mock.calls[1].arguments,[user,'send_email',{subject:'proposal'}])
})
