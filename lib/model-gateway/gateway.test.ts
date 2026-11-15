import assert from 'node:assert/strict'
import { test } from 'node:test'
import { gatewayCostMicroUsd, readGatewayUsage } from './usage'
import { upstreamRequest, VERCEL_GATEWAY_ORIGIN } from './upstream'
import { parseGatewayFeatures, withoutDisabledFeatures } from './features'
import { gatewayLiteLlm } from './config'
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

test('each source gets its own upstream; the run\'s model always replaces the CLI\'s', () => {
  const clientHeaders = new Headers({ 'anthropic-version': '2023-06-01', 'anthropic-beta': 'tools', cookie: 'session=secret', 'x-api-key': 'mkg_run_token' })
  const body = { model: 'claude-sonnet-5', max_tokens: 10, messages: [] }
  const credits = upstreamRequest({ protocol: 'anthropic', operation: 'messages', model: 'deepseek/deepseek-v4-pro', body, clientHeaders, upstream: { kind: 'vercel', token: 'vercel-token' } })
  assert.equal(credits.url, `${VERCEL_GATEWAY_ORIGIN}/claude-code/v1/messages`)
  assert.equal(credits.headers.authorization, 'Bearer vercel-token')
  assert.equal(credits.body.model, 'deepseek/deepseek-v4-pro')
  assert.equal(credits.headers.cookie, undefined, 'nothing but protocol headers leaves Mikka')
  assert.equal(credits.headers['x-api-key'], undefined, 'the run token never reaches a provider')
  const codex = upstreamRequest({ protocol: 'openai', operation: 'responses', model: 'openai/gpt-5.5', body: { input: 'hi' }, clientHeaders: new Headers(), upstream: { kind: 'vercel', token: 't' } })
  assert.equal(codex.url, `${VERCEL_GATEWAY_ORIGIN}/codex/v1/responses`)
  const native = upstreamRequest({ protocol: 'anthropic', operation: 'count_tokens', model: 'deepseek-chat', body, clientHeaders, upstream: { kind: 'provider', baseUrl: 'https://api.deepseek.com/anthropic/', key: 'sk-user' } })
  assert.equal(native.url, 'https://api.deepseek.com/anthropic/v1/messages/count_tokens')
  assert.equal(native.headers['x-api-key'], 'sk-user')
  const openai = upstreamRequest({ protocol: 'openai', operation: 'responses', model: 'gpt-5.5', body: {}, clientHeaders: new Headers(), upstream: { kind: 'provider', baseUrl: 'https://api.openai.com/v1', key: 'sk-user' } })
  assert.deepEqual([openai.url, openai.headers.authorization], ['https://api.openai.com/v1/responses', 'Bearer sk-user'])
  const converted = upstreamRequest({ protocol: 'openai', operation: 'responses', model: 'glm-5', body: { input: 'hi' }, clientHeaders: new Headers(),
    upstream: { kind: 'litellm', url: 'http://litellm:4000', masterKey: 'internal', chatBaseUrl: 'https://open.bigmodel.cn/api/paas/v4/', key: 'sk-user' } })
  assert.equal(converted.url, 'http://litellm:4000/v1/responses')
  assert.equal(converted.headers.authorization, 'Bearer internal')
  assert.deepEqual([converted.body.api_key, converted.body.api_base, converted.body.model], ['sk-user', 'https://open.bigmodel.cn/api/paas/v4', 'glm-5'])
  assert.throws(() => upstreamRequest({ protocol: 'openai', operation: 'messages', model: 'm', body: {}, clientHeaders: new Headers(), upstream: { kind: 'vercel', token: 't' } }))
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
})

const grant = (over: Partial<GatewayGrant> = {}): GatewayGrant => ({ runId: '10000000-0000-4000-8000-000000000001', ownerId: 'alice', workspaceId: '10000000-0000-4000-8000-000000000002', harness: 'claude_code', model: 'anthropic/claude-sonnet-5.5', source: { kind: 'credits' }, ...over })
function harness(over: Partial<GatewayDependencies> & { answer?: () => Response } = {}) {
  const calls = { reserved: [] as string[], settled: [] as [string, number | null, unknown][], fetched: [] as { url: string; init: RequestInit }[] }
  const dependencies: GatewayDependencies = {
    fetch: (async (url: string | URL | Request, init?: RequestInit) => { calls.fetched.push({ url: String(url), init: init! }); return (over.answer ?? (() => new Response(sse([
      { type: 'message_start', message: { usage: { input_tokens: 1000, output_tokens: 0 } } },
      { type: 'message_delta', usage: { output_tokens: 100 } },
    ]), { headers: { 'content-type': 'text/event-stream' } })))() }) as typeof fetch,
    verify: async token => token === 'mkg_valid' ? grant() : null,
    upstream: async () => ({ upstream: { kind: 'vercel', token: 'vercel-token' } }),
    reserve: async (_grant, id) => { calls.reserved.push(id) },
    settle: async (id, cost, usage) => { calls.settled.push([id, cost, usage]) },
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
  assert.equal(JSON.parse(String(calls.fetched[0].init.body)).model, 'anthropic/claude-sonnet-5.5')
  // 1000 input at $3/M + 100 output at $15/M = 3000 + 1500 micro-USD.
  assert.deepEqual(calls.settled.map(([id, cost]) => [id, cost]), [[calls.reserved[0], 4500]])
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
  assert.deepEqual([keyed.calls.reserved.length, keyed.calls.settled.length], [0, 0], 'the person\'s own key pays its provider directly')
  const counted = harness()
  await (await handleModelGateway(post({ messages: [] }), 'anthropic', 'count_tokens', counted.dependencies)).text()
  assert.deepEqual([counted.calls.reserved.length, counted.calls.settled.length], [0, 0], 'counting tokens is free')
})
