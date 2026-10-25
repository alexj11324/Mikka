import { authorizeModel, authorizePolicyTool } from '@/lib/policy/runtime'
import { coordinatorRoute } from '@/lib/policy/model'
import { generateText, type ModelMessage, type ToolExecutionOptions } from 'ai'
import { and, asc, desc, eq, inArray, or } from 'drizzle-orm'
import { ActionFailureError } from '@/lib/action-error'
import { addRunMessage, readRun, requestRunStop, runViewColumns } from '@/lib/agent-runs'
import { compactionCut, forgetNotes, instructionsWithMemory, promptMessages, rememberNote, SUMMARY_INSTRUCTIONS } from '@/lib/coordinator/context'
import { mailboxes } from '@/lib/mailbox-runtime'
import { MailboxError } from '@/lib/session-mailbox'
import { MAILBOX_INSTRUCTIONS } from '@/lib/mailbox-tools'
import { COORDINATOR_INSTRUCTIONS } from '@/lib/coordinator/instructions'
import { COORDINATOR_MODEL } from '@/lib/coordinator/model'
import * as store from '@/lib/coordinator/store'
import { db } from '@/lib/db'
import { agentRuns, agents, coordinatorEvents, deviceRepos, devices, factoryAttempts, factoryTasks, issueMembers, issues } from '@/lib/db/schema'
import { DEVICE_ONLINE_WINDOW_MS } from '@/lib/device-link'
import { type ApprovalActionName, type ComposioActionName } from '@/lib/composio-actions'
import { runComposioAction } from '@/lib/composio'
import { proposeCalendarBatch, recoverCalendarBatch, prepareAccountActionBatch } from '@/lib/operations/action-intent-runtime'
import { OperationError } from '@/lib/operations/ledger'
import type { ActionContext } from '@/lib/operations/action-intents'
import { proposeAction } from '@/lib/pending-action-store'
import { issueForUser } from '@/lib/issue-access'
import { readIssueMetadata } from '@/lib/issue-metadata'
import { tiptapToText } from '@/lib/tiptap-text'
import { FactoryError, type FactoryBinding, type FactoryRoute } from '@/lib/factory/contract'
import type { FactoryDispatchInput } from '@/lib/factory/dispatch'
import { factoryEventId } from '@/lib/factory/event-id'
import { dispatchFactoryRun, factoryMonitor, factoryStore, factoryQuestions, reconcileFactoryRuns } from '@/lib/factory/server'
import type { QuestionReference, ContextQuestionAnswer } from '@/lib/factory/questions/contract'
import { improvementStore, skillAssignments, improvementFactory } from '@/lib/self-improvement/server'
import { ImprovementError, type Feedback, type ImprovementHandoff, type ImprovementRehearsal } from '@/lib/self-improvement/contract'
import { executeSystemCredentialTool } from '@/lib/credentials/runtime'
import type { CredentialToolName } from '@/lib/credentials/execution-tools'

// Every function here is a durable step: it runs with full Node access, its
// result is recorded, and a failure is retried. Tools return `{ error }` for
// expected failures instead of throwing, so a bad id is not retried.

type ToolResult<T> = T | { error: string }

export async function credentialTool(userId: string, name: CredentialToolName, input: unknown) {
  'use step'
  await authorizePolicyTool(userId)
  return executeSystemCredentialTool({ userId }, name, input)
}

async function asToolResult<T>(fn: () => Promise<T>): Promise<ToolResult<T>> {
  try {
    return await fn()
  } catch (error) {
    if (error instanceof ActionFailureError || error instanceof FactoryError || error instanceof OperationError || error instanceof ImprovementError) return { error: error instanceof OperationError ? error.message : error.code }
    throw error
  }
}

export async function takeInbox(userId: string, holder: string) {
  'use step'
  return store.takeInbox(userId, holder)
}

export async function releaseLease(userId: string, holder: string) {
  'use step'
  return store.releaseLease(userId, holder)
}

export async function failTurn(userId: string, holder: string, error: string) {
  'use step'
  await store.failTurn(userId, holder, error)
}

export async function appendMessages(userId: string, holder: string, messages: ModelMessage[], warning: string | null = null, actionContext?: ActionContext) {
  'use step'
  await store.appendMessages(userId, holder, messages, warning, actionContext)
}

/**
 * Folds older messages into the summary once the conversation passes the
 * token budget, then returns the prompt for this turn: the instructions with
 * the person's memory, and the messages.
 */
export async function preparePrompt(userId: string): Promise<{ instructions: string; messages: ModelMessage[] }> {
  'use step'
  await reconcileFactoryRuns(userId)
  await factoryMonitor.reconcile(userId)
  let { summary, memory, messages } = await store.loadConversation(userId)
  const cut = compactionCut(summary, messages)
  if (cut !== null) {
    const folded = messages.filter(row => row.position <= cut)
    await authorizeModel(userId, coordinatorRoute(COORDINATOR_MODEL))
    const { text } = await generateText({
      model: COORDINATOR_MODEL,
      instructions: SUMMARY_INSTRUCTIONS,
      messages: [...promptMessages(summary, folded), { role: 'user', content: 'Write the summary now.' }],
    })
    await store.saveSummary(userId, text, cut)
    summary = text
    messages = messages.filter(row => row.position > cut)
  }
  return { instructions: instructionsWithMemory(`${COORDINATOR_INSTRUCTIONS}\n\n${MAILBOX_INSTRUCTIONS}`, memory), messages: promptMessages(summary, messages) }
}

export async function remember(userId: string, input: { note: string }) {
  'use step'
  return store.editMemory(userId, memory => {
    const next = rememberNote(memory, input.note)
    return next === null ? { error: 'memoryFull: forget something first' } : { memory: next, result: { remembered: true } }
  })
}

export async function forget(userId: string, input: { text: string }) {
  'use step'
  return store.editMemory(userId, memory => {
    const { memory: next, removed } = forgetNotes(memory, input.text)
    return { memory: next, result: { removed } }
  })
}

export async function composioAction(userId: string, action: ComposioActionName, input: unknown) {
  'use step'
  await authorizePolicyTool(userId)
  return runComposioAction(userId, action, input)
}

export async function proposeAccountAction(userId: string, action: ApprovalActionName, input: unknown, context?: ActionContext, options?: Pick<ToolExecutionOptions<unknown>, 'messages' | 'toolCallId'>) {
  'use step'
  await authorizePolicyTool(userId)
  if (action === 'create_calendar_event') {
    if (!context || !options) return { error: 'accountActionSourceRequired' }
    try { return await proposeCalendarBatch(userId, context, options) }
    catch (error) { if (error instanceof OperationError) return { error: error.message }; throw error }
  }
  return proposeAction(userId, action, input)
}

export async function listIssues(userId: string, input: { status?: string }) {
  'use step'
  const rows = await db.selectDistinct({ id: issues.id, title: issues.title, status: issues.status, priority: issues.priority, content: issues.content, updatedAt: issues.updatedAt })
    .from(issues).leftJoin(issueMembers, and(eq(issueMembers.issueId, issues.id), eq(issueMembers.memberId, userId)))
    .where(and(or(eq(issues.userId, userId), eq(issueMembers.memberId, userId)), input.status ? eq(issues.status, input.status) : undefined))
    .orderBy(desc(issues.updatedAt)).limit(100)
  return rows.filter(row => !readIssueMetadata(row.content).deletedAt).slice(0, 50).map(({ content, updatedAt, ...row }) => ({
    ...row, number: readIssueMetadata(content).number ?? null, updatedAt: updatedAt.toISOString(),
  }))
}

export async function getIssue(userId: string, input: { issueId: string }) {
  'use step'
  const issue = await issueForUser(userId, input.issueId)
  if (!issue) return { error: 'issueNotFound' }
  const runs = await db.select(runViewColumns).from(agentRuns).innerJoin(agents, eq(agents.id, agentRuns.agentId))
    .where(and(eq(agentRuns.issueId, issue.id), eq(agentRuns.userId, userId))).orderBy(desc(agentRuns.createdAt)).limit(5)
  const {tasks: factory} = await factoryStore.listForIssue(userId,issue.id)
  return {
    id: issue.id, number: readIssueMetadata(issue.content).number ?? null, title: issue.title,
    status: issue.status, priority: issue.priority, body: tiptapToText(issue.content).slice(0, 8000),
    runs: runs.map(run => ({ id: run.id, agent: run.agentName, status: run.status, createdAt: run.createdAt.toISOString() })),
    factory: factory.map(({id,...task})=>({taskId:id,...task})),
  }
}

export async function listAgents(userId: string) {
  'use step'
  const rows = await db.select({ id: agents.id, name: agents.name, description: agents.description, harness: agents.harness, deviceId: agents.deviceId, deviceName: devices.name, enabled: devices.enabled, lastSeenAt: devices.lastSeenAt })
    .from(agents).leftJoin(devices, eq(devices.id, agents.deviceId)).where(eq(agents.userId, userId)).orderBy(asc(agents.name))
  const deviceIds = [...new Set(rows.map(row => row.deviceId).filter((id): id is string => Boolean(id)))]
  const repos = deviceIds.length ? await db.select().from(deviceRepos).where(inArray(deviceRepos.deviceId, deviceIds)) : []
  return rows.map(row => ({
    id: row.id, name: row.name, description: row.description, harness: row.harness, device: row.deviceName,
    deviceOnline: Boolean(row.enabled && row.lastSeenAt && Date.now() - row.lastSeenAt.getTime() < DEVICE_ONLINE_WINDOW_MS),
    repos: repos.filter(repo => repo.deviceId === row.deviceId).map(repo => ({ id: repo.id, path: repo.repoPath, baseBranch: repo.baseBranch })),
  }))
}

export async function dispatchRun(userId: string, input: FactoryDispatchInput, context?: ActionContext, options?: Pick<ToolExecutionOptions<unknown>, 'messages' | 'toolCallId'>) {
  'use step'
  await authorizePolicyTool(userId)
  return asToolResult(async () => {
    if (context && options) await prepareAccountActionBatch(userId, context, options)
    return dispatchFactoryRun(userId, input, undefined, context?.sourceEventId)
  })
}

export async function selectBaselineSkill(userId: string, input: { runId:string }) {
  'use step'
  await authorizePolicyTool(userId)
  return asToolResult(() => skillAssignments.selectBaseline(userId,input.runId))
}
export async function dispatchBaselineRehearsal(userId:string,input:Omit<ImprovementRehearsal,'action'>) {
  'use step'
  await authorizePolicyTool(userId)
  return asToolResult(()=>improvementFactory.rehearse(userId,{action:'rehearse',...input}))
}
export async function recordRunFeedback(userId: string, input: Omit<Feedback,'action'>) {
  'use step'
  await authorizePolicyTool(userId)
  return asToolResult(() => improvementStore.recordFeedback(userId,{ action:'feedback',...input }))
}
export async function proposeSkillImprovement(userId: string, input: { runId:string }) {
  'use step'
  await authorizePolicyTool(userId)
  return asToolResult(() => improvementStore.propose(userId,input.runId))
}
export async function readRunImprovements(userId: string, input: { runId:string }) {
  'use step'
  return asToolResult(() => improvementStore.read(userId,input.runId))
}
export async function handoffSkillImprovement(userId: string, input: Omit<ImprovementHandoff,'action'>) {
  'use step'
  await authorizePolicyTool(userId)
  return asToolResult(() => improvementFactory.handoff(userId,{ action:'handoff',...input }))
}
export async function getSkillImprovementFactory(userId: string, input: { proposalId:string }) {
  'use step'
  return asToolResult(() => improvementFactory.status(userId,input.proposalId))
}

export async function listFactoryRequests(userId: string) {
  'use step'
  const rows = await db
    .select({
      sourceEventId: coordinatorEvents.id,
      payload: coordinatorEvents.payload,
      createdAt: coordinatorEvents.createdAt,
    })
    .from(coordinatorEvents)
    .where(
      and(
        eq(coordinatorEvents.userId, userId),
        eq(coordinatorEvents.kind, 'user_message'),
      ),
    )
    .orderBy(desc(coordinatorEvents.createdAt))
    .limit(10)
  return rows.map((row) => ({
    sourceEventId: row.sourceEventId,
    text: String(row.payload.text ?? ''),
    createdAt: row.createdAt,
    ...(typeof row.payload.questionId === 'string'
      ? { questionId: row.payload.questionId }
      : {}),
  }))
}

export async function routeFactoryTask(userId: string, input: Omit<FactoryRoute,'eventId'>) {
  'use step'
  await authorizePolicyTool(userId)
  return asToolResult(() => factoryStore.route(userId,{...input,eventId:input.sourceEventId}))
}

export async function getFactoryTask(
  userId: string,
  input: { taskId: string },
) {
  'use step'
  return asToolResult(async () => ({
    ...(await factoryStore.read(userId, input.taskId)),
    questions: await factoryQuestions.list(userId, input.taskId),
  }))
}

export async function listFactoryQuestions(
  userId: string,
  input: { taskId?: string },
) {
  'use step'
  return asToolResult(() =>
    input.taskId
      ? factoryQuestions.list(userId, input.taskId)
      : factoryQuestions.pending(userId),
  )
}

export async function getFactoryQuestion(
  userId: string,
  input: { questionId: string },
) {
  'use step'
  return asToolResult(() => factoryQuestions.read(userId, input.questionId))
}

export async function answerFactoryContext(
  userId: string,
  input: ContextQuestionAnswer,
) {
  'use step'
  await authorizePolicyTool(userId)
  return asToolResult(() =>
    factoryQuestions.answer({ source: 'orchestrator', userId }, input),
  )
}

export async function escalateFactoryQuestion(
  userId: string,
  input: { reference: QuestionReference; eventId: string; reason: string },
) {
  'use step'
  return asToolResult(() => factoryQuestions.escalate(userId, input))
}

export async function answerFactoryQuestionFromUser(
  userId: string,
  input: {
    reference: QuestionReference
    answerId: string
    sourceEventId: string
  },
) {
  'use step'
  await authorizePolicyTool(userId)
  return asToolResult(async () => {
    const [event] = await db
      .select({ payload: coordinatorEvents.payload })
      .from(coordinatorEvents)
      .where(
        and(
          eq(coordinatorEvents.id, input.sourceEventId),
          eq(coordinatorEvents.userId, userId),
          eq(coordinatorEvents.kind, 'user_message'),
        ),
      )
      .limit(1)
    if (!event || typeof event.payload.text !== 'string')
      throw new FactoryError('factoryHumanRequired')
    return factoryQuestions.answer(
      { source: 'human_event', userId },
      { ...input, text: event.payload.text },
    )
  })
}

export async function resolveFactoryTask(userId: string, input: { binding: FactoryBinding; sourceEventId: string; rationale: string; missingInformation: string[]; missingPermissions: string[]; needsSpec: boolean }) {
  'use step'
  await authorizePolicyTool(userId)
  const {binding,...resolution} = input
  return asToolResult(() => factoryStore.apply(userId,binding,input.sourceEventId,{action:'resolve',...resolution}))
}

export async function stopFactoryTask(userId: string, input: { binding: FactoryBinding; reason: string; action: 'cancel' | 'revoke' }) {
  'use step'
  return asToolResult(() => factoryStore.apply(userId,input.binding,factoryEventId(input.action,input.binding.attemptId),{action:input.action,reason:input.reason}))
}

export async function listRuns(userId: string, input: { issueId?: string; activeOnly?: boolean }) {
  'use step'
  const active = ['queued', 'preparing', 'running', 'waiting_input', 'finishing'] as const
  const rows = await db.select(runViewColumns).from(agentRuns).innerJoin(agents, eq(agents.id, agentRuns.agentId))
    .where(and(eq(agentRuns.userId, userId), input.issueId ? eq(agentRuns.issueId, input.issueId) : undefined, input.activeOnly ? inArray(agentRuns.status, [...active]) : undefined))
    .orderBy(desc(agentRuns.createdAt)).limit(20)
  return rows.map(run => ({ id: run.id, issueId: run.issueId, agent: run.agentName, status: run.status, stopReason: run.stopReason, createdAt: run.createdAt.toISOString() }))
}

export async function getRun(userId: string, input: { runId: string }) {
  'use step'
  const detail = await readRun(userId, input.runId)
  if (!detail) return { error: 'runNotFound' }
  const { run } = detail
  return {
    id: run.id, issueId: run.issueId, agent: run.agentName, harness: run.harness, status: run.status,
    stopReason: run.stopReason, error: run.error, summary: (run.report as { summary?: string } | null)?.summary ?? null,
    startedAt: run.startedAt?.toISOString() ?? null, finishedAt: run.finishedAt?.toISOString() ?? null,
    // The tail of the event stream, enough to see what the agent is doing.
    recentEvents: detail.chunks.slice(-5).map(chunk => JSON.stringify(chunk).slice(0, 1000)),
  }
}

export async function sendToRun(userId: string, input: { runId: string; text: string }) {
  'use step'
  await authorizePolicyTool(userId)
  return asToolResult(async () => { await addRunMessage(userId, input); return { sent: true } })
}

export async function stopRun(userId: string, input: { runId: string }) {
  'use step'
  return asToolResult(async () => {
    const [linked] = await db.select({taskId:factoryTasks.id}).from(factoryAttempts).innerJoin(factoryTasks,eq(factoryTasks.id,factoryAttempts.taskId))
      .where(and(eq(factoryAttempts.runId,input.runId),eq(factoryTasks.userId,userId))).limit(1)
    if (linked) {
      const {task} = await factoryStore.read(userId,linked.taskId)
      if (!['cancelled','revoked'].includes(task.status)) await factoryStore.apply(userId,{taskId:task.id,issueId:task.issueId,attemptId:task.attemptId,revision:task.revision,candidateId:task.candidateId},crypto.randomUUID(),{action:'cancel',reason:'Person requested run stop'})
    } else await requestRunStop(userId,input.runId)
    return {stopRequested:true}
  })
}

export async function recoverAccountActions(userId: string, context: ActionContext) {
  'use step'
  await authorizePolicyTool(userId)
  return recoverCalendarBatch(userId, context)
}

export async function mailboxAction(userId: string, action: 'recipients' | 'inbox' | 'sent' | 'send' | 'ack', input: { to?: string; key?: string; text?: string; replyTo?: string; ids?: string[] } = {}) {
  'use step'
  await authorizePolicyTool(userId)
  try {
    const actor = await mailboxes.conversation(userId, 'coordinator')
    switch (action) {
      case 'recipients': return await mailboxes.recipients(actor)
      case 'inbox': return await mailboxes.inbox(actor)
      case 'sent': return await mailboxes.sent(actor)
      case 'send': return await mailboxes.send(actor, input as { to: string; key: string; text: string; replyTo?: string })
      case 'ack': return await mailboxes.ack(actor, input.ids ?? [])
    }
  } catch (error) { if (error instanceof MailboxError) return { error: error.message }; throw error }
}

export async function authorizeCoordinator(userId: string, _round: number, _step: number) {
  'use step'
  await authorizeModel(userId, coordinatorRoute(COORDINATOR_MODEL))
}
