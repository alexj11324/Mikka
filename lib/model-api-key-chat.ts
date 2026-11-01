import 'server-only'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import type { LanguageModel } from 'ai'
import { pool } from './db'
import { openApiKeyForChat } from './model-api-keys'
import type { HostedApiKeySnapshot } from './subscription-model-snapshot'

type V4Model = Extract<LanguageModel, { specificationVersion: 'v4' }>

async function open(frozen: HostedApiKeySnapshot): Promise<V4Model> {
  const { apiKey, baseUrl } = await openApiKeyForChat(pool, frozen.ownerId, frozen.workspaceId, frozen.keyId)
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
  return new Proxy(first, { get(target, property) {
    const member = Reflect.get(target, property, target)
    if (property === 'doStream' || property === 'doGenerate') {
      return async (...args: unknown[]) => {
        const current = await open(frozen)
        return Reflect.apply(Reflect.get(current, property, current) as (...a: unknown[]) => unknown, current, args)
      }
    }
    return member
  } })
}
