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
} as const

export function metric(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}
export function modelLabel(value: unknown): string | undefined {
  return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._/:+-]{0,127}$/.test(value)
    && !/^(?:https?:|ph[cx]_|sk[-_]|gh[pousr]_|github_pat_)/i.test(value) ? value : undefined
}
export function generationAttributes(input: GenerationMetrics): Record<string, string | number | boolean> {
  const result: Record<string, string | number | boolean> = { 'mikka.harness': input.harness,
    'mikka.ai.provider': input.provider, 'mikka.ai.operation': 'agent', 'mikka.outcome': input.outcome ?? 'ok' }
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
    'mikka.ai.operation': 'agent', 'mikka.harness': input.harness,
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
