import assert from 'node:assert/strict'
import { test } from 'node:test'
import { gatewayCostMicroUsd, readGatewayUsage } from './usage'
import { upstreamRequest } from './upstream'
import { parseGatewayFeatures, withoutDisabledFeatures } from './features'
import { gatewayLiteLlm, SELF_HOSTED_DEFAULT_CATALOG_ID } from './config'
import { parseCreditsOption, creditsOptionId } from '../bot-model-menu-view'
import { GatewayRefusal, handleModelGateway, type GatewayDependencies } from './handler'
import type { GatewayGrant } from './token'
import { PaidResourceError } from '@/lib/abuse/policy'

const sse = (events: unknown[]) => events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n'

test('usage is read from Anthropic and Responses streams, and from one JSON answer', () => {
  const anthropic = sse([
    { type: 'message_start', message: { usage: { input_tokens: 100, output_tokens: 0, cache_read_input_tokens: 400, cache_creation_input_tokens: 50 } } },
    { type: 'content_block_delta', delta: { text: 'hi' } },
    { type: 'message_delta', usage: { output_tokens: 30 } },
  ])
  assert.deepEqual(readGatewayUsage('anthropic', anthropic), { inputTokens: 550, outputTokens: 30, cacheReadTokens: 400, cacheWriteTokens: 50 })
  const responses = sse([{ type: 'response.created' }, { type: 'response.completed', response: { usage: { input_tokens: 1000, output_tokens: 20, input_tokens_details: { cached_tokens: 600 } } } }])
  assert.deepEqual(readGatewayUsage('openai', responses), { inputTokens: 1000, outputTokens: 20, cacheReadTokens: 600, cacheWriteTokens: 0 })
  assert.deepEqual(readGatewayUsage('anthropic', JSON.stringify({ type: 'message', usage: { input_tokens: 7, output_tokens: 3 } })), { inputTokens: 7, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0 })
  assert.equal(readGatewayUsage('openai', sse([{ type: 'response.created' }])), null, 'no usage reported: unknown, never zero')
  assert.equal(readGatewayUsage('anthropic', 'data: {broken'), null)
})

test('cost is the list price with no markup, cached input at the cache price', () => {
  const model = { pricing: { input: 3, output: 15, cacheRead: 0.3 } }
  // 1M plain input at $3 + 1M output at $15 = $18 = 18,000,000 micro-USD.
  assert.equal(gatewayCostMicroUsd(model, { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0 }), 18_000_000)
  assert.equal(gatewayCostMicroUsd(model, { inputTokens: 1000, outputTokens: 0, cacheReadTokens: 1000, cacheWriteTokens: 0 }), 300)
  assert.equal(gatewayCostMicroUsd(model, { inputTokens: 1000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 1000 }), 3750)
  assert.equal(gatewayCostMicroUsd({ pricing: null }, { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }), null)
})

test('credits and BYOK reach only LiteLLM; credentials and routing come from the server', () => {
  const clientHeaders = new Headers({ 'anthropic-version': '2023-06-01', 'anthropic-beta': 'tools', cookie: 'session=secret', 'x-api-key': 'mkg_run_token', authorization: 'Bearer malicious' })
  const upstream = { url: 'http://litellm:4000/', masterKey: 'internal' }
  const body = { model: 'untrusted', max_tokens: 10, messages: [], api_key: 'attacker', api_base: 'https://attacker.test', custom_llm_provider: 'evil',
    fallbacks: ['other-paid-model'], model_list: [{}], mock_response: 'fake answer', extra_headers: { authorization: 'attacker' },
    metadata: { user_id: 'cli-user', _disable_fallbacks: false, api_key: 'attacker' } }
  const credits = upstreamRequest({ protocol: 'anthropic', operation: 'messages', model: 'anthropic/claude-small', body, clientHeaders, upstream })
  assert.equal(credits.url, 'http://litellm:4000/v1/messages')
  assert.equal(credits.headers['x-litellm-api-key'], 'Bearer internal')
  assert.equal(credits.headers['anthropic-beta'], 'tools')
  assert.equal(credits.headers.cookie, undefined)
  assert.equal(credits.headers['x-api-key'], undefined, 'the run token never leaves Mikka')
  assert.equal(credits.headers.authorization, undefined)
  assert.deepEqual(credits.body, { max_tokens: 10, messages: [], metadata: { user_id: 'cli-user' }, model: 'mikka-credits/anthropic/claude-small' })
  const defaultChoice = parseCreditsOption(creditsOptionId(SELF_HOSTED_DEFAULT_CATALOG_ID))
  assert.equal(defaultChoice, SELF_HOSTED_DEFAULT_CATALOG_ID)
  assert.equal(upstreamRequest({ protocol: 'anthropic', operation: 'messages', model: defaultChoice, body, clientHeaders, upstream }).body.model, 'mikka-default')
  const credential = { key: 'person-key', provider: 'anthropic' as const, apiBase: 'https://provider.test/' }
  const counted = upstreamRequest({ protocol: 'anthropic', operation: 'count_tokens', model: 'claude-small', body, clientHeaders, upstream: { ...upstream, credential } })
  assert.equal(counted.url, 'http://litellm:4000/v1/messages/count_tokens')
  assert.deepEqual([counted.body.api_key, counted.body.api_base, counted.body.model, counted.body.custom_llm_provider], ['person-key', 'https://provider.test', 'anthropic/claude-small', 'anthropic'])
  assert.equal(counted.body.disable_fallbacks, true, 'a failed personal key never falls back to a Mikka-paid deployment')
  assert.equal(counted.body.num_retries, 0)
  const codex = upstreamRequest({ protocol: 'openai', operation: 'responses', model: 'custom-model', body: { input: 'hi', stream: true, previous_response_id: 'previous' }, clientHeaders,
    upstream: { ...upstream, credential: { key: 'person-key', provider: 'openai', apiBase: 'https://provider.test/v1/', chatCompletionsOnly: true } } })
  assert.equal(codex.url, 'http://litellm:4000/v1/responses')
  assert.equal(codex.body.model, 'openai/chat_completions/custom-model')
  assert.equal(codex.body.stream, true)
  assert.equal(codex.body.previous_response_id, 'previous')
  assert.throws(() => upstreamRequest({ protocol: 'openai', operation: 'messages', model: 'm', body: {}, clientHeaders, upstream }))
})

test('turned-off features are removed before the request leaves', () => {
  const body = { thinking: { type: 'enabled' }, reasoning: { effort: 'high' }, tools: [
    { type: 'function', name: 'a', strict: true, function: { name: 'a', strict: true } },
    { type: 'custom', name: 'patch' },
  ] }
  assert.deepEqual(withoutDisabledFeatures(body, {}), body, 'everything on by default')
  const off = withoutDisabledFeatures(body, parseGatewayFeatures({ thinking: false, strict: false, customTools: false }))
  assert.equal(off.thinking, undefined); assert.equal(off.reasoning, undefined)
  assert.deepEqual(off.tools, [{ type: 'function', name: 'a', function: { name: 'a' } }])
  assert.deepEqual(parseGatewayFeatures({ unknown: true }), {}, 'an unknown stored shape turns nothing off')
})

test('LiteLLM is configured only with a clean URL and a master key', () => {
  assert.equal(gatewayLiteLlm({}), null)
  assert.equal(gatewayLiteLlm({ MIKKA_LITELLM_URL: 'http://litellm:4000/' }), null)
  assert.deepEqual(gatewayLiteLlm({ MIKKA_LITELLM_URL: 'http://litellm:4000/', MIKKA_LITELLM_MASTER_KEY: 'k' }), { url: 'http://litellm:4000', masterKey: 'k' })
  assert.equal(gatewayLiteLlm({ MIKKA_LITELLM_URL: 'http://user:pw@litellm:4000', MIKKA_LITELLM_MASTER_KEY: 'k' }), null)
  assert.deepEqual(gatewayLiteLlm({ MIKKA_LITELLM_URL: 'https://models.example.test/proxy/v1/', MIKKA_LITELLM_MASTER_KEY: 'k' }), { url: 'https://models.example.test/proxy', masterKey: 'k' })
})

const grant = (over: Partial<GatewayGrant> = {}): GatewayGrant => ({ runId: '10000000-0000-4000-8000-000000000001', ownerId: 'alice', workspaceId: '10000000-0000-4000-8000-000000000002', harness: 'claude_code', model: 'anthropic/claude-sonnet-5.5', source: { kind: 'credits' }, ...over })
function harness(over: Partial<GatewayDependencies> & { answer?: () => Response } = {}) {
  const calls = { reserved: [] as string[], settled: [] as [string, number | null, unknown][], generationIds: [] as (string | undefined)[], fetched: [] as { url: string; init: RequestInit }[] }
  const dependencies: GatewayDependencies = {
    fetch: (async (url: string | URL | Request, init?: RequestInit) => { calls.fetched.push({ url: String(url), init: init! }); return (over.answer ?? (() => new Response(sse([
      { type: 'message_start', message: { usage: { input_tokens: 1000, output_tokens: 0 } } },
      { type: 'message_delta', usage: { output_tokens: 100 } },
    ]), { headers: { 'content-type': 'text/event-stream', 'x-litellm-call-id': 'call-fixture' } })))() }) as typeof fetch,
    verify: async token => token === 'mkg_valid' ? grant() : null,
    upstream: async () => ({ upstream: { url: 'http://litellm:4000', masterKey: 'internal' } }),
    reserve: async (_grant, id) => { calls.reserved.push(id) },
    settle: async (id, cost, usage, generationId) => { calls.settled.push([id, cost, usage]); calls.generationIds.push(generationId) },
    catalogue: async () => [{ id: 'anthropic/claude-sonnet-5.5', vendor: 'anthropic', name: 'Sonnet', contextWindow: null, maxTokens: null, pricing: { input: 3, output: 15 }, tags: [], reasoning: [] }],
    ...over,
  }
  return { calls, dependencies }
}
const post = (body: unknown, headers: Record<string, string> = { 'x-api-key': 'mkg_valid' }) =>
  new Request('https://mikka.test/api/model-gateway/anthropic/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })

test('Mikka 额度: the gateway holds credit, streams the answer through, then settles at list price', async () => {
  const { calls, dependencies } = harness()
  const response = await handleModelGateway(post({ model: 'whatever', stream: true, messages: [] }), 'anthropic', 'messages', dependencies)
  assert.equal(response.status, 200)
  const text = await response.text()
  assert.match(text, /message_delta/, 'the provider\'s stream reaches the CLI unchanged')
  assert.equal(calls.reserved.length, 1)
  assert.equal(JSON.parse(String(calls.fetched[0].init.body)).model, 'mikka-credits/anthropic/claude-sonnet-5.5')
  // 1000 input at $3/M + 100 output at $15/M = 3000 + 1500 micro-USD.
  assert.deepEqual(calls.settled.map(([id, cost]) => [id, cost]), [[calls.reserved[0], 4500]])
  assert.deepEqual(calls.generationIds, ['call-fixture'])
})

test('a request is refused without a valid token, on the wrong protocol, or when nothing can pay', async () => {
  assert.equal((await handleModelGateway(post({}, {}), 'anthropic', 'messages', harness().dependencies)).status, 401)
  assert.equal((await handleModelGateway(post({}, { 'x-api-key': 'mkg_other' }), 'anthropic', 'messages', harness().dependencies)).status, 401)
  assert.equal((await handleModelGateway(post({}, { authorization: 'Bearer mkg_valid' }), 'openai', 'responses', harness().dependencies)).status, 403)
  const broke = harness({ reserve: async () => { throw new PaidResourceError('points_exhausted') } })
  const refused = await handleModelGateway(post({ messages: [] }), 'anthropic', 'messages', broke.dependencies)
  assert.equal(refused.status, 402)
  assert.deepEqual(await refused.json(), { type: 'error', error: { type: 'billing_error', message: 'points_exhausted' } })
  assert.equal(broke.calls.fetched.length, 0, 'nothing reaches a provider unpaid')
  const unsupported = harness({ upstream: async () => { throw new GatewayRefusal(400, 'model_gateway_protocol_unsupported') } })
  assert.equal((await handleModelGateway(post({ messages: [] }), 'anthropic', 'messages', unsupported.dependencies)).status, 400)
  assert.equal((await handleModelGateway(new Request('https://mikka.test/x', { method: 'POST', headers: { 'x-api-key': 'mkg_valid' }, body: 'not json' }), 'anthropic', 'messages', harness().dependencies)).status, 400)
})

test('a refused or failed provider call costs nothing; a key run is never metered', async () => {
  const refused = harness({ answer: () => Response.json({ error: 'bad' }, { status: 400 }) })
  assert.equal((await handleModelGateway(post({ messages: [] }), 'anthropic', 'messages', refused.dependencies)).status, 400)
  assert.deepEqual(refused.calls.settled.map(([, cost]) => cost), [0])
  const down = harness({ fetch: (async () => { throw new TypeError('fetch failed') }) as typeof fetch })
  assert.equal((await handleModelGateway(post({ messages: [] }), 'anthropic', 'messages', down.dependencies)).status, 502)
  assert.deepEqual(down.calls.settled.map(([, cost]) => cost), [0])
  const keyed = harness({ verify: async () => grant({ source: { kind: 'api_key', keyId: '10000000-0000-4000-8000-000000000003' }, model: 'deepseek-chat' }) })
  const response = await handleModelGateway(post({ messages: [] }), 'anthropic', 'messages', keyed.dependencies)
  await response.text()
  assert.deepEqual([keyed.calls.reserved.length, keyed.calls.settled.length], [0, 0], 'the person\'s own key pays through LiteLLM without Mikka credits')
  const counted = harness()
  await (await handleModelGateway(post({ messages: [] }), 'anthropic', 'count_tokens', counted.dependencies)).text()
  assert.deepEqual([counted.calls.reserved.length, counted.calls.settled.length], [0, 0], 'counting tokens is free')
})

test('Codex streaming through LiteLLM retains usage and settles the same credit hold', async () => {
  const { calls, dependencies } = harness({
    verify: async () => grant({ harness: 'codex' }),
    answer: () => new Response(sse([{ type: 'response.completed', response: { usage: { input_tokens: 20, output_tokens: 4 } } }]), { headers: { 'content-type': 'text/event-stream', 'x-litellm-model-api-base': 'https://private-provider.test' } }),
  })
  const response = await handleModelGateway(post({ model: 'untrusted', input: 'hi', stream: true, api_key: 'attacker', api_base: 'https://attacker.test' }), 'openai', 'responses', dependencies)
  assert.equal(response.status, 200)
  assert.match(await response.text(), /response.completed/)
  assert.equal(calls.fetched[0].url, 'http://litellm:4000/v1/responses')
  assert.equal(JSON.parse(String(calls.fetched[0].init.body)).api_base, undefined)
  assert.equal(response.headers.get('x-litellm-model-api-base'), null, 'internal provider metadata stays behind the gateway')
  assert.deepEqual(calls.settled.map(([id, cost]) => [id, cost]), [[calls.reserved[0], 120]])
})
