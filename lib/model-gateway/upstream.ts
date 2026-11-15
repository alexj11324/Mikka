/*
 * Where the Mikka model gateway sends one request (decision 2026-11-15-2000).
 * Pure: the caller resolves credentials; this only shapes the request.
 *
 * - Mikka 额度 → Vercel AI Gateway's coding-agent surfaces, which take any
 *   catalogue model in both protocols: `/claude-code` (Anthropic messages) and
 *   `/codex/v1` (Responses).
 * - The person's key, when the provider speaks the CLI's protocol → that
 *   provider's own endpoint. Never through Vercel: its BYOK retries a failed key
 *   on Vercel's own keys and bills Mikka.
 * - The person's key on a Chat Completions–only provider → LiteLLM, which
 *   converts the protocol; the key and base URL ride on that one request.
 */
import type { GatewayProtocol } from './usage'

export const VERCEL_GATEWAY_ORIGIN = 'https://ai-gateway.vercel.sh'
export type GatewayOperation = 'messages' | 'count_tokens' | 'responses'

export type GatewayUpstream =
  | { kind: 'vercel'; token: string }
  | { kind: 'provider'; baseUrl: string; key: string }
  | { kind: 'litellm'; url: string; masterKey: string; chatBaseUrl: string; key: string }

export interface UpstreamRequest { url: string; headers: Record<string, string>; body: Record<string, unknown> }

/** Client headers that carry protocol meaning, forwarded as sent. Nothing else from the CLI reaches a provider. */
const FORWARDED = ['anthropic-version', 'anthropic-beta', 'accept', 'openai-beta']

const trimmed = (url: string) => url.replace(/\/+$/, '')

function path(protocol: GatewayProtocol, operation: GatewayOperation) {
  if (protocol === 'anthropic') return operation === 'count_tokens' ? '/v1/messages/count_tokens' : '/v1/messages'
  return '/responses'
}

export function upstreamRequest(input: {
  protocol: GatewayProtocol
  operation: GatewayOperation
  /** The run's frozen model: it replaces whatever model the CLI asked for. */
  model: string
  body: Record<string, unknown>
  clientHeaders: Headers
  upstream: GatewayUpstream
}): UpstreamRequest {
  if ((input.protocol === 'anthropic') !== (input.operation !== 'responses')) throw new Error('model_gateway_operation_mismatch')
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  for (const name of FORWARDED) {
    const value = input.clientHeaders.get(name)
    if (value) headers[name] = value
  }
  if (input.protocol === 'anthropic' && !headers['anthropic-version']) headers['anthropic-version'] = '2023-06-01'
  const body = { ...input.body, model: input.model }
  const upstream = input.upstream
  if (upstream.kind === 'vercel') {
    const base = input.protocol === 'anthropic' ? `${VERCEL_GATEWAY_ORIGIN}/claude-code` : `${VERCEL_GATEWAY_ORIGIN}/codex/v1`
    return { url: base + path(input.protocol, input.operation), headers: { ...headers, authorization: `Bearer ${upstream.token}` }, body }
  }
  if (upstream.kind === 'provider') {
    const auth: Record<string, string> = input.protocol === 'anthropic' ? { 'x-api-key': upstream.key } : { authorization: `Bearer ${upstream.key}` }
    return { url: trimmed(upstream.baseUrl) + path(input.protocol, input.operation), headers: { ...headers, ...auth }, body }
  }
  // LiteLLM's wildcard deployment serves any model as an OpenAI-compatible chat model at `api_base`.
  return {
    url: trimmed(upstream.url) + (input.protocol === 'anthropic' ? path('anthropic', input.operation) : '/v1/responses'),
    headers: { ...headers, authorization: `Bearer ${upstream.masterKey}` },
    body: { ...body, api_key: upstream.key, api_base: trimmed(upstream.chatBaseUrl) },
  }
}
