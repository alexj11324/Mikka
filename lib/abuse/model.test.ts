import assert from 'node:assert/strict'
import { after, before, beforeEach, mock, test } from 'node:test'
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node'
import { hostedBillingScope } from './context'
const tracer = new NodeTracerProvider()
tracer.register()
after(() => tracer.shutdown())
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
const admissions: unknown[][] = []
let denyAt: 'prepare' | 'send' | null = null
let beforeSettlement: ((cost: number | null) => Promise<void>) | undefined, generationFailure: Error | undefined
const modelOptions: unknown[] = []
const factories: Array<{ callId?: string }> = []
let workflowIdentity: { workflowRunId: string; stepId: string; attempt: number } | undefined
mock.module('workflow', { namedExports: {
  getStepMetadata: () => { if (!workflowIdentity) throw Error('not_in_step'); return workflowIdentity },
  getWorkflowMetadata: () => { if (!workflowIdentity) throw Error('not_in_workflow'); return workflowIdentity },
} })
type Generation = { distinctId: string; event: string; properties?: Record<string, unknown> }
const captured: Generation[] = []
let selectedModel: unknown
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
      providerMetadata: { litellm: { cost } },
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
            providerMetadata: { litellm: { cost } },
          })
          c.close()
        },
      }),
    }
  },
}
mock.module(new URL('../posthog-server.ts', import.meta.url).href, {
  namedExports: { serverPostHog: () => ({ capture: (event: Generation) => captured.push(event) }) },
})
mock.module(new URL('../model-gateway/litellm-client.ts', import.meta.url).href, { namedExports: {
  createLiteLLMModel: (_model: string, options: { callId?: string }) => { factories.push(options); return selectedModel ?? model },
  liteLLMBaseUrl: () => 'https://litellm.fixture.invalid/v1',
  liteLLMCost: (value: { litellm?: { cost?: unknown } }) => {
    const cost = value?.litellm?.cost
    return typeof cost === 'string' && cost !== '' ? Math.ceil(Number(cost) * 1e6) : null
  },
  liteLLMGenerationId: (value: { litellm?: { generationId?: string } }) => value?.litellm?.generationId,
} })
mock.module(new URL('../model-admission/runtime.ts', import.meta.url).href, { namedExports: { modelAdmission: {
  async litellm(scope: unknown, model: string, endpoint: string, options: { auditAllowed?: boolean }) {
    admissions.push([scope, model, endpoint, options.auditAllowed])
    if (denyAt === (options.auditAllowed === false ? 'prepare' : 'send')) throw Error('modelRouteDenied')
    return null
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
  admissions.length = 0
  selectedModel = undefined
  denyAt = null
  beforeSettlement = undefined
  generationFailure = undefined
  factories.length = 0
  workflowIdentity = undefined
})

test('each actual reservation reaches its own LiteLLM call with the trusted native step identity', async () => {
  workflowIdentity = { workflowRunId: 'wrun_native', stepId: 'step_model', attempt: 2 }
  const wrapped = await hostedModel('workspace', 'fixture-model')
  const [generated, streamed] = await Promise.all([wrapped.doGenerate({ prompt: [] }), wrapped.doStream({ prompt: [] })])
  await streamed.stream.pipeTo(new WritableStream())
  assert.ok(generated.content.length)
  const bound = factories.flatMap(options => options.callId ? [options.callId] : [])
  assert.equal(bound.length, 2)
  assert.equal(new Set(bound).size, 2)
  assert.deepEqual(bound.sort(), reservations.map(id => `mikka-hosted:${id}:wrun_native:step_model:2`).sort())
  assert.deepEqual(settlements.map(row => row.cost), [2000, 2000])
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
test('LiteLLM generation preserves scoped owner attribution and numeric usage without prompt capture', async () => {
  await hostedBillingScope.run({ workspaceId: 'workspace', ownerId: 'billing-owner' }, async () => {
    const wrapped = await hostedModel('workspace', 'fixture-model', undefined, undefined, { operation: 'coordinator' })
    await wrapped.doGenerate({ prompt: [{ role: 'user', content: [{ type: 'text', text: 'PRIVATE_LITELLM_PROMPT' }] }] })
  })
  assert.deepEqual(admissions[0][0], { workspaceId: 'workspace', ownerId: 'billing-owner' })
  assert.equal(captured.length, 1)
  assert.equal(captured[0].distinctId, 'billing-owner')
  assert.equal(captured[0].properties?.['mikka.ai.route'], 'litellm')
  assert.equal(captured[0].properties?.['mikka.ai.operation'], 'coordinator')
  assert.equal(captured[0].properties?.$ai_input_tokens, 12)
  assert.equal(captured[0].properties?.$ai_output_tokens, 3)
  assert.equal(captured[0].properties?.$ai_total_cost_usd, 0.002)
  assert.doesNotMatch(JSON.stringify(captured), /PRIVATE_LITELLM_PROMPT/)
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

test('caller routing and credential overrides never reach LiteLLM', async () => {
  const wrapped = await hostedModel('workspace', 'fixture-model', undefined, 'alice')
  await wrapped.doGenerate({ prompt: [], headers: { authorization: 'synthetic-never-forward' },
    providerOptions: { gateway: { models: ['forbidden/model'], byok: { key: 'synthetic-never-forward' } } } })
  assert.equal(generated, 1)
  assert.equal((modelOptions[0] as { providerOptions: unknown }).providerOptions, undefined)
  assert.equal((modelOptions[0] as { headers: unknown }).headers, undefined)
  assert.deepEqual(admissions.map(row => row.slice(0, 3)), Array(2).fill([
    { workspaceId: 'workspace', ownerId: 'alice' }, 'fixture-model', 'https://litellm.fixture.invalid/v1',
  ]))
})
test('managed refusal precedes budget reservation; revocation during reservation precedes provider I/O', async () => {
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
test('an unverified injected transport cannot impersonate the LiteLLM endpoint', async () => {
  await assert.rejects(hostedModel('workspace', 'fixture-model', { ...model } as never, 'alice'), /modelRouteDenied/)
  assert.equal(reservations.length, 0)
  assert.equal(generated, 0)
})
for (const ending of ['error', 'cancel', 'finish'] as const) test(`early LiteLLM identity survives ${ending} without invented cost`, async () => {
  let controller!: ReadableStreamDefaultController
  let cancelled = false
  const source = new ReadableStream({
    start(value) {
      controller = value
      value.enqueue({ type: 'text-delta', id: 't', delta: 'Partial', providerMetadata: { litellm: { generationId: 'synthetic-generation' } } })
    },
    cancel() { cancelled = true },
  })
  selectedModel = { ...model, doStream: async () => ({ stream: source }) }
  const wrapped = await hostedModel('workspace', 'fixture-model')
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
    controller.enqueue({ type: 'finish', usage, finishReason: { unified: 'stop', raw: 'stop' }, providerMetadata: { litellm: { cost: '0.002' } } })
    controller.close()
    while (!(await reader.read()).done) {}
  }
  assert.ok(settlements.length)
  assert.ok(settlements.every(row => row.generationId === 'synthetic-generation'))
  assert.equal(settlements.at(-1)?.cost, ending === 'finish' ? 2000 : null)
})

test('LiteLLM header identity is durable before the first stream chunk', async () => {
  let cancelled = false
  selectedModel = { ...model, doStream: async () => ({
    response: { headers: { 'x-litellm-call-id': 'header-generation' } },
    stream: new ReadableStream({ cancel() { cancelled = true } }),
  }) }
  const wrapped = await hostedModel('workspace', 'fixture-model')
  const result = await wrapped.doStream({ prompt: [] })
  assert.deepEqual(generations, ['header-generation'])
  await result.stream.cancel()
  assert.equal(cancelled, true)
  assert.equal(settlements.at(-1)?.generationId, 'header-generation')
  assert.equal(settlements.at(-1)?.cost, null)
})

test('failure to persist the header identity stops upstream before settlement', async () => {
  let cancelled = false
  generationFailure = Error('Synthetic header identity persistence failed')
  selectedModel = { ...model, doStream: async () => ({
    response: { headers: { 'x-litellm-call-id': 'header-generation' } },
    stream: new ReadableStream({ cancel() { cancelled = true } }),
  }) }
  beforeSettlement = async () => { assert.equal(cancelled, true) }
  const wrapped = await hostedModel('workspace', 'fixture-model')
  await assert.rejects(async () => wrapped.doStream({ prompt: [] }), /header identity persistence failed/)
  assert.equal(settlements.at(-1)?.cost, null)
})


test('consumer cancellation stops upstream before blocked settlement and safely completes a pending read', async () => {
  let release!: () => void, entered!: () => void
  const blocked = new Promise<void>(resolve => { release = resolve })
  const settling = new Promise<void>(resolve => { entered = resolve })
  beforeSettlement = async () => { entered(); await blocked }
  let cancelled = false
  const source = new ReadableStream({ cancel() { cancelled = true } })
  selectedModel = { ...model, doStream: async () => ({ stream: source }) }
  const wrapped = await hostedModel('workspace', 'fixture-model')
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
  selectedModel = { ...model, doStream: async () => ({ stream: source }) }
  const wrapped = await hostedModel('workspace', 'fixture-model')
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
    start(controller) { controller.enqueue({ type: 'text-delta', id: 't', delta: 'Partial', providerMetadata: { litellm: { generationId: 'synthetic-generation' } } }) },
    cancel() { cancelled = true },
  })
  selectedModel = { ...model, doStream: async () => ({ stream: source }) }
  const wrapped = await hostedModel('workspace', 'fixture-model')
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

test('one hosted deadline covers cold readiness plus provider time while caller cancellation remains immediate', async t => {
  const deadlines: Array<{ milliseconds: number; controller: AbortController }> = []
  t.mock.method(AbortSignal, 'timeout', (milliseconds: number) => {
    const controller = new AbortController()
    deadlines.push({ milliseconds, controller })
    return controller.signal
  })
  const wrapped = await hostedModel('workspace', 'fixture-model')
  for (const method of ['doGenerate', 'doStream'] as const) {
    const caller = new AbortController()
    const result = await wrapped[method]({ prompt: [], abortSignal: caller.signal })
    assert.equal(deadlines.at(-1)?.milliseconds, 120_000)
    const received = (modelOptions.at(-1) as { abortSignal: AbortSignal }).abortSignal
    assert.equal(received.aborted, false)
    const reason = new Error('Synthetic request stopped')
    const stop = method === 'doGenerate' ? deadlines.at(-1)!.controller : caller
    stop.abort(reason)
    assert.equal(received.aborted, true)
    assert.equal(received.reason, reason)
    if (method === 'doStream') await (result as Awaited<ReturnType<typeof model.doStream>>).stream.cancel()
  }
  assert.deepEqual([generated, streamed, deadlines.length], [1, 1, 2], 'the larger budget does not retry or add a model request')
})
