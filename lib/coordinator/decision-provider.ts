import { liteLLMResponseCost } from '../model-gateway/litellm-client'

/** LiteLLM resolves the requested alias to its configured provider model. The
 * authenticated proxy's call ID binds that routing result and its spend log. */
export function decisionProviderReceipt(data: unknown, headers: Headers) {
  const envelope = (data && typeof data === 'object' ? data : {}) as { model?: unknown }
  const generation = headers.get('x-litellm-call-id') ?? undefined
  return {
    modelPresent: typeof envelope.model === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/.test(envelope.model),
    generation,
    cost: liteLLMResponseCost(headers),
  }
}
