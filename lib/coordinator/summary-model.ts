import type { ModelMessage } from 'ai'
import type { DefinitionSnapshot } from '../agent-kit/definition'
import { COORDINATOR_MODEL } from './model'
import { compactWithFrozenModel } from './compaction-model'

/** Compaction is inference too: a subscription turn must not silently bill
 * the host's default model while preparing its prompt. */
export async function summarizeConversation(ownerId: string, botId: string | null, snapshot: DefinitionSnapshot | undefined, options: { instructions: string; messages: ModelMessage[]; maxOutputTokens: number }) {
  const runtime = snapshot?.runtime ?? { harness: 'ai_sdk', model: COORDINATOR_MODEL }
  if (runtime.harness !== 'ai_sdk' || (runtime.modelSelection !== undefined && !runtime.modelSelection)) throw new Error('subscription_model_unavailable')
  const subscriptions = runtime.modelSelection ? await import('../subscription-runtime') : null
  try {
    const text = await compactWithFrozenModel({ ownerId, botId, workspaceId: runtime.modelSelection?.workspaceId ?? null }, runtime, options.messages, {
      service: () => { if (!subscriptions) throw new Error('subscription_model_unavailable'); return subscriptions.subscriptionRuntime() },
      workspace: async (owner, workspace) => { if (!subscriptions) throw new Error('subscription_model_unavailable'); await subscriptions.authorizeSubscriptionWorkspace(owner, workspace) },
    }, undefined, { instructions: options.instructions, maxOutputTokens: options.maxOutputTokens })
    return { text }
  } catch (error) {
    if (runtime.modelSelection && error instanceof Error && error.message === 'compactionModelUnavailable') throw new Error('subscription_generation_failed')
    throw error
  }
}
