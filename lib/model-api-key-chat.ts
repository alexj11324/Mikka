import 'server-only'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import type { LanguageModel, ModelMessage } from 'ai'
import { pool } from './db'
import { openApiKeyForChat } from './model-api-keys'
import type { HostedApiKeySnapshot } from './subscription-model-snapshot'
import { observedModel } from './tracing/ai'
import { estimateTokens } from './coordinator/context'

type V4Model = Extract<LanguageModel, { specificationVersion: 'v4' }>

async function open(frozen: HostedApiKeySnapshot): Promise<V4Model> {
  if (frozen.consumerId) {
    const { botChatOwnerExclusive, liveBotChatAuthority } = await import('./collaboration/bot-chat')
    if (frozen.collaborationEventId) {
      await liveBotChatAuthority(pool, frozen.collaborationEventId, { ownerId: frozen.ownerId, botId: frozen.consumerId })
    } else if (!await botChatOwnerExclusive(pool, frozen.ownerId, frozen.consumerId)) throw Error('shared_bot_execution_authority_required')
  }
  const { apiKey, baseUrl } = await openApiKeyForChat(pool, frozen.ownerId, frozen.workspaceId, frozen.keyId, process.env,
    { actorId: frozen.actorId, model: frozen.modelId, credentialOwnerId: frozen.credentialOwnerId, credentialRevision: frozen.credentialRevision })
  const model = createOpenAICompatible({ name: 'mikka-api-key', baseURL: baseUrl, apiKey }).chatModel(frozen.modelId) as LanguageModel
  if (typeof model === 'string' || model.specificationVersion !== 'v4') throw new Error('subscription_model_unavailable')
  return model
}

/**
 * A bot chat frozen on an API key model (C22). The key is opened again for
 * every model call, so deleting it or withdrawing its share stops the chat at
 * its next call instead of switching to another credential (orchestration.md § 2).
 * The provider bills the key's owner; Mikka charges no credits (§ 7).
 */
export async function resolveApiKeyChatModel(frozen: HostedApiKeySnapshot): Promise<LanguageModel> {
  const first = await open(frozen)
  return observedModel(new Proxy(first, { get(target, property) {
    const member = Reflect.get(target, property, target)
    if (property === 'doStream' || property === 'doGenerate') {
      return async (...args: unknown[]) => {
        if (frozen.collaborationEventId) {
          const input = args[0] as Parameters<V4Model['doStream']>[0]
          // This is a conservative request-capacity bound, never a claim about
          // provider usage or cost. Actual attempts also have a durable budget.
          const size = estimateTokens([...input.prompt as ModelMessage[],
            { role: 'user', content: JSON.stringify(input.tools ?? []) }])
          if (size > 64_000) throw Error('shared_bot_input_capacity_exceeded')
          const { reserveBotChatModelCall } = await import('./collaboration/bot-chat')
          const { stepIdentity } = await import('./model-call-timing')
          const budget = await reserveBotChatModelCall(frozen, await stepIdentity())
          const deadline = AbortSignal.timeout(Math.max(1, budget.expiresAt - Date.now()))
          args[0] = { ...input, maxOutputTokens: Math.min(input.maxOutputTokens ?? budget.maxOutputTokens, budget.maxOutputTokens),
            abortSignal: input.abortSignal ? AbortSignal.any([input.abortSignal, deadline]) : deadline }
        }
        const current = await open(frozen)
        return Reflect.apply(Reflect.get(current, property, current) as (...a: unknown[]) => unknown, current, args)
      }
    }
    return member
  } }), { modelId: frozen.modelId, userId: frozen.ownerId, route: 'api_key', operation: frozen.coordinator ? 'coordinator' : 'bot' })
}
