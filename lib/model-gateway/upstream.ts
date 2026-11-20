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

// LiteLLM accepts routing, credentials and mock responses in the JSON body.
// Admit only the public protocol fields so a task cannot replace those controls.
const PROTOCOL_FIELDS: Record<GatewayProtocol, readonly string[]> = {
  anthropic: ['messages', 'max_tokens', 'system', 'metadata', 'stop_sequences', 'stream', 'temperature', 'top_k', 'top_p', 'tools', 'tool_choice', 'thinking', 'output_config', 'service_tier', 'container', 'context_management'],
  openai: ['input', 'instructions', 'max_output_tokens', 'max_tool_calls', 'parallel_tool_calls', 'previous_response_id', 'reasoning', 'store', 'stream', 'stream_options', 'temperature', 'text', 'tool_choice', 'tools', 'top_p', 'top_logprobs', 'truncation', 'include', 'service_tier', 'prompt', 'prompt_cache_key', 'prompt_cache_retention', 'safety_identifier', 'user', 'background', 'conversation'],
}

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
  const body: Record<string, unknown> = Object.fromEntries(PROTOCOL_FIELDS[input.protocol].filter(name => name in input.body).map(name => [name, input.body[name]]))
  // Anthropic metadata is only a user identifier, not LiteLLM routing metadata.
  if (input.protocol === 'anthropic' && body.metadata) {
    const metadata = body.metadata as Record<string, unknown>
    body.metadata = typeof metadata.user_id === 'string' ? { user_id: metadata.user_id } : {}
  }
  body.model = managedLiteLlmModel(input.model)
  const credential = input.upstream.credential
  if (credential) Object.assign(body, {
    model: `${credential.provider}/${input.protocol === 'openai' && credential.chatCompletionsOnly ? 'chat_completions/' : ''}${input.model}`,
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
