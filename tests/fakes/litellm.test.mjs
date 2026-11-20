import assert from 'node:assert/strict'
import { test } from 'node:test'
import { FAKE_LITELLM_KEY, startFakeLiteLlm } from './litellm.mjs'

const headers = { authorization: `Bearer ${FAKE_LITELLM_KEY}`, 'content-type': 'application/json' }
const payload = (protocol, scenario, stream = true) => ({
  model: 'mikka-test', stream,
  ...(protocol === 'responses' ? { input: `[fixture:${scenario}]` } : { messages: [{ role: 'user', content: `[fixture:${scenario}]` }] }),
  tools: protocol === 'messages' ? [{ name: 'fixture_echo', input_schema: { type: 'object', properties: { text: { type: 'string' } } } }]
    : protocol === 'responses' ? [{ type: 'function', name: 'fixture_echo', parameters: { type: 'object', properties: { text: { type: 'string' } } } }]
      : [{ type: 'function', function: { name: 'fixture_echo', parameters: { type: 'object', properties: { text: { type: 'string' } } } } }],
})
const endpoint = protocol => protocol === 'chat' ? 'chat/completions' : protocol
const events = text => text.split('\n').filter(line => line.startsWith('data: ') && line !== 'data: [DONE]').map(line => JSON.parse(line.slice(6)))

test('all LiteLLM protocols stream text, tool arguments and complete usage receipts over HTTP', async t => {
  const server = await startFakeLiteLlm()
  t.after(() => server.close())
  for (const protocol of ['chat', 'messages', 'responses']) for (const scenario of ['stream', 'tool']) {
    const response = await fetch(`${server.url}/v1/${endpoint(protocol)}`, { method: 'POST', headers, body: JSON.stringify(payload(protocol, scenario)) })
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type'), /text\/event-stream/)
    assert.match(response.headers.get('x-litellm-call-id'), /^fake-litellm-/)
    assert.equal(response.headers.get('x-litellm-response-cost'), '0.001234')
    const chunks = events(await response.text())
    if (protocol === 'chat') {
      assert.deepEqual(chunks.at(-1).usage, { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18, cost: 0.001234 })
      if (scenario === 'stream') assert.equal(chunks.map(chunk => chunk.choices[0].delta.content ?? '').join(''), 'Scripted model response across several stream chunks.')
      else {
        assert.equal(chunks.at(-1).choices[0].finish_reason, 'tool_calls')
        const calls = chunks.flatMap(chunk => chunk.choices[0].delta.tool_calls ?? [])
        assert.equal(calls[0].function.name, 'fixture_echo')
        assert.deepEqual(JSON.parse(calls.map(call => call.function.arguments).join('')), { text: 'scripted tool input' })
      }
    } else if (protocol === 'messages') {
      assert.equal(chunks[0].type, 'message_start')
      assert.equal(chunks[0].message.usage.input_tokens, 11)
      assert.equal(chunks.at(-2).usage.output_tokens, 7)
      assert.equal(chunks.at(-1).type, 'message_stop')
      const deltas = chunks.filter(chunk => chunk.type === 'content_block_delta').map(chunk => chunk.delta)
      if (scenario === 'stream') assert.equal(deltas.map(delta => delta.text).join(''), 'Scripted model response across several stream chunks.')
      else assert.deepEqual(JSON.parse(deltas.map(delta => delta.partial_json).join('')), { text: 'scripted tool input' })
    } else {
      assert.equal(chunks[0].type, 'response.created')
      assert.equal(chunks.at(-1).type, 'response.completed')
      assert.equal(chunks.at(-1).response.usage.total_tokens, 18)
      if (scenario === 'stream') assert.equal(chunks.filter(chunk => chunk.type === 'response.output_text.delta').map(chunk => chunk.delta).join(''), 'Scripted model response across several stream chunks.')
      else assert.deepEqual(JSON.parse(chunks.filter(chunk => chunk.type === 'response.function_call_arguments.delta').map(chunk => chunk.delta).join('')), { text: 'scripted tool input' })
    }
  }
})

test('unmatched aliases, request features and routes fail instead of fabricating a response', async t => {
  const server = await startFakeLiteLlm()
  t.after(() => server.close())
  for (const [patch, status, code] of [
    [{ model: 'unregistered-model' }, 422, 'fixture_unknown_model'],
    [{ messages: [{ role: 'user', content: 'Unregistered scenario' }] }, 422, 'fixture_unmatched_request'],
    [{ api_key: 'a-live-looking-value-that-must-not-appear-in-errors' }, 401, 'fixture_non_synthetic_provider_key'],
  ]) {
    const response = await fetch(`${server.url}/v1/chat/completions`, { method: 'POST', headers, body: JSON.stringify({ ...payload('chat', 'stream'), ...patch }) })
    assert.equal(response.status, status)
    assert.deepEqual(await response.json(), { error: { type: 'fixture_error', code, message: code } })
  }
  const unknown = await fetch(`${server.url}/v1/not-a-model-endpoint`, { method: 'POST', headers, body: '{}' })
  assert.equal(unknown.status, 404)
  const unauthenticated = await fetch(`${server.url}/v1/models`)
  assert.equal(unauthenticated.status, 401)
})

test('429 and upstream failures preserve the HTTP failure and never issue usage receipts', async t => {
  const server = await startFakeLiteLlm()
  t.after(() => server.close())
  for (const [scenario, status, code] of [['429', 429, 'fixture_rate_limited'], ['5xx', 503, 'fixture_upstream_unavailable']]) {
    const response = await fetch(`${server.url}/v1/chat/completions`, { method: 'POST', headers, body: JSON.stringify(payload('chat', scenario)) })
    assert.equal(response.status, status)
    assert.equal((await response.json()).error.code, code)
    assert.equal(response.headers.get('x-litellm-response-cost'), null)
    assert.equal(response.headers.get('retry-after'), scenario === '429' ? '1' : null)
  }
})

test('a timed-out request remains pending until the actual HTTP client cancels it', async t => {
  let began
  const started = new Promise(resolve => { began = resolve })
  const server = await startFakeLiteLlm({ observe: event => { if (event.outcome === 'timeout') began() } })
  t.after(() => server.close())
  const controller = new AbortController()
  const request = fetch(`${server.url}/v1/responses`, { method: 'POST', headers, body: JSON.stringify(payload('responses', 'timeout')), signal: controller.signal })
  const rejected = assert.rejects(request, { name: 'AbortError' })
  await started
  controller.abort()
  await rejected
})

test('tool results reach the one script in the same normalized form on every protocol', async t => {
  const calls = []
  const server = await startFakeLiteLlm({ answer: request => { calls.push(request); return { content: [{ type: 'text', text: 'Tool result received' }] } } })
  t.after(() => server.close())
  const common = { model: 'mikka-default' }
  const result = { id: 'persisted-by-real-tool' }
  const inputs = {
    chat: { ...common, messages: [{ role: 'assistant', content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'create_issue', arguments: '{}' } }] }, { role: 'tool', tool_call_id: 'call-1', content: JSON.stringify(result) }] },
    messages: { ...common, messages: [{ role: 'assistant', content: [{ type: 'tool_use', id: 'call-1', name: 'create_issue', input: {} }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-1', content: JSON.stringify(result) }] }] },
    responses: { ...common, input: [{ type: 'function_call', call_id: 'call-1', name: 'create_issue', arguments: '{}' }, { type: 'function_call_output', call_id: 'call-1', output: JSON.stringify(result) }] },
  }
  for (const [protocol, input] of Object.entries(inputs)) {
    const response = await fetch(`${server.url}/v1/${endpoint(protocol)}`, { method: 'POST', headers, body: JSON.stringify(input) })
    assert.equal(response.status, 200)
    await response.json()
  }
  assert.equal(calls.length, 3)
  for (const request of calls) assert.deepEqual(request.prompt.at(-1), { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'call-1', toolName: 'create_issue', output: { type: 'json', value: result } }] })
})
