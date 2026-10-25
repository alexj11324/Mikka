import 'server-only'
import type { ModelMessage, ToolExecutionOptions } from 'ai'
import { pool } from '../db'
import { calendarOperations } from './calendar-runtime'
import { createActionIntents, intentKeyForSlot, type ActionContext } from './action-intents'
import { OperationError } from './ledger'

export const actionIntents = () => createActionIntents(pool)
async function materialize(owner: string, context: ActionContext, slot: Awaited<ReturnType<ReturnType<typeof createActionIntents>['slots']>>[number]) {
  const result = await calendarOperations().propose(owner, slot.input, intentKeyForSlot(context.sourceEventId, slot.actionSlotId), { ...context, actionSlotId: slot.actionSlotId })
  const ref = await actionIntents().bindProposal(owner, context, slot, result.actionId)
  return { ...result, ref }
}
export async function proposeCalendarBatch(owner: string, context: ActionContext, options: Pick<ToolExecutionOptions<unknown>, 'messages' | 'toolCallId'>) {
  const assistant = options.messages.findLast(m => m.role === 'assistant')
  if (!assistant || !Array.isArray(assistant.content)) throw new OperationError('accountActionBatchInvalid')
  const calls = assistant.content.filter(p => p.type === 'tool-call').map(p => ({ toolCallId: p.toolCallId, toolName: p.toolName, input: p.input }))
  const slots = await actionIntents().persistBatch(owner, context, calls)
  const slot = slots.find(s => s.toolCallId === options.toolCallId)
  if (!slot) throw new OperationError('accountActionSlotConflict')
  return materialize(owner, context, slot)
}
/** Read the persisted plan before a new workflow calls the model. This only
 * materializes approval proposals; it never approves or sends to a provider. */
export async function recoverCalendarBatch(owner: string, context: ActionContext): Promise<ModelMessage[]> {
  const slots = await actionIntents().slots(owner, context)
  if (!slots.length) return []
  const results: Awaited<ReturnType<typeof materialize>>[] = []
  for (const slot of slots) results.push(await materialize(owner, context, slot))
  return [
    { role: 'assistant', content: slots.map(s => ({ type: 'tool-call' as const, toolCallId: s.toolCallId, toolName: 'create_calendar_event', input: s.input })) },
    { role: 'tool', content: slots.map((s, i) => ({ type: 'tool-result' as const, toolCallId: s.toolCallId, toolName: 'create_calendar_event', output: { type: 'json' as const, value: results[i] } })) },
  ]
}

/** Dispatch and Calendar wrappers share the same pre-tool barrier. Parallel
 * dispatch cannot race ahead of a Calendar proposal in its assistant batch. */
export async function prepareAccountActionBatch(owner: string, context: ActionContext, options: Pick<ToolExecutionOptions<unknown>, 'messages' | 'toolCallId'>) {
  const assistant = options.messages.findLast(m => m.role === 'assistant')
  if (!assistant || !Array.isArray(assistant.content)) return
  const calls = assistant.content.filter(p => p.type === 'tool-call').map(p => ({ toolCallId: p.toolCallId, toolName: p.toolName, input: p.input }))
  if (!calls.some(c => c.toolName === 'create_calendar_event')) return
  for (const slot of await actionIntents().persistBatch(owner, context, calls)) await materialize(owner, context, slot)
}
