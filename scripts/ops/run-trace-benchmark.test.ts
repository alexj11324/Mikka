import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { context, propagation, trace } from '@opentelemetry/api'
import { CompositePropagator, ExportResultCode, W3CTraceContextPropagator, type ExportResult } from '@opentelemetry/core'
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base'
import { InMemoryLogRecordExporter } from '@opentelemetry/sdk-logs'
import { CodedError } from '@mikka/protocol/coded-error'
import { beginRequestTrace } from '../../apps/api/runtime/request-trace'
import { createTracerProvider, SafeExporter } from '../../lib/tracing/node'
import { createLogProvider } from '../../lib/tracing/logs'

const subject = () => import('./run-trace-benchmark')
const revision = 'a'.repeat(40)
const env = { NODE_ENV: 'test' as const, GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REPOSITORY: 'alexj11324/Mikka',
  GITHUB_REF: 'refs/heads/main', GITHUB_SHA: revision, MIKKA_EXPECTED_DEPLOYMENT_SHA: revision,
  NEXT_PUBLIC_POSTHOG_KEY: 'phc_UNIT_PRIVATE_CANARY', E2E_DATABASE_URL: 'postgresql://e2e:local-only@127.0.0.1:5432/mikka_e2e' }
const flag = ['--export-controlled-failures']
const require = createRequire(import.meta.url)
const workflow = require('js-yaml').load(readFileSync(new URL('../../.github/workflows/run-trace-acceptance.yml', import.meta.url), 'utf8'))

test('controlled-failure workflow mode has one isolated job and preserves every old mode', () => {
  assert.deepEqual(workflow.on.workflow_dispatch.inputs.mode.options, ['preflight', 'execute', 'export', 'controlled-failure'])
  for (const [mode, expected] of [['preflight', 'acceptance'], ['execute', 'acceptance'], ['export', 'export'], ['controlled-failure', 'controlled-failure'], ['unknown', undefined]]) {
    const active = Object.entries(workflow.jobs).filter(([, value]) => runInNewContext((value as { if: string }).if, {
      github: { repository: 'alexj11324/Mikka', ref: 'refs/heads/main' }, inputs: { mode },
    })).map(([name]) => name)
    assert.deepEqual(active, expected ? [expected] : [])
  }
  const job = workflow.jobs['controlled-failure']
  for (const github of [{ repository: 'foreign/repo', ref: 'refs/heads/main' }, { repository: 'alexj11324/Mikka', ref: 'refs/heads/unreviewed' }]) {
    assert.equal(runInNewContext(job.if, { github, inputs: { mode: 'controlled-failure' } }), false)
  }
  assert.equal(job.services.postgres.image, 'postgres:17')
  assert.equal(job.services.postgres.env.POSTGRES_DB, 'mikka_e2e')
  assert.deepEqual(job.services.postgres.ports, ['127.0.0.1:5432:5432'])
  assert.equal(job.permissions['id-token'], 'write')
  assert.equal(job.permissions.issues, undefined)
  const secretSteps = job.steps.filter((step: { uses?: string }) => step.uses?.startsWith('Infisical/'))
  assert.equal(secretSteps.length, 1)
  assert.equal(secretSteps[0].with['secret-name'], 'NEXT_PUBLIC_POSTHOG_KEY')
  assert.equal(secretSteps[0].with['secret-path'], '/vercel')
  assert.equal(secretSteps[0].with['identity-id'], '2cf9fa19-b9db-4c08-8ca0-b31859f2cbac')
  const testStep = job.steps.findIndex((step: { run?: string }) => step.run?.includes('--test scripts/ops/run-trace-benchmark.test.ts'))
  assert.ok(testStep >= 0 && testStep < job.steps.indexOf(secretSteps[0]))
  const overheadStep = job.steps.findIndex((step: { run?: string }) => step.run === 'mkdir -p production-run-observability-report\nnode --import ./scripts/server-test.mjs --import tsx scripts/ops/run-trace-benchmark.ts > production-run-observability-report/overhead.receipt.json\n')
  assert.ok(overheadStep > testStep && overheadStep < job.steps.indexOf(secretSteps[0]))
  const artifact = job.steps.find((step: { uses?: string }) => step.uses?.startsWith('actions/upload-artifact@'))
  assert.deepEqual(artifact.with.path.trim().split('\n'), ['production-run-observability-report/controlled-failure.receipt.json', 'production-run-observability-report/overhead.receipt.json'])
  assert.doesNotMatch(JSON.stringify(job), /ACME_DEMO_|SMOKE_OWNER_|run-observability-workflow\.mjs|browser-submit --runner|POSTHOG_PERSONAL_API_KEY/)
  assert.ok(job.steps.some((step: { run?: string }) => step.run === 'node --import ./scripts/server-test.mjs --import tsx scripts/ops/run-trace-benchmark.ts --export-controlled-failures'))
})

test('workflow source and unrelated-input guards execute before credentials', () => {
  const job = workflow.jobs['controlled-failure']
  assert.ok(job, 'A dedicated controlled-failure job is required')
  const step = job.steps.find((item: { name: string }) => item.name === 'Bind the isolated probe to this exact main revision')
  const script = step.run.match(/<<'JS'\n([\s\S]*?)\nJS\s*$/)?.[1]
  assert.ok(script)
  const clean = { ...env, ACCEPTANCE_MODE: 'controlled-failure', ACCEPTANCE_PREPARE: 'false', ACCEPTANCE_BROWSER_SUBMIT: 'false',
    ACCEPTANCE_MODEL_CASE: 'all', EXPORT_TARGET: 'dashboard', EXPORT_ID: '', REPLAY_SESSION_ID: '', REPLAY_TRACE_ID: '' }
  for (const patch of [{}, { MIKKA_EXPECTED_DEPLOYMENT_SHA: 'b'.repeat(40) }, { ACCEPTANCE_MODE: 'execute' },
    { ACCEPTANCE_PREPARE: 'true' }, { ACCEPTANCE_BROWSER_SUBMIT: 'true' }, { ACCEPTANCE_MODEL_CASE: 'claude' },
    { EXPORT_TARGET: 'insight' }, { EXPORT_ID: '123' }, { REPLAY_SESSION_ID: 'private-input' }, { REPLAY_TRACE_ID: 'private-input' }]) {
    const child = spawnSync(process.execPath, ['--input-type=module', '-'], { input: script, env: { ...clean, ...patch }, encoding: 'utf8' })
    assert.equal(child.status === 0, Object.keys(patch).length === 0)
  }
})

test('actual CLI rejects the source before connections and writes only a closed failure receipt', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'mikka-controlled-failure-'))
  try {
    const child = spawnSync(process.execPath, ['--import', new URL('../server-test.mjs', import.meta.url).pathname,
      '--import', require.resolve('tsx'), new URL('./run-trace-benchmark.ts', import.meta.url).pathname, ...flag], {
      cwd, encoding: 'utf8', env: { ...env, GITHUB_REF: 'refs/heads/unreviewed',
        TSX_TSCONFIG_PATH: new URL('../../tsconfig.json', import.meta.url).pathname }, timeout: 10_000,
    })
    assert.equal(child.status, 1)
    const receipt = JSON.parse(readFileSync(join(cwd, 'production-run-observability-report/controlled-failure.receipt.json'), 'utf8'))
    assert.equal(receipt.backendObserved, false)
    assert.equal(receipt.result, 'incomplete')
    assert.equal(receipt.failureCode, 'configuration_or_execution_failed')
    assert.doesNotMatch(JSON.stringify(receipt) + child.stdout + child.stderr, /PRIVATE_|phc_|phx_|Error:|stack|postgresql:/)
  } finally { rmSync(cwd, { recursive: true, force: true }) }
})

test('export opt-in is finite, source bound and uses only the official project-token endpoints', async () => {
  const { controlledFailureSettings } = await subject()
  assert.equal(controlledFailureSettings([], env), undefined)
  assert.equal(controlledFailureSettings([], { NODE_ENV: 'test' }), undefined)
  const settings = controlledFailureSettings(flag, env)!
  assert.equal(settings.requests, 20)
  assert.equal(settings.endpoint, 'https://us.i.posthog.com/i/v1/traces')
  assert.equal(settings.environment, 'dev')
  assert.equal(settings.version, revision)
  assert.equal(settings.token, env.NEXT_PUBLIC_POSTHOG_KEY)
  assert.equal(controlledFailureSettings(flag, { ...env, TRACE_BENCHMARK_REQUESTS: '5000', OTEL_EXPORTER_OTLP_ENDPOINT: 'https://foreign.test' })!.endpoint, settings.endpoint)
  for (const args of [['--export-controlled-failures', '--export-controlled-failures'], ['--endpoint=https://foreign.test'], ['--export-controlled-failures=1']]) {
    assert.throws(() => controlledFailureSettings(args, env), /invalid_trace_benchmark_mode/)
  }
  for (const patch of [{ NEXT_PUBLIC_POSTHOG_KEY: '' }, { NEXT_PUBLIC_POSTHOG_KEY: 'phx_PRIVATE_CANARY' },
    { NEXT_PUBLIC_POSTHOG_KEY: 'phc_PRIVATE\nCANARY' }, { GITHUB_SHA: 'moving-branch' },
    { MIKKA_EXPECTED_DEPLOYMENT_SHA: 'b'.repeat(40) }, { GITHUB_REF: 'refs/heads/unreviewed' },
    { GITHUB_REPOSITORY: 'foreign/repo' }, { GITHUB_ACTIONS: 'false' }, { GITHUB_EVENT_NAME: 'push' },
    { E2E_DATABASE_URL: 'postgresql://e2e:PRIVATE_CANARY@foreign.test/production' }]) {
    assert.throws(() => controlledFailureSettings(flag, { ...env, ...patch }), error => {
      assert.doesNotMatch(String(error), /PRIVATE|phc_|phx_|foreign\.test/)
      return true
    })
  }
})

test('raw exporter callbacks distinguish failure and pending even when product wrappers report success', async () => {
  const { observedExporter } = await subject()
  const local = { export: (_items: number[], done: (result: ExportResult) => void) => done({ code: ExportResultCode.SUCCESS }),
    shutdown: async () => {}, forceFlush: async () => {} }
  let callback: ((result: ExportResult) => void) | undefined
  const observed = observedExporter(local, { ...local, export: (_items, done) => { callback = done } })
  let completed = 0
  observed.exporter.export([1, 2, 3], () => { completed++ })
  assert.deepEqual(observed.receipt(), { enabled: true, batchesAttempted: 1, recordsAttempted: 3, batchesSucceeded: 0, recordsSucceeded: 0,
    batchesFailed: 0, recordsFailed: 0, batchesPending: 1, recordsPending: 3, exportThrows: 0, flushFailures: 0, shutdownFailures: 0 })
  callback!({ code: ExportResultCode.FAILED, error: new Error('PRIVATE_REMOTE_ERROR') })
  callback!({ code: ExportResultCode.SUCCESS })
  assert.equal(completed, 1)
  assert.equal(observed.receipt().batchesFailed, 1)
  assert.equal(observed.receipt().batchesSucceeded, 0)
  assert.equal(observed.receipt().batchesPending, 0)
  assert.doesNotMatch(JSON.stringify(observed.receipt()), /PRIVATE_REMOTE_ERROR|stack/)
})

test('synchronous transport errors and flush failures remain closed counters; local-only export stays local', async () => {
  const { observedExporter } = await subject()
  const local = { export: (_items: number[], done: (result: ExportResult) => void) => done({ code: ExportResultCode.SUCCESS }),
    shutdown: async () => {}, forceFlush: async () => {} }
  const observed = observedExporter(local, { ...local,
    export: () => { throw new Error('PRIVATE_TRANSPORT_CANARY') },
    forceFlush: async () => { throw new Error('PRIVATE_FLUSH_CANARY') },
    shutdown: async () => { throw new Error('PRIVATE_SHUTDOWN_CANARY') },
  })
  let result
  observed.exporter.export([1], value => { result = value.code })
  assert.equal(result, ExportResultCode.FAILED)
  await assert.rejects(observed.exporter.forceFlush())
  await assert.rejects(observed.exporter.shutdown())
  assert.equal(observed.receipt().recordsFailed, 1)
  assert.equal(observed.receipt().exportThrows, 1)
  assert.equal(observed.receipt().flushFailures, 1)
  assert.equal(observed.receipt().shutdownFailures, 1)
  assert.doesNotMatch(JSON.stringify(observed.receipt()), /PRIVATE_|stack/)
  const isolated = observedExporter(local)
  isolated.exporter.export([1], value => assert.equal(value.code, ExportResultCode.SUCCESS))
  await isolated.exporter.forceFlush(); await isolated.exporter.shutdown()
  assert.equal(isolated.receipt().enabled, false)
  assert.equal(isolated.receipt().batchesAttempted, 0)
})

test('actual sampler and safe exporters retain an unsampled ordinary failure and do not hide raw delivery failures', async () => {
  const { observedExporter } = await subject()
  const memorySpans = new InMemorySpanExporter(), memoryLogs = new InMemoryLogRecordExporter()
  const failed = { export: (_items: unknown[], done: (result: ExportResult) => void) => done({ code: ExportResultCode.FAILED, error: new Error('PRIVATE_REMOTE_ERROR') }),
    shutdown: async () => {}, forceFlush: async () => {} }
  const spans = observedExporter(memorySpans, failed), logs = observedExporter(memoryLogs, failed)
  const logger = createLogProvider({ endpoint: 'http://127.0.0.1/i/v1/traces', token: 'unit-no-export', environment: 'dev', version: revision, exporter: logs.exporter })
  const provider = createTracerProvider({ exporter: new SafeExporter(spans.exporter), logger: logger.getLogger('unit'), sampleRate: 0.1,
    environment: 'dev', version: revision, serverless: false })
  provider.register({ propagator: new CompositePropagator({ propagators: [new W3CTraceContextPropagator()] }) })
  try {
    const request = beginRequestTrace(new Request('http://127.0.0.1/api/trace-benchmark', { headers: {
      traceparent: '00-ffffffff000000000000000000000000-aaaaaaaaaaaaaaaa-00',
    } }), '/api/trace-benchmark')
    await request.run(async () => { assert.equal(trace.getActiveSpan()!.spanContext().traceFlags, 0) })
    request.finish(500, new CodedError('trace_acceptance_failed', { detail: 'controlled_database_failure', cause: new Error('PRIVATE_SQL_ERROR') }))
    await provider.forceFlush(); await logger.forceFlush()
    assert.equal(memorySpans.getFinishedSpans().length, 1)
    assert.equal(memoryLogs.getFinishedLogRecords().length, 1)
    const span = memorySpans.getFinishedSpans()[0]
    assert.equal(span.attributes['mikka.trace.sample_rate'], 1)
    assert.equal(span.attributes['mikka.error.code'], 'trace_acceptance_failed')
    assert.equal(span.attributes['mikka.error.detail'], 'controlled_database_failure')
    assert.equal(span.resource.attributes['service.version'], revision)
    assert.equal(span.resource.attributes['deployment.environment.name'], 'dev')
    assert.equal(spans.receipt().batchesFailed, 1)
    assert.equal(logs.receipt().batchesFailed, 1)
    assert.equal(spans.receipt().batchesSucceeded, 0)
    assert.doesNotMatch(JSON.stringify({ attributes: span.attributes, status: span.status, logs: memoryLogs.getFinishedLogRecords().map(item => ({ body: item.body, attributes: item.attributes })) }), /PRIVATE_|division by zero/)
  } finally {
    await Promise.allSettled([provider.shutdown(), logger.shutdown()])
    trace.disable(); context.disable(); propagation.disable()
  }
})
