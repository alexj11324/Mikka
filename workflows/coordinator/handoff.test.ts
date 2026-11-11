import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
import { before, beforeEach, mock, test } from 'node:test'
import type { ModelMessage, ToolSet } from 'ai'
import { attentionQuestionsFromEvents, completeAttentionQuestions } from '../../lib/coordinator/question-attention'
import { instrumentTools } from '../../lib/agent-kit/instrument'
import { questionEscalationSchema } from '../../lib/factory/questions/schema'

// Run the production Workflow loop and its final durable handoff. Only the
// external model, store and Workflow transports are in memory in this unit test.
const context = new AsyncLocalStorage<{ workflowRunId: string }>()
const owner = 'synthetic-handoff-owner', bot = 'synthetic-handoff-bot'
const queue: number[] = [], replies: Array<{ request: number; holder: string }> = []
const rounds: Array<{ round: number; holder: string }> = [], starts: string[] = []
const active = new Map<string, number>(), spawned: Promise<void>[] = []
let lease: string | null = null, requests = 11, nextRun = 1, deferred = 0, firstFinished = false

const permissionEvent = {
  eventId: '10000000-0000-4000-8000-000000000001',
  taskId: '10000000-0000-4000-8000-000000000002',
  issueId: '10000000-0000-4000-8000-000000000003',
  questionId: '10000000-0000-4000-8000-000000000004',
  runId: '10000000-0000-4000-8000-000000000005',
}
const permissionQuestion = {
  id: permissionEvent.questionId, userId: owner, taskId: permissionEvent.taskId,
  issueId: permissionEvent.issueId, sourceEventId: permissionEvent.eventId,
  originRunId: permissionEvent.runId, originSessionId: 'synthetic-native-session',
  attemptId: '10000000-0000-4000-8000-000000000006', candidateId: null,
  kind: 'permission', status: 'open', revision: 1, answerId: null, continuationRunId: null,
  escalationEventId: null,
  reference: {
    questionId: permissionEvent.questionId, questionRevision: 1,
    originRunId: permissionEvent.runId, originSessionId: 'synthetic-native-session',
    binding: { taskId: permissionEvent.taskId, issueId: permissionEvent.issueId,
      attemptId: '10000000-0000-4000-8000-000000000006', revision: 3, candidateId: null },
  },
}
let permissionCase = false, escalationEnabled = true, scheduledRead = false
let questionView = structuredClone(permissionQuestion)
let extraMessages: ModelMessage[] = []
let escalationError: string | Error | null = null
let stopAt: 'preparation' | 'model' | 'before-audit' | 'escalation' | null = null
let sendStop: () => void = () => {}
let stopDelivered: Promise<void> = Promise.resolve()
const failures: string[] = []
let executionState: 'running' | 'completed' | 'failed' = 'running'
let closeExecutionDuringModel = false
const execution = {id:'10000000-0000-4000-8000-000000000009',snapshot:{runtime:{harness:'ai_sdk',model:'synthetic'},effectiveTools:['escalate_factory_question']}}
const auditCallIds: string[] = []
let toolRegistryBuilds = 0
let pendingEscalationGate: Promise<void> | null = null
let notifyPendingEscalation: (() => void) | null = null
let stopMarkerReached = false

const hostedPolicyCalls: Array<{ scope: unknown; policy: unknown }> = []
const handoffOrder: string[] = []
const escalations: unknown[] = []
const permissionMessages = () => [
  { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'read-question', toolName: 'list_factory_questions', input: { taskId: permissionEvent.taskId } }] },
  { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'read-question', toolName: 'list_factory_questions', output: { type: 'json', value: [questionView] } }] },
  ...extraMessages,
  { role: 'assistant', content: [{ type: 'text', text: 'Please confirm the requested permission.' }] },
] as ModelMessage[]

let workflow: typeof import('./workflow')
const holder = () => context.getStore()!.workflowRunId
const stub = (path: string, namedExports: Record<string, unknown>) => mock.module(new URL(path, import.meta.url).href, { namedExports })

const releaseLease = async (userId: string, runId: string, botId: string) => {
  assert.deepEqual([userId, botId], [owner, bot])
  if (lease === runId) lease = null
  return queue.length > 0
}
const wakeCoordinator = async (userId: string) => {
  assert.equal(userId, owner)
  if (lease) { deferred++; return }
  if (!queue.length) return
  assert.equal(firstFinished, false, 'a fresh run may start while its predecessor is still finishing')
  const id = `wrun_handoff_${nextRun++}`
  starts.push(id)
  spawned.push(context.run({ workflowRunId: id }, () => workflow.coordinatorTurn(owner, bot)))
}
mock.module('workflow', { namedExports: {
  getWorkflowMetadata: () => context.getStore(),
  getWritable: () => new WritableStream(),
  createHook: () => {
    const requested=new Promise<void>(resolve=>{sendStop=resolve})
    let delivered:()=>void
    stopDelivered=new Promise<void>(resolve=>{delivered=resolve})
    return {async *[Symbol.asyncIterator]() {
      await requested
      yield {}
      // The for-await consumer has now applied the actual AbortController.
      delivered!()
    }}
  },
} })
stub('../../lib/coordinator/store.ts', { releaseLease })
stub('../../lib/coordinator/wake.ts', { wakeCoordinator })
stub('../../lib/subscription-workflow-turn.ts', { runHostedWorkflowTurn: async (...args: unknown[]) => {
  hostedPolicyCalls.push({ scope: args[3], policy: args[4] })
  if (permissionCase) {
    if (stopAt === 'model') { sendStop(); await stopDelivered }
    if (closeExecutionDuringModel) executionState = 'completed'
    return { text: 'Please confirm the requested permission.', finishReason: 'stop', responseMessages: permissionMessages(), modelCalls: 2 }
  }
  const request = active.get(holder())!
  const text = `Synthetic reply ${request}`
  return { text, finishReason: 'stop', responseMessages: [{ role: 'assistant', content: text }], modelCalls: 1 }
} })
stub('./native-turn.ts', { nativeCoordinatorTurn: async () => { throw new Error('native path is outside this fixture') } })
const escalateQuestion = async (userId: string, input: { reference: typeof permissionQuestion.reference; eventId: string }, _scope: unknown, botId: string) => {
  assert.deepEqual([userId, botId], [owner, bot])
  escalations.push(input)
  handoffOrder.push('escalated')
  if (pendingEscalationGate) { notifyPendingEscalation?.(); await pendingEscalationGate }
  if (stopAt === 'escalation') { sendStop(); await stopDelivered }
  if (escalationError instanceof Error) throw escalationError
  if (escalationError) return {error:escalationError}
  return { ...permissionQuestion, status: 'waiting_user', revision: 2, escalationEventId: input.eventId }
}
stub('./tools.ts', { coordinatorTools: (_owner: string, _bot: string, _scope: unknown, options: {execution: typeof execution; audits: Promise<unknown>[]}) => {
  toolRegistryBuilds++
  if (!permissionCase || !escalationEnabled) return {}
  assert.equal(options.execution.id,execution.id)
  const registry: ToolSet = {escalate_factory_question:{inputSchema:questionEscalationSchema,execute:input=>escalateQuestion(owner,input,undefined,bot)}}
  // The actual production wrapper performs the before/after and abort ordering.
  // Only its existing DB-backed hooks are in memory in this Workflow fixture.
  return instrumentTools(registry,execution.snapshot.effectiveTools,{
    before:async (callId,name) => {
      if (executionState !== 'running') throw new Error('agentExecutionClosed')
      if (!execution.snapshot.effectiveTools.includes(name)) throw new Error('agentToolNotAllowed')
      assert.equal(name,'escalate_factory_question')
      auditCallIds.push(callId);handoffOrder.push('tool-start')
      if (stopAt === 'before-audit') {sendStop();await stopDelivered}
    },
    after:async (_callId,_name,outcome) => {
      const audit=Promise.resolve().then(()=>{handoffOrder.push('tool-finish:'+outcome)})
      options.audits.push(audit)
    },
  })
} })
stub('./agent-kit-steps.ts', {
  beginAgentExecution: async () => null,
  // These recorded settings predate agentKitEnabled and keep the original steps.
  beginPreparedAgentExecution: async () => { assert.equal(permissionCase,true);executionState='running';return execution },
  finishAgentExecution: async (_owner: string, _bot: string, _execution: unknown, failure?: string) => { if (permissionCase) {executionState=failure?'failed':'completed';handoffOrder.push(failure ? 'failed' : 'completed')} },
  botRuntime: async () => ({ harness: 'ai_sdk' }),
})
stub('./steps.ts', {
  turnSettings: async () => ({ computerEnabled: false, mailboxEnabled: false, writeEnabled: false, switches: {}, coordinator: false, runtime: { harness: 'ai_sdk' },...(permissionCase ? {agentKitEnabled:true} : {}) }),
  takeInbox: async (_owner: string, runId: string) => {
    if (lease && lease !== runId) return { held: false, added: 0 }
    lease = runId
    const request = queue.shift()
    if (request !== undefined) active.set(runId, request)
    return { held: true, added: request === undefined ? 0 : 1, handoffOnly: false, handoffMatterIds: [], telegramTargets: [], pushEvents: [], ...(permissionCase ? { attentionQuestions: [permissionEvent] } : {}), ...(scheduledRead ? {scheduledRead:{allowedActions:[]}} : {}) }
  },
  prepareTurn: async () => {
    if (stopAt==='preparation') {sendStop();await stopDelivered}
    return { mailboxTools: [], prompt: { messages: [{ role: 'user', content: `Synthetic request ${active.get(holder())}` }] } }
  },
  writeStreamPart: async () => {},
  appendMessages: async (_owner: string, runId: string, _messages: unknown, _warning: unknown, _bot: string, _stream: string, stopped?: boolean) => {
    if (permissionCase) handoffOrder.push(stopped ? 'stopped-reply' : 'reply')
    const request = active.get(runId)!
    replies.push({ request, holder: runId })
    // The next input arrives after this reply is stored, before its Workflow
    // finishes the round. Its producer wake is deferred by the existing lease.
    if (request < requests) { queue.push(request + 1); await wakeCoordinator(owner) }
    return replies.length
  },
  escalateFactoryQuestionScoped: escalateQuestion,
  markStopped: async () => { stopMarkerReached = true; return 'Stopped.' },
  assertScheduleRead: async () => {},
  completeScheduleRead: async () => { handoffOrder.push('scheduled-result'); return 1 },
  noticeTurnFailure: async () => {},
  failTurn: async (_owner: string, _run: string, reason: string) => { failures.push(reason); lease = null },
  releaseLease,
  logTurnTiming: async ({ round }: { round: number }) => { rounds.push({ round, holder: holder() }) },
})

before(async () => { workflow = await import('./workflow') })
beforeEach(() => {
  queue.splice(0, queue.length, 1); replies.length = 0; rounds.length = 0; starts.length = 0; spawned.length = 0; active.clear()
  permissionCase = false; handoffOrder.length = 0; escalations.length = 0; hostedPolicyCalls.length = 0
  escalationEnabled = true; scheduledRead = false; questionView = structuredClone(permissionQuestion)
  extraMessages = []; escalationError = null; stopAt = null; failures.length = 0
  executionState='running';closeExecutionDuringModel=false;auditCallIds.length=0;toolRegistryBuilds=0
  pendingEscalationGate=null;notifyPendingEscalation=null;stopMarkerReached=false
  lease = null; requests = 11; nextRun = 1; deferred = 0; firstFinished = false
})

test('input queued during the tenth round is answered by a fresh run without a sweep', async () => {
  await context.run({ workflowRunId: 'wrun_original' }, () => workflow.coordinatorTurn(owner, bot))
  firstFinished = true
  await Promise.all(spawned)
  assert.deepEqual(rounds.filter(row => row.holder === 'wrun_original').map(row => row.round), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
  assert.equal(deferred, 10, 'every producer wake, including the eleventh input, met the old active lease')
  assert.deepEqual(starts, ['wrun_handoff_1'])
  assert.deepEqual(replies.map(row => row.request), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
  assert.equal(replies[10].holder, 'wrun_handoff_1')
  assert.deepEqual(queue, [])
  assert.equal(lease, null)
})

test('an exhausted workflow with no pending input releases its lease without starting another run', async () => {
  requests = 10
  await context.run({ workflowRunId: 'wrun_original' }, () => workflow.coordinatorTurn(owner, bot))
  assert.equal(replies.length, 10)
  assert.deepEqual(starts, [])
  assert.deepEqual(queue, [])
  assert.equal(lease, null)
})


test('an attention permission question is durably escalated before a text-only reply completes the turn', async () => {
  permissionCase = true
  requests = 1
  await context.run({ workflowRunId: 'wrun_permission' }, () => workflow.coordinatorTurn(owner, bot))
  assert.equal(escalations.length, 1, 'reading the question and telling the person is not the durable handoff')
  assert.deepEqual((escalations[0] as { reference: unknown }).reference, permissionQuestion.reference)
  assert.deepEqual(handoffOrder, ['tool-start', 'escalated', 'tool-finish:ok', 'reply', 'completed'])
  assert.deepEqual(auditCallIds,['question-attention:'+permissionEvent.eventId])
  assert.equal(lease, null)
})

const writeMessages = (output: unknown): ModelMessage[] => [
  {role:'assistant',content:[{type:'tool-call',toolCallId:'question-write',toolName:'escalate_factory_question',input:{reference:permissionQuestion.reference,eventId:'10000000-0000-4000-8000-000000000007',reason:'A human decision is needed.'}}]},
  {role:'tool',content:[{type:'tool-result',toolCallId:'question-write',toolName:'escalate_factory_question',output:{type:'json',value:output as never}}]},
]
const permissionTurn = () => context.run({workflowRunId:'wrun_permission'},() => workflow.coordinatorTurn(owner,bot))

test('a successful model escalation receipt completes without another scoped write', async () => {
  permissionCase = true; requests = 1
  extraMessages = writeMessages({...permissionQuestion,status:'waiting_user',revision:2})
  await permissionTurn()
  assert.deepEqual(escalations,[])
  assert.deepEqual(handoffOrder,['reply','completed'])
})

test('a model escalation with an error receipt fails the turn without retrying or publishing success', async () => {
  permissionCase = true; requests = 1
  extraMessages = writeMessages({error:'factoryQuestionStale'})
  await assert.rejects(permissionTurn(),/factoryQuestionStale/)
  assert.deepEqual(escalations,[])
  assert.deepEqual(handoffOrder,['failed'])
  assert.deepEqual(failures,['factoryQuestionStale'])
  assert.deepEqual(replies,[])
})

test('a missing escalation normal-service refusal is preserved as a failed turn', async () => {
  permissionCase = true; requests = 1; escalationError = 'factoryStopped'
  await assert.rejects(permissionTurn(),/factoryStopped/)
  assert.equal(escalations.length,1)
  assert.deepEqual(handoffOrder,['tool-start','escalated','tool-finish:error','failed'])
  assert.deepEqual(failures,['factoryStopped'])
  assert.deepEqual(replies,[])
})

test('a thrown scoped escalation error cannot become a completed turn', async () => {
  permissionCase = true; requests = 1; escalationError = new Error('synthetic-storage-refusal')
  await assert.rejects(permissionTurn(),/synthetic-storage-refusal/)
  assert.deepEqual(handoffOrder,['tool-start','escalated','tool-finish:error','failed'])
  assert.deepEqual(failures,['synthetic-storage-refusal'])
})

test('stopping before the completion boundary does not escalate an open question', async () => {
  permissionCase = true; requests = 1; stopAt = 'model'
  await permissionTurn()
  assert.deepEqual(escalations,[])
  assert.deepEqual(handoffOrder,['stopped-reply','completed'])
})

test('a stop during the one in-flight escalation stores the existing stopped reply', async () => {
  permissionCase = true; requests = 1; stopAt = 'escalation'
  await permissionTurn()
  assert.equal(escalations.length,1)
  assert.deepEqual(handoffOrder,['tool-start','escalated','tool-finish:ok','stopped-reply','completed'])
})

test('a scheduled read cannot perform the permission handoff', async () => {
  permissionCase = true; requests = 1; scheduledRead = true
  await permissionTurn()
  assert.deepEqual(escalations,[])
  assert.deepEqual(handoffOrder,['scheduled-result','completed'])
})

test('an execution without the actual escalation capability cannot perform the handoff', async () => {
  permissionCase = true; requests = 1; escalationEnabled = false
  await permissionTurn()
  assert.deepEqual(escalations,[])
  assert.deepEqual(handoffOrder,['reply','completed'])
})

test('closed or answered question views do not trigger another handoff', async t => {
  for (const status of ['waiting_user','answered','resuming','resolved','blocked','cancelled','expired','superseded']) {
    await t.test(status,async () => {
      questionView = {...structuredClone(permissionQuestion),status}
      let calls = 0
      assert.equal(await completeAttentionQuestions([permissionEvent],permissionMessages(),{
        userId:owner,enabled:true,escalate:async () => {calls++;throw new Error('unexpected write')},
      }),0)
      assert.equal(calls,0)
    })
  }
})

test('only the owned permission question with its exact host reference can be completed', async t => {
  const invalid: Array<[string,Record<string,unknown>]> = [
    ['owner',{userId:'different-owner'}],['task',{taskId:'10000000-0000-4000-8000-000000000008'}],
    ['issue',{issueId:'10000000-0000-4000-8000-000000000008'}],
    ['source-event',{sourceEventId:'10000000-0000-4000-8000-000000000008'}],
    ['origin-run',{originRunId:'10000000-0000-4000-8000-000000000008'}],
    ['context-question',{kind:'context'}],['answer',{answerId:'10000000-0000-4000-8000-000000000008'}],
    ['continuation',{continuationRunId:'10000000-0000-4000-8000-000000000008'}],
    ['escalation',{escalationEventId:'10000000-0000-4000-8000-000000000008'}],
    ['revision',{reference:{...permissionQuestion.reference,questionRevision:2}}],
    ['native-session',{reference:{...permissionQuestion.reference,originSessionId:'different-native-session'}}],
  ]
  for (const [name,patch] of invalid) await t.test(name,async () => {
    questionView = {...structuredClone(permissionQuestion),...patch}
    let calls = 0
    assert.equal(await completeAttentionQuestions([permissionEvent],permissionMessages(),{
      userId:owner,enabled:true,escalate:async () => {calls++;throw new Error('unexpected write')},
    }),0)
    assert.equal(calls,0)
  })
})

test('unpaired, duplicate, or model-written question values cannot authorize the handoff', async t => {
  const valid = permissionMessages()
  const inputs: Array<[string,ModelMessage[]]> = [
    ['text-only',[{role:'assistant',content:JSON.stringify(permissionQuestion)}]],
    ['missing-call',[valid[1]]],['duplicate-call',[valid[0],valid[0],valid[1]]],
    ['duplicate-output',[valid[0],valid[1],valid[1]]],['output-before-call',[valid[1],valid[0]]],
  ]
  for (const [name,messages] of inputs) await t.test(name,async () => {
    let calls = 0
    assert.equal(await completeAttentionQuestions([permissionEvent],messages,{
      userId:owner,enabled:true,escalate:async () => {calls++;throw new Error('unexpected write')},
    }),0)
    assert.equal(calls,0)
  })
})

const attentionEvent = () => ({
  id:permissionEvent.eventId,kind:'run_question',tier:'attention',issueId:permissionEvent.issueId,runId:permissionEvent.runId,
  payload:{taskId:permissionEvent.taskId,questionId:permissionEvent.questionId},
  triageDecision:{method:'model',chosenTier:'attention',eventId:permissionEvent.eventId,eventKind:'run_question',
    observedRun:{id:permissionEvent.runId},execution:{executionId:'synthetic-triage',providerGenerationId:'synthetic-provider',requestDigest:'a'.repeat(64)}},
})

test('the completion input is derived only from the actual attention receipt in the owned inbox read', async t => {
  assert.deepEqual(attentionQuestionsFromEvents([attentionEvent()]),[permissionEvent])
  const invalid: Array<[string,Record<string,unknown>]> = [
    ['non-question',{kind:'run_completed'}],['non-attention',{tier:'result'}],
    ['already-needs-human',{payload:{...attentionEvent().payload,needsUser:true}}],
    ['no-receipt',{triageDecision:null}],
    ['wrong-event',{triageDecision:{...attentionEvent().triageDecision,eventId:'10000000-0000-4000-8000-000000000008'}}],
    ['wrong-run',{triageDecision:{...attentionEvent().triageDecision,observedRun:{id:'10000000-0000-4000-8000-000000000008'}}}],
    ['no-model-execution',{triageDecision:{...attentionEvent().triageDecision,execution:null}}],
    ['fixed-rule',{triageDecision:{...attentionEvent().triageDecision,method:'fixed'}}],
  ]
  for (const [name,patch] of invalid) await t.test(name,() => {
    assert.deepEqual(attentionQuestionsFromEvents([{...attentionEvent(),...patch} as ReturnType<typeof attentionEvent>]),[])
  })
})


test('a cross-process execution close refuses the completion action before its business write', async () => {
  permissionCase=true;requests=1;closeExecutionDuringModel=true
  await assert.rejects(permissionTurn(),/agentExecutionClosed/)
  assert.deepEqual(escalations,[])
  assert.deepEqual(auditCallIds,[])
  assert.deepEqual(handoffOrder,['failed'])
  assert.deepEqual(failures,['agentExecutionClosed'])
  assert.deepEqual(replies,[])
})


test('stop during the actual instrumented before hook does not start escalation or report a failure', async () => {
  permissionCase=true;requests=1;stopAt='before-audit'
  await permissionTurn()
  assert.deepEqual(escalations,[])
  assert.deepEqual(handoffOrder,['tool-start','tool-finish:stopped','stopped-reply','completed'])
  assert.deepEqual(failures,[])
})


test('stop during preparation keeps the original lazy tool construction boundary', async () => {
  permissionCase=true;requests=1;stopAt='preparation'
  await permissionTurn()
  assert.equal(toolRegistryBuilds,0)
  assert.deepEqual(escalations,[])
  assert.deepEqual(handoffOrder,['stopped-reply','completed'])
  assert.deepEqual(failures,[])
})


test('stop marker precedes settlement of the new in-flight permission escalation', { timeout: 5000 }, async () => {
  permissionCase = true; requests = 1
  let releaseGate: () => void = () => {}
  pendingEscalationGate = new Promise<void>(resolve => { releaseGate = resolve })
  const entered = new Promise<void>(resolve => { notifyPendingEscalation = resolve })
  const running = permissionTurn()
  running.catch(() => {})
  let markerBeforeRelease = false
  let entryTimer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([entered, new Promise<void>((_resolve, reject) => {
      entryTimer = setTimeout(() => reject(new Error('local escalation entry timeout')), 2000)
    })])
    if (entryTimer) clearTimeout(entryTimer)
    sendStop()
    await stopDelivered
    await new Promise<void>(resolve => setImmediate(resolve))
    markerBeforeRelease = stopMarkerReached
    console.log(JSON.stringify({ event:'post_completion_stop_boundary', stage:'before_gate_release',
      markerObserved:markerBeforeRelease, escalations:escalations.length, replies:replies.length }))
  } finally {
    if (entryTimer) clearTimeout(entryTimer)
    releaseGate()
    await running
  }
  console.log(JSON.stringify({ event:'post_completion_stop_boundary', stage:'after_gate_release',
    markerObserved:stopMarkerReached, escalations:escalations.length, replies:replies.length }))
  assert.equal(markerBeforeRelease, true, 'Stop must mark the turn without waiting for its already running tool body')
})


// The settings fixture above returns coordinator:false for this ordinary named
// bot. Exercise the production workflow call site, not a directly built model.
test('a named bot hosted chat receives priority through the real Coordinator workflow', async () => {
  requests = 1
  await context.run({ workflowRunId: 'wrun_named_bot_priority' }, () => workflow.coordinatorTurn(owner, bot))
  assert.deepEqual(hostedPolicyCalls, [{
    scope: { ownerId: owner, botId: bot },
    policy: { codexServiceTier: 'priority' },
  }])
  assert.equal(replies.length, 1)
  assert.deepEqual(failures, [])
  assert.equal(lease, null)
})

test('a scheduled hosted chat omits priority through the real Coordinator workflow', async () => {
  requests = 1
  scheduledRead = true
  await context.run({ workflowRunId: 'wrun_scheduled_no_priority' }, () => workflow.coordinatorTurn(owner, bot))
  assert.deepEqual(hostedPolicyCalls, [{
    scope: { ownerId: owner, botId: bot },
    policy: undefined,
  }])
  assert.deepEqual(handoffOrder, ['scheduled-result'])
  assert.deepEqual(replies, [])
  assert.deepEqual(failures, [])
  assert.equal(lease, null)
})
