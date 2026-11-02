import assert from 'node:assert/strict'
import test from 'node:test'
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
