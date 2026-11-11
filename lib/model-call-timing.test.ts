import assert from 'node:assert/strict'
import test from 'node:test'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { timedModelStream, type ModelCallTiming } from './model-call-timing'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TestContext } from 'node:test'
import { SubscriptionWorkerClient } from '../packages/daemon/src/subscription-worker-client'
import { SubscriptionCallTiming, withSubscriptionTiming } from '../packages/daemon/src/subscription-worker-timing'

type Part = { type: string; [key: string]: unknown }

// A real child/line transport, with in-memory provider SSE and no network/DB.
function timingWorker(t: TestContext, mode: 'valid' | 'missing' | 'invalid' | 'wrong_id' | 'oversize' | 'refused' = 'valid', resolveIdentity?: ConstructorParameters<typeof SubscriptionWorkerClient>[2], streamIdentity?: ConstructorParameters<typeof SubscriptionWorkerClient>[3], transportTiming?: unknown) {
  const dir = mkdtempSync(join(tmpdir(), 'mikka-stage-timing-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const script = join(dir, 'worker.mjs')
  writeFileSync(script, `import {createInterface} from 'node:readline'
let config;const lines=createInterface({input:process.stdin});lines.on('line',line=>{
const frame=JSON.parse(line);if(!config){config=frame;return}
const mode=${JSON.stringify(mode)};const id=mode==='wrong_id'?'different-id':frame.id;
const timing=mode==='invalid'?{version:1,token:'fixture-private-token'}:{version:1,rpcBodyMs:7,authorizeMs:2,readCalls:1,readMs:1,accessReadBackend:'snapshot'};
const diagnostic=mode==='missing'?{}:{timing};
if(frame.method==='executeStream'&&${JSON.stringify(transportTiming)}!==undefined)diagnostic.transportTiming=${JSON.stringify(transportTiming)};
if(mode==='oversize'){console.log(JSON.stringify({id,result:'x'.repeat(262145),...diagnostic}));return}
if(mode==='refused'){console.log(JSON.stringify({id,error:'reconnect_required',result:{mustNotWin:true},...diagnostic}));return}
if(frame.method==='executeStream'){
const chunk={id:'synthetic',object:'chat.completion.chunk',created:1,model:'fixture-model',choices:[{index:0,delta:{content:'fixture-private-text'},finish_reason:null}]};
console.log(JSON.stringify({id,chunk:'data: '+JSON.stringify(chunk)+'\\n\\n'}));
const finish={...chunk,choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:2,total_tokens:12}};
console.log(JSON.stringify({id,chunk:'data: '+JSON.stringify(finish)+'\\n\\ndata: [DONE]\\n\\n'}));
}
console.log(JSON.stringify({id,result:{done:true},...diagnostic}));lines.close();
})`)
  return new SubscriptionWorkerClient({ binary: process.execPath, args: [script] }, {
    scope: { ownerId: 'fixture-private-owner', workspaceId: 'fixture-private-workspace', connectionId: '00000000-0000-4000-8000-000000000001', provider: 'codex' },
    databaseUrl: 'synthetic', infisicalOrigin: 'https://fixture.invalid', project: 'fixture-private-project', environment: 'test', path: '/fixture-private', workloadToken: 'fixture-private-custody', accessToken: 'fixture-private-access', accessPath: '/access',
  }, resolveIdentity, streamIdentity)
}
const streamOf = (parts: Part[]) => new ReadableStream<Part>({ start(controller) { for (const part of parts) controller.enqueue(part); controller.close() } })
async function drain<P extends { type: string }>(stream: ReadableStream<P>) { const seen: P[] = []; for await (const part of stream as unknown as AsyncIterable<P>) seen.push(part); return seen }
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

test('provider error parts mark timing interrupted and malformed counts or finish text are not logged', async () => {
  const lines: ModelCallTiming[] = []
  await drain(timedModelStream({ stream: streamOf([
    { type: 'error', error: new Error('private upstream response') },
    { type: 'finish', usage: { inputTokens: { total: NaN, cacheRead: -1, cacheWrite: Infinity }, outputTokens: -2 }, finishReason: { unified: 'private upstream response' } },
  ]) }, { route: 'hosted', model: 'm', tools: 0, startedAt: 0, requestedAt: 0 }, () => 5, line => lines.push(line)).stream)
  assert.equal(lines.length, 1)
  assert.equal(lines[0].interrupted, true)
  assert.deepEqual([lines[0].inputTokens, lines[0].cacheReadTokens, lines[0].cacheWriteTokens, lines[0].outputTokens, lines[0].finishReason], [null, null, null, null, null])
  assert.doesNotMatch(JSON.stringify(lines), /private upstream/)
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

test('real worker terminal diagnostics arrive before the compatible SDK flush logs one unchanged model result', async t => {
  const call = new SubscriptionCallTiming(), client = timingWorker(t)
  let requests = 0
  const model = createOpenAICompatible({ name: 'fixture', baseURL: 'https://fixture.invalid/v1', fetch: async () => {
    requests++
    return new Response(client.stream(1, 'fixture-model', {}), { headers: { 'content-type': 'text/event-stream' } })
  } })('fixture-model')
  const result = await withSubscriptionTiming(call, () => model.doStream({ prompt: [{ role: 'user', content: [{ type: 'text', text: 'fixture-private-prompt' }] }] }))
  const logs: ModelCallTiming[] = []
  // Consume outside ALS: client callbacks must retain the captured recorder.
  const seen = await drain(timedModelStream(result, { route: 'subscription', model: 'fixture-model', tools: 0, startedAt: 10, requestedAt: 20, subscriptionTiming: call }, () => 40, line => logs.push(line)).stream)
  assert.equal(requests, 1)
  assert.equal(seen.filter(part => part.type === 'text-delta').map(part => part.delta).join(''), 'fixture-private-text')
  assert.equal(seen.filter(part => part.type === 'finish').length, 1)
  assert.equal(logs.length, 1)
  assert.equal(logs[0].interrupted, false)
  assert.equal(logs[0].setupMs, 10)
  assert.equal(logs[0].firstTextMs, 20, 'legacy wall-clock arithmetic is unchanged')
  const stages = logs[0].subscriptionStages!
  assert.deepEqual(stages.workers.map(worker => [worker.ordinal, worker.method, worker.goState, worker.outcome]), [[1, 'prepare', 'reported', 'result'], [2, 'executeStream', 'reported', 'result']])
  assert.equal(stages.workers[1].go?.rpcBodyMs, 7)
  assert.ok(stages.streamEntryMs !== null && stages.firstIpcChunkMs !== null && stages.firstSdkTextMs !== null)
  assert.ok(stages.firstSdkTextMs >= stages.firstIpcChunkMs)
  assert.doesNotMatch(JSON.stringify(logs), /fixture-private|accessToken|workloadToken|databaseUrl|connectionId|different-id/)
})

test('missing or malformed optional worker timing cannot change a result or refusal and never bypasses the original frame guards', async t => {
  for (const mode of ['missing', 'invalid', 'refused', 'wrong_id', 'oversize'] as const) {
    await t.test(mode, async childTest => {
      const call = new SubscriptionCallTiming(), client = timingWorker(childTest, mode)
      const request = withSubscriptionTiming(call, () => client.call('prepare', { revision: 1 }))
      if (mode === 'missing' || mode === 'invalid') assert.deepEqual(await request, { done: true })
      else await assert.rejects(request, mode === 'refused' ? /reconnect_required/ : /subscription_worker_unavailable/)
      const worker = call.snapshot().workers[0]
      assert.equal(worker.goState, mode === 'invalid' ? 'invalid' : mode === 'refused' ? 'reported' : 'missing')
      assert.equal(worker.outcome, mode === 'missing' || mode === 'invalid' ? 'result' : 'error')
      assert.doesNotMatch(JSON.stringify(call.snapshot()), /fixture-private|different-id/)
    })
  }
})

test('cancel during identity preparation logs missing Go immediately and never starts an execution child after late resolution', async t => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<{ workloadToken: string }>()
  const identities: boolean[] = []
  const call = new SubscriptionCallTiming(), client = timingWorker(t, 'valid', executionOnly => {
    identities.push(executionOnly); entered.resolve(); return release.promise
  })
  const body = withSubscriptionTiming(call, () => client.stream(1, 'fixture-model', {}))
  await entered.promise
  const logs: ModelCallTiming[] = []
  const modelStream = new ReadableStream<Part>({ cancel: () => body.cancel() })
  const timed = timedModelStream({ stream: modelStream }, { route: 'subscription', model: 'fixture-model', tools: 0, startedAt: 0, requestedAt: 1, subscriptionTiming: call }, () => 2, line => logs.push(line))
  await timed.stream.cancel('fixture stop')
  assert.equal(logs.length, 1)
  assert.equal(logs[0].interrupted, true)
  assert.equal(logs[0].subscriptionStages!.workers[0].goState, 'missing')
  assert.equal(logs[0].subscriptionStages!.workers[0].outcome, 'pending', 'emit precedes underlying cancellation; do not invent future settlement')
  release.resolve({ workloadToken: 'fixture-private-late' })
  await release.promise
  await Promise.resolve()
  assert.deepEqual(identities, [false])
  assert.equal(call.snapshot().workers.length, 1)
  assert.equal(call.snapshot().workers[0].outcome, 'cancelled')
  assert.equal(call.snapshot().workers[0].identityMs, null)
  assert.equal(logs[0].subscriptionStages!.workers[0].outcome, 'pending', 'the emitted snapshot does not mutate')
})


test('a same-call warm projection produces one real worker row plus separate private-free pre-read timing', async t => {
  const call = new SubscriptionCallTiming()
  const scope = { ownerId: 'fixture-private-owner', workspaceId: 'fixture-private-workspace', connectionId: '00000000-0000-4000-8000-000000000001', provider: 'codex' }
  let reads = 0
  const client = timingWorker(t, 'valid', async () => { throw new Error('warm must not resolve identity twice') }, async () => {
    reads++
    return { accessSnapshot: {
      name: 'mikka-byos-00000000-0000-4000-8000-000000000001',
      value: JSON.stringify({ schema: 1, ...scope, payload: { type: 'codex', access_token: 'fixture-private-token', account_id: 'fixture-private-account', expired: new Date(Date.now() + 3_600_000).toISOString() } }),
    } }
  })
  const model = createOpenAICompatible({ name: 'fixture', baseURL: 'https://fixture.invalid/v1', fetch: async () =>
    new Response(client.stream(1, 'fixture-model', {}), { headers: { 'content-type': 'text/event-stream' } }),
  })('fixture-model')
  const result = await withSubscriptionTiming(call, () => model.doStream({ prompt: [{ role: 'user', content: [{ type: 'text', text: 'fixture-private-prompt' }] }] }))
  const logs: ModelCallTiming[] = []
  const seen = await drain(timedModelStream(result, { route: 'subscription', model: 'fixture-model', tools: 0, startedAt: 10, requestedAt: 20, subscriptionTiming: call }, () => 40, line => logs.push(line)).stream)
  assert.equal(reads, 1)
  assert.equal(seen.filter(part => part.type === 'finish').length, 1)
  assert.equal(logs.length, 1)
  const stages = logs[0].subscriptionStages!
  assert.deepEqual(stages.workers.map(row => [row.ordinal, row.method, row.outcome]), [[1, 'executeStream', 'result']])
  assert.equal(stages.streamPreRead!.outcome, 'ready')
  assert.ok(stages.streamPreRead!.settledMs! <= stages.workers[0].startedMs!)
  assert.equal(stages.workers[0].parentAccessAuthorityCalls, 0)
  assert.equal(stages.workers[0].parentProjectionReadCalls, 0)
  assert.equal(logs[0].firstTextMs, 20)
  assert.equal(logs[0].interrupted, false)
  const encoded = JSON.stringify(logs[0])
  assert.doesNotMatch(encoded, /fixture-private|accessToken|accessSnapshot|workloadToken|databaseUrl|connectionId|mikka-byos/)
  t.diagnostic('warm_model_timing_fixture_bytes=' + Buffer.byteLength(encoded))
})

test('real worker HTTP timing uses a separate bounded log without enlarging the original model receipt', async t => {
  const transport = { version: 1, getConnCalls: 1, dnsCalls: 1, connectCalls: 2, tlsCalls: 1, writeCalls: 1,
    getConnMs: 0, dnsStartMs: 1, dnsDoneMs: 2, connectStartMs: 3, connectDoneMs: 6,
    tlsStartMs: 7, tlsDoneMs: 11, gotConnMs: 12, wroteRequestMs: 13, firstByteMs: 30,
    headersMs: 32, firstEventMs: 34, firstTextMs: 38, reused: false, connectFailed: false }
  for (const [name, value, state] of [
    ['valid', transport, 'reported'], ['legacy', undefined, 'missing'],
    ['invalid', { ...transport, host: 'fixture-private-host' }, 'invalid'],
    ['null', null, 'invalid'],
  ] as const) await t.test(name, async child => {
    const call = new SubscriptionCallTiming(), client = timingWorker(child, 'valid', undefined, undefined, value)
    let requests = 0
    const model = createOpenAICompatible({ name: 'fixture', baseURL: 'https://fixture.invalid/v1', fetch: async () => {
      requests++
      return new Response(client.stream(1, 'fixture-model', {}), { headers: { 'content-type': 'text/event-stream' } })
    } })('fixture-model')
    const result = await withSubscriptionTiming(call, () => model.doStream({ prompt: [{ role: 'user', content: [{ type: 'text', text: 'fixture-private-prompt' }] }] }))
    const original: ModelCallTiming[] = [], diagnostics: Record<string, unknown>[] = []
    const seen = await drain(timedModelStream(result, { route: 'subscription', model: 'fixture-model', tools: 0, startedAt: 10, requestedAt: 20, subscriptionTiming: call, workflowRunId: 'wrun_fixture', stepId: 'step_fixture', attempt: 1 }, () => 40, line => original.push(line), line => diagnostics.push(line)).stream)
    assert.equal(requests, 1)
    assert.equal(seen.filter(part => part.type === 'finish').length, 1)
    assert.equal(original.length, 1)
    assert.equal(original[0].firstTextMs, 20)
    assert.equal(original[0].subscriptionStages!.workers[1].go!.rpcBodyMs, 7)
    assert.doesNotMatch(JSON.stringify(original), /transportTiming|getConnMs|connectCalls/)
    assert.equal(diagnostics.length, 1)
    assert.deepEqual(diagnostics[0], {
      msg: 'subscription_transport_timing', workflowRunId: 'wrun_fixture', stepId: 'step_fixture', attempt: 1,
      workerOrdinal: 2, outcome: 'result', state, ...(state === 'reported' ? transport : {}),
    })
    if (state !== 'reported') assert.equal(Object.hasOwn(diagnostics[0], 'dnsStartMs'), false)
    assert.ok(Buffer.byteLength(JSON.stringify(diagnostics[0])) < 1024)
    assert.doesNotMatch(JSON.stringify(diagnostics), /fixture-private|https?:|Authorization|Bearer|accessToken|requestBody/i)
    for (const key of ['host', 'url', 'headers', 'token', 'body']) assert.equal(Object.hasOwn(diagnostics[0], key), false)
  })
})

test('the complete HTTP log is below one KiB and neither log sink can change the stream', async () => {
  const call = new SubscriptionCallTiming(() => 0), worker = call.startWorker('executeStream')!
  const http: Record<string, unknown> = { version: 1 }
  for (const key of ['getConnMs', 'gotConnMs', 'dnsStartMs', 'dnsDoneMs', 'connectStartMs', 'connectDoneMs', 'tlsStartMs', 'tlsDoneMs', 'wroteRequestMs', 'firstByteMs', 'headersMs', 'firstEventMs', 'firstTextMs']) http[key] = 3_599_999.999
  for (const key of ['getConnCalls', 'dnsCalls', 'connectCalls', 'tlsCalls', 'writeCalls']) http[key] = 1_000_000
  for (const key of ['reused', 'dnsFailed', 'connectFailed', 'tlsFailed', 'writeFailed']) http[key] = false
  worker.terminalTransport(http, true); worker.settle('result')
  const rows: Record<string, unknown>[] = []
  const start = { route: 'subscription' as const, model: 'fixture', tools: 0, startedAt: 0, requestedAt: 0, subscriptionTiming: call,
    workflowRunId: 'wrun_' + 'x'.repeat(123), stepId: 'step_' + 'x'.repeat(123), attempt: 1_000_000 }
  await drain(timedModelStream({ stream: streamOf([{ type: 'finish' }]) }, start, () => 1, () => { throw new Error('old sink failed') }, row => rows.push(row)).stream)
  assert.equal(rows.length, 1)
  assert.ok(Buffer.byteLength(JSON.stringify(rows[0])) < 1024)
  assert.equal(rows[0].firstByteMs, 3_599_999.999)
  const seen = await drain(timedModelStream({ stream: streamOf([{ type: 'text-delta', delta: 'kept' }, { type: 'finish' }]) }, start, () => 1, () => {}, () => { throw new Error('transport sink failed') }).stream)
  assert.equal(seen[0].delta, 'kept')
})
