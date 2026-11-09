import { expect, it } from 'vitest'
import { ClaudeGenerationMetrics, CodexGenerationMetrics } from './generation-metrics'
import { generationEvent, type GenerationMetrics } from '../tracing-ai'

it('records final Claude usage once per message, including interleaved subagents, without content', () => {
  const captured: GenerationMetrics[] = []
  let now = 100
  const tracker = new ClaudeGenerationMetrics(value => captured.push(value), () => now)
  const stream = (event: unknown, parent_tool_use_id: string | null = null, ttft_ms?: number) => tracker.observe({ type: 'stream_event', event, parent_tool_use_id, ttft_ms })
  stream({ type: 'message_start', message: { id: 'msg_1', model: 'claude-haiku-5-5', content: [{ text: 'private prompt sk-secret' }], usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 } } }, null, 50)
  tracker.observe({ type: 'assistant', message: { id: 'msg_1', stop_reason: null, content: [{ text: 'private output' }], usage: { output_tokens: 1 } } })
  stream({ type: 'message_start', message: { id: 'msg_sub', model: 'claude-haiku-5-5', usage: { input_tokens: 5 } } }, 'tool_1')
  stream({ type: 'message_delta', usage: { output_tokens: 9 } }, 'tool_1')
  stream({ type: 'message_stop' }, 'tool_1')
  now = 200
  stream({ type: 'message_delta', usage: { output_tokens: 25 } })
  stream({ type: 'message_stop' })
  stream({ type: 'message_stop' })
  tracker.observe({ type: 'assistant', message: { id: 'msg_1', stop_reason: 'end_turn', usage: { output_tokens: 25 } } })
  expect(captured).toHaveLength(2)
  expect(captured[1]).toMatchObject({ inputTokens: 130, outputTokens: 25, cacheReadTokens: 100, cacheWriteTokens: 20, ttftMs: 50, latencyMs: 150 })
  expect(captured[0].latencyMs).toBeUndefined()
  expect(JSON.stringify(captured)).not.toContain('private')
  expect(JSON.stringify(captured)).not.toContain('sk-secret')
})

it('uses Codex last-request usage, ignores resume history and deduplicates total replays', () => {
  const captured: GenerationMetrics[] = []
  const tracker = new CodexGenerationMetrics(value => captured.push(value))
  tracker.observe({ total: { inputTokens: 1000, outputTokens: 500 }, last: { inputTokens: 500, outputTokens: 200 } })
  expect(captured).toHaveLength(0)
  tracker.startTurn()
  const first = { total: { inputTokens: 1050, outputTokens: 520 }, last: { inputTokens: 50, outputTokens: 20, cachedInputTokens: 30 } }
  tracker.observe(first, 'gpt-6-luna')
  tracker.observe(first, 'gpt-6-luna')
  tracker.observe({ total: { inputTokens: 1090, outputTokens: 530 }, last: { inputTokens: 40, outputTokens: 10 } }, 'gpt-6-luna')
  tracker.endTurn()
  expect(captured).toHaveLength(2)
  expect(captured[0]).toMatchObject({ inputTokens: 50, outputTokens: 20, cacheReadTokens: 30, timingBasis: 'app_server_usage' })
  for (const generation of captured) {
    expect(generation.latencyMs).toBeUndefined()
    expect(generation.ttftMs).toBeUndefined()
  }
})

it('closes an official aborted Claude response once and leaves final output usage unknown', () => {
  const captured: GenerationMetrics[] = []
  const tracker = new ClaudeGenerationMetrics(value => captured.push(value))
  tracker.observe({ type: 'stream_event', event: { type: 'message_start', message: { id: 'msg_abort', model: 'claude-haiku-5-5',
    usage: { input_tokens: 5, output_tokens: 1, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 } } } })
  const interrupted = { type: 'assistant', aborted: true, message: { id: 'msg_abort', model: 'claude-haiku-5-5', stop_reason: null,
    content: [{ text: 'PRIVATE_PARTIAL' }], usage: { input_tokens: 5, output_tokens: 1 } } }
  tracker.observe(interrupted)
  tracker.observe(interrupted)
  tracker.observe({ type: 'stream_event', event: { type: 'message_stop' } })
  tracker.observe({ type: 'assistant', message: { ...interrupted.message, stop_reason: 'end_turn' } })
  tracker.fail()
  expect(captured).toHaveLength(1)
  expect(captured[0]).toMatchObject({ inputTokens: 10, cacheReadTokens: 3, cacheWriteTokens: 2, outcome: 'error' })
  for (const key of ['outputTokens', 'ttftMs', 'latencyMs', 'totalCostUsd'] as const) expect(captured[0][key]).toBeUndefined()
  expect(JSON.stringify(captured)).not.toContain('PRIVATE')
})

it('accepts only the official aborted boolean without turning ordinary partial assistant blocks into generations', () => {
  const captured: GenerationMetrics[] = []
  const tracker = new ClaudeGenerationMetrics(value => captured.push(value))
  const message = { id: 'msg_no_stream', model: 'claude-haiku-5-5', stop_reason: null, usage: { output_tokens: 1 } }
  for (const aborted of [undefined, false, 'true']) tracker.observe({ type: 'assistant', aborted, message })
  expect(captured).toHaveLength(0)
  tracker.observe({ type: 'assistant', aborted: true, message })
  tracker.fail()
  expect(captured).toHaveLength(1)
  expect(captured[0]).toMatchObject({ model: 'claude-haiku-5-5', outcome: 'error' })
  for (const key of ['inputTokens', 'outputTokens', 'ttftMs', 'latencyMs', 'totalCostUsd'] as const) expect(captured[0][key]).toBeUndefined()
})

it('preserves Codex 0.163 cache writes per request without adding them to inclusive input or inventing unknowns', () => {
  const captured: GenerationMetrics[] = []
  const tracker = new CodexGenerationMetrics(value => captured.push(value))
  tracker.startTurn()
  for (const [index, cacheWriteInputTokens] of [12, 0, undefined, -1].entries()) {
    tracker.observe({ total: { inputTokens: 50 * (index + 1), outputTokens: 10 * (index + 1) },
      last: { inputTokens: 50, outputTokens: 10, cachedInputTokens: 20, cacheWriteInputTokens } }, 'gpt-6-luna')
  }
  tracker.endTurn()
  const events = captured.map(value => generationEvent(value,
    { traceparent: '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01', runId: 'run_1' })!)
  expect(events.map(event => event.properties.$ai_cache_creation_input_tokens)).toEqual([12, 0, undefined, undefined])
  expect(events.map(event => event.properties.$ai_input_tokens)).toEqual([50, 50, 50, 50])
  expect(events.every(event => event.properties.$ai_cache_reporting_exclusive === false)).toBe(true)
})

it('omits unknown/invalid numeric data and content from AI Analytics instead of inventing zeros or costs', () => {
  const event = generationEvent({ harness: 'codex', provider: 'openai', inputTokens: 10, outputTokens: NaN,
    cacheReadTokens: -1, totalCostUsd: Infinity, ttftMs: 50, model: 'https://private.example/secret', prompt: 'private', output: 'private' } as GenerationMetrics,
    { traceparent: '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01', runId: 'run_1' })!
  expect(event.properties.$ai_input_tokens).toBe(10)
  expect(event.properties.$ai_time_to_first_token).toBe(0.05)
  expect(event.properties.$process_person_profile).toBe(false)
  for (const property of ['$ai_output_tokens', '$ai_cache_read_input_tokens', '$ai_total_cost_usd', '$ai_model', 'prompt', 'output']) expect(event.properties).not.toHaveProperty(property)
  expect(JSON.stringify(event)).not.toContain('private')
})
