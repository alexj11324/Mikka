import { chmodSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base'
import { InMemoryLogRecordExporter } from '@opentelemetry/sdk-logs'
import { ClaudeAdapter } from '../src/adapters/claude'
import { ClaudeGenerationMetrics } from '../src/adapters/generation-metrics'
import { NoSandbox } from '../src/agents/sandbox'
import { ToolApprovalGate } from '../src/agents/tool-approval'
import { buildChildEnv } from '../src/env'
import { createLogger } from '../src/log'
import { daemonTracer } from '../src/tracing'
import type { AiSink } from '../src/tracing-ai'
import { cleanupTempDirs, makeRepo, tempDir } from './helpers'

afterEach(async () => { await daemonTracer.shutdown(); vi.restoreAllMocks(); cleanupTempDirs() })

it.each(['normal', 'aborted', 'duplicate_abort', 'abort_then_crash'] as const)(
  'records one Claude generation through the actual SDK, terminal and child close: %s', async scenario => {
    const spans = new InMemorySpanExporter()
    const captures: Parameters<AiSink['capture']>[0][] = []
    daemonTracer.configure({ endpoint: 'https://us.i.posthog.com/i/v1/traces', projectToken: 'phc_fixture123', sampleRate: 1 }, {
      exporter: spans, logExporter: new InMemoryLogRecordExporter(), env: {},
      aiSink: { capture: event => { captures.push(event) }, flush: async () => {}, shutdown: async () => {} },
    })
    const fail = vi.spyOn(ClaudeGenerationMetrics.prototype, 'fail')
    const home = tempDir('claude-generation-home-'), stateDir = tempDir('claude-generation-state-')
    const runId = `generation_${scenario}`, binary = resolve(import.meta.dirname, 'fakes/fake-claude-generation-abort.mjs')
    chmodSync(binary, 0o755)
    const adapter = new ClaudeAdapter({ sandbox: new NoSandbox(), stateDir, binary, configDir: join(home, '.claude'),
      subscriptionAuth: { accountId: 'fixture-account', token: async () => ({ accountId: 'fixture-account', accessToken: 'fixture-access',
        expiresAt: new Date(Date.now() + 60_000).toISOString() }) },
    })
    const session = await adapter.start({ runId, cwd: await makeRepo(), prompt: scenario, model: 'claude-haiku-5-5',
      toolApproval: new ToolApprovalGate(runId, { isLive: () => true }),
      traceContext: { traceparent: '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01', runId },
      env: buildChildEnv({ host: { PATH: process.env.PATH, HOME: home } }), log: createLogger({ level: 'silent' }),
    })
    const events = []
    for await (const event of session.events()) events.push(event)
    // Both calls re-enter the existing close promise after the terminal event.
    await session.cancel()
    expect(session.detach).toBeTypeOf('function')
    await session.detach?.()
    await daemonTracer.flush()
    const receipt = JSON.parse(readFileSync(join(stateDir, 'runs', runId, 'native-home', '.claude', 'fixture-process.json'), 'utf8'))
    expect(() => process.kill(receipt.pid, 0)).toThrow()
    expect(events.filter(event => event.type === 'exit')).toHaveLength(1)
    expect(events.at(-1)).toMatchObject({ type: 'exit', outcome: scenario === 'normal' ? 'succeeded' : 'failed' })
    expect(fail).toHaveBeenCalledTimes(scenario === 'abort_then_crash' ? 1 : 0)
    expect(captures).toHaveLength(1)
    expect(captures[0].properties).toMatchObject({ $ai_input_tokens: 10, $ai_cache_read_input_tokens: 3,
      $ai_cache_creation_input_tokens: 2, $ai_is_error: scenario !== 'normal', $ai_time_to_first_token: 0.02 })
    if (scenario === 'normal') expect(captures[0].properties.$ai_output_tokens).toBe(7)
    else {
      expect(captures[0].properties.$ai_error).toBe('ProviderError')
      expect(captures[0].properties).not.toHaveProperty('$ai_output_tokens')
    }
    expect(captures[0].properties).not.toHaveProperty('$ai_total_cost_usd')
    const generations = spans.getFinishedSpans().filter(span => span.name === 'daemon.ai.generation')
    expect(generations).toHaveLength(1)
    expect(generations[0].attributes['mikka.outcome']).toBe(scenario === 'normal' ? 'ok' : 'error')
    expect(JSON.stringify({ captures, attributes: generations.map(span => span.attributes) })).not.toMatch(/PRIVATE|fixture-access/)
  },
)
