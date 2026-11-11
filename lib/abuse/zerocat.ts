import 'server-only'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { trace } from '@opentelemetry/api'
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

/** How long a streamed ZeroCat call may take to send its first token before the call moves to Gateway. */
export const ZEROCAT_FIRST_TOKEN_TIMEOUT_MS = 20_000

/**
 * The default model through ZeroCat's OpenAI-compatible API. Without both
 * variables, or with another base URL, it throws and hostedModel uses the
 * model's Gateway route instead. Redirects are refused, as on Gateway.
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

/** Why a default-model call went to Gateway instead of ZeroCat (a closed set, for traces). */
export type ZeroCatFallbackReason = 'unconfigured' | 'endpoint_unexpected' | 'route_denied' | 'paused' | 'timeout' | 'rate_limited' | 'quota' | 'server_error' | 'redirect' | 'network' | 'request_rejected' | 'stream_error'

/** How long one instance skips ZeroCat after it failed, so calls do not each wait on a failing route. */
export const ZEROCAT_PAUSE_MS = 60_000
let pausedUntil = 0
export function pauseZeroCat(now = Date.now()) { pausedUntil = now + ZEROCAT_PAUSE_MS }
export function zeroCatPaused(now = Date.now()) { return now < pausedUntil }
/** For tests: forget an earlier pause. */
export function resumeZeroCat() { pausedUntil = 0 }

/** The errors in a failure's cause chain, outermost first. */
function causes(error: unknown, depth = 4): Error[] {
  const chain: Error[] = []
  for (let value = error; value instanceof Error && chain.length < depth; value = value.cause) chain.push(value)
  return chain
}

/** The fallback reason for a ZeroCat failure before its first token. */
export function zeroCatFailureReason(error: unknown, firstTokenTimedOut = false): ZeroCatFallbackReason {
  if (firstTokenTimedOut || (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError'))) return 'timeout'
  const status = zeroCatErrorStatus(error)
  if (status === 429) return 'rate_limited'
  if (status === 402) return 'quota'
  if (status !== undefined && status >= 500) return 'server_error'
  if (status !== undefined) return 'request_rejected'
  // undici refuses a redirect (the transport sets redirect: 'error') with this fixed cause.
  if (causes(error).some(item => item.message === 'unexpected redirect')) return 'redirect'
  // An AI SDK call error without a status never got an HTTP answer.
  return (error instanceof Error && error.name === 'AI_APICallError') || error instanceof TypeError ? 'network' : 'stream_error'
}

/** ZeroCat's HTTP status, when the failure carries one. */
export function zeroCatErrorStatus(error: unknown): number | undefined {
  const status = error instanceof Error ? (error as Error & { statusCode?: unknown }).statusCode : undefined
  return typeof status === 'number' && Number.isInteger(status) && status >= 100 && status < 600 ? status : undefined
}

/** Which credential Gateway finally served with ('system' is Vercel billing, 'byok' our own provider key). */
export function gatewayCredential(metadata: unknown): 'system' | 'byok' | undefined {
  const routing = (metadata as { gateway?: { routing?: { modelAttempts?: Array<{ success?: boolean; providerAttempts?: Array<{ success?: boolean; credentialType?: unknown }> }> } } } | undefined)?.gateway?.routing
  const attempt = routing?.modelAttempts?.findLast(model => model.success)?.providerAttempts?.findLast(provider => provider.success)
  return attempt?.credentialType === 'system' || attempt?.credentialType === 'byok' ? attempt.credentialType : undefined
}

const SAFE_NAME = /^[A-Za-z][A-Za-z0-9_]{0,39}$/
const SAFE_CODE = /^[A-Z][A-Z0-9_]{0,39}$/
/**
 * What a ZeroCat failure was, by error names and system codes only (never a
 * message, which can carry URLs or headers): `AI_APICallError>TypeError>Error`
 * and, say, `ECONNRESET` or `UND_ERR_CONNECT_TIMEOUT`.
 */
export function zeroCatFailureDetail(error: unknown): { error?: string; code?: string } {
  const chain = causes(error)
  const names = chain.map(item => SAFE_NAME.test(item.name) ? item.name : 'Error')
  const code = chain.map(item => (item as Error & { code?: unknown }).code).find((value): value is string => typeof value === 'string' && SAFE_CODE.test(value))
  return { ...(names.length ? { error: names.join('>') } : {}), ...(code ? { code } : {}) }
}

/**
 * One span and one log line per default-model call, naming the route that
 * served it, so PostHog (`mikka.model.route`) and Vercel logs count fallbacks.
 * Only closed-set values: no prompt, key or account data.
 */
export function recordModelRoute(value: { model: string; route: 'zerocat' | 'gateway' | 'cloudflare-workers-ai'; reason?: ZeroCatFallbackReason; status?: number; credential?: 'system' | 'byok'; error?: unknown; attemptMs?: number }) {
  const detail = value.error === undefined ? {} : zeroCatFailureDetail(value.error)
  const attributes = {
    'mikka.model.id': value.model,
    'mikka.model.route': value.route,
    ...(value.reason ? { 'mikka.model.fallback_reason': value.reason } : {}),
    ...(value.status !== undefined ? { 'mikka.model.zerocat_status': value.status } : {}),
    ...(value.credential ? { 'mikka.model.gateway_credential': value.credential } : {}),
    ...(detail.error ? { 'mikka.model.zerocat_error': detail.error } : {}),
    ...(detail.code ? { 'mikka.model.zerocat_error_code': detail.code } : {}),
    ...(value.attemptMs !== undefined ? { 'mikka.model.zerocat_ms': value.attemptMs } : {}),
  }
  trace.getTracer('mikka.model').startSpan('model.route', { attributes }).end()
  console.info(JSON.stringify({ event: 'default_model_route', ...attributes }))
}
