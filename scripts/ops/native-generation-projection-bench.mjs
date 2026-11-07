// Offline numeric projection only. No CLI, sockets, credentials or model calls.
// From the repository root: node --import tsx scripts/ops/native-generation-projection-bench.mjs
import { performance } from 'node:perf_hooks'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { CodexGenerationCollector } from '../../packages/daemon/src/codex-generation-telemetry.ts'

const traceId = '0123456789abcdef0123456789abcdef', origin = 1793980800000000000n
const id = value => value.toString(16).padStart(16, '0')
const span = (name, spanId, parentSpanId, start, end, fields = {}) => ({ name, traceId, spanId: id(spanId), parentSpanId: id(parentSpanId),
  startTimeUnixNano: String(origin + BigInt(start) * 1000000n), endTimeUnixNano: String(origin + BigInt(end) * 1000000n),
  attributes: Object.entries(fields).map(([key, value]) => ({ key, value: typeof value === 'number' ? { intValue: String(value) } : { stringValue: value } })),
})
const spans = [span('try_run_sampling_request', 1, 999, 0, 9000, { model: 'gpt-6-luna' }),
  span('stream_request', 2, 1, 0, 50), span('codex.sampling', 3, 1, 0, 550, { 'conversation.id': 'benchmark_thread' }),
  span('receiving_stream', 4, 1, 50, 8000), span('message_from_assistant', 5, 4, 100, 170, { from: 'output_item_added' }),
  span('receiving', 6, 5, 100, 150), span('completed', 7, 4, 300, 550, { 'gen_ai.usage.input_tokens': 50,
    'gen_ai.usage.output_tokens': 20, 'gen_ai.usage.cache_read.input_tokens': 30, 'gen_ai.usage.cache_write.input_tokens': 4 }),
  span('receiving', 8, 7, 300, 500)]
for (let index = 0; index < 252; index++) {
  spans.push(span('text_delta', 1000 + index * 2, 4, 150, 170), span('receiving', 1001 + index * 2, 1000 + index * 2, 150, 160))
}
const wire = JSON.stringify({ resourceSpans: [{ scopeSpans: [{ spans }] }] }), parsed = JSON.parse(wire)
const times = { parse: [], projection: [], combined: [] }
let generations = 0
const project = value => {
  const collector = new CodexGenerationCollector(() => generations++)
  collector.accept(value)
  const receipt = collector.finish(true)
  if (receipt.nativeGenerations !== 1 || receipt.truncated || receipt.incompleteRequests) throw new Error('INVALID_BENCHMARK_RECEIPT')
}
for (let index = 0; index < 120; index++) project(parsed)
for (let index = 0; index < 500; index++) {
  let start = performance.now(); JSON.parse(wire); times.parse.push(performance.now() - start)
  start = performance.now(); project(parsed); times.projection.push(performance.now() - start)
  start = performance.now(); project(JSON.parse(wire)); times.combined.push(performance.now() - start)
}
const percentiles = values => {
  const sorted = values.sort((a, b) => a - b)
  return { p50Ms: +sorted[Math.floor(sorted.length * 0.5)].toFixed(3), p95Ms: +sorted[Math.floor(sorted.length * 0.95)].toFixed(3) }
}
const report = { version: 1, runtime: process.version, scope: 'local_OTLP_JSON_parse_and_numeric_projection_only',
  collectorSha256: createHash('sha256').update(readFileSync(new URL('../../packages/daemon/src/codex-generation-telemetry.ts', import.meta.url))).digest('hex'),
  cloudOrProviderRequests: 0, spansPerBatch: spans.length, bytesPerBatch: Buffer.byteLength(wire),
  samples: 500, warmup: 120, generations, parse: percentiles(times.parse),
  projection: percentiles(times.projection), combined: percentiles(times.combined) }
process.stdout.write(JSON.stringify(report) + '\n')
