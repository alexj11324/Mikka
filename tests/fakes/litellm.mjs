// The shared scripted model boundary. Nothing in this server forwards a request.
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'

export const FAKE_LITELLM_KEY = 'mikka-local-litellm'
export const FAKE_MODEL_KEY = 'mikka-local-model-placeholder'
export const FAKE_MODELS = ['mikka-default', 'mikka-title', 'mikka-decision', 'mikka-planning', 'mikka-test', 'mvp-subscription-model', 'deepseek-flash', 'deepseek-v4.1-flash']
const MAX_BODY = 16 * 1024 * 1024
const parts = text => String(text).match(/[\s\S]{1,24}/g) ?? []
const unbox = value => { try { return JSON.parse(value) } catch { return value } }
const textOf = value => typeof value === 'string' ? value : (value ?? []).filter(part => ['text', 'input_text', 'output_text'].includes(part.type)).map(part => part.text).join('\n')

async function readJson(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > MAX_BODY) throw Object.assign(new Error('fixture_body_too_large'), { status: 413 })
    chunks.push(chunk)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString()) }
  catch (cause) { throw Object.assign(new Error('fixture_invalid_json', { cause }), { status: 400 }) }
}

function normalize(body, protocol) {
  const names = new Map(), prompt = []
  const messages = protocol === 'responses'
    ? typeof body.input === 'string' ? [{ role: 'user', content: body.input }] : body.input ?? []
    : body.messages ?? []
  if (body.system || body.instructions) prompt.push({ role: 'system', content: textOf(body.system ?? body.instructions) })
  for (const message of messages) {
    if (message.type === 'function_call') {
      names.set(message.call_id, message.name)
      prompt.push({ role: 'assistant', content: [{ type: 'tool-call', toolCallId: message.call_id, toolName: message.name, input: message.arguments }] })
      continue
    }
    if (message.type === 'function_call_output') {
      prompt.push({ role: 'tool', content: [{ type: 'tool-result', toolCallId: message.call_id, toolName: names.get(message.call_id), output: { type: 'json', value: unbox(message.output) } }] })
      continue
    }
    if (message.role === 'tool') {
      prompt.push({ role: 'tool', content: [{ type: 'tool-result', toolCallId: message.tool_call_id, toolName: names.get(message.tool_call_id), output: { type: 'json', value: unbox(message.content) } }] })
      continue
    }
    const content = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : [...(message.content ?? [])]
    for (const call of message.tool_calls ?? []) {
      names.set(call.id, call.function.name)
      content.push({ type: 'tool-call', toolCallId: call.id, toolName: call.function.name, input: call.function.arguments })
    }
    const normalized = []
    for (const part of content) {
      if (part.type === 'tool_use') {
        names.set(part.id, part.name)
        normalized.push({ type: 'tool-call', toolCallId: part.id, toolName: part.name, input: JSON.stringify(part.input) })
      } else if (part.type === 'tool_result') {
        if (normalized.length) { prompt.push({ role: message.role, content: normalized.splice(0) }) }
        prompt.push({ role: 'tool', content: [{ type: 'tool-result', toolCallId: part.tool_use_id, toolName: names.get(part.tool_use_id), output: { type: 'json', value: unbox(textOf(part.content)) } }] })
      } else normalized.push(['input_text', 'output_text'].includes(part.type) ? { type: 'text', text: part.text } : part)
    }
    if (normalized.length) prompt.push({ role: message.role === 'developer' ? 'system' : message.role, content: normalized })
  }
  return { model: body.model, prompt, tools: (body.tools ?? []).map(tool => ({ ...tool, name: tool.function?.name ?? tool.name, inputSchema: tool.function?.parameters ?? tool.parameters ?? tool.input_schema })) }
}

function probeAnswer(request) {
  if (request.model !== 'mikka-test') return null
  const text = textOf(request.prompt.findLast(message => message.role === 'user')?.content)
  const scenario = /^\[fixture:(stream|tool|429|5xx|timeout|cost)\]$/.exec(text)?.[1]
  if (!scenario) return null
  if (scenario === '429') return { status: 429, code: 'fixture_rate_limited', retryAfter: '1' }
  if (scenario === '5xx') return { status: 503, code: 'fixture_upstream_unavailable' }
  if (scenario === 'timeout') return { hang: true }
  if (scenario === 'tool') {
    if (!request.tools.some(tool => tool.name === 'fixture_echo')) return { status: 422, code: 'fixture_tool_missing' }
    return { content: [{ type: 'tool-call', toolCallId: 'fixture-call-1', toolName: 'fixture_echo', input: '{"text":"scripted tool input"}' }] }
  }
  return { content: [{ type: 'text', text: 'Scripted model response across several stream chunks.' }], cost: 0.001234 }
}

function chat(answer, model, id, usage, stream, { start = true, end = true } = {}) {
  const content = answer.content.filter(part => part.type === 'text').map(part => part.text).join('')
  const calls = answer.content.filter(part => part.type === 'tool-call').map((part, index) => ({ index, id: part.toolCallId, type: 'function', function: { name: part.toolName, arguments: typeof part.input === 'string' ? part.input : JSON.stringify(part.input) } }))
  const finish_reason = calls.length ? 'tool_calls' : 'stop'
  const base = { id, object: stream ? 'chat.completion.chunk' : 'chat.completion', created: 1, model }
  if (!stream) return { ...base, choices: [{ index: 0, finish_reason, message: { role: 'assistant', content: content || null, ...(calls.length && { tool_calls: calls.map(({ index: _index, ...call }) => call) }) } }], usage }
  const chunk = (delta, finish = null, extra = {}) => ({ ...base, choices: [{ index: 0, delta, finish_reason: finish }], ...extra })
  return [...(start ? [chunk({ role: 'assistant' })] : []), ...parts(content).map(content => chunk({ content })),
    ...calls.flatMap(call => [chunk({ tool_calls: [{ ...call, function: { name: call.function.name, arguments: '' } }] }), ...parts(call.function.arguments).map(arguments_ => chunk({ tool_calls: [{ index: call.index, function: { arguments: arguments_ } }] }))]),
    ...(end ? [chunk({}, finish_reason, { usage })] : [])].map(value => `data: ${JSON.stringify(value)}\n\n`).join('') + (end ? 'data: [DONE]\n\n' : '')
}

function messages(answer, model, id, usage, stream) {
  const content = answer.content.map(part => part.type === 'tool-call'
    ? { type: 'tool_use', id: part.toolCallId, name: part.toolName, input: unbox(part.input) }
    : { type: 'text', text: part.text })
  const stop_reason = content.some(part => part.type === 'tool_use') ? 'tool_use' : 'end_turn'
  const message = { id, type: 'message', role: 'assistant', model, content, stop_reason, stop_sequence: null, usage: { input_tokens: usage.prompt_tokens, output_tokens: usage.completion_tokens } }
  if (!stream) return message
  const events = [{ type: 'message_start', message: { ...message, content: [], stop_reason: null, usage: { ...message.usage, output_tokens: 0 } } }]
  for (const [index, block] of content.entries()) {
    events.push({ type: 'content_block_start', index, content_block: block.type === 'tool_use' ? { ...block, input: {} } : { type: 'text', text: '' } })
    for (const fragment of parts(block.type === 'tool_use' ? JSON.stringify(block.input) : block.text)) events.push({ type: 'content_block_delta', index, delta: block.type === 'tool_use' ? { type: 'input_json_delta', partial_json: fragment } : { type: 'text_delta', text: fragment } })
    events.push({ type: 'content_block_stop', index })
  }
  events.push({ type: 'message_delta', delta: { stop_reason, stop_sequence: null }, usage: { output_tokens: usage.completion_tokens } }, { type: 'message_stop' })
  return events.map(value => `event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`).join('')
}

function responses(answer, model, id, usage, stream) {
  const output = answer.content.map((part, index) => part.type === 'tool-call'
    ? { id: `${id}-${index}`, type: 'function_call', status: 'completed', call_id: part.toolCallId, name: part.toolName, arguments: typeof part.input === 'string' ? part.input : JSON.stringify(part.input) }
    : { id: `${id}-${index}`, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: part.text, annotations: [], logprobs: [] }] })
  const response = { id, object: 'response', created_at: 1, status: 'completed', model, output, error: null, incomplete_details: null, usage: { input_tokens: usage.prompt_tokens, output_tokens: usage.completion_tokens, total_tokens: usage.total_tokens, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } }
  if (!stream) return response
  const events = [{ type: 'response.created', response: { ...response, status: 'in_progress', output: [], usage: null } }]
  for (const [output_index, item] of output.entries()) {
    events.push({ type: 'response.output_item.added', output_index, item: { ...item, status: 'in_progress', ...(item.type === 'function_call' ? { arguments: '' } : { content: [] }) } })
    if (item.type === 'function_call') {
      for (const delta of parts(item.arguments)) events.push({ type: 'response.function_call_arguments.delta', item_id: item.id, output_index, delta })
      events.push({ type: 'response.function_call_arguments.done', item_id: item.id, output_index, arguments: item.arguments })
    } else {
      events.push({ type: 'response.content_part.added', item_id: item.id, output_index, content_index: 0, part: { type: 'output_text', text: '', annotations: [], logprobs: [] } })
      for (const delta of parts(item.content[0].text)) events.push({ type: 'response.output_text.delta', item_id: item.id, output_index, content_index: 0, delta, logprobs: [] })
      events.push({ type: 'response.output_text.done', item_id: item.id, output_index, content_index: 0, text: item.content[0].text, logprobs: [] }, { type: 'response.content_part.done', item_id: item.id, output_index, content_index: 0, part: item.content[0] })
    }
    events.push({ type: 'response.output_item.done', output_index, item })
  }
  events.push({ type: 'response.completed', response })
  return events.map((value, sequence_number) => `event: ${value.type}\ndata: ${JSON.stringify({ ...value, sequence_number })}\n\n`).join('')
}

/** Returns the HTTP hook shared by dev:local, MVP and standalone tests. */
export function createLiteLlmRoutes({ basePath = '/litellm', apiKey = FAKE_LITELLM_KEY, answer = () => null, decision = () => null, observe = () => {} } = {}) {
  return async (request, response, url) => {
    if (!url.pathname.startsWith(`${basePath}/`)) return false
    const json = (value, status = 200) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); return true }
    const error = (code, status) => { observe({ kind: 'litellm-refused', code }); return json({ error: { type: 'fixture_error', code, message: code } }, status) }
    const auth = request.headers.authorization ?? request.headers['x-litellm-api-key']
    if (auth !== `Bearer ${apiKey}`) return error('fixture_invalid_key', 401)
    if (url.search) return error('fixture_unmatched_query', 400)
    const path = url.pathname.slice(basePath.length)
    if (path === '/v1/models' && request.method === 'GET') return json({ object: 'list', data: FAKE_MODELS.map(id => ({ id, object: 'model', created: 1, owned_by: 'scripted-fixture' })) })
    const protocol = { '/v1/chat/completions': 'chat', '/v1/messages': 'messages', '/v1/responses': 'responses', '/v1/decisions': 'decisions', '/v1/messages/count_tokens': 'count_tokens' }[path]
    if (request.method !== 'POST' || !protocol) return error('fixture_unmatched_route', 404)
    try {
      const body = await readJson(request)
      const alias = typeof body.model === 'string' ? body.model.replace(/^openai\/(?:chat_completions\/)?/, '').replace(/^mikka-credits\//, '') : null
      if (!FAKE_MODELS.includes(alias)) return error('fixture_unknown_model', 422)
      if (body.api_key !== undefined && body.api_key !== FAKE_MODEL_KEY) return error('fixture_non_synthetic_provider_key', 401)
      const id = `fake-litellm-${randomUUID()}`
      if (protocol === 'count_tokens') return json({ input_tokens: 11 })
      const normalized = normalize(body, protocol)
      normalized.model = alias
      const result = protocol === 'decisions' ? await decision(body) : probeAnswer(normalized) ?? await answer(normalized, { body, protocol })
      if (!result) return error('fixture_unmatched_request', 422)
      observe({ kind: 'litellm-request', protocol, model: alias, callId: id, outcome: result.status ?? (result.hang ? 'timeout' : 'success') })
      if (result.status) {
        if (result.retryAfter) response.setHeader('retry-after', result.retryAfter)
        return error(result.code, result.status)
      }
      if (result.hang) { await new Promise(resolve => response.once('close', resolve)); return true }
      const cost = result.cost ?? 0.001234
      response.setHeader('x-litellm-call-id', id)
      response.setHeader('x-litellm-response-cost', String(cost))
      if (protocol === 'decisions') return json(result)
      if (!Array.isArray(result.content) || !result.content.length) return error('fixture_empty_answer', 422)
      const usage = { prompt_tokens: result.usage?.inputTokens?.total ?? 11, completion_tokens: result.usage?.outputTokens?.total ?? 7, cost }
      usage.total_tokens = usage.prompt_tokens + usage.completion_tokens
      if (result.next && (protocol !== 'chat' || !body.stream)) return error('fixture_stream_gate_protocol', 422)
      const output = ({ chat, messages, responses })[protocol](result, body.model, id, usage, body.stream === true, { end: !result.next })
      if (!body.stream) return json(output)
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      if (result.next) {
        response.write(output)
        const next = await result.next
        response.end(chat(next, body.model, id, usage, true, { start: false }))
      } else response.end(output)
      return true
    } catch (cause) {
      // No request text, credentials or arbitrary thrown message enters evidence.
      const code = ['fixture_body_too_large', 'fixture_invalid_json'].includes(cause.message) ? cause.message : 'fixture_script_failed'
      return error(code, code === 'fixture_script_failed' ? 422 : cause.status)
    }
  }
}

export async function startFakeLiteLlm(options = {}) {
  const routes = createLiteLlmRoutes({ ...options, basePath: '' })
  const server = createServer(async (request, response) => {
    if (!await routes(request, response, new URL(request.url, 'http://127.0.0.1'))) { response.writeHead(404); response.end() }
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) },
  }
}
