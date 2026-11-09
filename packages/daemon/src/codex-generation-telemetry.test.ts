import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { expect, it } from 'vitest'
import { CodexGenerationCollector, codexGenerationReceiptAttributes, codexTraceEnvironment, startCodexGenerationCollector } from './codex-generation-telemetry'
import type { GenerationMetrics } from './tracing-ai'

const trace = '0123456789abcdef0123456789abcdef'
const epoch = 1_793_980_800_000
const spanId = (value: number) => value.toString(16).padStart(16, '0')
const stamp = (offset: number) => (BigInt(epoch + offset) * 1_000_000n).toString()
const usage = { inputTokens: 50, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 4 }
const fallback = (extra: Partial<GenerationMetrics> = {}): GenerationMetrics => ({ harness: 'codex', provider: 'openai', model: 'gpt-6-luna', ...usage, ...extra })
const span = (name: string, identity: number, parent: number, start: number, end: number, values: Record<string, unknown> = {}) => ({ name,
  traceId: trace, spanId: spanId(identity), parentSpanId: spanId(parent), startTimeUnixNano: stamp(start), endTimeUnixNano: stamp(end),
  attributes: Object.entries(values).map(([key, value]) => ({ key, value: typeof value === 'number' ? { intValue: String(value) } : { stringValue: value } })),
  events: [{ name: 'PRIVATE_EVENT', attributes: [{ key: 'PRIVATE_KEY', value: { stringValue: 'PRIVATE_BODY' } }] }],
})
function request(seed = 10, conversation = 'thread_1', start = 0) {
  return [
    span('try_run_sampling_request', seed, 999, start, start + 9000, { model: 'gpt-6-luna', prompt: 'PRIVATE_PROMPT' }),
    span('stream_request', seed + 1, seed, start, start + 50),
    span('codex.sampling', seed + 2, seed, start, start + 550, { 'conversation.id': conversation }),
    span('receiving_stream', seed + 3, seed, start + 50, start + 8000),
    span('message_from_assistant', seed + 4, seed + 3, start + 100, start + 170, { from: 'output_item_added' }),
    span('receiving', seed + 5, seed + 4, start + 100, start + 150),
    span('completed', seed + 6, seed + 3, start + 300, start + 550, {
      'gen_ai.usage.input_tokens': usage.inputTokens, 'gen_ai.usage.output_tokens': usage.outputTokens,
      'gen_ai.usage.cache_read.input_tokens': usage.cacheReadTokens, 'gen_ai.usage.cache_write.input_tokens': usage.cacheWriteTokens,
      'codex.request.reasoning_effort': 'high',
      'error.message': 'PRIVATE_ERROR', 'user.email': 'PRIVATE_EMAIL',
    }),
    span('receiving', seed + 7, seed + 6, start + 300, start + 500),
    span('created', seed + 8, seed + 3, start + 50, start + 80),
    span('receiving', seed + 9, seed + 8, start + 50, start + 75),
  ]
}
const batch = (spans: unknown[]) => ({ resourceSpans: [{ resource: { attributes: [{ key: 'private', value: { stringValue: 'PRIVATE_RESOURCE' } }] },
  scopeSpans: [{ scope: { name: 'PRIVATE_SCOPE' }, spans }] }] })

it('matches exact native request ancestry across reversed batches and excludes tool drain from actual timestamps', () => {
  const events: GenerationMetrics[] = []
  const collector = new CodexGenerationCollector(value => events.push(value))
  collector.observeFallback(fallback(), 'thread_1')
  for (const item of request().toReversed()) expect(collector.accept(batch([item]))).toBe(true)
  expect(events).toHaveLength(0)
  const receipt = collector.finish(true)
  expect(events).toEqual([{ ...fallback(), effort: 'high', startedAt: epoch, endedAt: epoch + 500, latencyMs: 500,
    firstOutputMs: 150, ttftMs: 150, timingBasis: 'official_cli_trace', ttftBasis: 'request_to_first_output_item', modelBasis: 'native_sampling_config', outcome: 'ok' }])
  expect(events[0].ttftMs, 'the earlier response.created receipt is not first output').toBe(150)
  expect(receipt).toMatchObject({ nativeGenerations: 1, fallbackGenerations: 0, matchedFallbacks: 1, truncated: false,
    cliExitObserved: true, flush: 'not_confirmed', incompleteRequests: 0 })
  expect(JSON.stringify({ events, receipt, attributes: codexGenerationReceiptAttributes(receipt) })).not.toContain('PRIVATE')
})

it('keeps an official completed response with no usage, including duplicate reversed exports, without numeric matching', () => {
  const events: GenerationMetrics[] = []
  const collector = new CodexGenerationCollector(value => events.push(value))
  const records = request()
  const completed = records.find(item => item.name === 'completed')!
  completed.attributes = completed.attributes.filter(attribute => !attribute.key.startsWith('gen_ai.usage.'))
  collector.accept(batch(records.toReversed()))
  collector.accept(batch(records))
  const receipt = collector.finish(true)
  expect(events).toHaveLength(1)
  expect(events[0]).toMatchObject({ startedAt: epoch, endedAt: epoch + 500, latencyMs: 500, ttftMs: 150, outcome: 'ok' })
  for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'totalCostUsd'] as const) expect(events[0][key]).toBeUndefined()
  expect(receipt).toMatchObject({ nativeGenerations: 1, fallbackGenerations: 0, matchedFallbacks: 0, incompleteRequests: 0, flush: 'not_confirmed' })
  expect(collector.finish()).toBe(receipt)
})

it('prefers a complete usage tuple over an empty replay before or after its receiving span arrives', () => {
  for (const emptyFirst of [false, true]) for (const receivingLast of [false, true]) {
    const events: GenerationMetrics[] = []
    const collector = new CodexGenerationCollector(value => events.push(value))
    const records = request(), full = records.find(item => item.name === 'completed')!
    const empty = { ...full, attributes: full.attributes.filter(attribute => !attribute.key.startsWith('gen_ai.usage.')) }
    const received = records.find(item => item.name === 'receiving' && item.parentSpanId === full.spanId)!
    collector.observeFallback(fallback(), 'thread_1')
    collector.accept(batch(records.filter(item => item !== full && item !== received).toReversed()))
    for (const completed of emptyFirst ? [empty, full] : [full, empty]) {
      collector.accept(batch(receivingLast ? [completed] : [received, completed]))
    }
    if (receivingLast) collector.accept(batch([received]))
    const receipt = collector.finish(true)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject(usage)
    expect(receipt).toMatchObject({ nativeGenerations: 1, fallbackGenerations: 0, matchedFallbacks: 1, incompleteRequests: 0 })
  }
})

it('does not turn invalid usage scalars or unreadable attribute lists into an absent usage tuple', () => {
  for (const attributes of [undefined, {}, Array.from({ length: 129 }, () => ({ key: 'other', value: { stringValue: 'unused' } })),
    Object.keys(usage).map((_, index) => ({ key: ['gen_ai.usage.input_tokens', 'gen_ai.usage.output_tokens',
      'gen_ai.usage.cache_read.input_tokens', 'gen_ai.usage.cache_write.input_tokens'][index], value: { intValue: '-1' } })),
    [{ key: 'gen_ai.usage.input_tokens', value: { boolValue: false } }],
  ]) {
    const events: GenerationMetrics[] = []
    const collector = new CodexGenerationCollector(value => events.push(value))
    const records: unknown[] = request().map(item => item.name === 'completed' ? { ...item, attributes } : item)
    collector.accept(batch(records))
    expect(collector.finish()).toMatchObject({ nativeGenerations: 0, fallbackGenerations: 0, incompleteRequests: 1 })
    expect(events).toHaveLength(0)
  }
})

it('projects only known native reasoning effort variants from the same completed handler', () => {
  const known = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'persistent']
  for (const effort of [...known, 'default', 'custom-effort', 'PRIVATE_EFFORT', 'sk-private']) {
    const events: GenerationMetrics[] = []
    const collector = new CodexGenerationCollector(value => events.push(value))
    const records = request()
    const completed = records.find(item => item.name === 'completed')!
    completed.attributes = completed.attributes.filter(attribute => attribute.key !== 'codex.request.reasoning_effort')
    completed.attributes.push({ key: 'codex.request.reasoning_effort', value: { stringValue: effort } })
    collector.accept(batch(records)); collector.finish()
    expect(events[0].effort).toBe(known.includes(effort) ? effort : undefined)
    expect(JSON.stringify(events)).not.toMatch(/PRIVATE|sk-private|custom-effort/)
  }
})

it('deduplicates repeated exports and subtracts equal usages one by one without cross-conversation or model matching', () => {
  const events: GenerationMetrics[] = []
  const collector = new CodexGenerationCollector(value => events.push(value))
  for (let i = 0; i < 3; i++) collector.observeFallback(fallback(), 'thread_1')
  collector.observeFallback(fallback({ model: 'gpt-other' }), 'thread_1')
  const all = [...request(10), ...request(20, 'thread_1', 1000), ...request(30, 'subagent_1', 2000)]
  collector.accept(batch(all.toReversed()))
  collector.accept(batch(all))
  const receipt = collector.finish(true)
  expect(events.filter(event => event.timingBasis === 'official_cli_trace')).toHaveLength(3)
  expect(events.filter(event => event.timingBasis === 'app_server_usage')).toHaveLength(2)
  expect(receipt).toMatchObject({ nativeGenerations: 3, fallbackGenerations: 2, matchedFallbacks: 2, missingNative: 2 })
  expect(receipt.duplicateCompletions).toBeGreaterThan(0)
  for (const event of events.filter(item => item.timingBasis === 'app_server_usage')) {
    expect(event.startedAt).toBeUndefined(); expect(event.endedAt).toBeUndefined()
    expect(event.latencyMs).toBeUndefined(); expect(event.ttftMs).toBeUndefined()
  }
  expect(collector.finish(false)).toBe(receipt)
  expect(collector.accept(batch(all))).toBe(false)
})

it('keeps missing cache fields distinct from zero and does not invent timing for old or incomplete native traces', () => {
  const events: GenerationMetrics[] = []
  const collector = new CodexGenerationCollector(value => events.push(value))
  collector.observeFallback(fallback({ cacheWriteTokens: undefined, latencyMs: 9999, ttftMs: 999 }), 'thread_1')
  collector.observeFallback(fallback(), 'thread_1')
  collector.accept(batch(request().filter(item => item.name !== 'stream_request')))
  const receipt = collector.finish(false)
  expect(receipt).toMatchObject({ nativeGenerations: 0, fallbackGenerations: 2, missingNative: 2, incompleteRequests: 1, cliExitObserved: false })
  expect(events[0]).not.toHaveProperty('latencyMs')
  expect(events[0]).not.toHaveProperty('ttftMs')
  expect(events[0].cacheWriteTokens).toBeUndefined()
  const empty = new CodexGenerationCollector(value => events.push(value))
  empty.observeFallback(fallback({ cacheWriteTokens: 0 }), 'thread_1')
  expect(empty.finish().fallbackGenerations).toBe(1)
  expect(events.at(-1)?.cacheWriteTokens).toBe(0)
})

it('uses the full app-server receipt when native usage is partial and preserves a genuine native cache-write zero', () => {
  for (const cacheWrite of [undefined, 0]) {
    const events: GenerationMetrics[] = []
    const collector = new CodexGenerationCollector(value => events.push(value))
    const records = request()
    // A sampling request can itself be an OTLP root.
    records[0].parentSpanId = ''
    collector.observeFallback(fallback({ cacheWriteTokens: cacheWrite ?? 4 }), 'thread_1')
    const completed = records.find(item => item.name === 'completed')!
    completed.attributes = completed.attributes.filter(attribute => attribute.key !== 'gen_ai.usage.cache_write.input_tokens')
    if (cacheWrite !== undefined) completed.attributes.push({ key: 'gen_ai.usage.cache_write.input_tokens', value: { intValue: String(cacheWrite) } })
    collector.accept(batch(records)); const receipt = collector.finish(true)
    expect(events).toHaveLength(1)
    expect(events[0].timingBasis).toBe(cacheWrite === undefined ? 'app_server_usage' : 'official_cli_trace')
    expect(events[0].cacheWriteTokens).toBe(cacheWrite ?? 4)
    expect(receipt.missingNative).toBe(cacheWrite === undefined ? 1 : 0)
  }
})

it('adds only the loopback endpoint to each existing proxy bypass and limits native collection to Linux', () => {
  for (const [env, upper, lower] of [
    [{}, '127.0.0.1', '127.0.0.1'],
    [{ NO_PROXY: 'upper.example' }, 'upper.example,127.0.0.1', 'upper.example,127.0.0.1'],
    [{ no_proxy: 'lower.example' }, 'lower.example,127.0.0.1', 'lower.example,127.0.0.1'],
    [{ NO_PROXY: 'upper.example', no_proxy: 'lower.example' }, 'upper.example,127.0.0.1', 'lower.example,127.0.0.1'],
    [{ NO_PROXY: '', no_proxy: 'lower.example' }, '127.0.0.1', 'lower.example,127.0.0.1'],
  ] as const) {
    const original = { ...env, HTTP_PROXY: 'http://PRIVATE_PROXY', HTTPS_PROXY: 'http://PRIVATE_PROXY', ALL_PROXY: 'http://PRIVATE_PROXY' }
    expect(codexTraceEnvironment(original, 'linux')).toEqual({ NO_PROXY: upper, no_proxy: lower })
    expect(original).toEqual({ ...env, HTTP_PROXY: 'http://PRIVATE_PROXY', HTTPS_PROXY: 'http://PRIVATE_PROXY', ALL_PROXY: 'http://PRIVATE_PROXY' })
    expect(codexTraceEnvironment(original, 'darwin')).toBeUndefined()
    expect(codexTraceEnvironment(original, 'win32')).toBeUndefined()
  }
})

it('rejects ambiguous same-parent request boundaries and scopes equal span IDs by native trace ID', () => {
  const events: GenerationMetrics[] = []
  const collector = new CodexGenerationCollector(value => events.push(value))
  collector.observeFallback(fallback(), 'thread_1')
  collector.accept(batch([...request(), span('stream_request', 70, 10, 400, 450)]))
  const otherTrace = request().map(item => ({ ...item, traceId: 'fedcba9876543210fedcba9876543210' }))
  collector.accept(batch(otherTrace))
  expect(collector.finish()).toMatchObject({ nativeGenerations: 1, fallbackGenerations: 0, invalidSpans: 1 })
  expect(events).toHaveLength(1)
})

it('bounds unmatched metadata, preserves fallback receipts on truncation and never traverses content', () => {
  const events: GenerationMetrics[] = []
  const collector = new CodexGenerationCollector(value => events.push(value), 4)
  const record = request()[0]
  Object.defineProperty(record, 'events', { get() { throw new Error('PRIVATE_EVENTS_READ') } })
  const payload = batch([record])
  Object.defineProperty(payload.resourceSpans[0], 'resource', { get() { throw new Error('PRIVATE_RESOURCE_READ') } })
  expect(collector.accept(payload)).toBe(true)
  for (let i = 0; i < 8; i++) {
    collector.observeFallback(fallback({ outputTokens: i }), 'thread_1')
    collector.accept(batch([span('receiving', 100 + i, 200 + i, 0, 1)]))
  }
  const receipt = collector.finish()
  expect(receipt.truncated).toBe(true)
  expect(events).toHaveLength(8)
  expect(events.every(event => event.timingBasis === 'app_server_usage')).toBe(true)
  expect(JSON.stringify({ events, receipt })).not.toContain('PRIVATE')
})

it('ignores malformed clocks and usage, supports OTLP hex/base64 IDs and keeps secrets out of labels', () => {
  const events: GenerationMetrics[] = []
  const collector = new CodexGenerationCollector(value => events.push(value))
  const valid = request().map(item => ({ ...item, traceId: Buffer.from(item.traceId, 'hex').toString('base64'),
    spanId: Buffer.from(item.spanId, 'hex').toString('base64'), parentSpanId: Buffer.from(item.parentSpanId, 'hex').toString('base64') }))
  collector.accept(batch(valid))
  collector.accept(batch([{ ...request(20)[0], endTimeUnixNano: 'PRIVATE_CLOCK' },
    { ...request(30)[0], startTimeUnixNano: stamp(2), endTimeUnixNano: stamp(1) }]))
  collector.observeFallback(fallback({ model: 'sk-private', inputTokens: -1, outputTokens: NaN }), 'thread_1')
  expect(collector.finish()).toMatchObject({ nativeGenerations: 1, invalidSpans: 2, fallbackGenerations: 1 })
  expect(events.at(-1)?.model).toBeUndefined()
  expect(events.at(-1)?.inputTokens).toBeUndefined()
  expect(JSON.stringify(events)).not.toMatch(/PRIVATE|sk-private/)
})

it('real loopback fake child flushes reversed and duplicate OTLP batches on SIGTERM within the existing child deadline', async () => {
  const events: GenerationMetrics[] = []
  const receiver = await startCodexGenerationCollector(value => events.push(value))
  const first = request(10), second = request(20, 'thread_1', 1000)
  for (let i = 0; i < 3; i++) receiver.collector.observeFallback(fallback(), 'thread_1')
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    process.on('message', () => {});
    let raw = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', value => raw += value);
    process.stdin.on('end', () => {
      const fixture = JSON.parse(raw); raw = '';
      if (!/^http:\\/\\/127\\.0\\.0\\.1:\\d+\\/v1\\/traces\\/[a-f0-9]{32}$/.test(fixture.endpoint)) process.exit(2);
      process.once('SIGTERM', async () => {
        try {
          for (const body of fixture.batches) {
            const response = await fetch(fixture.endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
            if (response.status !== 200) process.exit(3);
            await response.arrayBuffer();
          }
          process.exit(0);
        } catch { process.exit(4); }
      });
      process.send('ready');
    });
  `], { env: {}, stdio: ['pipe', 'ignore', 'ignore', 'ipc'] })
  let forced = false
  const deadline = setTimeout(() => { forced = true; child.kill('SIGKILL') }, 3000)
  try {
    const ready = once(child, 'message'), exited = once(child, 'exit')
    child.stdin!.end(JSON.stringify({ endpoint: receiver.endpoint, batches: [batch([...first, ...second].toReversed()), batch(first)] }))
    expect((await ready)[0]).toBe('ready')
    child.kill('SIGTERM')
    expect((await exited)[0]).toBe(0)
    const receipt = await receiver.close(true)
    expect(forced).toBe(false)
    expect(receipt).toMatchObject({ nativeGenerations: 2, fallbackGenerations: 1, matchedFallbacks: 2,
      missingNative: 1, cliExitObserved: true, rejectedBatches: 0, truncated: false, flush: 'not_confirmed' })
    expect(events).toHaveLength(3)
    expect(JSON.stringify({ events, receipt })).not.toContain('PRIVATE')
    expect(receiver.args.filter(value => value.startsWith('otel.trace_exporter='))).toHaveLength(1)
  } finally { clearTimeout(deadline); if (child.exitCode === null) child.kill('SIGKILL'); await receiver.close() }
}, 5000)
