import 'server-only'
import { context, createContextKey, isSpanContextValid, SpanKind, SpanStatusCode, trace, type Attributes } from '@opentelemetry/api'
import type { LanguageModel } from 'ai'
import { safeErrorAttributes } from '@mikka/protocol/tracing'
import { telemetryId } from '@mikka/protocol/trace-context'
import { MODEL_FIRST_TOKEN, modelFinishReason, modelMetric, modelTokenUsage } from '@/lib/model-call-timing'
import { serverPostHog, type ServerPostHog } from '@/lib/posthog-server'
import { captureTraceContext, traceAttributes, traceMetadata } from './context'

type Model = Extract<LanguageModel, { specificationVersion: 'v4' }>
type CallArgs = Parameters<Model['doGenerate']>[0]
type StreamPart = Awaited<ReturnType<Model['doStream']>>['stream'] extends ReadableStream<infer P> ? P : never
type Outcome = 'success' | 'error' | 'cancelled' | 'incomplete'

/** Closed, numeric metadata only. Never pass prompts, response objects or tool arguments here. */
export interface AiMetadata {
  operation?: 'coordinator' | 'bot' | 'decision' | 'compaction' | 'profile_extraction' | 'short_title' | 'action_title' | 'agent'
  tier?: string
  tierScore?: number
  tierConfidence?: number
  effort?: string
  effortScore?: number
  effortConfidence?: number
}

export interface AiRoute {
  route?: 'gateway' | 'zerocat' | 'cloudflare-workers-ai' | 'subscription' | 'api_key' | 'self_hosted' | 'decision'
  fallbackReason?: string
  zeroCatMs?: number
  totalCostUsd?: number | null
}

interface Observation {
  route: AiRoute
  usage?: ReturnType<typeof modelTokenUsage>
}
const metadataKey = createContextKey('mikka.ai.metadata')
const generationKey = createContextKey('mikka.ai.generation')
const observedModels = new WeakSet<Model>()
const label = (value: unknown): string | undefined => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._/:+-]{0,127}$/.test(value)
  && !/^(?:https?:|ph[cx]_|sk[-_]|gh[pousr]_|github_pat_)/i.test(value) ? value : undefined

/** Scope metadata for every model/tool step, including an SDK retry. */
export function withAiMetadata<T>(metadata: AiMetadata, work: () => T): T {
  const previous = context.active().getValue(metadataKey) as AiMetadata | undefined
  return context.with(context.active().setValue(metadataKey, { ...previous, ...metadata }), work)
}

/** Route and settlement can finish while reading a provider stream. The wrapper binds that context. */
export function recordAiRoute(route: AiRoute): void {
  const current = context.active().getValue(generationKey) as Observation | undefined
  if (current) Object.assign(current.route, route)
}

/** Preserve a provider's numeric receipt even if later billing/settlement fails. */
export function recordAiUsage(usage: unknown): void {
  const current = context.active().getValue(generationKey) as Observation | undefined
  if (current) current.usage = modelTokenUsage(usage)
}

function metadataAttributes(metadata: AiMetadata): Attributes {
  const attributes: Attributes = {}
  for (const [field, name] of [['operation', 'operation'], ['tier', 'tier'], ['effort', 'effort']] as const) {
    const value = label(metadata[field])
    if (value) attributes[`mikka.ai.${name}`] = value
  }
  for (const [field, name] of [['tierScore', 'tier_score'], ['tierConfidence', 'tier_confidence'], ['effortScore', 'effort_score'], ['effortConfidence', 'effort_confidence']] as const) {
    const value = modelMetric(metadata[field])
    if (value !== null && (!field.endsWith('Confidence') || value <= 1)) attributes[`mikka.ai.${name}`] = value
  }
  return attributes
}

function providerEffort(args: Pick<CallArgs, 'providerOptions'>): string | undefined {
  const options = args.providerOptions
  return label(options?.openai?.reasoningEffort) ?? label(options?.anthropic?.effort)
}

export interface ObservedModelOptions extends AiRoute, AiMetadata {
  modelId?: string
  provider?: 'openai' | 'anthropic'
  userId?: string
  /** Injected sinks and clock make privacy and cancellation testable without sending any telemetry. */
  posthog?: Pick<ServerPostHog, 'capture'> | null
  now?: () => number
}

interface AiReceipt {
  usage?: unknown
  totalCostUsd?: number | null
  metadata?: AiMetadata
  invalid?: boolean
}

function beginGeneration(options: ObservedModelOptions, args: Pick<CallArgs, 'abortSignal' | 'providerOptions'>, streaming: boolean) {
  const now = options.now ?? performance.now.bind(performance)
  const parent = context.active()
  const metadata: AiMetadata = { ...options, ...parent.getValue(metadataKey) as AiMetadata | undefined }
  metadata.effort ??= providerEffort(args)
  const modelId = label(options.modelId) ?? 'unknown'
  const started = now()
  const startedAt = new Date()
  const span = trace.getTracer('mikka.ai').startSpan('mikka.ai.generation', { kind: SpanKind.CLIENT, attributes: {
    ...traceAttributes(captureTraceContext()), ...metadataAttributes(metadata),
    'mikka.ai.model': modelId, 'mikka.ai.streaming': streaming, 'mikka.trace.critical': true,
  } }, parent)
  const observation: Observation = { route: { route: options.route } }
  const scope = trace.setSpan(parent, span).setValue(generationKey, observation)
  const identity = traceMetadata(parent)
  const parentSpan = trace.getSpanContext(parent)
  let ended = false
  let firstToken: number | undefined
  let usage: unknown
  let finishReason: string | null = null
  let streamError: unknown
  let receivedFinish = false
  let tools = 0
  let invalid = false
  const finish = (outcome: Outcome, error?: unknown) => {
    if (ended) return
    ended = true
    if (invalid && outcome === 'success') outcome = 'error'
    args.abortSignal?.removeEventListener('abort', aborted)
    try {
      const latency = Math.max(0, now() - started)
      const counts = observation.usage ?? modelTokenUsage(usage)
      const attributes: Attributes = {
        'mikka.ai.latency_ms': latency, 'mikka.ai.outcome': outcome,
        'mikka.ai.cache_reporting_exclusive': false,
      }
      if (streaming) attributes['mikka.ai.tool_calls'] = tools
      for (const [field, name] of [['inputTokens', 'input_tokens'], ['outputTokens', 'output_tokens'], ['cacheReadTokens', 'cache_read_tokens'], ['cacheWriteTokens', 'cache_write_tokens']] as const) {
        if (counts[field] !== null) attributes[`mikka.ai.${name}`] = counts[field]
      }
      if (firstToken !== undefined) attributes['mikka.ai.ttft_ms'] = Math.max(0, firstToken - started)
      if (finishReason) attributes['mikka.ai.finish_reason'] = finishReason
      const route = observation.route
      if (route.route) attributes['mikka.ai.route'] = route.route
      if (label(route.fallbackReason)) attributes['mikka.ai.fallback_reason'] = route.fallbackReason
      const zeroCatMs = modelMetric(route.zeroCatMs)
      if (zeroCatMs !== null) attributes['mikka.ai.zerocat_ms'] = zeroCatMs
      const cost = modelMetric(route.totalCostUsd)
      if (cost !== null) attributes['mikka.ai.total_cost_usd'] = cost
      if (error !== undefined) Object.assign(attributes, safeErrorAttributes(error))
      span.setAttributes({ ...metadataAttributes(metadata), ...attributes })
      if (outcome !== 'success') span.setStatus({ code: SpanStatusCode.ERROR })
      const spanContext = span.spanContext()
      const properties: Record<string, unknown> = {
        app: 'mikka', ...traceAttributes(captureTraceContext({}, scope)), ...metadataAttributes(metadata), ...attributes,
        $ai_model: modelId, $ai_provider: options.provider ?? (route.route === 'gateway' ? 'vercel-ai-gateway' : route.route ?? 'unknown'),
        $ai_span_name: label(metadata.operation) ?? 'model_generation', $ai_latency: latency / 1000,
        $ai_cache_reporting_exclusive: false, $ai_is_error: outcome !== 'success', $ai_stream: streaming,
      }
      if (isSpanContextValid(spanContext)) {
        properties.$ai_trace_id = spanContext.traceId
        properties.$ai_span_id = spanContext.spanId
      }
      if (parentSpan && isSpanContextValid(parentSpan)) properties.$ai_parent_id = parentSpan.spanId
      if (telemetryId(identity.sessionId)) {
        properties.$ai_session_id = identity.sessionId
        properties.$session_id = identity.sessionId
      }
      for (const [field, name] of [['inputTokens', '$ai_input_tokens'], ['outputTokens', '$ai_output_tokens'], ['cacheReadTokens', '$ai_cache_read_input_tokens'], ['cacheWriteTokens', '$ai_cache_creation_input_tokens']] as const) {
        if (counts[field] !== null) properties[name] = counts[field]
      }
      if (firstToken !== undefined) properties.$ai_time_to_first_token = Math.max(0, firstToken - started) / 1000
      if (finishReason) properties.$ai_stop_reason = finishReason
      if (cost !== null) { properties.$ai_total_cost_usd = cost; properties.$ai_cost_passthrough = true }
      // Anonymous operational calls must not create an artificial person profile.
      const distinctId = telemetryId(identity.posthogDistinctId) ? identity.posthogDistinctId : telemetryId(options.userId) ? options.userId : 'mikka:server'
      if (distinctId === 'mikka:server') properties.$process_person_profile = false
      const posthog = options.posthog === undefined ? serverPostHog() : options.posthog
      posthog?.capture({ distinctId, event: '$ai_generation', timestamp: startedAt, properties })
    } catch { /* telemetry is best effort, including a rejected analytics queue */ }
    finally { span.end() }
  }
  const terminalOutcome = (otherwise: Outcome): Outcome => streamError !== undefined || finishReason === 'error' ? 'error' : receivedFinish ? 'success' : otherwise
  const aborted = () => finish(terminalOutcome('cancelled'), streamError ?? (receivedFinish ? undefined : args.abortSignal?.reason))
  args.abortSignal?.addEventListener('abort', aborted, { once: true })
  return {
    scope, finish,
    receipt(receipt: AiReceipt) {
      if (receipt.usage !== undefined) usage = receipt.usage
      if (receipt.totalCostUsd !== undefined) observation.route.totalCostUsd = receipt.totalCostUsd
      if (receipt.metadata) Object.assign(metadata, receipt.metadata)
      invalid ||= receipt.invalid === true
    },
    part(part: StreamPart) {
      if (firstToken === undefined && MODEL_FIRST_TOKEN.has(part.type)) firstToken = now()
      if (part.type === 'tool-call') tools++
      if (part.type === 'error') streamError = part.error ?? new Error('Model stream error')
      if (part.type === 'finish') { usage = part.usage; finishReason = modelFinishReason(part.finishReason); receivedFinish = true }
    },
    result(result: Awaited<ReturnType<Model['doGenerate']>>) {
      usage = result.usage
      finishReason = modelFinishReason(result.finishReason)
      finish(finishReason === 'error' ? 'error' : 'success')
    },
    closed() { finish(terminalOutcome('incomplete'), streamError) },
    cancelled() { finish(terminalOutcome('cancelled'), streamError) },
  }
}

/** Numeric receipt for a non-SDK generation, such as the Gateway Decisions API. */
export async function observeAiRequest<T>(options: ObservedModelOptions, work: (receipt: (value: AiReceipt) => void) => Promise<T>, signal?: AbortSignal): Promise<T> {
  const call = beginGeneration(options, { abortSignal: signal }, false)
  try {
    const result = await context.with(call.scope, () => work(call.receipt))
    call.finish('success')
    return result
  } catch (error) { call.finish(signal?.aborted ? 'cancelled' : 'error', error); throw error }
}

/**
 * One event per v4 provider invocation, not one per run or one per chunk. Manual
 * capture is PostHog's supported SDK-independent integration. We intentionally
 * do not enable SDK input/output telemetry or install a second trace provider.
 */
export function observedModel(model: Model, options: ObservedModelOptions = {}): Model {
  if (observedModels.has(model)) return model
  const begin = (args: CallArgs, streaming: boolean) => beginGeneration({ ...options, modelId: options.modelId ?? model.modelId }, args, streaming)
  const wrapped = new Proxy(model, { get(target, property) {
    if (property === 'doGenerate') return async (args: CallArgs) => {
      const call = begin(args, false)
      try {
        const result = await context.with(call.scope, () => target.doGenerate(args))
        call.result(result)
        return result
      } catch (error) { call.finish(args.abortSignal?.aborted ? 'cancelled' : 'error', error); throw error }
    }
    if (property === 'doStream') return async (args: CallArgs) => {
      const call = begin(args, true)
      try {
        const result = await context.with(call.scope, () => target.doStream(args))
        const reader = result.stream.getReader()
        const stream = new ReadableStream<StreamPart>({
          async pull(controller) {
            try {
              const next = await context.with(call.scope, () => reader.read())
              if (next.done) { call.closed(); controller.close(); return }
              call.part(next.value)
              controller.enqueue(next.value)
            } catch (error) { call.finish(args.abortSignal?.aborted ? 'cancelled' : 'error', error); controller.error(error) }
          },
          async cancel(reason) {
            call.cancelled()
            await context.with(call.scope, () => reader.cancel(reason))
          },
        })
        return { ...result, stream }
      } catch (error) { call.finish(args.abortSignal?.aborted ? 'cancelled' : 'error', error); throw error }
    }
    const value = Reflect.get(target, property, target)
    return typeof value === 'function' ? value.bind(target) : value
  } })
  observedModels.add(wrapped)
  return wrapped
}
