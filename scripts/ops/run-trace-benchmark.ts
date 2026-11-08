/**
 * Isolated HTTP + PostgreSQL overhead/retention check for #1512.
 * Run with E2E_DATABASE_URL pointing at an owned loopback *_e2e database:
 * node --import ./scripts/server-test.mjs --import tsx scripts/ops/run-trace-benchmark.ts
 * No schema writes, external telemetry, model calls, secrets or raw SQL errors in output.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { context, propagation, ROOT_CONTEXT, trace } from '@opentelemetry/api'
import { CompositePropagator, W3CTraceContextPropagator } from '@opentelemetry/core'
import { registerInstrumentations } from '@opentelemetry/instrumentation'
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base'
import { InMemoryLogRecordExporter } from '@opentelemetry/sdk-logs'
import { CodedError } from '@mikka/protocol/coded-error'
import { beginRequestTrace } from '../../apps/api/runtime/request-trace'
import { RunContextPropagator, withRunSpan, withTraceMetadata } from '../../lib/tracing/context'
import { createPgInstrumentation, createTracerProvider, SafeExporter } from '../../lib/tracing/node'
import { createLogProvider } from '../../lib/tracing/logs'
import { localDatabaseTarget } from '../test-accounts/database-target.mjs'

const connectionString = process.env.E2E_DATABASE_URL
localDatabaseTarget(connectionString)
const spans = new InMemorySpanExporter()
const logs = new InMemoryLogRecordExporter()
const logProvider = createLogProvider({ endpoint: 'http://127.0.0.1/i/v1/traces', token: 'isolated-no-export', environment: 'dev', exporter: logs })
const provider = createTracerProvider({ exporter: new SafeExporter(spans), sampleRate: 0.1, environment: 'dev', logger: logProvider.getLogger('benchmark'), serverless: false })
provider.register({ propagator: new CompositePropagator({ propagators: [new W3CTraceContextPropagator(), new RunContextPropagator()] }) })
const unregister = registerInstrumentations({ tracerProvider: provider, instrumentations: [createPgInstrumentation()] })
const { Pool } = createRequire(import.meta.url)('pg') as typeof import('pg')
const database = new Pool({ connectionString, max: 1, statement_timeout: 5_000, connectionTimeoutMillis: 5_000 })
const count = Math.min(5_000, Math.max(200, Number(process.env.TRACE_BENCHMARK_REQUESTS) || 600))
const failureIds = new Set<string>()
const durations = { off: [] as number[], on: [] as number[] }
const roundTrips = { off: [] as number[], on: [] as number[] }
const flush = async () => { await provider.forceFlush(); await logProvider.forceFlush() }
const server = createServer((incoming, response) => {
  void context.with(ROOT_CONTEXT, async () => {
    const mode = incoming.url === '/off' ? 'off' : 'on'
    const failure = incoming.url === '/failure'
    const request = new Request('http://127.0.0.1/api/trace-benchmark', { method: failure ? 'GET' : 'POST' })
    const started = performance.now()
    const requestTrace = mode === 'on' ? beginRequestTrace(request, '/api/trace-benchmark') : undefined
    let status = 200
    let cause: unknown
    const stage = <T>(name: string, work: () => Promise<T>) => mode === 'on' && !failure ? withRunSpan(name, {}, work) : work()
    const run = async () => {
      if (failure) failureIds.add(trace.getActiveSpan()!.spanContext().traceId)
      await stage('dispatch.prepare', () => database.query('SELECT 1 AS ready'))
      await stage('dispatch.claim', () => database.query('SELECT 1 AS ready'))
      if (failure) {
        try { await database.query('SELECT 1 / 0') }
        catch (error) { throw new CodedError('trace_acceptance_failed', { detail: 'controlled_database_failure', cause: error }) }
      }
      await stage('completion.persist', () => database.query('SELECT 1 AS ready'))
    }
    try {
      if (requestTrace) await requestTrace.run(() => withTraceMetadata({ runId: randomUUID(), threadId: randomUUID() }, run))
      else await run()
    } catch (error) { status = 500; cause = error }
    requestTrace?.finish(status, cause)
    const elapsed = performance.now() - started
    response.writeHead(status, { 'content-type': 'application/json', 'server-timing': `handler;dur=${elapsed}` })
    response.end(JSON.stringify({ ok: status === 200 }))
  }).catch(() => { response.writeHead(500); response.end('{"ok":false}') })
})

function distribution(values: number[]) {
  const sorted = values.toSorted((a, b) => a - b)
  return { n: values.length, mean_ms: values.reduce((sum, value) => sum + value, 0) / values.length,
    p50_ms: sorted[Math.floor(sorted.length * 0.5)], p95_ms: sorted[Math.floor(sorted.length * 0.95)], p99_ms: sorted[Math.floor(sorted.length * 0.99)] }
}

try {
  await database.query('SELECT 1')
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const origin = `http://127.0.0.1:${address.port}`
  const request = async (mode: 'off' | 'on', collect: boolean) => {
    const started = performance.now()
    const response = await fetch(`${origin}/${mode}`)
    await response.arrayBuffer()
    assert.equal(response.status, 200)
    if (collect) {
      durations[mode].push(Number(response.headers.get('server-timing')!.split('dur=')[1]))
      roundTrips[mode].push(performance.now() - started)
    }
  }
  for (let i = 0; i < 100; i++) { await request('off', false); await request('on', false) }
  await flush()
  spans.reset(); logs.reset()
  // Alternate blocks and order, so neither condition gets all of the warm CPU/connection benefit.
  const block = 20
  for (let batch = 0; batch < Math.ceil(count / block); batch++) {
    for (const mode of batch % 2 ? ['on', 'off'] as const : ['off', 'on'] as const) {
      for (let i = 0; i < Math.min(block, count - batch * block); i++) await request(mode, true)
      await flush()
    }
  }
  const successfulRoots = spans.getFinishedSpans().filter(span => span.name === 'POST /api/trace-benchmark')
  assert.equal(successfulRoots.length, count, 'Every critical request must be retained')
  assert.ok(spans.getFinishedSpans().some(span => span.attributes['db.system.name'] === 'postgresql' || span.attributes['db.system'] === 'postgresql'), 'Real PostgreSQL driver spans required')
  await flush()
  spans.reset(); logs.reset()
  for (let i = 0; i < 20; i++) {
    const response = await fetch(`${origin}/failure`)
    await response.arrayBuffer()
    assert.equal(response.status, 500)
  }
  await flush()
  const exported = spans.getFinishedSpans()
  const failedRoots = exported.filter(span => span.name === 'GET /api/trace-benchmark')
  const linked = logs.getFinishedLogRecords()
  assert.equal(failedRoots.length, 20, 'Every ordinary failed request must be retained')
  for (const id of failureIds) {
    assert.ok(exported.some(span => span.spanContext().traceId === id && span.attributes['db.operation'] === 'SELECT'))
    assert.ok(linked.some(record => record.spanContext?.traceId === id && record.severityText === 'ERROR'))
  }
  assert.ok(failedRoots.every(span => span.attributes['mikka.error.detail'] === 'controlled_database_failure'))
  const safe = JSON.stringify({ spans: exported.map(span => ({ name: span.name, attributes: span.attributes, status: span.status, events: span.events })), logs: linked.map(record => ({ body: record.body, attributes: record.attributes })) })
  assert.equal(safe.includes('division by zero'), false, 'SQL error messages must not leave the process')
  const off = distribution(durations.off), on = distribution(durations.on)
  console.log(JSON.stringify({ environment: { node: process.version, platform: process.platform, postgres: 'real loopback', requests_per_condition: count, queries_per_request: 3 },
    boundary: 'Real HTTP and pg driver; async batched in-memory collectors. Excludes external collector network, model and cloud provisioning latency.',
    handler: { off, on, delta_mean_ms: on.mean_ms - off.mean_ms, delta_p95_ms: on.p95_ms - off.p95_ms },
    round_trip: { off: distribution(roundTrips.off), on: distribution(roundTrips.on) },
    retention: { critical: `${successfulRoots.length}/${count}`, controlled_failures: `${failedRoots.length}/20`, linked_error_logs: failureIds.size, safe_cause_chain: true, raw_sql_error_exported: false } }, null, 2))
} finally {
  server.closeAllConnections()
  await new Promise<void>(resolve => server.close(() => resolve()))
  await database.end()
  unregister()
  await Promise.allSettled([provider.shutdown(), logProvider.shutdown()])
  trace.disable(); context.disable(); propagation.disable()
}
