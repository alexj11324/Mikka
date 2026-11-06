import assert from 'node:assert/strict'
import { after, before, beforeEach, test } from 'node:test'
import { context, propagation, SpanStatusCode, trace } from '@opentelemetry/api'
import { AlwaysOnSampler, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base'
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node'
import type { LanguageModel } from 'ai'
import { observedModel, observeAiRequest, recordAiRoute, recordAiUsage, withAiMetadata } from './ai'
import { withRunSpan, withTraceMetadata } from './context'
import { modelTokenUsage } from '../model-call-timing'

type Model = Extract<LanguageModel, { specificationVersion: 'v4' }>
type Part = Awaited<ReturnType<Model['doStream']>>['stream'] extends ReadableStream<infer P> ? P : never
type Generate = Awaited<ReturnType<Model['doGenerate']>>
type Event = { distinctId: string; event: string; properties?: Record<string, unknown>; timestamp?: Date }
const memory = new InMemorySpanExporter()
const provider = new NodeTracerProvider({ sampler: new AlwaysOnSampler(), spanProcessors: [new SimpleSpanProcessor(memory)] })
const captured: Event[] = []
const sink = { capture: (value: Event) => { captured.push(value) } }
const usage = { inputTokens: { total: 18000, noCache: 200, cacheRead: 17500, cacheWrite: 300 }, outputTokens: { total: 120, text: 100, reasoning: 20 } }
const reply = { content: [{ type: 'text', text: 'PRIVATE_RESPONSE' }], finishReason: { unified: 'stop', raw: 'PRIVATE_FINISH' }, usage, warnings: [], request: { body: 'PRIVATE_REQUEST' }, response: { headers: { authorization: 'SECRET_TOKEN' } } } as Generate
const args = { prompt: [{ role: 'user', content: [{ type: 'text', text: 'PRIVATE_PROMPT' }] }], tools: [{ type: 'function', name: 'PRIVATE_TOOL', inputSchema: {} }] } as Parameters<Model['doGenerate']>[0]
const base = (stream?: () => ReadableStream<Part>, generate?: () => Promise<Generate>): Model => ({ specificationVersion: 'v4', provider: 'test', modelId: 'test/model', supportedUrls: {}, doGenerate: generate ?? (async () => reply), doStream: async () => ({ stream: stream!() }) })
const streamOf = (parts: unknown[]) => new ReadableStream<Part>({ start(controller) { for (const part of parts) controller.enqueue(part as Part); controller.close() } })
async function drain(stream: ReadableStream<Part>) { const parts: Part[] = []; for await (const part of stream) parts.push(part); return parts }
const privacy = () => assert.doesNotMatch(JSON.stringify({ events: captured, spans: memory.getFinishedSpans().map(span => ({ attributes: span.attributes, events: span.events, status: span.status })) }), /PRIVATE_|SECRET_TOKEN/)

before(() => provider.register())
beforeEach(() => { captured.length = 0; memory.reset() })
after(async () => { await provider.shutdown(); trace.disable(); context.disable(); propagation.disable() })

test('each generation shares its APM ancestry and session, captures numeric usage/cost and never captures content', async () => {
  let clock = 100
  const model = observedModel(base(undefined, async () => {
    recordAiRoute({ route: 'gateway', fallbackReason: 'timeout', zeroCatMs: 1000, totalCostUsd: 0.000345 })
    clock += 250
    return reply
  }), { route: 'zerocat', posthog: sink, now: () => clock })
  assert.equal(observedModel(model, { posthog: sink }), model, 'wrapping an observed provider is idempotent')
  await withRunSpan('workflow.coordinator', {}, () => withTraceMetadata({ runId: 'run-123', threadId: 'thread-123', posthogDistinctId: 'user-123', sessionId: 'session-123' }, () =>
    withAiMetadata({ operation: 'coordinator', tier: 'standard', effort: 'high', effortScore: 2.1, effortConfidence: 0.9 }, async () => {
      assert.equal(await model.doGenerate(args), reply)
      await model.doGenerate(args)
    })))
  assert.equal(captured.length, 2)
  await provider.forceFlush()
  const spans = memory.getFinishedSpans()
  const generations = spans.filter(span => span.name === 'mikka.ai.generation')
  const parent = spans.find(span => span.name === 'workflow.coordinator')!
  assert.equal(generations.length, 2)
  for (const [index, generation] of generations.entries()) {
    const properties = captured[index].properties!
    assert.equal(captured[index].distinctId, 'user-123')
    assert.ok(captured[index].timestamp instanceof Date, 'AI time lines start at invocation time, not capture time')
    assert.equal(properties.$ai_trace_id, parent.spanContext().traceId)
    assert.equal(properties.$ai_span_id, generation.spanContext().spanId)
    assert.equal(properties.$ai_parent_id, parent.spanContext().spanId)
    assert.equal(properties.$ai_session_id, 'session-123')
    assert.equal(properties.$session_id, 'session-123', 'a genuine frontend session also links its replay')
    assert.equal(properties['mikka.run_id'], 'run-123')
    assert.equal(properties.$ai_input_tokens, 18000, 'SDK input total already includes both cache counts')
    assert.equal(properties.$ai_output_tokens, 120)
    assert.equal(properties.$ai_cache_read_input_tokens, 17500)
    assert.equal(properties.$ai_cache_creation_input_tokens, 300)
    assert.equal(properties.$ai_cache_reporting_exclusive, false)
    assert.equal(properties.$ai_latency, 0.25)
    assert.equal(properties.$ai_time_to_first_token, undefined, 'a non-streaming call has no measured TTFT')
    assert.equal(properties.$ai_total_cost_usd, 0.000345)
    assert.equal(properties.$ai_cost_passthrough, true, 'the actual provider receipt must not be overwritten by catalogue pricing')
    assert.equal(properties.$ai_stream, false)
    assert.equal(properties['mikka.ai.route'], 'gateway')
    assert.equal(properties['mikka.ai.fallback_reason'], 'timeout')
    assert.equal(properties['mikka.ai.effort_score'], 2.1)
    assert.equal(generation.attributes['mikka.ai.total_cost_usd'], 0.000345)
  }
  privacy()
})

test('stream first token, finish and cancellation preserve the original stream and produce one receipt', async () => {
  let clock = 100
  let index = 0
  const parts = [
    { type: 'stream-start', warnings: [] },
    { type: 'tool-input-start', id: 'private-id', toolName: 'PRIVATE_TOOL' },
    { type: 'tool-call', toolCallId: 'private-id', toolName: 'PRIVATE_TOOL', input: 'PRIVATE_TOOL_INPUT' },
    { type: 'text-delta', id: 'text-id', delta: 'PRIVATE_RESPONSE' },
    { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'PRIVATE_FINISH' }, usage },
  ]
  const model = observedModel(base(() => new ReadableStream<Part>({ pull(controller) {
    clock += 10
    if (index === parts.length) { recordAiRoute({ totalCostUsd: 0 }); controller.close(); return }
    controller.enqueue(parts[index++] as Part)
  } })), { posthog: sink, now: () => clock, route: 'subscription' })
  const result = await model.doStream(args)
  assert.deepEqual(await drain(result.stream), parts)
  assert.equal(captured.length, 1)
  const properties = captured[0].properties!
  assert.equal(properties.$ai_is_error, false)
  assert.equal(typeof properties.$ai_time_to_first_token, 'number')
  assert.ok((properties.$ai_time_to_first_token as number) > 0)
  assert.equal(properties.$ai_total_cost_usd, 0, 'a reported zero is distinct from missing cost')
  assert.equal(properties['mikka.ai.tool_calls'], 1)
  privacy()
})

test('missing and invalid token counts stay absent; public v7 and provider v4 cache fields agree', () => {
  assert.deepEqual(modelTokenUsage({ inputTokens: 18000, outputTokens: 120, inputTokenDetails: { cacheReadTokens: 17500, cacheWriteTokens: 300 } }), modelTokenUsage(usage))
  assert.deepEqual(modelTokenUsage({ inputTokens: { total: NaN, cacheRead: -1, cacheWrite: Infinity }, outputTokens: -2 }), { inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null })
  assert.deepEqual(modelTokenUsage(undefined), { inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null })
  assert.equal(modelTokenUsage({ inputTokens: { total: 0, cacheRead: 0, cacheWrite: 0 }, outputTokens: 0 }).inputTokens, 0)
})

test('credential-looking labels and URLs are omitted from AI events and spans', async () => {
  for (const value of ['https://private.example', 'http://private.example', 'phc_private', 'phx_private', 'sk-private', 'sk_private', 'ghp_private', 'gho_private', 'ghu_private', 'ghs_private', 'ghr_private', 'github_pat_private']) {
    await observedModel(base(undefined, async () => {
      recordAiRoute({ fallbackReason: value })
      return reply
    }), { modelId: value, tier: value, effort: value, posthog: sink }).doGenerate(args)
    const properties = captured.at(-1)!.properties!
    assert.equal(properties.$ai_model, 'unknown')
    for (const key of ['mikka.ai.fallback_reason', 'mikka.ai.tier', 'mikka.ai.effort', '$ai_session_id', '$session_id']) assert.equal(properties[key], undefined)
  }
  await provider.forceFlush()
  for (const span of memory.getFinishedSpans()) {
    assert.equal(span.attributes['mikka.ai.model'], 'unknown')
    assert.equal(span.attributes['mikka.ai.fallback_reason'], undefined)
    assert.equal(span.attributes['mikka.ai.tier'], undefined)
    assert.equal(span.attributes['mikka.ai.effort'], undefined)
  }
  privacy()
})

test('stream read errors and error parts record safe error causes once without swallowing provider errors', async () => {
  const failure = Object.assign(new Error('PRIVATE_ERROR SECRET_TOKEN'), { code: 'ECONNRESET', cause: new TypeError('PRIVATE_CAUSE') })
  const model = observedModel(base(() => new ReadableStream({ pull() { throw failure } })), { posthog: sink })
  await assert.rejects(drain((await model.doStream(args)).stream), error => error === failure)
  assert.equal(captured.length, 1)
  assert.equal(captured[0].properties?.$ai_is_error, true)
  assert.equal(captured[0].properties?.$ai_input_tokens, undefined)
  assert.equal(captured[0].properties?.$ai_time_to_first_token, undefined)
  await provider.forceFlush()
  assert.equal(memory.getFinishedSpans()[0].status.code, SpanStatusCode.ERROR)
  assert.equal(captured[0].properties?.['mikka.error.code'], 'ECONNRESET')
  const inBand = observedModel(base(() => streamOf([{ type: 'error', error: failure }])), { posthog: sink })
  assert.equal((await drain((await inBand.doStream(args)).stream)).length, 1)
  assert.equal(captured.length, 2)
  assert.equal(captured[1].properties?.$ai_is_error, true)
  const interrupted = observedModel(base(() => new ReadableStream({ start(controller) { controller.enqueue({ type: 'error', error: failure }) } })), { posthog: sink })
  const reader = (await interrupted.doStream(args)).stream.getReader()
  await reader.read()
  await reader.cancel()
  assert.equal(captured[2].properties?.['mikka.ai.outcome'], 'error', 'SDK cleanup cannot turn a provider error into user cancellation')
  privacy()
})

test('abort and consumer cancellation end telemetry once and still cancel upstream', async () => {
  let cancelled = 0
  const signal = new AbortController()
  const model = observedModel(base(() => new ReadableStream<Part>({ cancel() { cancelled++ } })), { posthog: sink })
  const result = await model.doStream({ ...args, abortSignal: signal.signal })
  signal.abort(new Error('PRIVATE_CANCEL SECRET_TOKEN'))
  assert.equal(captured.length, 1, 'an upstream that stalls after abort cannot leave a live span')
  await result.stream.cancel('PRIVATE_CONSUMER_REASON')
  assert.equal(cancelled, 1)
  assert.equal(captured.length, 1)
  assert.equal(captured[0].properties?.['mikka.ai.outcome'], 'cancelled')
  privacy()
})

test('setup errors and an unavailable telemetry sink preserve business behavior', async () => {
  const failure = new Error('PRIVATE_SETUP_FAILURE')
  const model = observedModel(base(undefined, async () => { recordAiUsage(usage); throw failure }), { posthog: sink })
  await assert.rejects(async () => model.doGenerate(args), error => error === failure)
  assert.equal(captured.length, 1)
  assert.equal(captured[0].properties?.$ai_input_tokens, 18000, 'a later settlement error does not discard a known provider receipt')
  const broken = observedModel(base(), { posthog: { capture() { throw new Error('queue full') } } })
  assert.equal(await broken.doGenerate(args), reply)
  const incomplete = observedModel(base(() => streamOf([])), { posthog: sink })
  await drain((await incomplete.doStream(args)).stream)
  assert.equal(captured[1].properties?.['mikka.ai.outcome'], 'incomplete')
  privacy()
})

test('non-SDK Decisions expose only validated numeric scores and usage, not answers', async () => {
  const value = await observeAiRequest({ modelId: 'openai/test-decisions', operation: 'decision', posthog: sink }, async receipt => {
    receipt({ usage: { inputTokens: 100, outputTokens: 8 }, totalCostUsd: 0.0001 })
    receipt({ metadata: { tierScore: 1.2, tierConfidence: 0.8, effortScore: 2.1, effortConfidence: 2 }, invalid: true })
    return 'PRIVATE_ANSWER'
  })
  assert.equal(value, 'PRIVATE_ANSWER')
  assert.equal(captured.length, 1)
  assert.equal(captured[0].properties?.$ai_input_tokens, 100)
  assert.equal(captured[0].properties?.['mikka.ai.tier_score'], 1.2)
  assert.equal(captured[0].properties?.['mikka.ai.effort_confidence'], undefined)
  assert.equal(captured[0].properties?.$ai_is_error, true)
  privacy()
})
