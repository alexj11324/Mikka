import assert from 'node:assert/strict'
import test from 'node:test'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { timedModelStream, type ModelCallTiming } from './model-call-timing'
import { timedTools, type ToolTiming } from './subscription-workflow-turn'

type Part = { type: string; [key: string]: unknown }
const streamOf = (parts: Part[]) => new ReadableStream<Part>({ start(controller) { for (const part of parts) controller.enqueue(part); controller.close() } })
async function drain(stream: ReadableStream<Part>) { const seen: Part[] = []; for await (const part of stream as unknown as AsyncIterable<Part>) seen.push(part); return seen }
function clock(...times: number[]) { let index = 0; return () => times[Math.min(index++, times.length - 1)] }

test('a model call logs when its first token, first text and end came, its token counts and tool count, never its content', async () => {
  const lines: ModelCallTiming[] = []
  const parts: Part[] = [
    { type: 'stream-start', warnings: [] },
    { type: 'tool-input-start', id: 't1', toolName: 'create_issue' },
    { type: 'tool-call', toolCallId: 't1', toolName: 'create_issue', input: '{"title":"secret plan"}' },
    { type: 'text-delta', id: 'x', delta: '已经派出去了' },
    { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_use' }, usage: { inputTokens: { total: 18_000, cacheRead: 17_500, cacheWrite: 300 }, outputTokens: { total: 120 } } },
  ]
  // Times: tool-input-start, text-delta, end.
  const timed = timedModelStream({ stream: streamOf(parts), request: { body: 'kept' } }, { route: 'subscription', model: 'claude-haiku-5-5', tools: 76, startedAt: 1_000, requestedAt: 1_300, workflowRunId: 'wrun_x', stepId: 'step_1', attempt: 1 }, clock(4_300, 9_300, 9_800), line => lines.push(line))
  assert.deepEqual(timed.request, { body: 'kept' }, 'the rest of the result passes through')
  assert.deepEqual(await drain(timed.stream), parts, 'the stream passes through unchanged')
  assert.deepEqual(lines, [{
    msg: 'model_call_timing', route: 'subscription', model: 'claude-haiku-5-5', workflowRunId: 'wrun_x', stepId: 'step_1', attempt: 1, tools: 76,
    setupMs: 300, firstTokenMs: 3_000, firstTextMs: 8_000, durationMs: 8_500, inputTokens: 18_000, cacheReadTokens: 17_500, cacheWriteTokens: 300, outputTokens: 120, toolCalls: 1, finishReason: 'tool-calls', interrupted: false,
    rawCache: { read: { state: 'missing', tokens: null }, write: { state: 'missing', tokens: null }, creation: { state: 'missing', tokens: null } },
  }])
  assert.doesNotMatch(JSON.stringify(lines), /secret plan|已经派出去了|create_issue/, 'no prompt, reply or tool content')
})

test('a call with no text and a failing stream still logs once, marked interrupted, and the error reaches the caller', async () => {
  const lines: ModelCallTiming[] = []
  const failing = new ReadableStream<Part>({ pull() { throw new Error('upstream reset') } })
  const timed = timedModelStream({ stream: failing }, { route: 'hosted', model: 'm', tools: 0, startedAt: 0, requestedAt: 10 }, clock(50), line => lines.push(line))
  await assert.rejects(drain(timed.stream), /upstream reset/)
  assert.equal(lines.length, 1)
  assert.deepEqual([lines[0].interrupted, lines[0].firstTokenMs, lines[0].firstTextMs, lines[0].inputTokens, lines[0].cacheReadTokens, lines[0].cacheWriteTokens, lines[0].workflowRunId], [true, null, null, null, null, null, null])
  const silent = timedModelStream({ stream: streamOf([{ type: 'finish', usage: {} }]) }, { route: 'hosted', model: 'm', tools: 0, startedAt: 0, requestedAt: 0 }, clock(5), () => { throw new Error('log sink down') })
  assert.equal((await drain(silent.stream)).length, 1, 'a failing log never fails the call')
})

test('each tool call is timed by name, failures included, and its result is unchanged', async () => {
  const timings: ToolTiming[] = []
  const tools = timedTools({
    dispatch_run: { description: 'd', inputSchema: undefined as never, execute: async (input: { repo: string }) => ({ runId: `run-${input.repo}` }) },
    broken: { description: 'b', inputSchema: undefined as never, execute: async () => { throw new Error('tool failed') } },
    schema_only: { description: 's', inputSchema: undefined as never },
  } as never, timings, clock(100, 2_600, 3_000, 3_400))
  const options = { toolCallId: 'c', messages: [] } as never
  assert.deepEqual(await tools.dispatch_run.execute!({ repo: 'Mikka_test' }, options), { runId: 'run-Mikka_test' })
  await assert.rejects(tools.broken.execute!({}, options), /tool failed/)
  assert.equal(tools.schema_only.execute, undefined, 'a tool without execute is left as it is')
  assert.deepEqual(timings, [{ tool: 'dispatch_run', ms: 2_500, failed: false }, { tool: 'broken', ms: 400, failed: true }])
})

test('the cacheable prefix is logged as short hashes of the tools and each system message, never their text', async () => {
  const { promptPrefix } = await import('./model-call-timing')
  const tools = [{ type: 'function', name: 'create_issue', description: 'secret tool text', inputSchema: {} }]
  const one = await promptPrefix([{ role: 'system', content: 'RULES secret' }, { role: 'system', content: 'memory: today' }, { role: 'user', content: 'hi' }], tools)
  const two = await promptPrefix([{ role: 'system', content: 'RULES secret' }, { role: 'system', content: 'memory: tomorrow' }, { role: 'user', content: 'again' }], tools)
  assert.equal(one.tools, two.tools)
  assert.equal(one.system[0], two.system[0], 'the stable rules hash the same')
  assert.notEqual(one.system[1], two.system[1], 'the part that changed is the one that differs')
  assert.match(one.tools, /^[0-9a-f]{12}$/)
  assert.doesNotMatch(JSON.stringify([one, two]), /secret|memory|create_issue/)
  const lines: ModelCallTiming[] = []
  await drain(timedModelStream({ stream: streamOf([{ type: 'finish', usage: {} }]) }, { route: 'subscription', model: 'm', tools: 1, startedAt: 0, requestedAt: 0, prefix: one }, clock(1), line => lines.push(line)).stream)
  assert.deepEqual(lines[0].prefix, one)
})

test('the actual compatible SDK timing distinguishes missing, null, zero and positive raw cache counts', async t => {
  for (const sample of [
    { name: 'missing', details: undefined, normalized: 0, read: { state: 'missing', tokens: null } },
    { name: 'null', details: { cached_tokens: null }, normalized: 0, read: { state: 'null', tokens: null } },
    { name: 'zero', details: { cached_tokens: 0 }, normalized: 0, read: { state: 'number', tokens: 0 } },
    { name: 'positive', details: { cached_tokens: 3072 }, normalized: 3072, read: { state: 'number', tokens: 3072 } },
  ]) {
    await t.test(sample.name, async () => {
      let requests = 0
      const model = createOpenAICompatible({ name: 'fixture', baseURL: 'https://fixture.invalid/v1', fetch: async () => {
        requests++
        const chunk = { id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'gpt-6-luna', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: {
          prompt_tokens: 4096, completion_tokens: 1, total_tokens: 4097,
          ...(sample.details === undefined ? {} : { prompt_tokens_details: { ...sample.details, cache_write_tokens: 0, cached_creation_tokens: 17, private_field: 'synthetic-private-usage' } }),
          private_field: 'synthetic-private-usage',
        } }
        return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } })
      } })('gpt-6-luna')
      const result = await model.doStream({ prompt: [{ role: 'user', content: [{ type: 'text', text: 'synthetic-private-prompt' }] }] })
      const logs: ModelCallTiming[] = []
      const timed = timedModelStream(result, { route: 'subscription', model: 'gpt-6-luna', tools: 0, startedAt: 0, requestedAt: 1 }, () => 5, line => logs.push(line))
      for await (const part of timed.stream) assert.notEqual(part.type, 'error')
      assert.equal(requests, 1, 'only the injected in-memory transport is called')
      assert.equal(logs.length, 1)
      assert.equal(logs[0].cacheReadTokens, sample.normalized, 'the existing SDK count keeps its original meaning')
      assert.equal(logs[0].cacheWriteTokens, null, 'a new diagnostic does not invent the SDK normalized write count')
      assert.deepEqual(logs[0].rawCache, {
        read: sample.read,
        write: sample.details === undefined ? { state: 'missing', tokens: null } : { state: 'number', tokens: 0 },
        creation: sample.details === undefined ? { state: 'missing', tokens: null } : { state: 'number', tokens: 17 },
      }, 'raw_cache_field_presence_not_reported')
      assert.doesNotMatch(JSON.stringify(logs), /synthetic-private|private_field|prompt_tokens_details/)
    })
  }
})

test('raw cache diagnostics reject malformed counts and read only own whitelisted fields', async () => {
  for (const invalid of [undefined, 'synthetic-private', {}, [], -1, 0.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    const logs: ModelCallTiming[] = []
    const parts = [{ type: 'finish', usage: { inputTokens: { cacheRead: 88 }, raw: {
      prompt_tokens_details: { cached_tokens: invalid, cache_write_tokens: null, cached_creation_tokens: 0, unknown: 'synthetic-private' },
    } } }]
    await drain(timedModelStream({ stream: streamOf(parts) }, { route: 'subscription', model: 'fixture', tools: 0, startedAt: 0, requestedAt: 1 }, () => 5, line => logs.push(line)).stream)
    assert.equal(logs[0].cacheReadTokens, 88)
    assert.deepEqual(logs[0].rawCache, { read: { state: 'invalid', tokens: null }, write: { state: 'null', tokens: null }, creation: { state: 'number', tokens: 0 } })
    assert.doesNotMatch(JSON.stringify(logs), /synthetic-private|unknown/)
  }
  const logs: ModelCallTiming[] = []
  await drain(timedModelStream({ stream: streamOf([{ type: 'finish', usage: { raw: { prompt_tokens_details: Object.create({ cached_tokens: 99 }) } } }]) }, { route: 'subscription', model: 'fixture', tools: 0, startedAt: 0, requestedAt: 1 }, () => 5, line => logs.push(line)).stream)
  assert.deepEqual(logs[0].rawCache.read, { state: 'missing', tokens: null }, 'inherited properties are not provider fields')
})
