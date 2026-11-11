/**
 * Isolated HTTP + PostgreSQL overhead/retention check for #1512.
 * Run with E2E_DATABASE_URL pointing at an owned loopback *_e2e database:
 * node --import ./scripts/server-test.mjs --import tsx scripts/ops/run-trace-benchmark.ts
 * Default mode is entirely local. --export-controlled-failures sends only 20
 * existing test failures to PostHog, from the exact-main opt-in workflow.
 * No schema writes, model calls, secrets or raw SQL errors in output.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { mkdir, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { context, propagation, ROOT_CONTEXT, trace } from '@opentelemetry/api'
import { CompositePropagator, ExportResultCode, W3CTraceContextPropagator, type ExportResult } from '@opentelemetry/core'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto'
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-proto'
import { registerInstrumentations } from '@opentelemetry/instrumentation'
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base'
import { InMemoryLogRecordExporter } from '@opentelemetry/sdk-logs'
import { CodedError } from '@mikka/protocol/coded-error'
import { beginRequestTrace } from '../../apps/api/runtime/request-trace'
import { RunContextPropagator, withRunSpan, withTraceMetadata } from '../../lib/tracing/context'
import { createPgInstrumentation, createTracerProvider, SafeExporter } from '../../lib/tracing/node'
import { createLogProvider } from '../../lib/tracing/logs'
import { localDatabaseTarget } from '../test-accounts/database-target.mjs'

// These are test-environment failures, never production coding runs. There is
// no endpoint, request-count or token-kind override on the export path.
export function controlledFailureSettings(args: string[], env: NodeJS.ProcessEnv) {
  if (!args.length) return undefined
  if (args.length !== 1 || args[0] !== '--export-controlled-failures') throw new Error('invalid_trace_benchmark_mode')
  if (env.GITHUB_ACTIONS !== 'true' || env.GITHUB_EVENT_NAME !== 'workflow_dispatch'
    || env.GITHUB_REPOSITORY !== 'alexj11324/Mikka' || env.GITHUB_REF !== 'refs/heads/main'
    || !/^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? '') || env.GITHUB_SHA !== env.MIKKA_EXPECTED_DEPLOYMENT_SHA) {
    throw new Error('controlled_failure_source_binding_required')
  }
  const token = env.NEXT_PUBLIC_POSTHOG_KEY
  if (!token || !/^phc_[a-zA-Z0-9_-]{1,256}$/.test(token)) throw new Error('controlled_failure_project_token_required')
  localDatabaseTarget(env.E2E_DATABASE_URL)
  return { endpoint: 'https://us.i.posthog.com/i/v1/traces', token, version: env.GITHUB_SHA, environment: 'dev', requests: 20 } as const
}

type ExportSink<T> = { export(items: T[], done: (result: ExportResult) => void): void; shutdown(): Promise<void>; forceFlush?(): Promise<void> }

/** Observe only sanitized batches, inside the product Safe exporters. Their
 * deliberate SUCCESS-on-failure behavior must not become delivery evidence. */
export function observedExporter<T>(local: ExportSink<T>, remote?: ExportSink<T>) {
  const counts = { enabled: Boolean(remote), batchesAttempted: 0, recordsAttempted: 0, batchesSucceeded: 0, recordsSucceeded: 0,
    batchesFailed: 0, recordsFailed: 0, exportThrows: 0, flushFailures: 0, shutdownFailures: 0 }
  return {
    receipt: () => ({ ...counts, batchesPending: counts.batchesAttempted - counts.batchesSucceeded - counts.batchesFailed,
      recordsPending: counts.recordsAttempted - counts.recordsSucceeded - counts.recordsFailed }),
    exporter: {
      export(items: T[], done: (result: ExportResult) => void) {
        local.export(items, result => {
          if (!remote || result.code !== ExportResultCode.SUCCESS) return done(result)
          counts.batchesAttempted++; counts.recordsAttempted += items.length
          let completed = false
          const finish = (outcome: ExportResult) => {
            if (completed) return
            completed = true
            if (outcome.code === ExportResultCode.SUCCESS) { counts.batchesSucceeded++; counts.recordsSucceeded += items.length }
            else { counts.batchesFailed++; counts.recordsFailed += items.length }
            // Error text stays inside the product wrapper, never in the receipt.
            done({ code: outcome.code })
          }
          try { remote.export(items, finish) } catch { counts.exportThrows++; finish({ code: ExportResultCode.FAILED }) }
        })
      },
      async forceFlush() {
        await local.forceFlush?.()
        try { await remote?.forceFlush?.() } catch { counts.flushFailures++; throw new Error('controlled_failure_export_flush_failed') }
      },
      async shutdown() {
        await local.shutdown()
        try { await remote?.shutdown() } catch { counts.shutdownFailures++; throw new Error('controlled_failure_export_shutdown_failed') }
      },
    },
  }
}

export async function runTraceBenchmark(args = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env) {
  const settings = controlledFailureSettings(args, env)
  const connectionString = env.E2E_DATABASE_URL
  localDatabaseTarget(connectionString)
  const spans = new InMemorySpanExporter()
  const logs = new InMemoryLogRecordExporter()
  const spanExport = observedExporter(spans, settings ? new OTLPTraceExporter({ url: settings.endpoint,
    headers: { Authorization: `Bearer ${settings.token}` }, timeoutMillis: 5_000 }) : undefined)
  const logExport = observedExporter(logs, settings ? new OTLPLogExporter({ url: settings.endpoint.replace(/\/traces$/, '/logs'),
    headers: { Authorization: `Bearer ${settings.token}` }, timeoutMillis: 5_000 }) : undefined)
  const logProvider = createLogProvider({ endpoint: 'http://127.0.0.1/i/v1/traces', token: 'isolated-no-export', environment: 'dev', version: settings?.version, exporter: settings ? logExport.exporter : logs })
  const provider = createTracerProvider({ exporter: new SafeExporter(settings ? spanExport.exporter : spans), sampleRate: 0.1, environment: 'dev', version: settings?.version, logger: logProvider.getLogger('benchmark'), serverless: false })
  provider.register({ propagator: new CompositePropagator({ propagators: [new W3CTraceContextPropagator(), new RunContextPropagator()] }) })
  const unregister = registerInstrumentations({ tracerProvider: provider, instrumentations: [createPgInstrumentation()] })
  const { Pool } = createRequire(import.meta.url)('pg') as typeof import('pg')
  const database = new Pool({ connectionString, max: 1, statement_timeout: 5_000, connectionTimeoutMillis: 5_000 })
  const count = Math.min(5_000, Math.max(200, Number(env.TRACE_BENCHMARK_REQUESTS) || 600))
  const failureIds = new Set<string>()
  let initialUnsampled = 0, attempted = 0, failedResponses = 0, executionComplete = false
  let report: Record<string, unknown> | undefined
  let localChecksPassed = false
  let cleanupComplete = false
  const startedAt = new Date().toISOString()
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
        if (failure) {
          const info = trace.getActiveSpan()!.spanContext()
          failureIds.add(info.traceId)
          if (!(info.traceFlags & 1)) initialUnsampled++
        }
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
    let successfulRoots: ReturnType<InMemorySpanExporter['getFinishedSpans']> = []
    if (!settings) {
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
      successfulRoots = spans.getFinishedSpans().filter(span => span.name === 'POST /api/trace-benchmark')
      assert.equal(successfulRoots.length, count, 'Every critical request must be retained')
      assert.ok(spans.getFinishedSpans().some(span => span.attributes['db.system.name'] === 'postgresql' || span.attributes['db.system'] === 'postgresql'), 'Real PostgreSQL driver spans required')
      await flush()
      spans.reset(); logs.reset()
    }
    for (let i = 0; i < 20; i++) {
      attempted++
      const response = await fetch(`${origin}/failure`, settings ? { signal: AbortSignal.timeout(10_000) } : undefined)
      await response.arrayBuffer()
      if (response.status === 500) failedResponses++
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
    executionComplete = true
    if (!settings) {
      const off = distribution(durations.off), on = distribution(durations.on)
      report = { environment: { node: process.version, platform: process.platform, postgres: 'real loopback', requests_per_condition: count, queries_per_request: 3 },
        boundary: 'Real HTTP and pg driver; async batched in-memory collectors. Excludes external collector network, model and cloud provisioning latency.',
        handler: { off, on, delta_mean_ms: on.mean_ms - off.mean_ms, delta_p95_ms: on.p95_ms - off.p95_ms },
        round_trip: { off: distribution(roundTrips.off), on: distribution(roundTrips.on) },
        retention: { critical: `${successfulRoots.length}/${count}`, controlled_failures: `${failedRoots.length}/20`, linked_error_logs: failureIds.size, safe_cause_chain: true, raw_sql_error_exported: false } }
    }
  } catch (error) {
    if (!settings) throw error
  } finally {
    if (settings) {
      const exported = spans.getFinishedSpans(), linked = logs.getFinishedLogRecords()
      const roots = exported.filter(span => span.name === 'GET /api/trace-benchmark')
      const checks = {
        allAttemptsCompleted: executionComplete && attempted === 20 && failedResponses === 20 && failureIds.size === 20,
        rootsRetained: roots.length === 20 && new Set(roots.map(span => span.spanContext().traceId)).size === 20
          && roots.every(span => failureIds.has(span.spanContext().traceId)),
        ordinaryFailures: roots.length === 20 && roots.every(span => span.status.code === 2 && span.attributes['http.response.status_code'] === 500
          && span.attributes['mikka.trace.critical'] === false && span.attributes['mikka.trace.sample_rate'] === 1 && span.attributes['mikka.trace.retention'] === 'error_or_slow'),
        realPgErrorPerTrace: failureIds.size === 20 && [...failureIds].every(id => {
          const pg = exported.filter(span => span.spanContext().traceId === id && span.attributes['db.operation'] === 'SELECT'
            && (span.attributes['db.system.name'] === 'postgresql' || span.attributes['db.system'] === 'postgresql'))
          return pg.length === 3 && pg.filter(span => span.status.code === 2).length === 1
        }),
        safeCausePerTrace: roots.length === 20 && roots.every(span => span.attributes['mikka.error.code'] === 'trace_acceptance_failed'
          && span.attributes['mikka.error.detail'] === 'controlled_database_failure' && String(span.attributes['mikka.error.causes']).includes('22012')),
        linkedErrorLogPerTrace: roots.length === 20 && roots.every(root => linked.some(record => record.spanContext?.traceId === root.spanContext().traceId
          && record.spanContext?.spanId === root.spanContext().spanId && record.severityText === 'ERROR'
          && record.attributes['mikka.error.code'] === 'trace_acceptance_failed' && record.attributes['mikka.error.detail'] === 'controlled_database_failure')),
        unsampledFailuresPromoted: initialUnsampled > 0,
        rawSqlErrorAbsent: !JSON.stringify({ spans: exported.map(span => ({ name: span.name, attributes: span.attributes, status: span.status, events: span.events })),
          logs: linked.map(record => ({ body: record.body, attributes: record.attributes })) }).includes('division by zero'),
      }
      localChecksPassed = Object.values(checks).every(Boolean)
      report = { version: 1, kind: 'controlled_failure_otlp_probe', sourceRevision: settings.version, environment: 'dev', startedAt, endedAt: new Date().toISOString(),
        boundary: '20 synthetic test-environment HTTP/real PostgreSQL failures through the product sampler, retention and safe exporters. No production coding run or model. Raw OTLP callback success is not backend ingestion evidence.',
        configuredSampleRate: 0.1, attempted, failedResponses, initialUnsampled, localRetainedRoots: roots.length, localExportedSpans: exported.length, localExportedLogs: linked.length,
        traceIds: [...failureIds].sort(), perTrace: roots.map(root => ({ traceId: root.spanContext().traceId, rootSpanId: root.spanContext().spanId,
          pgSpanIds: exported.filter(span => span.spanContext().traceId === root.spanContext().traceId && span.attributes['db.operation'] === 'SELECT').map(span => span.spanContext().spanId),
          errorSpanIds: exported.filter(span => span.spanContext().traceId === root.spanContext().traceId && span.status.code === 2).map(span => span.spanContext().spanId) })),
        checks, backendObserved: false }
    }
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    const databaseClosed = await Promise.allSettled([database.end()])
    unregister()
    const providersClosed = await Promise.allSettled([provider.shutdown(), logProvider.shutdown()])
    cleanupComplete = [...databaseClosed, ...providersClosed].every(value => value.status === 'fulfilled')
    trace.disable(); context.disable(); propagation.disable()
  }
  assert.ok(report)
  if (settings) {
    const transport = { spans: spanExport.receipt(), logs: logExport.receipt() }
    const callbacksComplete = Object.values(transport).every(value => value.batchesAttempted > 0 && value.batchesSucceeded === value.batchesAttempted
      && value.recordsSucceeded === value.recordsAttempted && value.batchesFailed === 0 && value.batchesPending === 0 && value.flushFailures === 0 && value.shutdownFailures === 0)
    const exitCode = localChecksPassed && callbacksComplete && cleanupComplete ? 0 : 1
    return { exitCode, report: { ...report, cleanupComplete,
      transportBoundary: 'Raw OTLP exporter callback batches/items; not HTTP wire attempts or stored PostHog rows.',
      transport, result: exitCode ? 'incomplete' : 'exported_awaiting_backend_verification' } }
  }
  assert.ok(cleanupComplete, 'Local benchmark cleanup required')
  return { exitCode: 0, report }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await runTraceBenchmark()
    if (process.argv.includes('--export-controlled-failures')) {
      await mkdir('production-run-observability-report', { recursive: true })
      await writeFile('production-run-observability-report/controlled-failure.receipt.json', JSON.stringify(result.report, null, 2) + '\n')
    }
    console.log(JSON.stringify(result.report, null, 2))
    process.exitCode = result.exitCode
  } catch {
    // Database, token, OTLP and assertion error objects are never log payloads.
    const failure = { version: 1, kind: 'trace_benchmark_failure', result: 'incomplete', backendObserved: false,
      failureCode: 'configuration_or_execution_failed' }
    if (process.argv.includes('--export-controlled-failures')) {
      await mkdir('production-run-observability-report', { recursive: true }).catch(() => {})
      await writeFile('production-run-observability-report/controlled-failure.receipt.json', JSON.stringify(failure, null, 2) + '\n').catch(() => {})
    }
    console.error(JSON.stringify(failure))
    process.exitCode = 1
  }
}
