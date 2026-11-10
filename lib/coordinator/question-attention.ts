import type { ModelMessage } from 'ai'
import { z } from 'zod'
import { FactoryError } from '../factory/contract'
import { questionReferenceSchema, type QuestionReference } from '../factory/questions/schema'

export interface AttentionQuestion {
  eventId: string
  taskId: string
  issueId: string
  questionId: string
  runId: string
}
interface QuestionEvent {
  id: string
  kind: string
  tier: string | null
  issueId: string | null
  runId: string | null
  payload: Record<string, unknown>
  triageDecision: unknown
}
const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
const uuid = (value: unknown): value is string => z.uuid().safeParse(value).success

/** Reuse the owned inbox rows and their actual model receipts, not event prose. */
export function attentionQuestionsFromEvents(events: readonly QuestionEvent[]): AttentionQuestion[] {
  return events.flatMap(event => {
    const receipt = record(event.triageDecision)
    const observed = record(receipt?.observedRun)
    const execution = record(receipt?.execution)
    if (event.kind !== 'run_question' || event.tier !== 'attention' || event.payload.needsUser === true ||
        receipt?.method !== 'model' || receipt.chosenTier !== 'attention' ||
        receipt.eventId !== event.id || receipt.eventKind !== event.kind ||
        observed?.id !== event.runId || !execution ||
        typeof execution.executionId !== 'string' || !execution.executionId ||
        typeof execution.providerGenerationId !== 'string' || !execution.providerGenerationId ||
        typeof execution.requestDigest !== 'string' || !/^[a-f0-9]{64}$/.test(execution.requestDigest) ||
        !uuid(event.id) || !uuid(event.issueId) || !uuid(event.runId) ||
        !uuid(event.payload.taskId) || !uuid(event.payload.questionId)) return []
    return [{ eventId: event.id, taskId: event.payload.taskId, issueId: event.issueId,
      questionId: event.payload.questionId, runId: event.runId }]
  })
}

interface Part { index: number; role: string; value: Record<string, unknown> }
function toolParts(messages: readonly ModelMessage[]): Part[] {
  return messages.flatMap(message => Array.isArray(message.content)
    ? message.content.flatMap(value => {
      const part = record(value)
      return part && (part.type === 'tool-call' || part.type === 'tool-result')
        ? [{ role: message.role, value: part }] : []
    }) : []).map((part, index) => ({ ...part, index }))
}
function pairedOutput(parts: readonly Part[], call: Part): unknown {
  const id = call.value.toolCallId
  if (typeof id !== 'string' || !id ||
      parts.filter(part => part.role === 'assistant' && part.value.type === 'tool-call' && part.value.toolCallId === id).length !== 1) return undefined
  const outputs = parts.filter(part => part.role === 'tool' && part.value.type === 'tool-result' &&
    part.value.toolCallId === id && part.value.toolName === call.value.toolName)
  if (outputs.length !== 1 || outputs[0].index <= call.index) return undefined
  const output = record(outputs[0].value.output)
  return output?.type === 'json' ? output.value : undefined
}
const completedQuestionStates = new Set(['waiting_user', 'answered', 'resuming', 'resolved', 'blocked', 'cancelled', 'expired', 'superseded'])
const questionWrites = new Set(['escalate_factory_question', 'answer_factory_context', 'answer_factory_question_from_user'])

function failedReceipt(output: unknown): never {
  const error = record(output)?.error
  // The normal scoped step returns closed Factory/Action errors, never model prose.
  throw new FactoryError(typeof error === 'string' && error ? error : 'factoryQuestionPending')
}

/**
 * The model has already selected attention and read this permission question.
 * Finish the missing durable handoff before publishing its reply. This never
 * answers, grants permission, starts work, reads the DB, or retries a tool call.
 * The existing scoped escalation service rechecks current owner/task/native fences.
 */
export async function completeAttentionQuestions(
  events: readonly AttentionQuestion[],
  messages: readonly ModelMessage[],
  context: {
    userId: string
    enabled: boolean
    signal?: AbortSignal
    escalate(input: { reference: QuestionReference; eventId: string; reason: string }): Promise<unknown>
  },
): Promise<number> {
  if (!context.enabled || context.signal?.aborted || !events.length) return 0
  const parts = toolParts(messages)
  const handled = new Set<string>()
  let completed = 0
  for (const event of events) {
    if (context.signal?.aborted) return completed
    if (handled.has(event.questionId)) continue
    handled.add(event.questionId)
    const reads = parts.filter(part => part.role === 'assistant' && part.value.type === 'tool-call' &&
      part.value.toolName === 'list_factory_questions' && record(part.value.input)?.taskId === event.taskId)
    let question: Record<string, unknown> | null = null
    for (const read of reads) {
      const output = pairedOutput(parts, read)
      if (!Array.isArray(output)) continue
      const matches = output.map(record).filter(value => value?.id === event.questionId)
      if (matches.length === 1) question = matches[0]
    }
    if (!question || question.userId !== context.userId || question.taskId !== event.taskId ||
        question.issueId !== event.issueId || question.sourceEventId !== event.eventId ||
        question.originRunId !== event.runId || question.kind !== 'permission' ||
        question.status !== 'open' || question.answerId != null ||
        question.continuationRunId != null || question.escalationEventId != null) continue
    const reference = questionReferenceSchema.safeParse(question.reference)
    if (!reference.success || reference.data.questionId !== event.questionId ||
        reference.data.questionRevision !== question.revision ||
        reference.data.binding.taskId !== event.taskId || reference.data.binding.issueId !== event.issueId ||
        reference.data.binding.attemptId !== question.attemptId ||
        reference.data.binding.candidateId !== question.candidateId ||
        reference.data.originRunId !== event.runId ||
        reference.data.originSessionId !== question.originSessionId) continue

    const writes = parts.filter(part => part.role === 'assistant' && part.value.type === 'tool-call' &&
      questionWrites.has(String(part.value.toolName)) &&
      record(record(part.value.input)?.reference)?.questionId === event.questionId)
    if (writes.length) {
      // A lost/error/ambiguous receipt is not permission to repeat a possible write.
      const outputs = writes.map(write => pairedOutput(parts, write))
      const settled = outputs.some(output => {
        const value = record(output)
        return value && (value.id === event.questionId || value.questionId === event.questionId) &&
          (completedQuestionStates.has(String(value.status)) || uuid(value.continuationRunId))
      })
      if (!settled) failedReceipt(outputs.find(output => record(output)?.error) ?? outputs[0])
      continue
    }
    const output = await context.escalate({
      reference: reference.data,
      // The real attention event is the stable request key. The normal service
      // derives its own question-escalated event and preserves its replay checks.
      eventId: event.eventId,
      reason: 'The Coordinator attention judgment requires a human answer to this permission question.',
    })
    const value = record(output)
    // The normal instrumented tool can observe stop during its before audit
    // and refuse the effect. Let the Workflow use its existing stopped path.
    if (context.signal?.aborted && value?.error === 'stopped') return completed
    if (!value || value.id !== event.questionId || !completedQuestionStates.has(String(value.status))) failedReceipt(output)
    completed++
  }
  return completed
}
