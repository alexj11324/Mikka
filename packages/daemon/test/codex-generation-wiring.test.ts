import { afterEach, expect, it } from 'vitest'
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base'
import { InMemoryLogRecordExporter } from '@opentelemetry/sdk-logs'
import { CodexAdapter } from '../src/adapters/codex'
import { NoSandbox } from '../src/agents/sandbox'
import { ToolApprovalGate } from '../src/agents/tool-approval'
import { daemonTracer } from '../src/tracing'
import { createLogger } from '../src/log'
import { cleanupTempDirs, makeRepo, tempDir } from './helpers'

afterEach(async () => { await daemonTracer.shutdown(); cleanupTempDirs() })

it.each(['off', 'spans_only', 'generations'] as const)('starts a native receiver only for %s, preserves owned setup errors and cleans its endpoint', async mode => {
  const spans = new InMemorySpanExporter()
  daemonTracer.configure({ endpoint: 'https://us.i.posthog.com/i/v1/traces', projectToken: 'phc_fixture123', sampleRate: 1 }, {
    exporter: spans, logExporter: new InMemoryLogRecordExporter(),
    aiSink: mode === 'generations' ? { capture() {}, flush: async () => {}, shutdown: async () => {} } : null,
    env: mode === 'off' ? { MIKKA_DAEMON_TRACING: '0' } : {},
  })
  const home = tempDir('native-generation-home-'), stateDir = tempDir('native-generation-state-')
  const failure = new Error('PRIVATE_SETUP_FAILURE')
  let argv: string[] = [], childEnv: Record<string, string> = {}
  const adapter = new CodexAdapter({ stateDir, sandbox: new NoSandbox(), binary: '/synthetic/codex',
    cliTiming: { args: ['-c', 'otel.trace_exporter="none"'], env: { OTEL_TRACES_EXPORTER: 'none' } },
    spawnCli: async (_sandbox, input, options) => { argv = input; childEnv = options.env; throw failure },
  })
  const traceContext = { traceparent: '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01', runId: 'wiring_run' }
  await expect(adapter.start({ runId: 'wiring_run', cwd: await makeRepo(), prompt: 'PRIVATE_PROMPT',
    toolApproval: new ToolApprovalGate('wiring_run', { isLive: () => true }),
    env: { HOME: home, PATH: process.env.PATH ?? '', SYNTHETIC_SELECTED_KEY: 'PRIVATE_KEY',
      NO_PROXY: 'upper.example', no_proxy: 'lower.example', HTTP_PROXY: 'http://PRIVATE_PROXY' },
    machineEnvironment: true, traceContext, log: createLogger({ level: 'silent' }) })).rejects.toBe(failure)
  const traceOptions = argv.filter(value => value.startsWith('otel.trace_exporter='))
  expect(childEnv.HOME).toBe(home)
  expect(childEnv.SYNTHETIC_SELECTED_KEY).toBe('PRIVATE_KEY')
  expect(childEnv.HTTP_PROXY).toBe('http://PRIVATE_PROXY')
  if (mode === 'generations' && process.platform === 'linux') {
    expect(childEnv.NO_PROXY).toBe('upper.example,127.0.0.1')
    expect(childEnv.no_proxy).toBe('lower.example,127.0.0.1')
    expect(traceOptions).toHaveLength(2)
    expect(traceOptions[0]).toBe('otel.trace_exporter="none"')
    expect(traceOptions[1]).toMatch(/^otel\.trace_exporter=\{otlp-http=\{endpoint="http:\/\/127\.0\.0\.1:\d+\/v1\/traces\/[a-f0-9]{32}"/)
    expect(childEnv.OTEL_EXPORTER_OTLP_TRACES_TIMEOUT).toBe('1000')
    await daemonTracer.flush()
    const endpoint = /endpoint="([^"]+)"/.exec(traceOptions[1])![1]
    await expect(fetch(endpoint, { method: 'POST' })).rejects.toThrow()
    const receipt = spans.getFinishedSpans().find(span => span.name === 'daemon.ai.collection')!
    expect(receipt.attributes['mikka.ai.cli_exit_observed']).toBe(false)
    expect(receipt.attributes['mikka.ai.native_flush_confirmed']).toBe(false)
  } else {
    expect(childEnv.NO_PROXY).toBe('upper.example')
    expect(childEnv.no_proxy).toBe('lower.example')
    expect(traceOptions).toEqual(['otel.trace_exporter="none"'])
    expect(childEnv.OTEL_EXPORTER_OTLP_TRACES_TIMEOUT).toBeUndefined()
  }
  expect(JSON.stringify(spans.getFinishedSpans().map(span => span.attributes))).not.toContain('PRIVATE')
})
