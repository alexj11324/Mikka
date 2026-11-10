import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { generationEffort, metric, modelLabel, type GenerationMetrics } from './tracing-ai'

// Pinned Codex 0.163: core/src/session/turn.rs and otel/src/events/session_telemetry.rs.
// A request's stream_request and receiving_stream share a parent. Only the
// completed handler's receiving child ends at receipt of that response; the
// enclosing spans can remain alive while tools drain.
const LIMIT = 4096
export const CODEX_TRACE_BODY_LIMIT = 1_048_576

/** Codex's Linux OTLP client respects the environment proxy bypass. Its
 * optional macOS/Windows system proxy can override NO_PROXY, so those hosts
 * keep app-server usage until a per-exporter direct route is available. */
export function codexTraceEnvironment(env: Record<string, string | undefined>, platform: NodeJS.Platform = process.platform): Record<string, string> | undefined {
  if (platform !== 'linux') return undefined
  const append = (value: string | undefined) => value ? `${value},127.0.0.1` : '127.0.0.1'
  return { NO_PROXY: append(env.NO_PROXY ?? env.no_proxy), no_proxy: append(env.no_proxy ?? env.NO_PROXY) }
}
const HANDLERS = new Set(['created', 'completed', 'text_delta', 'tool_input_delta', 'reasoning_summary_delta',
  'reasoning_summary_done', 'reasoning_content_delta', 'reasoning_summary_part_added', 'server_model',
  'model_verifications', 'turn_moderation_metadata', 'safety_buffering', 'server_reasoning_included',
  'rate_limits', 'models_etag', 'additional_tools', 'message_from_assistant', 'message_from_user',
  'message_from_system', 'message_from_developer', 'agent_message', 'reasoning', 'local_shell_call',
  'function_call', 'tool_search_call', 'function_call_output', 'tool_search_output', 'custom_tool_call',
  'custom_tool_call_output', 'web_search_call', 'image_generation_call', 'compaction',
  'configuration_update', 'compaction_trigger', 'context_compaction', 'other'])
const STRUCTURAL = new Set(['try_run_sampling_request', 'stream_request', 'receiving_stream', 'codex.sampling', 'receiving'])
const USAGE = { inputTokens: 'gen_ai.usage.input_tokens', outputTokens: 'gen_ai.usage.output_tokens',
  cacheReadTokens: 'gen_ai.usage.cache_read.input_tokens', cacheWriteTokens: 'gen_ai.usage.cache_write.input_tokens' } as const
const FIELDS = new Set(['model', 'conversation.id', 'from', 'otel.name', 'codex.request.reasoning_effort', ...Object.values(USAGE)])
const object = (value: unknown): Record<string, unknown> | undefined => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : undefined
const identifier = (value: unknown): string | undefined => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value) ? value : undefined
function id(value: unknown, bytes: number): string | undefined {
  if (typeof value !== 'string') return
  if (new RegExp(`^[0-9a-fA-F]{${bytes * 2}}$`).test(value)) return /^0+$/.test(value) ? undefined : value.toLowerCase()
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return
  const decoded = Buffer.from(value, 'base64')
  if (decoded.length === bytes && decoded.toString('base64') === value && decoded.some(byte => byte !== 0)) return decoded.toString('hex')
}
function nanos(value: unknown): bigint | undefined {
  if (typeof value !== 'string' || !/^\d{1,20}$/.test(value)) return
  return BigInt(value)
}
function number(value: unknown): number | undefined {
  if (typeof value === 'string' && /^\d{1,16}$/.test(value)) value = Number(value)
  const result = metric(value)
  return result !== undefined && Number.isSafeInteger(result) ? result : undefined
}
function scalar(value: unknown): unknown {
  const item = object(value)
  return item?.stringValue ?? item?.intValue ?? item?.doubleValue
}
type Usage = Pick<GenerationMetrics, keyof typeof USAGE>
type Request = { start?: bigint; model?: string; conversation?: string; streamRequest?: string; receivingStream?: string; invalid?: boolean }
type Handler = { stream: string; added: boolean; completed?: boolean; usage?: Usage; effort?: GenerationMetrics['effort'] }
type Pair = { handler?: Handler; received?: bigint }
type Stream = { request?: string; firstOutput?: bigint; completed?: { key: string; at: bigint; usage?: Usage; effort?: GenerationMetrics['effort'] } }
type Fallback = { value: GenerationMetrics; count: number }
type Emit = (value: GenerationMetrics) => void
export type CodexGenerationReceipt = {
  source: 'official_cli_trace'; flush: 'not_confirmed'; cliExitObserved: boolean
  batches: number; spansReceived: number; nativeGenerations: number; fallbackGenerations: number
  matchedFallbacks: number; missingNative: number; incompleteRequests: number
  invalidSpans: number; rejectedBatches: number; duplicateCompletions: number; truncated: boolean
}

export function codexGenerationReceiptAttributes(receipt: CodexGenerationReceipt): Record<string, number | boolean> {
  return { 'mikka.ai.native_generations': receipt.nativeGenerations, 'mikka.ai.fallback_generations': receipt.fallbackGenerations,
    'mikka.ai.matched_fallbacks': receipt.matchedFallbacks, 'mikka.ai.missing_native': receipt.missingNative,
    'mikka.ai.incomplete_requests': receipt.incompleteRequests, 'mikka.ai.invalid_spans': receipt.invalidSpans,
    'mikka.ai.rejected_batches': receipt.rejectedBatches, 'mikka.ai.duplicate_completions': receipt.duplicateCompletions,
    'mikka.ai.collection_truncated': receipt.truncated, 'mikka.ai.cli_exit_observed': receipt.cliExitObserved,
    'mikka.ai.native_flush_confirmed': false }
}

/** Only IDs, closed labels and numeric measurements survive a batch. No raw
 * records, resources, events, attributes, content or error text are retained. */
export class CodexGenerationCollector {
  private readonly requests = new Map<string, Request>()
  private readonly streams = new Map<string, Stream>()
  private readonly pairs = new Map<string, Pair>()
  private readonly completed = new Set<string>()
  private readonly fallback = new Map<string, Fallback>()
  private readonly unmatchedNative = new Map<string, number>()
  private fallbackCount = 0
  private disabled = false
  private closed = false
  private result?: CodexGenerationReceipt
  private readonly counts = { batches: 0, spansReceived: 0, nativeGenerations: 0, fallbackGenerations: 0,
    matchedFallbacks: 0, invalidSpans: 0, rejectedBatches: 0, duplicateCompletions: 0, truncated: false }
  constructor(private readonly emit: Emit, private readonly limit = LIMIT) {}

  reject() { if (!this.closed) this.counts.rejectedBatches++ }
  truncate() { if (!this.closed) { this.counts.truncated = true; this.disabled = true } }

  accept(input: unknown): boolean {
    if (this.closed) return false
    const resources = object(input)?.resourceSpans
    if (!Array.isArray(resources)) { this.reject(); return false }
    this.counts.batches++
    for (const resource of resources) {
      const scopes = object(resource)?.scopeSpans
      if (!Array.isArray(scopes)) { this.reject(); continue }
      for (const scope of scopes) {
        const spans = object(scope)?.spans
        if (!Array.isArray(spans)) { this.reject(); continue }
        for (const span of spans) {
          this.counts.spansReceived++
          if (!this.disabled) this.record(span)
        }
      }
    }
    return true
  }

  /** App-server counts remain independent receipts. Match only equal numeric
   * multisets in the same native conversation/model, never attach guessed time. */
  observeFallback(value: GenerationMetrics, conversation: string): void {
    if (this.closed) return
    const clean: GenerationMetrics = { harness: 'codex', provider: 'openai', model: modelLabel(value.model), timingBasis: 'app_server_usage', outcome: value.outcome }
    for (const key of Object.keys(USAGE) as (keyof Usage)[]) clean[key] = metric(value[key])
    const key = this.signature(clean, conversation)
    const native = this.unmatchedNative.get(key) ?? 0
    if (native) { this.decrement(this.unmatchedNative, key); this.counts.matchedFallbacks++; return }
    if (this.fallbackCount >= this.limit) { this.truncate(); this.flushFallback() }
    if (this.disabled) { this.emitFallback(clean); return }
    const previous = this.fallback.get(key)
    this.fallback.set(key, { value: clean, count: (previous?.count ?? 0) + 1 })
    this.fallbackCount++
  }

  finish(cliExitObserved = false): CodexGenerationReceipt {
    if (this.result) return this.result
    this.complete()
    const incompleteRequests = new Set([...this.requests.keys(), ...[...this.streams].map(([key, stream]) => stream.request ?? key)]).size
    this.flushFallback()
    this.closed = true
    this.requests.clear(); this.streams.clear(); this.pairs.clear(); this.completed.clear(); this.unmatchedNative.clear()
    return this.result = { source: 'official_cli_trace', flush: 'not_confirmed', cliExitObserved,
      ...this.counts, missingNative: this.counts.fallbackGenerations, incompleteRequests }
  }

  private record(input: unknown) {
    const raw = object(input)
    let name = raw?.name
    if (typeof name !== 'string' || (!STRUCTURAL.has(name) && !HANDLERS.has(name) && name !== 'handle_responses')) return
    const trace = id(raw?.traceId, 16), span = id(raw?.spanId, 8), parent = id(raw?.parentSpanId, 8)
    const start = nanos(raw?.startTimeUnixNano), end = nanos(raw?.endTimeUnixNano)
    if (!trace || !span || (!parent && name !== 'try_run_sampling_request') || start === undefined || end === undefined || end < start) { this.counts.invalidSpans++; return }
    const key = `${trace}:${span}`, parentKey = `${trace}:${parent}`
    const fields: Record<string, unknown> = {}
    const attributes = Array.isArray(raw?.attributes) && raw.attributes.length <= 128 ? raw.attributes : undefined
    if (attributes) {
      for (const item of attributes) {
        const attribute = object(item)
        if (typeof attribute?.key === 'string' && FIELDS.has(attribute.key)) fields[attribute.key] = scalar(attribute.value)
      }
    }
    if (name === 'handle_responses') {
      if (typeof fields['otel.name'] !== 'string' || !HANDLERS.has(fields['otel.name'])) return
      name = fields['otel.name']
    }
    if (this.requests.size + this.streams.size + this.pairs.size >= this.limit) { this.truncate(); return }
    if (name === 'try_run_sampling_request') {
      if (this.completed.has(key)) return
      const request = this.requests.get(key) ?? {}
      request.model = modelLabel(fields.model)
      this.requests.set(key, request)
    } else if (name === 'stream_request' || name === 'codex.sampling') {
      if (this.completed.has(parentKey)) return
      const request = this.requests.get(parentKey) ?? {}
      if (name === 'stream_request') {
        if (request.streamRequest && request.streamRequest !== key) { request.invalid = true; this.counts.invalidSpans++ }
        request.streamRequest = key; request.start = start
      }
      else request.conversation = identifier(fields['conversation.id'])
      this.requests.set(parentKey, request)
    } else if (name === 'receiving_stream') {
      if (this.completed.has(parentKey)) return
      const request = this.requests.get(parentKey) ?? {}
      if (request.receivingStream && request.receivingStream !== key) { request.invalid = true; this.counts.invalidSpans++ }
      request.receivingStream = key
      this.requests.set(parentKey, request)
      const stream = this.streams.get(key) ?? {}
      stream.request = parentKey
      this.streams.set(key, stream)
    } else {
      const pairKey = name === 'receiving' ? parentKey : key
      const pair = this.pairs.get(pairKey) ?? {}
      if (name === 'receiving') pair.received = end
      else {
        const usage: Usage = {}
        if (name === 'completed') for (const [property, attribute] of Object.entries(USAGE)) usage[property as keyof Usage] = number(fields[attribute])
        const fullUsage = name === 'completed' && Object.keys(USAGE).every(key => usage[key as keyof Usage] !== undefined)
        // Official 0.163 also completes responses with usage=None. Require raw
        // key absence, not invalid scalars or a list we could not safely read.
        const noUsage = name === 'completed' && attributes !== undefined
          && attributes.every(item => typeof object(item)?.key === 'string')
          && Object.values(USAGE).every(key => !Object.hasOwn(fields, key))
        const handler: Handler = { stream: parentKey, added: fields.from === 'output_item_added',
          ...(name === 'completed' ? { effort: generationEffort(fields['codex.request.reasoning_effort']) } : {}),
          ...(fullUsage || noUsage ? { completed: true } : {}),
          // A partial tuple cannot safely cancel its full app-server receipt.
          ...(fullUsage ? { usage } : {}) }
        // An empty replay must not erase usage before the receiving child arrives.
        if (!pair.handler?.completed || (handler.completed && (!pair.handler.usage || handler.usage))) pair.handler = handler
      }
      if (pair.handler && pair.received !== undefined) {
        this.pairs.delete(pairKey)
        const handler = pair.handler
        if (!handler.added && !handler.completed) return
        const stream = this.streams.get(handler.stream) ?? {}
        if (handler.added && (stream.firstOutput === undefined || pair.received < stream.firstOutput)) stream.firstOutput = pair.received
        if (handler.completed) {
          if (stream.completed && stream.completed.key !== pairKey) { this.truncate(); return }
          if (stream.completed) this.counts.duplicateCompletions++
          if (!stream.completed?.usage || handler.usage)
            stream.completed = { key: pairKey, at: pair.received, usage: handler.usage, effort: handler.effort }
        }
        this.streams.set(handler.stream, stream)
      } else this.pairs.set(pairKey, pair)
    }
  }

  private complete() {
    if (this.disabled || this.closed) return
    for (const [key, stream] of this.streams) {
      const request = stream.request && this.requests.get(stream.request), end = stream.completed
      if (!request || request.invalid || request.start === undefined || !request.model || !request.conversation || !end) continue
      if (end.at < request.start || end.at - request.start > 86_400_000_000_000n) { this.counts.invalidSpans++; this.streams.delete(key); continue }
      if (this.completed.has(stream.request!)) { this.counts.duplicateCompletions++; this.streams.delete(key); continue }
      if (this.completed.size >= this.limit || this.unmatchedNative.size >= this.limit) { this.truncate(); return }
      const first = stream.firstOutput
      const firstOutputMs = first !== undefined && first >= request.start && first <= end.at ? Number(first - request.start) / 1_000_000 : undefined
      const value: GenerationMetrics = { harness: 'codex', provider: 'openai', model: request.model, ...end.usage, effort: end.effort,
        startedAt: Number(request.start) / 1_000_000, endedAt: Number(end.at) / 1_000_000,
        latencyMs: Number(end.at - request.start) / 1_000_000,
        // PostHog's Responses integration counts output_item.added as TTFT.
        // This can precede visible text; created/in_progress are not tokens.
        firstOutputMs, ttftMs: firstOutputMs,
        ...(firstOutputMs === undefined ? {} : { ttftBasis: 'request_to_first_output_item' as const }),
        timingBasis: 'official_cli_trace', modelBasis: 'native_sampling_config', outcome: 'ok' }
      // Missing numbers are not a numeric receipt and must never cancel one.
      if (end.usage) {
        const signature = this.signature(value, request.conversation), fallback = this.fallback.get(signature)
        if (fallback) {
          if (--fallback.count === 0) this.fallback.delete(signature)
          this.fallbackCount--; this.counts.matchedFallbacks++
        } else this.unmatchedNative.set(signature, (this.unmatchedNative.get(signature) ?? 0) + 1)
      }
      this.completed.add(stream.request!)
      this.counts.nativeGenerations++
      this.streams.delete(key); this.requests.delete(stream.request!)
      try { this.emit(value) } catch { /* Observability does not fail an agent. */ }
    }
  }
  private signature(value: GenerationMetrics, conversation: string): string {
    return JSON.stringify([identifier(conversation) ?? '', modelLabel(value.model) ?? '',
      ...Object.keys(USAGE).map(key => metric(value[key as keyof Usage]) ?? null)])
  }
  private decrement(map: Map<string, number>, key: string) { const count = map.get(key)!; if (count === 1) map.delete(key); else map.set(key, count - 1) }
  private emitFallback(value: GenerationMetrics) {
    this.counts.fallbackGenerations++
    try { this.emit({ ...value, nativeUnavailableReason: this.counts.truncated ? 'native_trace_truncated' : 'native_trace_missing' }) }
    catch { /* keep business behavior */ }
  }
  private flushFallback() {
    for (const item of this.fallback.values()) for (let i = 0; i < item.count; i++) this.emitFallback(item.value)
    this.fallback.clear(); this.fallbackCount = 0
  }
}

/** One child owns this loopback receiver. Native data never reaches a remote
 * exporter: it is projected above and emitted through the existing safe sink.
 * Close runs after child exit, in the background; it adds no child kill delay. */
export async function startCodexGenerationCollector(emit: Emit) {
  const collector = new CodexGenerationCollector(emit)
  const path = `/v1/traces/${randomBytes(16).toString('hex')}`
  const server = createServer({ maxHeaderSize: 8192 }, (request, response) => {
    if (request.method !== 'POST' || request.url !== path || !/^application\/json(?:;|$)/i.test(request.headers['content-type'] ?? '')
      || (request.headers['content-encoding'] && request.headers['content-encoding'] !== 'identity')) {
      collector.reject(); response.writeHead(400).end(); request.resume(); return
    }
    void (async () => {
      let bytes = 0
      const chunks: Buffer[] = []
      try {
        for await (const chunk of request) {
          bytes += chunk.length
          if (bytes > CODEX_TRACE_BODY_LIMIT) { collector.reject(); collector.truncate(); response.writeHead(413).end(); request.destroy(); return }
          chunks.push(chunk)
        }
        const accepted = collector.accept(JSON.parse(Buffer.concat(chunks).toString('utf8')))
        response.writeHead(accepted ? 200 : 400, { 'content-type': 'application/json' }).end('{}')
      } catch { collector.reject(); if (!response.writableEnded) response.writeHead(400).end() }
      finally { chunks.length = 0 }
    })()
  })
  server.requestTimeout = 1000; server.headersTimeout = 1000; server.maxConnections = 4
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
  })
  server.on('error', () => collector.reject())
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`
  let closed: Promise<CodexGenerationReceipt> | undefined
  return { collector, endpoint,
    env: { OTEL_EXPORTER_OTLP_TRACES_TIMEOUT: '1000' },
    args: ['-c', `otel.trace_exporter={otlp-http={endpoint=${JSON.stringify(endpoint)},protocol="json",headers={}}}`,
      '-c', 'otel.log_user_prompt=false', '-c', 'otel.log_agent_responses=false', '-c', 'otel.log_guardian_assessments=false'],
    close: (cliExitObserved = false) => closed ??= new Promise<CodexGenerationReceipt>(resolve => {
      const timer = setTimeout(() => { collector.truncate(); server.closeAllConnections() }, 1000)
      timer.unref()
      server.close(() => { clearTimeout(timer); resolve(collector.finish(cliExitObserved)) })
    }),
  }
}
