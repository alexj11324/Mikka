import { assertNativeToolScope, type NativeToolScope } from './tool-scope'
import { and,desc,eq,isNull } from 'drizzle-orm'
import { ActionFailureError } from '@/lib/action-error'
import { db } from '@/lib/db'
import { coordinatorEvents } from '@/lib/db/schema'
import { createIssueFromRequest } from '@/lib/coordinator/issue-create'
import { FactoryError, type FactoryBinding, type FactoryRoute } from '@/lib/factory/contract'
import type { FactoryDispatchInput } from '@/lib/factory/dispatch'
import { factoryEventId } from '@/lib/factory/event-id'
import { dispatchFactoryRun, factoryStore, factoryQuestions } from '@/lib/factory/server'
import type { QuestionReference, ContextQuestionAnswer } from '@/lib/factory/questions/contract'
import { improvementStore, skillAssignments, improvementFactory, skillRegistry, skillEvaluations } from '@/lib/self-improvement/server'
import { readCommittedSkill } from '@/lib/self-improvement/source'
import { ImprovementError, type Feedback, type ImprovementHandoff, type ImprovementRehearsal, type ImprovementRegistration, type SkillEvaluationCommand } from '@/lib/self-improvement/contract'

type ToolResult<T> = T | { error: string }

async function asToolResult<T>(fn: () => Promise<T>): Promise<ToolResult<T>> {
  try {
    return await fn()
  } catch (error) {
    if (error instanceof ActionFailureError || error instanceof FactoryError || error instanceof ImprovementError) return { error: error.code }
    throw error
  }
}

export async function dispatchRun(userId: string, input: FactoryDispatchInput, scope?: NativeToolScope) {
  'use step'
  await assertNativeToolScope(userId,scope)
  return asToolResult(() => dispatchFactoryRun(userId, input))
}

export async function selectBaselineSkill(userId: string, input: { runId:string }, scope?: NativeToolScope) {
  'use step'
  await assertNativeToolScope(userId,scope)
  return asToolResult(() => skillAssignments.selectBaseline(userId,input.runId))
}

export async function selectActiveSkill(userId: string, input: { runId: string }, scope?: NativeToolScope) {
  'use step'
  await assertNativeToolScope(userId,scope)
  return asToolResult(() => skillAssignments.selectActive(userId,input.runId))
}

export async function registerSkillCandidate(userId: string, input: Omit<ImprovementRegistration,'action'>, scope?: NativeToolScope) {
  'use step'
  await assertNativeToolScope(userId,scope)
  return asToolResult(() => skillRegistry.registerCandidate(userId,input,async source => {
    const markdown = await readCommittedSkill(source)
    await assertNativeToolScope(userId,scope)
    return markdown
  }))
}

export async function skillEvaluation(userId: string, input: SkillEvaluationCommand, scope?: NativeToolScope) {
  'use step'
  await assertNativeToolScope(userId,scope)
  return asToolResult(async () => {
    switch (input.action) {
      case 'freeze_benchmark': return skillEvaluations.freezeBenchmark(userId,input.sourceRunId)
      case 'dispatch_training': return skillEvaluations.dispatchNext(userId,input.instanceId,true)
      case 'begin_evaluation': return skillEvaluations.beginEvaluation(userId,input.instanceId,input.proposalId,input.candidateVersionId)
      case 'dispatch_evaluation': return skillEvaluations.dispatchNext(userId,input.evaluationId,false)
      case 'compare_evaluation': return skillEvaluations.compare(userId,input.evaluationId)
    }
  })
}

export async function dispatchBaselineRehearsal(userId:string,input:Omit<ImprovementRehearsal,'action'>, scope?: NativeToolScope) {
  'use step'
  await assertNativeToolScope(userId,scope)
  return asToolResult(()=>improvementFactory.rehearse(userId,{action:'rehearse',...input}))
}

export async function recordRunFeedback(userId: string, input: Omit<Feedback,'action'>, scope?: NativeToolScope) {
  'use step'
  await assertNativeToolScope(userId,scope)
  return asToolResult(() => improvementStore.recordFeedback(userId,{ action:'feedback',...input }))
}

export async function proposeSkillImprovement(userId: string, input: { runId:string }, scope?: NativeToolScope) {
  'use step'
  await assertNativeToolScope(userId,scope)
  return asToolResult(() => improvementStore.propose(userId,input.runId))
}

export async function readRunImprovements(userId: string, input: { runId:string }, scope?: NativeToolScope) {
  'use step'
  await assertNativeToolScope(userId,scope)
  return asToolResult(() => improvementStore.read(userId,input.runId))
}

export async function handoffSkillImprovement(userId: string, input: Omit<ImprovementHandoff,'action'>, scope?: NativeToolScope) {
  'use step'
  await assertNativeToolScope(userId,scope)
  return asToolResult(() => improvementFactory.handoff(userId,{ action:'handoff',...input }))
}

export async function getSkillImprovementFactory(userId: string, input: { proposalId:string }, scope?: NativeToolScope) {
  'use step'
  await assertNativeToolScope(userId,scope)
  return asToolResult(() => improvementFactory.status(userId,input.proposalId))
}

export async function listFactoryRequests(userId: string, scope?: NativeToolScope) {
  'use step'
  await assertNativeToolScope(userId,scope)
  const rows = await db
    .select({
      sourceEventId: coordinatorEvents.id,
      issueId: coordinatorEvents.issueId,
      payload: coordinatorEvents.payload,
      createdAt: coordinatorEvents.createdAt,
    })
    .from(coordinatorEvents)
    .where(
      and(
        eq(coordinatorEvents.userId, userId),
        eq(coordinatorEvents.kind, 'user_message'),
        isNull(coordinatorEvents.botId),
      ),
    )
    .orderBy(desc(coordinatorEvents.createdAt))
    .limit(10)
  return rows.map((row) => ({
    sourceEventId: row.sourceEventId,
    issueId: row.issueId,
    text: String(row.payload.text ?? ''),
    createdAt: row.createdAt,
    ...(typeof row.payload.questionId === 'string'
      ? { questionId: row.payload.questionId }
      : {}),
  }))
}

export async function createIssueFromRequestStep(userId: string, input: { sourceEventId: string; title: string }, scope?: NativeToolScope) {
  'use step'
  await assertNativeToolScope(userId,scope)
  return asToolResult(() => createIssueFromRequest(userId, input))
}

export async function routeFactoryTask(userId: string, input: Omit<FactoryRoute,'eventId'>, scope?: NativeToolScope) {
  'use step'
  await assertNativeToolScope(userId,scope)
  return asToolResult(() => factoryStore.route(userId,{...input,eventId:input.sourceEventId}))
}

type CoordinatorQuestionReference = Pick<QuestionReference, 'questionId' | 'questionRevision'>

function coordinatorQuestion(question: Awaited<ReturnType<typeof factoryQuestions.read>>) {
  return {
    ...question,
    reference: { questionId: question.reference.questionId, questionRevision: question.reference.questionRevision },
  }
}

async function resolveQuestionReference(userId: string, reference: CoordinatorQuestionReference): Promise<QuestionReference> {
  const question = await factoryQuestions.read(userId, reference.questionId)
  // Keep the caller's revision so the store can fence first writes and recognize original replays.
  return { ...question.reference, questionRevision: reference.questionRevision }
}

export async function getFactoryTask(
  userId: string,
  input: { taskId: string }, scope?: NativeToolScope) {
  'use step'
  await assertNativeToolScope(userId,scope)
  return asToolResult(async () => ({
    ...(await factoryStore.read(userId, input.taskId)),
    questions: (await factoryQuestions.list(userId, input.taskId)).map(coordinatorQuestion),
  }))
}

export async function listFactoryQuestions(
  userId: string,
  input: { taskId?: string }, scope?: NativeToolScope) {
  'use step'
  await assertNativeToolScope(userId,scope)
  return asToolResult(async () => (
    await (input.taskId
      ? factoryQuestions.list(userId, input.taskId)
      : factoryQuestions.pending(userId))
  ).map(coordinatorQuestion))
}

export async function getFactoryQuestion(
  userId: string,
  input: { questionId: string }, scope?: NativeToolScope) {
  'use step'
  await assertNativeToolScope(userId,scope)
  return asToolResult(async () => coordinatorQuestion(await factoryQuestions.read(userId, input.questionId)))
}

export async function answerFactoryContext(
  userId: string,
  input: Omit<ContextQuestionAnswer, 'reference'> & { reference: CoordinatorQuestionReference }, scope?: NativeToolScope) {
  'use step'
  await assertNativeToolScope(userId,scope)
  return asToolResult(async () => {
    const reference = await resolveQuestionReference(userId, input.reference)
    await assertNativeToolScope(userId,scope)
    return factoryQuestions.answer({ source: 'orchestrator', userId }, { ...input, reference })
  })
}

export async function escalateFactoryQuestion(
  userId: string,
  input: { reference: CoordinatorQuestionReference; eventId: string; reason: string }, scope?: NativeToolScope) {
  'use step'
  await assertNativeToolScope(userId,scope)
  return asToolResult(async () => {
    const reference = await resolveQuestionReference(userId, input.reference)
    await assertNativeToolScope(userId,scope)
    return coordinatorQuestion(await factoryQuestions.escalate(userId, { ...input, reference }))
  })
}

export async function answerFactoryQuestionFromUser(
  userId: string,
  input: {
    reference: CoordinatorQuestionReference
    answerId: string
    sourceEventId: string
  }, scope?: NativeToolScope) {
  'use step'
  await assertNativeToolScope(userId,scope)
  return asToolResult(async () => {
    const [event] = await db
      .select({ payload: coordinatorEvents.payload })
      .from(coordinatorEvents)
      .where(
        and(
          eq(coordinatorEvents.id, input.sourceEventId),
          eq(coordinatorEvents.userId, userId),
          eq(coordinatorEvents.kind, 'user_message'),
        isNull(coordinatorEvents.botId),
        ),
      )
      .limit(1)
    if (!event || typeof event.payload.text !== 'string')
      throw new FactoryError('factoryHumanRequired')
    const reference = await resolveQuestionReference(userId, input.reference)
    await assertNativeToolScope(userId,scope)
    return factoryQuestions.answer(
      { source: 'human_event', userId },
      { ...input, reference, text: event.payload.text },
    )
  })
}

export async function resolveFactoryTask(userId: string, input: { binding: FactoryBinding; sourceEventId: string; rationale: string; missingInformation: string[]; missingPermissions: string[]; needsSpec: boolean }, scope?: NativeToolScope) {
  'use step'
  await assertNativeToolScope(userId,scope)
  const {binding,...resolution} = input
  return asToolResult(() => factoryStore.apply(userId,binding,input.sourceEventId,{action:'resolve',...resolution}))
}

export async function stopFactoryTask(userId: string, input: { binding: FactoryBinding; reason: string; action: 'cancel' | 'revoke' }, scope?: NativeToolScope) {
  'use step'
  await assertNativeToolScope(userId,scope)
  return asToolResult(() => factoryStore.apply(userId,input.binding,factoryEventId(input.action,input.binding.attemptId),{action:input.action,reason:input.reason}))
}
