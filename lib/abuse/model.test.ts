import assert from 'node:assert/strict'
import { before, beforeEach, mock, test } from 'node:test'
import { hostedBillingScope } from './context'
import { COORDINATOR_MODEL } from '../coordinator/model'
// This provider unit fixture has no organization account. Real account selection
// and revocation are exercised against PostgreSQL in tests/billing.db.test.ts.
mock.module(new URL('../billing/organization-account.ts', import.meta.url).href, { namedExports: {
  resolvePlatformBillingAccount: async (workspaceId: string) => ({ organizationId: null, accountWorkspaceId: workspaceId }),
} })
let verified = true,
  allow = true
const reservations: string[] = [],
  settlements: Array<{ id: string; cost: number | null; generationId?: string }> = [],
  generations: string[] = []
let generated = 0,
  streamed = 0,
  cost: unknown = '0.002'
const workersAiAdmissions: unknown[][] = []
let managed = false, denyAt: 'prepare' | 'send' | null = null
let beforeSettlement: ((cost: number | null) => Promise<void>) | undefined, generationFailure: Error | undefined
const modelOptions: unknown[] = []
type Generation = { distinctId: string; event: string; properties?: Record<string, unknown> }
const captured: Generation[] = [], selfHostedAdmissions: unknown[][] = []
let selfHostedConfig: ReturnType<typeof import('../default-model-config')['selfHostedDefaultModelConfig']> = null
let selfHostedTransport: { baseURL: string; apiKey?: string } | undefined
let gatewayCalls = 0
let gatewayConfig: { baseURL?: string; fetch?: typeof fetch; apiKey?: string } | undefined
const usage = { inputTokens: { total: 12 }, outputTokens: { total: 3 } }
const model = {
  specificationVersion: 'v4',
  provider: 'fixture',
  modelId: 'fixture-model',
  supportedUrls: {},
  async doGenerate(options: unknown) {
    generated++
    modelOptions.push(options)
    return {
      content: [{ type: 'text', text: 'fixture' }],
      usage,
      finishReason: { unified: 'stop', raw: 'stop' },
      warnings: [],
      providerMetadata: { gateway: { cost } },
    }
  },
  async doStream(options: unknown) {
    streamed++
    modelOptions.push(options)
    return {
      stream: new ReadableStream({
        start(c) {
          c.enqueue({ type: 'text-delta', id: 't', delta: 'fixture' })
          c.enqueue({
            type: 'finish',
            usage,
            finishReason: { unified: 'stop', raw: 'stop' },
            providerMetadata: { gateway: { cost } },
          })
          c.close()
        },
      }),
    }
  },
}
const gateway = Object.assign(() => { gatewayCalls++; return model }, {
  getAvailableModels: async () => ({
    models: [
      {
        id: 'fixture-model',
        pricing: { input: '0.000001', output: '0.000001' },
      },
    ],
  }),
})
mock.module(new URL('../default-model-config.ts', import.meta.url).href, {
  namedExports: { selfHostedDefaultModelConfig: () => selfHostedConfig, defaultModelConfigured: () => Boolean(selfHostedConfig) },
})
// This unit fixture has no cloud binding; cloud-backed admission has its own tests.
mock.module(new URL('../cloud-services/runtime.ts', import.meta.url).href, {
  namedExports: { cloudClient: { capability: async () => null } },
})
mock.module(new URL('../posthog-server.ts', import.meta.url).href, {
  namedExports: { serverPostHog: () => ({ capture: (event: Generation) => captured.push(event) }) },
})
const localUsage = { inputTokens: { total: 12, noCache: 4, cacheRead: 6, cacheWrite: 2 }, outputTokens: { total: 3 },
  raw: { prompt_tokens: 12, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 6 } } }
mock.module('@ai-sdk/openai-compatible', { namedExports: { createOpenAICompatible: (config: typeof selfHostedTransport) => {
  selfHostedTransport = config
  return { chatModel: (modelId: string) => ({ ...model, modelId,
    async doGenerate(options: unknown) {
      return { ...await model.doGenerate(options), usage: localUsage,
        content: [{ type: 'text', text: 'PRIVATE_SELF_HOSTED_RESPONSE' }],
        request: { body: 'PRIVATE_SELF_HOSTED_REQUEST' } }
    },
    async doStream(options: unknown) {
      streamed++; modelOptions.push(options)
      return { stream: new ReadableStream({ start(controller) {
        controller.enqueue({ type: 'text-delta', id: 't', delta: 'PRIVATE_SELF_HOSTED_RESPONSE' })
        controller.enqueue({ type: 'finish', usage: localUsage, finishReason: { unified: 'stop', raw: 'stop' } })
        controller.close()
      } }) }
    },
  }) }
} } })
mock.module('ai', { namedExports: { gateway, createGateway: (options: typeof gatewayConfig) => { gatewayConfig = options; return gateway } } })
mock.module(new URL('../model-admission/runtime.ts', import.meta.url).href, { namedExports: { modelAdmission: {
  async workersAi(scope: unknown, model: string, endpoint: string, options: { auditAllowed?: boolean }) {
    workersAiAdmissions.push([scope,model,endpoint,options.auditAllowed])
    if (denyAt === (options.auditAllowed === false ? 'prepare' : 'send')) throw Error('modelRouteDenied')
    return null
  },
  async selfHosted(...args: unknown[]) {
    selfHostedAdmissions.push(args)
    if (denyAt) throw Error('modelRouteDenied')
    return null
  },
  async gateway(_scope: unknown, model: string, endpoint: string, options: { auditAllowed?: boolean }) {
    if (denyAt === (options.auditAllowed === false ? 'prepare' : 'send')) throw Error('modelRouteDenied')
    return managed ? { model, endpoint, servingProviders: ['deepseek'], dataRegion: 'unknown' } : null
  },
} } })
mock.module(new URL('./runtime.ts', import.meta.url).href, {
  namedExports: {
    canUseMikkaPaid: async () => {
      if (!verified) throw Error('verification_required')
    },
    hostedUsage: {
      reserve: async (_ws: string, _model: string, id: string) => {
        if (!allow) throw Error('points_exhausted')
        reservations.push(id)
      },
      recordGeneration: async (_id: string, generationId: string) => { if (generationFailure) throw generationFailure; generations.push(generationId) },
      settle: async (id: string, cost: number | null, _input?: number, _output?: number, generationId?: string) => {
        await beforeSettlement?.(cost)
        settlements.push({ id, cost, ...(generationId ? { generationId } : {}) })
      },
    },
  },
})
mock.module(new URL('./alerts.ts', import.meta.url).href, {
  namedExports: { checkAbuseAlerts: async () => {} },
})
let hostedModel: (typeof import('./model'))['hostedModel']
before(async () => {
  ;({ hostedModel } = await import('./model'))
})
beforeEach(() => {
  verified = true
  allow = true
  cost = '0.002'
  generated = 0
  streamed = 0
  reservations.length = 0
  settlements.length = 0
  generations.length = 0
  modelOptions.length = 0
  captured.length = 0
  selfHostedAdmissions.length = 0
  selfHostedConfig = null
  selfHostedTransport = undefined
  gatewayCalls = 0
  managed = false
  denyAt = null
  gatewayConfig = undefined
  beforeSettlement = undefined
  generationFailure = undefined
})

for (const streaming of [false, true]) test(`self-hosted default ${streaming ? 'stream' : 'generation'} keeps direct admission and records only its actual model receipt`, async () => {
  selfHostedConfig = { baseURL: 'https://self-hosted-canary.invalid/v1', apiKey: 'synthetic-self-hosted-key-canary', modelId: 'configured/local-model' }
  verified = false; allow = false
  const ownerId = streaming ? 'billing-owner' : 'explicit-owner'
  await hostedBillingScope.run({ workspaceId: 'workspace', ownerId: 'billing-owner' }, async () => {
    const wrapped = await hostedModel('workspace', COORDINATOR_MODEL, undefined, streaming ? undefined : ownerId,
      { operation: 'coordinator', tier: 'standard', effort: 'high' })
    assert.equal(wrapped.modelId, 'configured/local-model')
    const args = { prompt: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'PRIVATE_SELF_HOSTED_PROMPT' }] }],
      providerOptions: { gateway: { apiKey: 'PRIVATE_SELF_HOSTED_GATEWAY_KEY' } } }
    if (streaming) {
      const result = await wrapped.doStream(args)
      const parts = []; for await (const part of result.stream) parts.push(part)
      assert.equal(parts[0].type, 'text-delta')
      assert.equal(parts.at(-1)?.type, 'finish')
    } else assert.equal((await wrapped.doGenerate(args)).content[0].type, 'text')
  })
  assert.equal(gatewayCalls, 0)
  assert.equal(generated + streamed, 1)
  assert.equal(reservations.length + settlements.length + generations.length, 0)
  assert.deepEqual(selfHostedAdmissions[0].slice(0, 3), [
    { workspaceId: 'workspace', ownerId }, 'configured/local-model', selfHostedConfig.baseURL,
  ])
  assert.equal(selfHostedTransport?.baseURL, selfHostedConfig.baseURL)
  assert.equal(selfHostedTransport?.apiKey, selfHostedConfig.apiKey)
  assert.deepEqual((modelOptions[0] as { providerOptions: unknown }).providerOptions, {})
  assert.equal(captured.length, 1, 'the self-hosted early return must pass through the generation observer exactly once')
  const event = captured[0], properties = event.properties!
  assert.equal(event.distinctId, ownerId)
  assert.equal(event.event, '$ai_generation')
  assert.equal(properties.$ai_model, 'configured/local-model', 'do not report the hosted UI alias')
  assert.equal(properties['mikka.ai.route'], 'self_hosted')
  assert.equal(properties['mikka.ai.operation'], 'coordinator')
  assert.equal(properties['mikka.ai.effort'], 'high')
  assert.equal(properties.$ai_input_tokens, 12)
  assert.equal(properties.$ai_output_tokens, 3)
  assert.equal(properties.$ai_cache_read_input_tokens, 6)
  assert.equal(properties.$ai_cache_creation_input_tokens, 2)
  assert.equal(properties.$ai_stream, streaming)
  assert.equal(properties.$ai_is_error, false)
  assert.equal(properties.$ai_total_cost_usd, undefined, 'no charge or zero-cost receipt is invented')
  assert.equal(typeof properties.$ai_time_to_first_token, streaming ? 'number' : 'undefined')
  assert.doesNotMatch(JSON.stringify(captured), /PRIVATE_SELF_HOSTED|self-hosted-canary\.invalid|synthetic-self-hosted-key-canary/)
})

test('a refused self-hosted generation stays refused without provider or paid fallback and without borrowed owner scope', async () => {
  selfHostedConfig = { baseURL: 'https://self-hosted-canary.invalid/v1', apiKey: 'synthetic-self-hosted-key-canary', modelId: 'configured/local-model' }
  denyAt = 'send'
  await hostedBillingScope.run({ workspaceId: 'another-workspace', ownerId: 'unrelated-owner' }, async () => {
    const wrapped = await hostedModel('workspace', COORDINATOR_MODEL, undefined, undefined, { operation: 'bot' })
    await assert.rejects(async () => wrapped.doGenerate({ prompt: [] }), /modelRouteDenied/)
  })
  assert.deepEqual(selfHostedAdmissions[0][0], { workspaceId: 'workspace', ownerId: undefined })
  assert.equal(generated + streamed + gatewayCalls, 0)
  assert.equal(reservations.length + settlements.length, 0)
  assert.equal(captured.length, 1)
  assert.equal(captured[0].distinctId, 'mikka:server')
  assert.equal(captured[0].properties?.$ai_is_error, true)
  assert.equal(captured[0].properties?.['mikka.ai.route'], 'self_hosted')
  assert.equal(captured[0].properties?.$ai_input_tokens, undefined)
})
test('verification and zero balance prevent provider I/O, including another tool step', async () => {
  verified = false
  await assert.rejects(
    hostedModel('workspace', 'fixture-model'),
    /verification_required/,
  )
  assert.equal(generated + streamed, 0)
  verified = true
  const wrapped = await hostedModel('workspace', 'fixture-model')
  await wrapped.doGenerate({ prompt: [] })
  allow = false
  await assert.rejects(
    Promise.resolve(wrapped.doGenerate({ prompt: [] })),
    /points_exhausted/,
  )
  assert.equal(generated, 1)
  assert.equal(settlements[0].cost, 2000)
})
test('stream finish settles before delivery; every call has its own ledger identity', async () => {
  const wrapped = await hostedModel('workspace', 'fixture-model')
  const result = await wrapped.doStream({ prompt: [] })
  const reader = result.stream.getReader()
  while (!(await reader.read()).done) {}
  await wrapped.doGenerate({ prompt: [] })
  assert.equal(streamed, 1)
  assert.equal(generated, 1)
  assert.equal(new Set(reservations).size, 2)
  assert.deepEqual(
    settlements.map((row) => row.cost),
    [2000, 2000],
  )
})
test('missing provider cost is held for reconciliation, never silently free', async () => {
  cost = undefined
  await assert.rejects(
    Promise.resolve(
      (await hostedModel('workspace', 'fixture-model')).doGenerate({
        prompt: [],
      }),
    ),
    /usage_cost_unavailable/,
  )
  assert.equal(settlements[0].cost, null)
})

test('managed provider options replace caller fallback, credentials and provider order', async () => {
  managed = true
  const wrapped = await hostedModel('workspace', 'fixture-model', undefined, 'alice')
  await wrapped.doGenerate({ prompt: [], providerOptions: { gateway: { models: ['forbidden/model'], only: ['forbidden'],
    order: ['forbidden'], byok: { forbidden: [{ apiKey: 'synthetic-never-forward' }] } } } })
  assert.equal(generated, 1)
  assert.deepEqual((modelOptions[0] as { providerOptions: unknown }).providerOptions, {
    gateway: { only: ['deepseek'], order: ['deepseek'], models: [], user: 'workspace' },
  })
  assert.equal(gatewayConfig?.baseURL, 'https://ai-gateway.vercel.sh/v4/ai')
})
test('managed refusal precedes budget reservation; revocation during reservation precedes provider I/O', async () => {
  managed = true
  const wrapped = await hostedModel('workspace', 'fixture-model', undefined, 'alice')
  denyAt = 'prepare'
  await assert.rejects(Promise.resolve(wrapped.doGenerate({ prompt: [] })), /modelRouteDenied/)
  assert.equal(reservations.length, 0)
  assert.equal(generated + streamed, 0)
  denyAt = 'send'
  await assert.rejects(Promise.resolve(wrapped.doStream({ prompt: [] })), /modelRouteDenied/)
  assert.equal(reservations.length, 1)
  assert.equal(generated + streamed, 0)
  assert.equal(settlements[0].cost, 0)
})
test('an unverified injected transport cannot impersonate the managed Gateway endpoint', async () => {
  managed = true
  await assert.rejects(Promise.resolve((await hostedModel('workspace', 'fixture-model', { ...model } as never, 'alice')).doGenerate({ prompt: [] })), /modelRouteDenied/)
  assert.equal(reservations.length, 0)
  assert.equal(generated, 0)
})
test('a trusted custom-key Gateway remains usable under an allowed managed route',async()=>{
  managed=true
  const {createTrustedGatewayModel}=await import('./model')
  const provider=await createTrustedGatewayModel('fixture-model','synthetic-custom-key')
  const wrapped=await hostedModel('workspace','fixture-model',provider,'alice')
  await wrapped.doGenerate({prompt:[]})
  assert.equal(generated,1)
  assert.equal(gatewayConfig?.apiKey,'synthetic-custom-key')
  assert.equal(gatewayConfig?.baseURL,'https://ai-gateway.vercel.sh/v4/ai')
  denyAt='prepare'
  await assert.rejects(Promise.resolve(wrapped.doGenerate({prompt:[]})),/modelRouteDenied/)
  assert.equal(generated,1)
})

for (const ending of ['error', 'cancel', 'finish'] as const) test(`early Gateway identity survives ${ending} without invented cost`, async () => {
  let controller!: ReadableStreamDefaultController
  let cancelled = false
  const source = new ReadableStream({
    start(value) {
      controller = value
      value.enqueue({ type: 'text-delta', id: 't', delta: 'Partial', providerMetadata: { gateway: { generationId: 'synthetic-generation' } } })
    },
    cancel() { cancelled = true },
  })
  const wrapped = await hostedModel('workspace', 'fixture-model', { ...model, doStream: async () => ({ stream: source }) } as never)
  const reader = (await wrapped.doStream({ prompt: [] })).stream.getReader()
  await reader.read()
  assert.deepEqual(generations, ['synthetic-generation'], 'identity is persisted before content reaches the caller')
  assert.equal(settlements.length, 0, 'the identity alone does not settle or debit money')
  if (ending === 'cancel') {
    await reader.cancel()
    assert.equal(cancelled, true)
  } else if (ending === 'error') {
    controller.error(new Error('Synthetic interrupted transport'))
    await assert.rejects(reader.read(), /interrupted transport/)
  } else {
    controller.enqueue({ type: 'finish', usage, finishReason: { unified: 'stop', raw: 'stop' }, providerMetadata: { gateway: { cost: '0.002' } } })
    controller.close()
    while (!(await reader.read()).done) {}
  }
  assert.ok(settlements.length)
  assert.ok(settlements.every(row => row.generationId === 'synthetic-generation'))
  assert.equal(settlements.at(-1)?.cost, ending === 'finish' ? 2000 : null)
})


test('consumer cancellation stops upstream before blocked settlement and safely completes a pending read', async () => {
  let release!: () => void, entered!: () => void
  const blocked = new Promise<void>(resolve => { release = resolve })
  const settling = new Promise<void>(resolve => { entered = resolve })
  beforeSettlement = async () => { entered(); await blocked }
  let cancelled = false
  const source = new ReadableStream({ cancel() { cancelled = true } })
  const wrapped = await hostedModel('workspace', 'fixture-model', { ...model, doStream: async () => ({ stream: source }) } as never)
  const reader = (await wrapped.doStream({ prompt: [] })).stream.getReader()
  const reading = reader.read(), stopping = reader.cancel('Browser disconnected')
  try {
    await settling
    assert.equal(cancelled, true, 'accounting latency cannot leave the provider generating after cancellation')
    assert.equal((await reading).done, true)
    assert.equal(settlements.length, 0)
  } finally { release(); await stopping }
  assert.equal(settlements.length, 1, 'the cancelled pending pull must not settle a second time')
  assert.equal(settlements[0].cost, null)
})

test('cancel still stops upstream when unknown-cost settlement fails, and rejects the accounting failure', async () => {
  beforeSettlement = async () => { throw Error('Synthetic accounting database unavailable') }
  let cancelled = false
  const source = new ReadableStream({ cancel() { cancelled = true } })
  const wrapped = await hostedModel('workspace', 'fixture-model', { ...model, doStream: async () => ({ stream: source }) } as never)
  const stream = (await wrapped.doStream({ prompt: [] })).stream
  await assert.rejects(stream.cancel('Browser disconnected'), /accounting database unavailable/)
  assert.equal(cancelled, true)
  assert.equal(settlements.length, 0, 'a failed accounting write is not a successful or zero-cost settlement')
})

test('a stream processing error stops upstream before waiting for its unknown-cost settlement', async () => {
  generationFailure = new Error('Synthetic generation identity persistence failed')
  let release!: () => void, entered!: () => void
  const blocked = new Promise<void>(resolve => { release = resolve })
  const settling = new Promise<void>(resolve => { entered = resolve })
  beforeSettlement = async () => { entered(); await blocked }
  let cancelled = false
  const source = new ReadableStream({
    start(controller) { controller.enqueue({ type: 'text-delta', id: 't', delta: 'Partial', providerMetadata: { gateway: { generationId: 'synthetic-generation' } } }) },
    cancel() { cancelled = true },
  })
  const wrapped = await hostedModel('workspace', 'fixture-model', { ...model, doStream: async () => ({ stream: source }) } as never)
  const reader = (await wrapped.doStream({ prompt: [] })).stream.getReader()
  const reading = assert.rejects(reader.read(), /generation identity persistence failed/)
  try { await settling; assert.equal(cancelled, true) }
  finally { release(); await reading }
  assert.equal(settlements.at(-1)?.cost, null)
})

test('server-owned billing adapter reuses the full route and settles in its own ledger exactly once', async () => {
  verified = false // The default platform admission must not be consulted.
  const events: string[] = [], costs: Array<number | null> = []
  const adapter = {
    admit: async (workspace: string) => { assert.equal(workspace, 'fixture-workspace'); events.push('admit') },
    usage: {
      metered: true,
      reserve: async (workspace: string, _model: string, id: string) => { events.push('reserve'); return { id, workspaceId: workspace } },
      recordGeneration: async () => {},
      settle: async (_id: string, value: number | null) => { costs.push(value) },
    },
  }
  const selected = await hostedModel('fixture-workspace', 'fixture-model', undefined, 'fixture-owner', adapter)
  await selected.doGenerate({ prompt: [] })
  assert.deepEqual(events, ['admit', 'reserve'])
  assert.deepEqual(costs, [2000])
  assert.equal(reservations.length, 0)
  assert.equal(settlements.length, 0)
})

test('Workers AI fallback enforces its own route before reserve and before send and meters both SDK paths', async t => {
  const keys = ['MIKKA_HOSTED_MODEL_FALLBACK','CLOUDFLARE_WORKERS_AI_TOKEN','CLOUDFLARE_WORKERS_AI_ACCOUNT_ID','ZEROCAT_API_KEY','ZEROCAT_BASE_URL'] as const
  const saved = new Map(keys.map(key => [key,process.env[key]]))
  t.after(() => { for (const [key,value] of saved) if (value === undefined) delete process.env[key]; else process.env[key]=value })
  process.env.MIKKA_HOSTED_MODEL_FALLBACK='cloudflare-workers-ai'
  process.env.CLOUDFLARE_WORKERS_AI_TOKEN='account-model-test'
  process.env.CLOUDFLARE_WORKERS_AI_ACCOUNT_ID='a'.repeat(32)
  delete process.env.ZEROCAT_API_KEY
  delete process.env.ZEROCAT_BASE_URL
  const selected = await hostedModel('w',COORDINATOR_MODEL,undefined,'owner')
  const args = {prompt:[],headers:{'x-caller':'discard'},providerOptions:{gateway:{order:['foreign']}}}
  await selected.doGenerate(args)
  const streamed = await selected.doStream(args)
  await streamed.stream.pipeTo(new WritableStream())
  const endpoint = 'https://api.cloudflare.com/client/v4/accounts/'+'a'.repeat(32)+'/ai/v1'
  assert.equal(selfHostedTransport?.baseURL,endpoint)
  assert.equal(selfHostedTransport?.apiKey,'account-model-test')
  assert.equal(workersAiAdmissions.length,4)
  assert.deepEqual(workersAiAdmissions[0],[{workspaceId:'w',ownerId:'owner'},COORDINATOR_MODEL,endpoint,false])
  assert.deepEqual(workersAiAdmissions[1],[{workspaceId:'w',ownerId:'owner'},COORDINATOR_MODEL,endpoint,undefined])
  assert.deepEqual(settlements.map(x=>x.cost),[6,6])
  for(const actual of modelOptions as typeof args[]) { assert.equal(actual.headers,undefined); assert.equal(actual.providerOptions,undefined) }
  denyAt='send'
  await assert.rejects(selected.doGenerate(args),/modelRouteDenied/)
  assert.equal(settlements.at(-1)?.cost,0)
  delete process.env.CLOUDFLARE_WORKERS_AI_TOKEN
  await assert.rejects(hostedModel('w',COORDINATOR_MODEL),/modelRouteDenied/)
  await assert.rejects(hostedModel('w','other/vendor'),/modelRouteDenied/)
})

test('Workers AI settlement requires the original token breakdown even when the SDK supplies defaults', async () => {
  const {workersAiCost}=await import('./workers-ai')
  const normalized={inputTokens:{total:10,cacheRead:0},outputTokens:{total:3}}
  assert.equal(workersAiCost({...normalized,raw:{prompt_tokens:10,completion_tokens:3,prompt_tokens_details:{cached_tokens:0}}}),7)
  assert.equal(workersAiCost({...normalized,raw:{prompt_tokens:10,completion_tokens:3}}),null)
  assert.equal(workersAiCost({...normalized,raw:{prompt_tokens:10,completion_tokens:3,prompt_tokens_details:{cached_tokens:8}}}),null)
})
