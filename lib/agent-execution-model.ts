import type { LanguageModel } from 'ai'
import { SubscriptionRefusal } from '@mikka/protocol/subscription'
import { agentModelSourceSchema, resolveAgentModel } from './agent-model'
import { resolveAgentSubscription } from './agent-subscription'
import type { SubscriptionService } from './subscription-service'

/** Called with authenticated execution context, never browser-supplied ownership.
 * Run/definition snapshot selection belongs to the caller; this adapter resolves
 * only that explicit selection through the existing subscription service.
 */
export async function resolveAgentExecutionModel(
  context: { ownerId: string; consumerId: string; source?: unknown; signal?: AbortSignal },
  dependencies: {
    defaultModel(): LanguageModel
    subscriptionService(): SubscriptionService
    workspace(ownerId: string, workspaceId: string): Promise<void>
  },
): Promise<LanguageModel> {
  const checkCancelled = () => {
    if (context.signal?.aborted) throw new DOMException('Model resolution cancelled', 'AbortError')
  }
  checkCancelled()
  const parsed = context.source === undefined ? undefined : agentModelSourceSchema.safeParse(context.source)
  if (parsed && !parsed.success) throw new SubscriptionRefusal('binding_mismatch')
  const result = await resolveAgentModel(parsed?.data, {
    defaultModel: dependencies.defaultModel,
    subscriptionModel: async bindingId => {
      checkCancelled()
      const service = dependencies.subscriptionService()
      const model = await resolveAgentSubscription(context.ownerId, context.consumerId, bindingId, service,
        async (ownerId, workspaceId) => {
          checkCancelled()
          await dependencies.workspace(ownerId, workspaceId)
          checkCancelled()
        }, context.signal)
      checkCancelled()
      return model
    },
  })
  checkCancelled()
  return result
}
