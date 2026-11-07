import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { after, before, mock, test } from 'node:test'
import { generateText, streamText } from 'ai'
import { CloudServiceError } from './errors'

let connection: { serviceUrl: string } | null = null, deny = false, quota = false
let origin = '', network = 0, localBilling = 0
const admissions: unknown[][] = [], received: { path: string; body: Record<string, unknown> }[] = []
const owner = { ownerId: 'local-person', workspaceId: 'local-workspace' }
const saved = Object.fromEntries(['MIKKA_EDITION', 'AI_GATEWAY_API_KEY', 'ZEROCAT_API_KEY', 'ZEROCAT_BASE_URL', 'VERCEL', 'VERCEL_OIDC_TOKEN', 'MIKKA_DEFAULT_MODEL_BASE_URL', 'MIKKA_DEFAULT_MODEL_API_KEY', 'MIKKA_DEFAULT_MODEL_ID'].map(key => [key, process.env[key]]))
mock.module(new URL('./runtime.ts', import.meta.url).href, { namedExports: {
  cloudClient: { capability: async (user: string, scope: string) => { assert.equal(user, owner.ownerId); assert.equal(scope, 'models'); return connection } },
  cloudRequest: async (user: string, scope: string, path: string, init?: RequestInit) => {
    assert.equal(user, owner.ownerId); assert.equal(scope, 'models')
    if (quota) throw new CloudServiceError('cloud_quota_exhausted')
    network++
    return fetch(`${origin}${path}`, { ...init, redirect: 'error', headers: { ...Object.fromEntries(new Headers(init?.headers)), authorization: 'Bearer fixture-cloud-access' } })
  },
} })
mock.module(new URL('../model-admission/runtime.ts', import.meta.url).href, { namedExports: {
  modelAdmission: { selfHosted: async (...args: unknown[]) => { admissions.push(args); if (deny) throw new Error('modelRouteDenied'); return null } },
  assertUnmanagedModelTransport: async (scope: unknown) => { assert.deepEqual(scope, owner); if (deny) throw new Error('modelRouteDenied') },
} })
mock.module(new URL('../abuse/context.ts', import.meta.url).href, { namedExports: { hostedBillingScope: { getStore: () => owner } } })
mock.module(new URL('../abuse/runtime.ts', import.meta.url).href, { namedExports: {
  canUseMikkaPaid: async () => { localBilling++; throw new Error('local billing must not run') },
  hostedUsage: { reserve: async () => { localBilling++ }, settle: async () => { localBilling++ } },
} })

const { defaultModelTarget, defaultModelAvailable, cloudDecisionTarget } = await import('../default-model')
const { cloudDefaultModel } = await import('./model')
const { invokeDecision } = await import('../coordinator/decide')
const modelId = 'deepseek/deepseek-v4.1-flash', decisionId = 'openai/gpt-6-luna-decisions'
const usage = { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10, prompt_tokens_details: { cached_tokens: 2 } }
const server = createServer(async (request, response) => {
  assert.equal(request.headers.authorization, 'Bearer fixture-cloud-access')
  const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk))
  const body = JSON.parse(Buffer.concat(chunks).toString())
  received.push({ path: request.url!, body })
  if (request.url === '/v1/decisions') {
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ model: decisionId, answers: [{ type: 'predicate', name: 'safe', probability: 1 }], provider_metadata: { gateway: { generationId: 'fixture-paid-decision', cost: '0.00001' } } }))
    return
  }
  assert.equal(request.url, '/v1/models/chat/completions')
  const common = { id: 'fixture-chat', created: 1, model: modelId }
  if (body.stream) {
    response.setHeader('content-type', 'text/event-stream')
    for (const value of [
      { ...common, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: 'Cloud stream.' }, finish_reason: null }] },
      { ...common, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      { ...common, object: 'chat.completion.chunk', choices: [], usage },
    ]) response.write(`data: ${JSON.stringify(value)}\n\n`)
    response.end('data: [DONE]\n\n')
  } else {
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ ...common, object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: 'Cloud reply.' }, finish_reason: 'stop' }], usage }))
  }
})
before(async () => {
  for (const key of Object.keys(saved)) delete process.env[key]
  process.env.MIKKA_EDITION = 'community'
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})
after(() => {
  server.closeAllConnections(); server.close()
  for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
})

test('local readiness selects models binding before administrator provider and never contacts cloud', async () => {
  assert.equal(await defaultModelAvailable(owner.ownerId), false)
  process.env.MIKKA_DEFAULT_MODEL_BASE_URL = 'https://own.example/v1'
  process.env.MIKKA_DEFAULT_MODEL_API_KEY = 'fixture-own-key'
  process.env.MIKKA_DEFAULT_MODEL_ID = 'own-model'
  assert.deepEqual(await defaultModelTarget(owner.ownerId), { kind: 'self-hosted' })
  connection = { serviceUrl: 'https://cloud.example/mikka/cloud' }
  assert.deepEqual(await defaultModelTarget(owner.ownerId), { kind: 'cloud', ...connection })
  assert.deepEqual(await cloudDecisionTarget(owner.ownerId), connection)
  process.env.MIKKA_EDITION = 'cloud'
  assert.equal(await cloudDecisionTarget(owner.ownerId), null)
  assert.equal(await defaultModelTarget(owner.ownerId), null, 'cloud edition never routes back through its own relay')
  process.env.MIKKA_EDITION = 'community'
  assert.equal(network, 0)
})

test('real OpenAI-compatible SDK handles JSON and streaming through only the fixed cloud capability', async () => {
  const model = cloudDefaultModel(owner, connection!.serviceUrl)
  const output = await generateText({ model, prompt: 'Protocol fixture.', maxOutputTokens: 20_000, maxRetries: 0,
    providerOptions: { gateway: { apiKey: 'must-not-forward' }, 'openai-compatible': { user: 'payer-takeover', headers: { authorization: 'other' } } } })
  assert.equal(output.text, 'Cloud reply.')
  assert.equal(output.usage.inputTokens, 7)
  assert.equal(received[0].body.model, modelId)
  assert.equal(received[0].body.max_tokens, 4096)
  assert.ok(!JSON.stringify(received[0].body).includes('payer-takeover'))
  assert.ok(!JSON.stringify(received[0].body).includes('must-not-forward'))
  const streamed = streamText({ model, prompt: 'Stream fixture.', maxRetries: 0 })
  assert.equal(await streamed.text, 'Cloud stream.')
  assert.equal((await streamed.usage).outputTokens, 3)
  assert.deepEqual(admissions[0].slice(0, 3), [owner, modelId, `${connection!.serviceUrl}/v1/models`])
  assert.equal(localBilling, 0)
})

test('model policy and cloud quota fail without redirecting to the configured own provider', async () => {
  const model = cloudDefaultModel(owner, connection!.serviceUrl), before = network
  deny = true
  await assert.rejects(generateText({ model, prompt: 'Denied', maxRetries: 0 }), /modelRouteDenied/)
  deny = false; quota = true
  await assert.rejects(generateText({ model, prompt: 'No credits', maxRetries: 0 }), /cloud_quota_exhausted/)
  quota = false
  assert.equal(network, before)
  assert.equal(localBilling, 0)
})

test('Decisions uses cloud without a local gateway key or charge and retains its provider receipt', async () => {
  const result = await invokeDecision('fixture', 'Synthetic classification', [{ type: 'predicate', name: 'safe', instructions: 'Return true for this fixture.' }])
  assert.ok(result)
  assert.equal(result.execution.providerGenerationId, 'fixture-paid-decision')
  assert.equal(result.answers.get('safe')?.type, 'predicate')
  assert.equal(received.at(-1)?.path, '/v1/decisions')
  assert.equal(localBilling, 0)
  quota = true
  await assert.rejects(invokeDecision('fixture', 'No credits', [{ type: 'predicate', name: 'safe', instructions: 'Fixture.' }]), /cloud_quota_exhausted/)
  quota = false
})
