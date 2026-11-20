// LiteLLM accepts routing, credentials and mock responses in the JSON body.
// Admit only the public protocol fields so a task cannot replace those controls.
const PROTOCOL_FIELDS = {
  anthropic: ['messages', 'max_tokens', 'system', 'metadata', 'stop_sequences', 'stream', 'temperature', 'top_k', 'top_p', 'tools', 'tool_choice', 'thinking', 'output_config', 'service_tier', 'container', 'context_management'],
  openai: ['input', 'instructions', 'max_output_tokens', 'max_tool_calls', 'parallel_tool_calls', 'previous_response_id', 'reasoning', 'store', 'stream', 'stream_options', 'temperature', 'text', 'tool_choice', 'tools', 'top_p', 'top_logprobs', 'truncation', 'include', 'service_tier', 'prompt', 'prompt_cache_key', 'prompt_cache_retention', 'safety_identifier', 'user', 'background', 'conversation'],
}

/** @param {'anthropic'|'openai'} protocol @param {Record<string, unknown>} request */
export function modelGatewayProtocolBody(protocol, request) {
  const body = Object.fromEntries(PROTOCOL_FIELDS[protocol].filter(name => name in request).map(name => [name, request[name]]))
  // Anthropic metadata is only a user identifier, not LiteLLM routing metadata.
  if (protocol === 'anthropic' && body.metadata) {
    const metadata = body.metadata
    body.metadata = typeof metadata.user_id === 'string' ? { user_id: metadata.user_id } : {}
  }
  return body
}
