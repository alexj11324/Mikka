import 'server-only'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { COORDINATOR_MODEL } from '@/lib/coordinator/model'
import { ModelAdmissionError } from '@/lib/model-admission/contract'
import { workersAiTransport } from '../workers-ai-config'

export const workersAiModelId = '@cf/deepseek-ai/deepseek-v4.1-flash-1017'

/** One physical model on the account selected by the operator. No caller can supply a URL or key. */
export function workersAiConfig(modelId: string, env = process.env) {
  const transport = workersAiTransport(env)
  if (modelId !== COORDINATOR_MODEL || !transport) throw new ModelAdmissionError('modelRouteDenied')
  return transport
}

export function workersAiModel(config: ReturnType<typeof workersAiConfig>) {
  return createOpenAICompatible({
    name: 'cloudflare-workers-ai', baseURL: config.baseURL, apiKey: config.key, includeUsage: true,
    fetch: (input, init) => fetch(input, { ...init, redirect: 'error' }),
  }).chatModel(workersAiModelId)
}

/** https://developers.cloudflare.com/ai/models/@cf/deepseek-ai/deepseek-v4.1-flash-1017/
 * List-price usage in microdollars, before any account-level Startup Credit. */
export function workersAiCost(usage: { inputTokens: { total?: number; cacheRead?: number }; outputTokens: { total?: number }; raw?: unknown }): number | null {
  const raw = usage.raw as { prompt_tokens?: unknown; completion_tokens?: unknown; prompt_tokens_details?: { cached_tokens?: unknown } } | undefined
  const input = usage.inputTokens.total, cached = usage.inputTokens.cacheRead, output = usage.outputTokens.total
  // The compatibility SDK synthesizes a zero cache count when the provider omits it.
  if (!raw || raw.prompt_tokens !== input || raw.completion_tokens !== output || raw.prompt_tokens_details?.cached_tokens !== cached) return null
  if (input === undefined || cached === undefined || output === undefined || ![input,cached,output].every(Number.isSafeInteger)
    || input < 0 || output < 0 || cached < 0 || cached > input) return null
  const milliMicroUsd = (input - cached) * 300 + cached * 6 + output * 1200
  return Number.isSafeInteger(milliMicroUsd) ? Math.ceil(milliMicroUsd / 1000) : null
}
