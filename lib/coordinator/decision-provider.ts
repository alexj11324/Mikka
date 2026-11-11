import { gatewayCost, gatewayGenerationId } from '../abuse/policy'
import { gatewayAuth } from '../ai-gateway-auth'

export const gatewayEndpoint = 'https://ai-gateway.vercel.sh/v1/decisions'
export const nativeEndpoint = 'https://api.openai.com/v1/decisions'
const nativeModel = 'gpt-6-luna'

/** The application authorizes the logical model; only the provider's wire spelling differs. */
export async function decisionTransport(endpoint: string, model: string, env: Record<string, string | undefined> = process.env) {
  if (endpoint === nativeEndpoint) {
    if (![nativeModel, 'openai/gpt-6-luna-decisions'].includes(model)
        || env.DECISIONS_BILLING_PROFILE !== 'openai-global-standard' || !env.OPENAI_DECISIONS_API_KEY) return null
    return { native: true, model: nativeModel, key: env.OPENAI_DECISIONS_API_KEY }
  }
  // Reject other paths, query strings and schemes on the native provider's domain.
  // A compatible endpoint on another administrator-selected host keeps its original key policy.
  let url: URL
  try { url = new URL(endpoint) } catch { return null }
  if (url.hostname === 'api.openai.com') return null
  const key = env.DECISIONS_API_KEY || (endpoint === gatewayEndpoint ? (await gatewayAuth(env))?.token : env.AI_GATEWAY_API_KEY)
  return key ? { native: false, model, key } : null
}

type TokenUsage = { input_tokens?: unknown; output_tokens?: unknown; input_tokens_details?: { cached_tokens?: unknown; cache_write_tokens?: unknown } }
type ProviderEnvelope = { model?: unknown; provider_metadata?: unknown; usage?: TokenUsage }
const count = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0

/** Standard global OpenAI Decisions prices per million input tokens. Output is uncharged.
 * Work with thousandths of a microdollar and round once, like the existing ledger.
 * https://developers.openai.com/api/docs/guides/decisions#pricing-and-availability
 * https://developers.openai.com/api/docs/models/gpt-6-luna */
function nativeCost(usage: TokenUsage | undefined): number | null {
  const input = usage?.input_tokens, output = usage?.output_tokens
  const reads = usage?.input_tokens_details?.cached_tokens, writes = usage?.input_tokens_details?.cache_write_tokens
  if (!count(input) || !count(output) || !count(reads) || !count(writes) || reads + writes > input) return null
  const milliMicroUsd = ((input - reads - writes) * 100 + reads * 10 + writes * 125) * (input > 272000 ? 2 : 1)
  return Number.isSafeInteger(milliMicroUsd) ? Math.ceil(milliMicroUsd / 1000) : null
}

export function decisionProviderReceipt(native: boolean, model: string, data: unknown, headers: Headers) {
  const envelope = (data && typeof data === 'object' ? data : {}) as ProviderEnvelope
  if (!native) return { modelMatches: envelope.model === model, cost: gatewayCost(envelope.provider_metadata), generation: gatewayGenerationId(envelope.provider_metadata) }
  const requestId = headers.get('x-request-id')
  const modelMatches = envelope.model === model
  const generation = requestId && /^req_[a-zA-Z0-9_-]{1,190}$/.test(requestId) ? requestId : undefined
  return { modelMatches, generation, cost: modelMatches && generation ? nativeCost(envelope.usage) : null }
}
