import type { LanguageModel } from 'ai'
import { z } from 'zod'
import { SubscriptionRefusal } from '@mikka/protocol/subscription'

export const agentModelSourceSchema = z.object({
  type: z.literal('subscription'),
  bindingId: z.uuid(),
}).strict()
export type AgentModelSource = z.infer<typeof agentModelSourceSchema>

/** An explicit BYOS request can never reach the default paid model factory. */
export async function resolveAgentModel(
  source: AgentModelSource | undefined,
  factories: {
    defaultModel(): LanguageModel
    subscriptionModel?: (bindingId: string) => Promise<Exclude<LanguageModel, string>>
  },
): Promise<LanguageModel> {
  if (!source) return factories.defaultModel()
  if (!factories.subscriptionModel) throw new SubscriptionRefusal('backend_unavailable')
  return factories.subscriptionModel(source.bindingId)
}
