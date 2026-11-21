import type { DynamicModelContext } from 'eve'
import { defineState } from 'eve/context'
import { scopeFromAuth } from './scope'
import type { DefinitionSnapshot } from '../agent-kit/definition'
import type { HostedRuntimeSnapshot } from '../subscription-model-snapshot'
import type { ScheduledRead } from '../schedules/contract'

// The turn.started hook selects the person's model and Bot capabilities.
// Eve persists these business choices before evaluating the turn's definitions.
export const turnModel = defineState<HostedRuntimeSnapshot | null>('mikka.model', () => null)
export const turnPolicy = defineState<Pick<DefinitionSnapshot, 'definition' | 'effectiveTools' | 'personalPlugins'> | null>('mikka.policy', () => null)
export const turnRequest = defineState<{ sourceEventId?: string; scheduledRead: ScheduledRead | null; startIndex?: number }>('mikka.request', () => ({ scheduledRead: null }))

export async function modelForSession(ctx: DynamicModelContext) {
  // Eve evaluates authored definitions while compiling. Turn state must be
  // available then; loading model/workflow implementations belongs to a turn.
  const {evaluationForSession,evaluationModel}=await import('./evaluation-runtime')
  const evaluation=await evaluationForSession(ctx)
  if(evaluation)return evaluationModel(evaluation)
  const scope = scopeFromAuth(ctx.session.auth.current)
  const runtime = turnModel.get()
  if (!runtime || runtime.harness !== 'ai_sdk' || !runtime.model) throw new Error('subscription_model_unavailable')
  const { withModelEffort } = await import('../model-effort')
  if (!runtime.modelSelection) {
    const { HostedWorkflowModel } = await import('../abuse/workflow-model')
    return withModelEffort(new HostedWorkflowModel(scope.ownerId, scope.botId, runtime.model), runtime.effort)
  }
  const [{ SubscriptionWorkflowModel }, { streamingModel }] = await Promise.all([
    import('../subscription-workflow-model'), import('./streaming-model'),
  ])
  const requestPolicy = ctx.session.parent || turnRequest.get().scheduledRead ? undefined : { codexServiceTier: 'priority' as const }
  return withModelEffort(streamingModel(new SubscriptionWorkflowModel(runtime.modelSelection, requestPolicy)), runtime.effort)
}

export async function instructionsForSession(ctx: DynamicModelContext) {
  const {evaluationForSession}=await import('./evaluation-runtime')
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
