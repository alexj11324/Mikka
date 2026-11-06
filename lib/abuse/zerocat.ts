import 'server-only'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import type { LanguageModel } from 'ai'
import { ZEROCAT_MODEL_ENDPOINT } from '@/lib/model-admission/contract'
import { PaidResourceError } from './policy'

type Model = Extract<LanguageModel, { specificationVersion: 'v4' }>

/** ZeroCat's id for the model Mikka calls `deepseek/deepseek-v4.1-flash` (COORDINATOR_MODEL). */
export const ZEROCAT_MODEL_ID = 'deepseek-v4.1-flash'

/**
 * List price of the default model in USD per million tokens, the same rates
 * Vercel AI Gateway billed for it (rounded up from settled hosted_usage rows).
 * ZeroCat returns token counts but no cost, so a call is settled from these.
 * Output includes reasoning tokens.
 */
export const ZEROCAT_PRICE_USD_PER_MILLION = { input: 0.12, cachedInput: 0.012, output: 1 } as const

/** Base URL and key, from ZEROCAT_BASE_URL and ZEROCAT_API_KEY; null when either is missing. */
export function zeroCatConfig(env: Record<string, string | undefined> = process.env) {
  const baseURL = env.ZEROCAT_BASE_URL?.trim().replace(/\/+$/, '')
  const apiKey = env.ZEROCAT_API_KEY?.trim()
  return baseURL && apiKey ? { baseURL, apiKey } : null
}

/**
 * The default model through ZeroCat's OpenAI-compatible API. Without both
 * variables it refuses with the hosted "temporarily unavailable" code; it never
 * falls back to AI Gateway. Redirects are refused, as on the Gateway transport.
 */
export function createZeroCatModel(env: Record<string, string | undefined> = process.env): Model {
  const config = zeroCatConfig(env)
  if (!config) throw new PaidResourceError('usage_cost_unavailable', { detail: 'zerocat_unconfigured' })
  if (config.baseURL !== ZEROCAT_MODEL_ENDPOINT) throw new PaidResourceError('usage_cost_unavailable', { detail: 'zerocat_endpoint_unexpected' })
  return createOpenAICompatible({
    name: 'zerocat',
    baseURL: config.baseURL,
    apiKey: config.apiKey,
    includeUsage: true,
    fetch: (input, init) => fetch(input, { ...init, redirect: 'error' }),
  }).chatModel(ZEROCAT_MODEL_ID) as Model
}

interface Usage {
  inputTokens: { total?: number | undefined; cacheRead?: number | undefined }
  outputTokens: { total?: number | undefined }
}
/** Integer microdollars for one call's usage, or null when ZeroCat sent no token counts. */
export function zeroCatCost(usage: Usage | undefined): number | null {
  const input = usage?.inputTokens.total
  const output = usage?.outputTokens.total
  if (typeof input !== 'number' || typeof output !== 'number' || input < 0 || output < 0) return null
  const cached = Math.min(Math.max(usage?.inputTokens.cacheRead ?? 0, 0), input)
  const price = ZEROCAT_PRICE_USD_PER_MILLION
  // USD per million tokens equals microdollars per token.
  const cost = Math.ceil((input - cached) * price.input + cached * price.cachedInput + output * price.output)
  return Number.isSafeInteger(cost) ? cost : null
}
