import { chmodSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base'
import { InMemoryLogRecordExporter } from '@opentelemetry/sdk-logs'
import { CodexAdapter } from '../src/adapters/codex'
import { NoSandbox } from '../src/agents/sandbox'
import { ToolApprovalGate } from '../src/agents/tool-approval'
import { buildChildEnv } from '../src/env'
import { createLogger } from '../src/log'
import { daemonTracer } from '../src/tracing'
import type { AiSink } from '../src/tracing-ai'
import { cleanupTempDirs, makeRepo, tempDir, waitFor } from './helpers'

afterEach(async () => { await daemonTracer.shutdown(); cleanupTempDirs() })

it.each(['known', 'missing_fresh', 'missing_reused'] as const)(
  'retains a Codex completed response through actual adapter close: %s', async scenario => {
    const spans = new InMemorySpanExporter(), captures: Parameters<AiSink['capture']>[0][] = []
    daemonTracer.configure({ endpoint: 'https://us.i.posthog.com/i/v1/traces', projectToken: 'phc_fixture123', sampleRate: 1 }, {
      exporter: spans, logExporter: new InMemoryLogRecordExporter(), env: {},
      aiSink: { capture: event => { captures.push(event) }, flush: async () => {}, shutdown: async () => {} },
    })
    const home = tempDir('codex-completion-home-'), stateDir = tempDir('codex-completion-state-')
    const runId = `completion_${scenario}`, binary = resolve(import.meta.dirname, 'fakes/fake-codex-generation-completion.mjs')
    chmodSync(binary, 0o755)
    const adapter = new CodexAdapter({ sandbox: new NoSandbox(), stateDir, binary,
      subscriptionAuth: { accountId: 'fixture-account', token: async () => ({ accessToken: 'fixture-access', chatgptAccountId: 'fixture-account' }) },
    })
    const session = await adapter.start({ runId, cwd: await makeRepo(), prompt: scenario, model: 'gpt-6-luna',
      toolApproval: new ToolApprovalGate(runId, { isLive: () => true }),
      traceContext: { traceparent: '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01', runId },
      env: buildChildEnv({ host: { PATH: process.env.PATH, HOME: home } }), log: createLogger({ level: 'silent' }),
    })
    const events = []
    for await (const event of session.events()) events.push(event)
    await session.cancel()
    const receipt = JSON.parse(readFileSync(join(stateDir, 'runs', runId, 'codex-home', 'fixture-process.json'), 'utf8'))
    expect(() => process.kill(receipt.pid, 0)).toThrow()
    expect(events.at(-1)).toMatchObject({ type: 'exit', outcome: 'succeeded' })
    const collection = await waitFor(async () => { await daemonTracer.flush(); return spans.getFinishedSpans().find(span => span.name === 'daemon.ai.collection') }, 5000)
    const expected = scenario === 'missing_reused' ? 2 : 1
    expect(receipt).toMatchObject({ rawCompleted: expected, usageNotifications: scenario === 'missing_fresh' ? 0 : expected })
    expect(captures).toHaveLength(expected)
    expect(collection.attributes).toMatchObject({ 'mikka.ai.native_generations': expected, 'mikka.ai.fallback_generations': 0,
      'mikka.ai.matched_fallbacks': scenario === 'missing_fresh' ? 0 : 1, 'mikka.ai.incomplete_requests': 0,
      'mikka.ai.rejected_batches': 0, 'mikka.ai.cli_exit_observed': true, 'mikka.ai.native_flush_confirmed': false })
    if (scenario !== 'known') {
      const missing = captures.filter(event => event.properties.$ai_input_tokens === undefined)
      expect(missing).toHaveLength(1)
      for (const key of ['$ai_input_tokens', '$ai_output_tokens', '$ai_cache_read_input_tokens', '$ai_cache_creation_input_tokens', '$ai_total_cost_usd'])
        expect(missing[0].properties).not.toHaveProperty(key)
      expect(missing[0].properties).toMatchObject({ $ai_is_error: false, $ai_latency: 0.5, $ai_time_to_first_token: 0.15 })
    }
    expect(JSON.stringify({ captures, collection: collection.attributes })).not.toMatch(/PRIVATE|fixture-access/)
  },
)
