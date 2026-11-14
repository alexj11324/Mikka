import type { DynamicModelContext } from 'eve'
import { defineState } from 'eve/context'
import {evaluationForSession,evaluationModel} from './evaluation-runtime'
import { HostedWorkflowModel } from '../abuse/workflow-model'
import { SubscriptionWorkflowModel } from '../subscription-workflow-model'
import { scopeFromAuth } from './scope'
import { streamingModel } from './streaming-model'
import type { DefinitionSnapshot } from '../agent-kit/definition'
import type { HostedRuntimeSnapshot } from '../subscription-model-snapshot'
import type { ScheduledRead } from '../schedules/contract'

// The turn.started hook selects the person's model and Bot capabilities.
// Eve persists these business choices before evaluating the turn's definitions.
export const turnModel = defineState<HostedRuntimeSnapshot | null>('mikka.model', () => null)
export const turnPolicy = defineState<Pick<DefinitionSnapshot, 'definition' | 'effectiveTools' | 'personalPlugins'> | null>('mikka.policy', () => null)
export const turnRequest = defineState<{ sourceEventId?: string; scheduledRead: ScheduledRead | null }>('mikka.request', () => ({ scheduledRead: null }))

export async function modelForSession(ctx: DynamicModelContext) {
  const evaluation=await evaluationForSession(ctx)
  if(evaluation)return evaluationModel(evaluation)
  const scope = scopeFromAuth(ctx.session.auth.current)
  const runtime = turnModel.get()
  if (!runtime || runtime.harness !== 'ai_sdk' || !runtime.model) throw new Error('subscription_model_unavailable')
  return runtime.modelSelection ? streamingModel(new SubscriptionWorkflowModel(runtime.modelSelection)) : new HostedWorkflowModel(scope.ownerId, scope.botId, runtime.model)
}

export async function instructionsForSession(ctx: DynamicModelContext) {
  const evaluation=await evaluationForSession(ctx)
  if(evaluation)return evaluation.instructions
  const scope = scopeFromAuth(ctx.session.auth.current)
  const { scheduledRead } = turnRequest.get()
  if (scheduledRead) return `This is an authorized scheduled read-only task. Use only the provided read tools. Do not request approval, create schedules or perform writes. Return the result for the original chat.\n${scheduledRead.prompt}`
  // Slack gets product policy but never private web history, memory or profile.
  if (scope.surface === 'slack') {
    const { COORDINATOR_INSTRUCTIONS } = await import('../coordinator/instructions')
    return COORDINATOR_INSTRUCTIONS + '\nUse only this Slack conversation. Do not access private web chat history or memories. Reply in the same thread; call no_reply when no useful response is needed.'
  }
  const { asProductPrincipal } = await import('./product-definitions')
  return asProductPrincipal(scope, async () => {
    const { composeEveInstructions } = await import('../coordinator/product-instructions')
    return composeEveInstructions(scope.ownerId, scope.botId, undefined, { sessionId: ctx.session.id, turnId: ctx.turn!.id }, turnPolicy.get() ?? undefined)
  })
}
