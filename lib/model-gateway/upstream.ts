import { modelGatewayProtocolBody } from './protocol-fields.mjs'
/* The run's frozen model and server-owned credential reach only LiteLLM. */
import { managedLiteLlmModel } from './config'
import type { GatewayProtocol } from './usage'

export type GatewayOperation = 'messages' | 'count_tokens' | 'responses'

export interface GatewayUpstream {
  url: string
  masterKey: string
  /** Opened server-side for this request; never accepted from the CLI. */
  credential?: { key: string; provider: 'anthropic' | 'openai'; apiBase: string; chatCompletionsOnly?: boolean }
}

export interface UpstreamRequest { url: string; headers: Record<string, string>; body: Record<string, unknown> }

/** Client headers that carry protocol meaning. Authentication never passes through. */
const FORWARDED = ['anthropic-version', 'anthropic-beta', 'accept', 'openai-beta']

export function upstreamRequest(input: {
  protocol: GatewayProtocol
  operation: GatewayOperation
  /** The run's frozen model replaces whatever model the CLI asked for. */
  model: string
  body: Record<string, unknown>
  clientHeaders: Headers
  upstream: GatewayUpstream
}): UpstreamRequest {
  if ((input.protocol === 'anthropic') !== (input.operation !== 'responses')) throw new Error('model_gateway_operation_mismatch')
  const headers: Record<string, string> = { 'content-type': 'application/json', 'x-litellm-api-key': `Bearer ${input.upstream.masterKey}` }
  for (const name of FORWARDED) {
    const value = input.clientHeaders.get(name)
    if (value) headers[name] = value
  }
  if (input.protocol === 'anthropic' && !headers['anthropic-version']) headers['anthropic-version'] = '2023-06-01'
  const body = modelGatewayProtocolBody(input.protocol, input.body)
  body.model = managedLiteLlmModel(input.model)
  const credential = input.upstream.credential
  if (credential) Object.assign(body, {
    model: `${credential.provider}/${credential.chatCompletionsOnly ? 'chat_completions/' : ''}${input.model}`,
    custom_llm_provider: credential.provider,
    api_key: credential.key,
    api_base: credential.apiBase.replace(/\/+$/, ''),
    disable_fallbacks: true,
    num_retries: 0,
  })
  const path = input.protocol === 'anthropic'
    ? input.operation === 'count_tokens' ? '/v1/messages/count_tokens' : '/v1/messages'
    : '/v1/responses'
  return { url: input.upstream.url.replace(/\/+$/, '') + path, headers, body }
}
