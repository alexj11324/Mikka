import { generateText, type ModelMessage } from 'ai'
import type { DefinitionSnapshot } from '../agent-kit/definition'
import { COORDINATOR_MODEL } from './model'

/** Compaction is inference too: a subscription turn must not silently bill
 * the host's default model while preparing its prompt. */
export async function summarizeConversation(ownerId: string, botId: string | null, snapshot: DefinitionSnapshot | undefined, options: { instructions: string; messages: ModelMessage[]; maxOutputTokens: number }) {
  const runtime = snapshot?.runtime
  if (runtime && runtime.modelSelection !== undefined) {
    if (runtime.harness !== 'ai_sdk' || !runtime.modelSelection) throw new Error('subscription_model_unavailable')
    const { resolveFrozenHostedModel } = await import('../subscription-model-snapshot')
    const { authorizeSubscriptionWorkspace, subscriptionRuntime } = await import('../subscription-runtime')
    const model = await resolveFrozenHostedModel({ ownerId, botId, workspaceId: runtime.modelSelection.workspaceId }, runtime, {
      service: () => subscriptionRuntime(), workspace: authorizeSubscriptionWorkspace,
    })
    const { streamText } = await import('ai')
    let failed = false
    const result = streamText({ ...options, model, maxRetries: 0, onError: () => { failed = true } })
    const text = await result.text
    if (failed || await result.finishReason === 'error') throw new Error('subscription_generation_failed')
    return { text }
  }
  // Preserve legacy/native summary behavior; hosted snapshots retain their saved model.
  const model = runtime?.harness === 'ai_sdk' ? runtime.model : COORDINATOR_MODEL
  if (!model) throw new Error('subscription_model_unavailable')
  return generateText({ ...options, model })
}
