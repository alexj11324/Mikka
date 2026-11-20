import assert from 'node:assert/strict'
import test from 'node:test'
import { handleModelGateway, type GatewayDependencies } from '../lib/model-gateway/handler'
import type { GatewayGrant } from '../lib/model-gateway/token'

/*
 * Decision 2026-11-15-2000, against a real LiteLLM started with
 * deploy/litellm/config.yaml and an OpenAI-compatible Chat Completions server:
 *   MIKKA_LITELLM_TEST_URL=http://127.0.0.1:4012 MIKKA_LITELLM_TEST_MASTER_KEY=… \
 *   MIKKA_LITELLM_TEST_PROVIDER=http://127.0.0.1:9911/v1
 * The gateway sends Claude Code's Anthropic messages and Codex's Responses
 * requests through LiteLLM to a provider that speaks only Chat Completions,
 * with the person's key on that one request, and settles from the converted usage.
 */
const url = process.env.MIKKA_LITELLM_TEST_URL, masterKey = process.env.MIKKA_LITELLM_TEST_MASTER_KEY, provider = process.env.MIKKA_LITELLM_TEST_PROVIDER
const skip = !url || !masterKey || !provider

function dependencies(grant: GatewayGrant, settled: (number | null)[], credits = false): GatewayDependencies {
  return {
    fetch, verify: async token => token === 'mkg_litellm' ? grant : null,
    upstream: async () => ({ upstream: { url: url!, masterKey: masterKey!, ...(credits ? {} : { credential: { provider: 'openai' as const, apiBase: provider!, key: 'sk-person-key', chatCompletionsOnly: true } }) } }),
    reserve: async () => {}, settle: async (_id, cost) => { settled.push(cost) },
    catalogue: async () => [{ id: grant.model, vendor: 'zai', name: 'GLM', contextWindow: null, maxTokens: null, pricing: { input: 1, output: 2 }, tags: [], reasoning: [] }],
  }
}

test('Claude Code reaches a Chat Completions–only provider through LiteLLM, tool calls included', { skip }, async () => {
  const settled: (number | null)[] = []
  const grant: GatewayGrant = { runId: '10000000-0000-4000-8000-000000000001', ownerId: 'alice', workspaceId: '10000000-0000-4000-8000-000000000002', harness: 'claude_code', model: 'zai/glm-5', source: { kind: 'credits' } }
  const response = await handleModelGateway(new Request('https://mikka.test/api/model-gateway/anthropic/v1/messages', { method: 'POST',
    headers: { 'x-api-key': 'mkg_litellm', 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 50, stream: true, messages: [{ role: 'user', content: 'use tool' }],
      tools: [{ name: 'bash', description: 'run', input_schema: { type: 'object', properties: { c: { type: 'string' } } } }] }) }), 'anthropic', 'messages', dependencies(grant, settled))
  assert.equal(response.status, 200)
  const text = await response.text()
  assert.match(text, /"type": ?"tool_use"/)
  assert.match(text, /"stop_reason": ?"tool_use"/)
  assert.deepEqual(settled, [20 * 1 + 5 * 2], 'settled from the usage LiteLLM converted')
})

test('Codex reaches a Chat Completions–only provider through LiteLLM', { skip }, async () => {
  const settled: (number | null)[] = []
  const grant: GatewayGrant = { runId: '10000000-0000-4000-8000-000000000001', ownerId: 'alice', workspaceId: '10000000-0000-4000-8000-000000000002', harness: 'codex', model: 'zai/glm-5', source: { kind: 'credits' } }
  const response = await handleModelGateway(new Request('https://mikka.test/api/model-gateway/openai/v1/responses', { method: 'POST',
    headers: { authorization: 'Bearer mkg_litellm', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-5.5', stream: true, input: 'hi' }) }), 'openai', 'responses', dependencies(grant, settled))
  assert.equal(response.status, 200)
  const text = await response.text()
  assert.match(text, /response\.completed/)
  assert.deepEqual(settled, [11 * 1 + 2 * 2])
})

for (const protocol of ['anthropic', 'openai'] as const) {
  test(`Mikka credits preserve vendor/model through the LiteLLM Vercel wildcard and ${protocol} bridge`, { skip }, async () => {
    const settled: (number | null)[] = []
    const grant: GatewayGrant = { runId: '10000000-0000-4000-8000-000000000001', ownerId: 'alice', workspaceId: '10000000-0000-4000-8000-000000000002',
      harness: protocol === 'anthropic' ? 'claude_code' : 'codex', model: 'fixture/provider-model', source: { kind: 'credits' } }
    const body = protocol === 'anthropic'
      ? { max_tokens: 50, stream: true, messages: [{ role: 'user', content: 'hi' }] }
      : { stream: true, input: 'hi' }
    const response = await handleModelGateway(new Request('https://mikka.test/api/model-gateway', { method: 'POST',
      headers: { authorization: 'Bearer mkg_litellm', 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      protocol, protocol === 'anthropic' ? 'messages' : 'responses', dependencies(grant, settled, true))
    assert.equal(response.status, 200)
    assert.match(await response.text(), protocol === 'anthropic' ? /message_delta/ : /response\.completed/)
    assert.deepEqual(settled, [11 * 1 + 2 * 2])
  })
}
