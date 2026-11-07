import { PostHog } from 'posthog-node'
import { sanitizeTraceContext, telemetryId, traceAttributes, type RunTraceContext } from '@mikka/protocol/trace-context'
import type { Harness } from '@mikka/protocol/harness'

/** Deliberately cannot accept prompt, response, tool, file, credential or error-message objects. */
export interface GenerationMetrics {
  harness: Harness
  provider: 'anthropic' | 'openai'
  model?: string | null
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  totalCostUsd?: number
  latencyMs?: number
  ttftMs?: number
  /** May precede visible text; PostHog Responses TTFT uses this boundary. */
  firstOutputMs?: number
  timingBasis?: 'official_cli_trace' | 'app_server_usage'
  ttftBasis?: 'request_to_first_output_item'
  modelBasis?: 'native_sampling_config'
  effort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra' | 'persistent'
  nativeUnavailableReason?: 'platform_proxy_unverified' | 'receiver_start_failed' | 'native_trace_missing' | 'native_trace_truncated'
  /** Actual native interval, independent of export/batch arrival time. */
  startedAt?: number
  endedAt?: number
  outcome?: 'ok' | 'error' | 'cancelled'
}

export const AI_NUMBERS = {
  inputTokens: ['mikka.ai.input_tokens', '$ai_input_tokens'],
  outputTokens: ['mikka.ai.output_tokens', '$ai_output_tokens'],
  cacheReadTokens: ['mikka.ai.cache_read_tokens', '$ai_cache_read_input_tokens'],
  cacheWriteTokens: ['mikka.ai.cache_write_tokens', '$ai_cache_creation_input_tokens'],
  totalCostUsd: ['mikka.ai.total_cost_usd', '$ai_total_cost_usd'],
  latencyMs: ['mikka.ai.latency_ms', '$ai_latency'],
  ttftMs: ['mikka.ai.ttft_ms', '$ai_time_to_first_token'],
  firstOutputMs: ['mikka.ai.first_output_item_ms', 'mikka.ai.first_output_item_ms'],
} as const

export const AI_METADATA = ['mikka.ai.timing_basis', 'mikka.ai.ttft_basis', 'mikka.ai.model_basis', 'mikka.ai.effort', 'mikka.ai.native_unavailable_reason'] as const
/** Fixed Codex 0.163 ReasoningEffort variants. Custom(String) is not telemetry.
 * https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/protocol/src/openai_models.rs */
export function generationEffort(value: unknown): GenerationMetrics['effort'] {
  return typeof value === 'string' && ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'persistent'].includes(value)
    ? value as GenerationMetrics['effort'] : undefined
}
function provenance(input: GenerationMetrics): Record<string, string> {
  const result: Record<string, string> = {}
  if (input.timingBasis === 'official_cli_trace' || input.timingBasis === 'app_server_usage') result['mikka.ai.timing_basis'] = input.timingBasis
  if (input.ttftBasis === 'request_to_first_output_item') result['mikka.ai.ttft_basis'] = input.ttftBasis
  if (input.modelBasis === 'native_sampling_config') result['mikka.ai.model_basis'] = input.modelBasis
  const effort = generationEffort(input.effort)
  if (effort !== undefined) result['mikka.ai.effort'] = effort
  if (input.nativeUnavailableReason && ['platform_proxy_unverified', 'receiver_start_failed', 'native_trace_missing', 'native_trace_truncated'].includes(input.nativeUnavailableReason)) {
    result['mikka.ai.native_unavailable_reason'] = input.nativeUnavailableReason
  }
  return result
}

export function metric(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}
export function modelLabel(value: unknown): string | undefined {
  return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._/:+-]{0,127}$/.test(value)
    && !/^(?:https?:|ph[cx]_|sk[-_]|gh[pousr]_|github_pat_)/i.test(value) ? value : undefined
}
export function generationAttributes(input: GenerationMetrics): Record<string, string | number | boolean> {
  const result: Record<string, string | number | boolean> = { 'mikka.harness': input.harness,
    'mikka.ai.provider': input.provider, 'mikka.ai.operation': 'agent', 'mikka.outcome': input.outcome ?? 'ok', ...provenance(input) }
  const model = modelLabel(input.model)
  if (model) result['mikka.ai.model'] = model
  for (const [key, [attribute]] of Object.entries(AI_NUMBERS)) {
    const value = metric(input[key as keyof GenerationMetrics])
    if (value !== undefined) result[attribute] = value
  }
  return result
}

export function generationEvent(input: GenerationMetrics, carrier: RunTraceContext, parentId?: string, startedAt?: Date) {
  const clean = sanitizeTraceContext(carrier)
  if (!clean) return undefined
  carrier = clean
  const distinctId = carrier.posthogDistinctId ?? carrier.runId
  if (!telemetryId(distinctId)) return undefined
  const properties: Record<string, string | number | boolean> = {
    ...traceAttributes(carrier), '$ai_trace_id': carrier.traceparent.slice(3, 35),
    '$ai_span_id': carrier.traceparent.slice(36, 52), '$ai_provider': input.provider,
    '$ai_is_error': input.outcome === 'error', '$ai_cache_reporting_exclusive': false,
    'mikka.ai.operation': 'agent', 'mikka.harness': input.harness, ...provenance(input),
  }
  if (parentId && /^[0-9a-f]{16}$/.test(parentId)) properties.$ai_parent_id = parentId
  if (telemetryId(carrier.sessionId)) {
    properties.$ai_session_id = carrier.sessionId
    properties.$session_id = carrier.sessionId
  }
  if (!carrier.posthogDistinctId) properties.$process_person_profile = false
  const model = modelLabel(input.model)
  if (model) properties.$ai_model = model
  if (metric(input.totalCostUsd) !== undefined) properties.$ai_cost_passthrough = true
  if (input.outcome === 'error') properties.$ai_error = 'ProviderError'
  for (const [key, [, attribute]] of Object.entries(AI_NUMBERS)) {
    const value = metric(input[key as keyof GenerationMetrics])
    if (value !== undefined) properties[attribute] = key === 'latencyMs' || key === 'ttftMs' ? value / 1_000 : value
  }
  return { distinctId, event: '$ai_generation', properties, disableGeoip: true, ...(startedAt ? { timestamp: startedAt } : {}) }
}

export interface AiSink {
  capture(event: NonNullable<ReturnType<typeof generationEvent>>): void
  flush(): Promise<unknown>
  shutdown(): Promise<unknown>
}

/** Bounded SDK queue, no feature flag polling, no retries, and the same export backoff as APM. */
export function createAiSink(endpoint: string, projectToken: string): AiSink {
  const client = new PostHog(projectToken, { host: new URL(endpoint).origin, flushAt: 20, maxQueueSize: 512,
    flushInterval: 10_000, requestTimeout: 5_000, fetchRetryCount: 0, disableGeoip: true })
  let pausedUntil = 0
  client.on('error', () => { pausedUntil = Date.now() + 60_000 })
  return {
    capture(event) { if (Date.now() >= pausedUntil) { try { client.capture(event) } catch { pausedUntil = Date.now() + 60_000 } } },
    flush: () => client.flush().catch(() => {}),
    shutdown: () => client.shutdown().catch(() => {}),
  }
}
