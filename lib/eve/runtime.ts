import type { DynamicModelContext } from 'eve'
import {evaluationForSession,evaluationModel} from './evaluation-runtime'
import { HostedWorkflowModel } from '../abuse/workflow-model'
import { SubscriptionWorkflowModel } from '../subscription-workflow-model'
import { assertEveScope, scopeFromAuth } from './scope'
import { streamingModel } from './streaming-model'
import { prepareEveExecution, productRpc } from './product-rpc'

/** The immutable execution is a Mikka policy/model grant, not model history. */
export async function executionForSession(ctx: DynamicModelContext) {
  const scope = await assertEveScope(scopeFromAuth(ctx.session.auth.current))
  if (!ctx.turn) throw new Error('agentExecutionClosed')
  const prepared = await ctx.memo(['mikka-execution', ctx.turn.id], async () => {
    return prepareEveExecution(scope,ctx.session.id,ctx.turn!.id)
  })
  // Answers retain the original request's authority, rather than creating a
  // new human request. This memo is owned by the native eve turn.
  const sourceEventId = await ctx.memo(['mikka-source',ctx.turn.id], async () => {
    const {pool} = await import('../db')
    return (await pool.query<{source_event_id:string}>('SELECT source_event_id FROM eve_turn_sources WHERE session_id=$1 AND turn_id=$2',[ctx.session.id,ctx.turn!.id])).rows[0]?.source_event_id ?? null
  })
  const scheduledRead = sourceEventId ? await (await import('./scheduled-read')).loadScheduledRead(scope,sourceEventId) : null
  return { scope, ...prepared, sourceEventId, scheduledRead }
}

export async function modelForSession(ctx: DynamicModelContext) {
  const evaluation=await evaluationForSession(ctx)
  if(evaluation)return evaluationModel(evaluation)
  const { scope, runtime } = await executionForSession(ctx)
  if (runtime.harness !== 'ai_sdk' || !runtime.model) throw new Error('subscription_model_unavailable')
  return runtime.modelSelection ? streamingModel(new SubscriptionWorkflowModel(runtime.modelSelection)) : new HostedWorkflowModel(scope.ownerId, scope.botId, runtime.model)
}

export async function instructionsForSession(ctx: DynamicModelContext) {
  const evaluation=await evaluationForSession(ctx)
  if(evaluation)return evaluation.instructions
  const { scope, execution, scheduledRead } = await executionForSession(ctx)
  if (scheduledRead) return `This is an authorized scheduled read-only task. Use only the provided read tools. Do not request approval, create schedules or perform writes. Return the result for the original chat.\n${scheduledRead.prompt}`
  // Slack gets product policy but never private web history, memory or profile.
  if (scope.surface === 'slack') {
    const { COORDINATOR_INSTRUCTIONS } = await import('../coordinator/instructions')
    return COORDINATOR_INSTRUCTIONS + '\nUse only this Slack conversation. Do not access private web chat history or memories. Reply in the same thread; call no_reply when no useful response is needed.'
  }
  return (await productRpc<{instructions:string}>(scope,{operation:'instructions',sessionId:ctx.session.id,turnId:ctx.turn!.id,executionId:execution?.id})).instructions
}
