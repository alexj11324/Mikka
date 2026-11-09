import { metric, modelLabel, type GenerationMetrics } from '../tracing-ai'

type RecordValue = Record<string, unknown>
const record = (value: unknown): RecordValue => value && typeof value === 'object' ? value as RecordValue : {}
const identifier = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value)
type Emit = (value: GenerationMetrics) => void
type ClaudeGeneration = { id: string; model?: string; startedAt: number; ttftMs?: number; input?: number; output?: number; cacheRead?: number; cacheWrite?: number }

/** Only numeric usage and model labels are retained; content blocks are never inspected. */
export class ClaudeGenerationMetrics {
  private readonly active = new Map<string, ClaudeGeneration>()
  private readonly completed = new Set<string>()
  constructor(private readonly emit: Emit, private readonly now: () => number = Date.now) {}

  observe(value: unknown): void {
    try {
      const message = record(value)
      if (message.type !== 'stream_event' && message.type !== 'assistant') return
      const channel = identifier(message.parent_tool_use_id) ? message.parent_tool_use_id : ''
      if (message.type === 'stream_event') {
        const event = record(message.event)
        if (event.type === 'message_start') {
          const start = record(event.message)
          if (!identifier(start.id) || this.completed.has(start.id)) return
          // Bound concurrent subagent records even if a broken CLI never sends message_stop.
          if (!this.active.has(channel) && this.active.size >= 256) return
          const generation: ClaudeGeneration = { id: start.id, model: modelLabel(start.model), startedAt: this.now(), ttftMs: metric(message.ttft_ms) }
          this.usage(generation, start.usage)
          this.active.set(channel, generation)
          return
        }
        const generation = this.active.get(channel)
        if (!generation) return
        const ttft = metric(message.ttft_ms)
        if (ttft !== undefined && generation.ttftMs === undefined) {
          generation.ttftMs = ttft
          generation.startedAt = this.now()
        }
        if (event.type === 'message_delta') this.usage(generation, event.usage)
        if (event.type === 'message_stop') this.finish(channel, generation)
        return
      }
      const body = record(message.message)
      const aborted = message.aborted === true
      // Full messages are a fallback for producers without streaming. Block-level
      // frames have no stop_reason; the SDK's explicit aborted frame is terminal.
      if (!identifier(body.id) || (body.stop_reason == null && !message.error && !aborted) || this.completed.has(body.id)) return
      const existing = this.active.get(channel)
      const generation: ClaudeGeneration = existing?.id === body.id ? existing : { id: body.id, model: modelLabel(body.model), startedAt: this.now() }
      this.usage(generation, body.usage)
      // An interrupted assistant still carries message_start's output placeholder,
      // not final response usage. Preserve unknown output instead of reporting it.
      if (aborted) generation.output = undefined
      this.finish(channel, generation, Boolean(message.error) || aborted)
    } catch { /* A CLI telemetry frame cannot interrupt the session. */ }
  }

  fail(): void {
    for (const [channel, generation] of this.active) {
      try { this.finish(channel, generation, true) } catch { /* Keep the original provider failure. */ }
    }
  }

  private usage(generation: ClaudeGeneration, value: unknown) {
    const usage = record(value)
    for (const [field, key] of [['input', 'input_tokens'], ['output', 'output_tokens'], ['cacheRead', 'cache_read_input_tokens'], ['cacheWrite', 'cache_creation_input_tokens']] as const) {
      const number = metric(usage[key])
      if (number !== undefined) generation[field] = number
    }
  }
  private finish(channel: string, generation: ClaudeGeneration, failed = false) {
    this.active.delete(channel)
    if (this.completed.has(generation.id)) return
    this.completed.add(generation.id)
    if (this.completed.size > 4_096) this.completed.delete(this.completed.values().next().value!)
    this.emit({ harness: 'claude_code', provider: 'anthropic', model: generation.model,
      // Anthropic input_tokens excludes both cache buckets. Normalize once so
      // PostHog's inclusive cache semantics match the web provider wrapper.
      inputTokens: generation.input === undefined ? undefined : generation.input + (generation.cacheRead ?? 0) + (generation.cacheWrite ?? 0),
      outputTokens: generation.output, cacheReadTokens: generation.cacheRead, cacheWriteTokens: generation.cacheWrite,
      ttftMs: generation.ttftMs,
      // The SDK supplies request-to-first-token time. Without it, stream time
      // would understate request latency, so leave latency unavailable.
      latencyMs: generation.ttftMs === undefined ? undefined : Math.max(0, this.now() - generation.startedAt) + generation.ttftMs,
      outcome: failed ? 'error' : 'ok',
    })
  }
}

/** Codex publishes `last` for one model request and `total` for the whole thread. */
export class CodexGenerationMetrics {
  private active = false
  private previousTotal: string | undefined
  constructor(private readonly emit: Emit) {}
  startTurn(): void { this.active = true }
  endTurn(): void { this.active = false }
  observe(value: unknown, model?: string | null): void {
    try {
      const usage = record(value), last = record(usage.last), total = record(usage.total)
      // A replayed cumulative total must not create a second generation. Never
      // derive model usage by subtracting totals across resumed thread history.
      const input = metric(total.inputTokens), output = metric(total.outputTokens), cached = metric(total.cachedInputTokens)
      const stamp = input === undefined || output === undefined ? undefined : `${input}:${output}:${cached ?? ''}`
      if (stamp && stamp === this.previousTotal) return
      if (stamp) this.previousTotal = stamp
      if (!this.active) return
      const inputTokens = metric(last.inputTokens), outputTokens = metric(last.outputTokens)
      if (inputTokens === undefined && outputTokens === undefined) return
      // 0.163 emits tokenUsage after pending tools drain. Neither this receipt
      // time nor turn/start is a reliable per-request model timing boundary.
      this.emit({ harness: 'codex', provider: 'openai', model, inputTokens, outputTokens,
        cacheReadTokens: metric(last.cachedInputTokens), cacheWriteTokens: metric(last.cacheWriteInputTokens), timingBasis: 'app_server_usage', outcome: 'ok' })
    } catch { /* A CLI telemetry frame cannot interrupt the session. */ }
  }
}
