import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { WorkflowAgent, type ModelCallStreamPart } from '@ai-sdk/workflow'
import { MockLanguageModelV4 } from 'ai/test'
import { registerSerializationClass } from 'workflow/internal/class-serialization'
import { fingerprint } from '@/lib/credentials/fingerprint'
import { QUIET_REPLY } from '@/lib/attention/handoff'
import { coordinatorTextStream, type CoordinatorStreamTiming } from './stream-response'
import { ScopedCoordinatorWritable } from './scoped-stream'
import { coordinatorStreamReply, type CoordinatorLiveReply } from '@/tests/support/legacy-coordinator-stream'
import type { CoordinatorStreamEvent, CoordinatorWorkflowStreamPart } from './stream'

const start = (id = 'run:0', quietEligible = false): CoordinatorWorkflowStreamPart => ({ type: 'coordinator-turn-start', id, quietEligible })
const delta = (text: string): ModelCallStreamPart => ({ type: 'text-delta', id: '0', text })
const committed = (id = 'run:0', through = 2, quiet = false): CoordinatorWorkflowStreamPart => ({ type: 'coordinator-turn-committed', id, through, quiet })
const boundary = (type: 'start-step' | 'finish-step') => ({ type }) as unknown as CoordinatorWorkflowStreamPart
const scopedStart = (id = 'run:0', quietEligible = false): CoordinatorWorkflowStreamPart => ({ type: 'coordinator-turn-start', id, quietEligible, modelStream: 'scoped-v1' })
const scopedPart = (id: string, part: ModelCallStreamPart): CoordinatorWorkflowStreamPart => ({ type: 'coordinator-model-part', id, part })
const body = (events: CoordinatorStreamEvent[]) => events.map(event => event.type === 'text' ? event.delta : '').join('')

async function drain(stream: ReadableStream<CoordinatorStreamEvent>, events: CoordinatorStreamEvent[] = []) {
  const reader = stream.getReader()
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) return events
      events.push(next.value)
    }
  } finally { reader.releaseLock() }
}

async function project(parts: CoordinatorWorkflowStreamPart[]) {
  const output = new ReadableStream<CoordinatorWorkflowStreamPart>({ start(controller) { parts.forEach(part => controller.enqueue(part)); controller.close() } })
  return drain(output.pipeThrough(coordinatorTextStream('owner', [])))
}

test('invalid SDK calls and paired errors stay server-side while the corrected reply commits',async()=>{
  const events=await project([start(),
    {type:'tool-call',toolCallId:'bad',toolName:'none',input:{x:'private input'},dynamic:true,invalid:true,error:new Error('private error')} as CoordinatorWorkflowStreamPart,
    {type:'tool-error',toolCallId:'bad',toolName:'none',input:{x:'private input'},dynamic:true,error:'AI_NoSuchToolError: private error'} as CoordinatorWorkflowStreamPart,
    boundary('finish-step'),boundary('start-step'),
    {type:'tool-call',toolCallId:'bad',toolName:'registered',input:{}} as CoordinatorWorkflowStreamPart,
    {type:'tool-result',toolCallId:'bad',toolName:'registered',input:{},output:{ok:true}} as CoordinatorWorkflowStreamPart,
    delta('Corrected reply'),committed(),
  ])
  assert.deepEqual(events.filter(event=>event.type==='tool').map(event=>[event.name,event.state]),[['registered','running'],['registered','done']])
  assert.equal(body(events),'Corrected reply')
  assert.equal(events.at(-1)?.type,'committed')
  assert.doesNotMatch(JSON.stringify(events),/private|NoSuchTool|none/)
})

test('text arrives before the turn commits; model internals never leave the stream', async () => {
  const raw = new TransformStream<CoordinatorWorkflowStreamPart, CoordinatorWorkflowStreamPart>()
  const writer = raw.writable.getWriter()
  const reader = raw.readable.pipeThrough(coordinatorTextStream('owner', [])).getReader()
  const first = reader.read()
  await writer.write(start())
  assert.deepEqual((await first).value, { type: 'start', id: 'run:0' })
  const text = reader.read()
  await writer.write(delta('第一段'))
  assert.deepEqual((await text).value, { type: 'text', id: 'run:0', delta: '第一段' })
  await reader.cancel()
  await assert.rejects(writer.write(committed()))

  const events = await project([start(), { type: 'reasoning-delta', id: 'r', text: 'private reasoning' },
    { type: 'tool-input-delta', id: 't', delta: 'private tool input' }, delta('public'), committed()])
  assert.equal(body(events), 'public')
  assert.equal(JSON.stringify(events).includes('private'), false)
})

test('a scoped stop freezes the live reply at the same boundary as its stored stopped text', async () => {
  const events = await project([start(), delta('Before stop.'),
    { type: 'coordinator-turn-stopped', id: 'run:0' },
    delta(' Late queued tail.'), { type: 'reset-step' }, delta('Late replacement'), committed()])
  assert.equal(body(events), 'Before stop.')
  assert.equal(events.some(event => event.type === 'reset'), false)
  assert.equal(events.at(-1)?.type, 'committed')
})

test('scoped model parts and old control markers cannot change the next round', async () => {
  const scoped = scopedPart
  const events = await project([scopedStart('run:0'), scoped('run:0', delta('First.')),
    { type: 'coordinator-turn-stopped', id: 'run:0' }, scoped('run:0', delta('Late first')), committed(),
    scopedStart('run:1'), scoped('run:1', delta('Second')), scopedStart('run:0'),
    { type: 'coordinator-turn-stopped', id: 'run:0' }, committed(),
    scoped('run:0', { type: 'reset-step' }), scoped('run:0', delta('old tail')),
    delta('unscoped tail'), scoped('run:1', delta(' reply.')), committed('run:1', 4)])
  const texts = (id: string) => events.flatMap(event => event.type === 'text' && event.id === id ? [event.delta] : []).join('')
  assert.equal(texts('run:0'), 'First.')
  assert.equal(texts('run:1'), 'Second reply.')
  assert.deepEqual(events.filter(event => event.type === 'committed').map(event => event.id), ['run:0', 'run:1'])
})

test('the real SDK and step serializer retain turn scope through a revived durable writable', { timeout: 10_000 }, async t => {
  // Resolve the installed transitive core through workflow, as the SDK does. No transport is contacted.
  const workflowRequire = createRequire(createRequire(import.meta.url).resolve('workflow'))
  const coreRequire = createRequire(workflowRequire.resolve('@workflow/core'))
  const { dehydrateStepArguments, hydrateStepArguments, getDeserializeStream } = await import(pathToFileURL(workflowRequire.resolve('@workflow/core/serialization')).href)
  const { SPEC_VERSION_CURRENT } = await import(pathToFileURL(coreRequire.resolve('@workflow/world')).href)
  registerSerializationClass('class//test//ScopedCoordinatorWritable', ScopedCoordinatorWritable)
  const worldKey = Symbol.for('@workflow/world//cache')
  const previousWorld = Reflect.get(globalThis, worldKey)
  const fetch = mock.method(globalThis, 'fetch', async () => { throw new Error('offline_fixture_network_forbidden') })
  t.after(() => { fetch.mock.restore(); if (previousWorld === undefined) Reflect.deleteProperty(globalThis, worldKey); else Reflect.set(globalThis, worldKey, previousWorld) })
  const frames: Uint8Array[] = []
  let closes = 0
  const record = (runId: string, name: string, chunks: Uint8Array[]) => {
    assert.equal(runId, 'wrun_fixture')
    assert.equal(name, 'default')
    frames.push(...chunks.map(chunk => chunk.slice()))
  }
  Reflect.set(globalThis, worldKey, { specVersion: SPEC_VERSION_CURRENT, streams: {
    write: async (runId: string, name: string, chunk: Uint8Array) => record(runId, name, [chunk]),
    writeMulti: async (runId: string, name: string, chunks: Uint8Array[]) => record(runId, name, chunks),
    close: async () => { closes++ },
  } })
  const handle = new WritableStream<CoordinatorWorkflowStreamPart>({ write() { throw new Error('workflow_handle_must_be_revived') } })
  Object.defineProperty(handle, Symbol.for('WORKFLOW_STREAM_NAME'), { value: 'default' })
  const encoded = await dehydrateStepArguments([new ScopedCoordinatorWritable(handle, 'run:0')], 'wrun_fixture', undefined)
  assert.ok(encoded instanceof Uint8Array)
  const ops: Promise<unknown>[] = []
  const [revived] = await hydrateStepArguments(encoded, 'wrun_fixture', undefined, ops) as [ScopedCoordinatorWritable]
  assert.ok(revived instanceof ScopedCoordinatorWritable)
  const controller = new AbortController()
  let modelSignal: AbortSignal | undefined
  const model = new MockLanguageModelV4({ doStream: async options => {
    modelSignal = options.abortSignal
    return { stream: new ReadableStream({ start(output) {
      output.enqueue({ type: 'stream-start', warnings: [] })
      output.enqueue({ type: 'text-start', id: 't' })
      output.enqueue({ type: 'text-delta', id: 't', delta: 'First.' })
      output.enqueue({ type: 'text-delta', id: 't', delta: 'Queued tail.' })
      output.enqueue({ type: 'text-end', id: 't' })
      output.enqueue({ type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: {
        inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 2, text: 2, reasoning: 0 },
      } })
      output.close()
    } }) }
  } })
  await new WorkflowAgent({ model }).stream({ messages: [{ role: 'user', content: 'synthetic fixture' }], writable: revived,
    preventClose: true, maxRetries: 0, abortSignal: controller.signal })
  await Promise.all(ops)
  assert.equal(modelSignal, controller.signal)
  assert.equal(revived.locked, false)
  assert.equal(closes, 0, 'preventClose preserves the shared durable stream for control markers and later rounds')
  assert.equal(fetch.mock.callCount(), 0)
  const bytes = new ReadableStream<Uint8Array>({ start(output) { frames.forEach(frame => output.enqueue(frame)); output.close() } })
  const sdkParts: CoordinatorWorkflowStreamPart[] = []
  for await (const part of bytes.pipeThrough(getDeserializeStream({}, undefined))) sdkParts.push(part as CoordinatorWorkflowStreamPart)
  assert.ok(sdkParts.length >= 4)
  assert.ok(sdkParts.every(part => part.type === 'coordinator-model-part' && part.id === 'run:0'))
  assert.ok(sdkParts.some(part => part.type === 'coordinator-model-part' && part.part.type === 'reset-step'))
  assert.ok(sdkParts.some(part => part.type === 'coordinator-model-part' && (part.part.type as string) === 'finish'))
  const first = sdkParts.findIndex(part => part.type === 'coordinator-model-part' && part.part.type === 'text-delta')
  assert.ok(first >= 0)
  // Another durable step can publish Stop and the next turn before the model writer's accepted tail drains.
  const events = await project([scopedStart(), ...sdkParts.slice(0, first + 1),
    { type: 'coordinator-turn-stopped', id: 'run:0' }, committed(), scopedStart('run:1'),
    scopedPart('run:1', delta('Next.')), ...sdkParts.slice(first + 1), committed('run:1', 4)])
  assert.equal(body(events), 'First.Next.')
  assert.deepEqual(events.filter(event => event.type === 'committed').map(event => event.id), ['run:0', 'run:1'])
})

test('the scoped writer preserves real backpressure, lock, error, abort and close behavior', async () => {
  const accepted: CoordinatorWorkflowStreamPart[] = []
  const blocked = Promise.withResolvers<void>()
  let closed = 0
  const raw = new WritableStream<CoordinatorWorkflowStreamPart>({
    async write(part) { accepted.push(part); await blocked.promise }, close() { closed++ },
  })
  const scoped = new ScopedCoordinatorWritable(raw, 'run:7')
  const writer = scoped.getWriter()
  assert.equal(scoped.locked, true)
  assert.throws(() => scoped.getWriter(), TypeError)
  let settled = false
  const pending = writer.write(delta('safe')).then(() => { settled = true })
  await Promise.resolve()
  assert.equal(settled, false)
  assert.equal(writer.desiredSize, 0)
  blocked.resolve()
  await pending
  await writer.ready
  assert.deepEqual(accepted, [scopedPart('run:7', delta('safe'))])
  writer.releaseLock()
  assert.equal(scoped.locked, false)
  await scoped.close()
  assert.equal(closed, 1)
  const reason = new Error('synthetic write failure')
  let aborted: unknown
  const abortable = new ScopedCoordinatorWritable(new WritableStream({ abort(value) { aborted = value } }), 'run:8')
  const abortWriter = abortable.getWriter()
  const rejectedClosed = assert.rejects(abortWriter.closed, error => error === reason)
  await abortWriter.abort(reason)
  await rejectedClosed
  assert.equal(aborted, reason)
  abortWriter.releaseLock()
  const failed = new ScopedCoordinatorWritable(new WritableStream({ write() { throw reason } }), 'run:9').getWriter()
  const failedClosed = assert.rejects(failed.closed, error => error === reason)
  await assert.rejects(failed.write(delta('safe')), error => error === reason)
  await failedClosed
  failed.releaseLock()
})

test('Stop does not depend on a cooperative SDK model stream to discard the late tail', async t => {
  const controller = new AbortController()
  const raw: CoordinatorWorkflowStreamPart[] = [scopedStart()]
  const fetch = mock.method(globalThis, 'fetch', async () => { throw new Error('offline_fixture_network_forbidden') })
  t.after(() => fetch.mock.restore())
  const writable = new ScopedCoordinatorWritable(new WritableStream<CoordinatorWorkflowStreamPart>({ write(part) {
    raw.push(part)
    if (part.type === 'coordinator-model-part' && part.part.type === 'text-delta' && part.part.text === 'Before.') {
      raw.push({ type: 'coordinator-turn-stopped', id: 'run:0' })
      controller.abort()
    }
  } }), 'run:0')
  let passedSignal: AbortSignal | undefined
  const model = new MockLanguageModelV4({ doStream: async options => {
    passedSignal = options.abortSignal
    return { stream: new ReadableStream({ start(output) {
      output.enqueue({ type: 'stream-start', warnings: [] })
      output.enqueue({ type: 'text-start', id: 't' })
      output.enqueue({ type: 'text-delta', id: 't', delta: 'Before.' })
      output.enqueue({ type: 'text-delta', id: 't', delta: 'Accepted late.' })
      output.enqueue({ type: 'text-end', id: 't' })
      output.enqueue({ type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: {
        inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 2, text: 2, reasoning: 0 },
      } })
      output.close()
    } }) }
  } })
  await new WorkflowAgent({ model }).stream({ messages: [{ role: 'user', content: 'synthetic fixture' }], writable,
    preventClose: true, maxRetries: 0, abortSignal: controller.signal })
  assert.equal(passedSignal, controller.signal)
  assert.equal(passedSignal.aborted, true)
  assert.ok(raw.some(part => part.type === 'coordinator-model-part' && part.part.type === 'text-delta' && part.part.text === 'Accepted late.'))
  assert.equal(body(await project([...raw, committed()])), 'Before.')
  const { stoppedStepText } = await import('./stop')
  assert.equal(await stoppedStepText(new ReadableStream({ start(output) { raw.forEach(part => output.enqueue(part)); output.close() } }), 'run:0'), 'Before.')
  assert.equal(fetch.mock.callCount(), 0)
})

test('scoped output preserves all 63 secret splits and Unicode secret checks before release', async () => {
  const old = process.env.BETTER_AUTH_SECRET
  process.env.BETTER_AUTH_SECRET = 'offline-stream-guard-fixture-secret'
  try {
    const secret = '0123456789abcdef'.repeat(4)
    const prefix = 'Safe intro. '
    for (const value of [secret, '凭证🔒秘密字段不可输出🔑']) {
      const fingerprints = [fingerprint('owner', value)]
      for (let split = 1; split < value.length; split++) {
        const events: CoordinatorStreamEvent[] = []
        const raw = new ReadableStream<CoordinatorWorkflowStreamPart>({ start(output) {
          for (const part of [scopedStart(), scopedPart('run:0', delta(prefix + value.slice(0, split))),
            scopedPart('run:0', delta(value.slice(split))), committed()]) output.enqueue(part)
          output.close()
        } })
        await assert.rejects(drain(raw.pipeThrough(coordinatorTextStream('owner', fingerprints)), events))
        assert.equal(body(events), prefix.slice(0, Math.max(0, prefix.length + split - (value.length - 1))))
        assert.equal(events.some(event => event.type === 'committed'), false)
      }
    }
  } finally { if (old === undefined) delete process.env.BETTER_AUTH_SECRET; else process.env.BETTER_AUTH_SECRET = old }
})

test('scoped retry resets and quiet turns keep the existing text guard and sentinel behavior', async () => {
  const events = await project([scopedStart(), scopedPart('run:0', delta('旧的回答🔒')), scopedPart('run:0', { type: 'reset-step' }),
    scopedPart('run:0', delta('新的回答🌍')), committed(), scopedStart('run:1', true),
    scopedPart('run:1', delta(QUIET_REPLY.slice(0, 5))), scopedPart('run:1', delta(QUIET_REPLY.slice(5))), committed('run:1', 4, true)])
  let replies: CoordinatorLiveReply[] = []
  for (const event of events) if (event.type !== 'committed') replies = coordinatorStreamReply(replies, event)
  assert.equal(replies[0].text, '新的回答🌍')
  assert.equal(events.some(event => event.type === 'text' && event.id === 'run:1'), false)
  assert.equal(events.some(event => event.type === 'reset' && event.text === ''), true)
  assert.equal(JSON.stringify(events).includes(QUIET_REPLY), false)
})

test('projection timing separates holdback from quiet and records only local numeric observations', async () => {
  const old = process.env.BETTER_AUTH_SECRET
  process.env.BETTER_AUTH_SECRET = 'offline-stream-guard-fixture-secret'
  try {
    const saved = fingerprint('owner', 'synthetic-guard-value-'.repeat(4))
    for (const scenario of ['held', 'immediate', 'quiet'] as const) {
      let time = 100
      const samples: CoordinatorStreamTiming[] = []
      const projection = coordinatorTextStream('owner', scenario === 'immediate' ? [] : [saved], { now: () => time, onTiming: sample => { samples.push(sample) } })
      const events = drain(projection.readable)
      const writer = projection.writable.getWriter()
      await writer.write(scopedStart('run:0', scenario === 'quiet'))
      time = 105
      await writer.write(scopedPart('run:0', delta(scenario === 'quiet' ? QUIET_REPLY : '短回复🌍')))
      time = 120
      // Even a scoped SDK finish does not certify a successful persisted turn.
      await writer.write(scopedPart('run:0', { type: 'finish' } as unknown as ModelCallStreamPart))
      time = 140
      await writer.write(committed('run:0', 2, scenario === 'quiet'))
      await writer.close()
      projection.reportTerminal(4)
      const output = await events
      assert.equal(samples.length, 1)
      assert.deepEqual(samples[0], { streamId: 'run:0', fingerprintCount: scenario === 'immediate' ? 0 : 1,
        maxHoldback: scenario === 'immediate' ? 0 : saved.length - 1, firstRawTextMs: 5,
        firstEmittedTextMs: scenario === 'quiet' ? null : scenario === 'held' ? 40 : 5,
        committedMs: 40, firstEmittedAtCommitted: scenario === 'held' ? 1 : 0,
        firstBlockedByHoldback: scenario === 'held' ? 1 : 0, quietEligible: scenario === 'quiet' ? 1 : 0, stopped: 0, terminal: 0 })
      assert.equal(body(output), scenario === 'quiet' ? '' : '短回复🌍')
      assert.ok(Object.entries(samples[0]).every(([key, value]) => key === 'streamId' || value === null || typeof value === 'number'))
      assert.equal(JSON.stringify(samples).includes(saved.digest), false)
    }
  } finally { if (old === undefined) delete process.env.BETTER_AUTH_SECRET; else process.env.BETTER_AUTH_SECRET = old }
})

test('projection diagnostics finalize once for EOF, cancellation, supersession and guard errors', async () => {
  const old = process.env.BETTER_AUTH_SECRET
  process.env.BETTER_AUTH_SECRET = 'offline-stream-guard-fixture-secret'
  try {
    const secret = 'synthetic-saved-value'
    for (const terminal of [1, 2, 3, 4] as const) {
      const samples: CoordinatorStreamTiming[] = []
      const projection = coordinatorTextStream('owner', [fingerprint('owner', secret)], { now: () => 1, onTiming: sample => { samples.push(sample); throw new Error('synthetic diagnostic failure') } })
      const reading = drain(projection.readable)
      // Register the failure handler before writing the part rejected by the credential guard.
      const observed = terminal === 2 ? assert.rejects(reading) : reading
      const writer = projection.writable.getWriter()
      await writer.write(scopedStart())
      if (terminal === 2) await assert.rejects(writer.write(scopedPart('run:0', delta(secret))))
      else {
        if (terminal === 3) await writer.write(scopedStart('run:1'))
        if (terminal === 4) projection.reportTerminal(4)
        await writer.close()
      }
      await observed
      projection.reportTerminal(4)
      assert.equal(samples[0].terminal, terminal)
      assert.equal(samples.filter(sample => sample.streamId === 'run:0').length, 1)
      assert.equal(samples[0].firstEmittedTextMs, null)
      assert.equal(samples[0].committedMs, null)
    }
  } finally { if (old === undefined) delete process.env.BETTER_AUTH_SECRET; else process.env.BETTER_AUTH_SECRET = old }
})

test('tool-backed steps concatenate; a retried step replaces only its partial attempt', async () => {
  const events = await project([start(), { type: 'reset-step' }, delta('first'), boundary('finish-step'), boundary('start-step'),
    { type: 'reset-step' }, delta('wrong'), { type: 'reset-step' }, delta('second'), committed(), start('run:1'), delta('next turn'), committed('run:1', 4)])
  let visible = ''
  for (const event of events) {
    if (event.type === 'start') visible = ''
    if (event.type === 'text') visible += event.delta
    if (event.type === 'reset') visible = event.text
    if (event.type === 'committed') assert.equal(visible, event.id === 'run:0' ? 'first\n\nsecond' : 'next turn')
  }
  assert.ok(events.some(event => event.type === 'reset' && event.text === 'first'))
})

test('a quiet handoff sentinel is never flashed, while an actual notification streams', async () => {
  const events = await project([start('quiet', true), delta(QUIET_REPLY.slice(0, 3)), delta(QUIET_REPLY.slice(3)), committed('quiet', 1, true),
    start('notify', true), delta('Something arrived'), committed('notify', 2)])
  assert.equal(body(events), 'Something arrived')
  const multiStep = await project([start('quiet', true), delta('Checking the matter.'), boundary('finish-step'), boundary('start-step'),
    { type: 'reset-step' }, delta(QUIET_REPLY.slice(0, 3)), delta(QUIET_REPLY.slice(3)), committed('quiet', 3, true)])
  assert.equal(body(multiStep), 'Checking the matter.')
})

test('split saved secrets are blocked before any secret character reaches the browser', async () => {
  const old = process.env.BETTER_AUTH_SECRET
  process.env.BETTER_AUTH_SECRET = 'offline-stream-guard-fixture-secret'
  try {
    const secret = 'synthetic-password'
    const fingerprints = [fingerprint('owner', secret)]
    const raw = new ReadableStream<CoordinatorWorkflowStreamPart>({ start(controller) {
      controller.enqueue(start())
      controller.enqueue(delta('safe '.repeat(10) + secret.slice(0, 8)))
      controller.enqueue(delta(secret.slice(8)))
      controller.close()
    } })
    const seen: CoordinatorStreamEvent[] = []
    await assert.rejects(drain(raw.pipeThrough(coordinatorTextStream('owner', fingerprints)), seen), { code: 'credential_secret_detected' })
    assert.ok(body(seen).length > 0)
    assert.equal(body(seen), ('safe '.repeat(10)).slice(0, body(seen).length))

    const safe = new ReadableStream<CoordinatorWorkflowStreamPart>({ start(controller) {
      controller.enqueue(start()); controller.enqueue(delta('short safe reply')); controller.enqueue(committed()); controller.close()
    } })
    const safeEvents = await drain(safe.pipeThrough(coordinatorTextStream('owner', fingerprints)))
    assert.equal(body(safeEvents), 'short safe reply')
  } finally {
    if (old === undefined) delete process.env.BETTER_AUTH_SECRET
    else process.env.BETTER_AUTH_SECRET = old
  }
})

const call = (toolCallId: string, toolName: string, input: unknown) => ({ type: 'tool-call', toolCallId, toolName, input }) as unknown as CoordinatorWorkflowStreamPart
const result = (toolCallId: string, toolName: string, output: unknown) => ({ type: 'tool-result', toolCallId, toolName, input: {}, output }) as unknown as CoordinatorWorkflowStreamPart
const failure = (toolCallId: string, toolName: string) => ({ type: 'tool-error', toolCallId, toolName, input: {}, error: 'private failure detail' }) as unknown as CoordinatorWorkflowStreamPart
const reasoning = (type: 'reasoning-start' | 'reasoning-end') => ({ type, id: 'r' }) as unknown as CoordinatorWorkflowStreamPart

test('each tool streams its name, state and short previews; thinking streams as it goes', async () => {
  const events = await project([start(), reasoning('reasoning-start'), { type: 'reasoning-delta', id: 'r', text: 'private reasoning' } as CoordinatorWorkflowStreamPart, reasoning('reasoning-end'),
    call('c1', 'create_issue', { title: 'Fix login', body: 'x'.repeat(400) }), result('c1', 'create_issue', { id: 'i1' }),
    call('c2', 'record_attention', { level: 'high' }), result('c2', 'record_attention', {}),
    call('c3', 'dispatch_run', { issueId: 'i1' }), failure('c3', 'dispatch_run'), delta('Done.'), committed()])
  // Deltas as the masker releases them: a token-shaped end ("…g" could start "ghp_") waits for the next piece.
  const thought = events.flatMap(event => event.type === 'thinking' && event.state === 'delta' ? [event.text] : []).join('')
  assert.equal(thought, 'private reasoning', 'readable reasoning streams as it is thought')
  const steps = events.filter(event => event.type === 'tool' || (event.type === 'thinking' && event.state !== 'delta'))
  assert.deepEqual(steps.map(event => event.type === 'tool' ? [event.call, event.name, event.state] : [event.type, event.state]), [
    ['thinking', 'start'], ['thinking', 'end'], ['c1', 'create_issue', 'running'], ['c1', 'create_issue', 'done'], ['c3', 'dispatch_run', 'running'], ['c3', 'dispatch_run', 'error'],
  ], 'a hidden tool never shows')
  const created = steps[2] as Extract<CoordinatorStreamEvent, { type: 'tool' }>
  assert.equal(created.input?.length, 200, 'the input preview is as short as the stored one')
  assert.ok(created.input?.startsWith('{"body": "xxx'), 'printed as the stored chat prints jsonb: keys in its order, ", " and ": "')
  assert.equal((steps[3] as Extract<CoordinatorStreamEvent, { type: 'tool' }>).output, '{"id": "i1"}')
  assert.equal(JSON.stringify(events).includes('private failure detail'), false, 'tool error details stay on the server')
  assert.ok(events.findIndex(event => event.type === 'thinking' && event.state === 'delta') < events.findIndex(event => event.type === 'thinking' && event.state === 'end'))
})

test('a call\'s note streams whole as its quote, apart from the cut input preview; past 1000 characters it ends in an ellipsis', async () => {
  const note = 'Upgrade axios and run the tests. '.repeat(10).trim()
  const events = await project([start(), call('c1', 'dispatch_run', { issueId: 'i1', botId: 'b1', note }), call('c2', 'dispatch_run', { note: 'x'.repeat(1200) }), committed()])
  const tools = events.filter((event): event is Extract<CoordinatorStreamEvent, { type: 'tool' }> => event.type === 'tool')
  assert.ok(tools[0].input?.startsWith('{"note": ') && tools[0].input.length === 200, 'jsonb puts the note first, and the preview cuts it')
  assert.equal(tools[0].quote, note, 'the quote carries it whole')
  assert.equal(tools[1].quote, `${'x'.repeat(1000)}…`)
})

test('a saved secret straddling the quote\'s cut leaves none of itself: the note is checked whole first', async () => {
  const old = process.env.BETTER_AUTH_SECRET
  process.env.BETTER_AUTH_SECRET = 'offline-stream-guard-fixture-secret'
  try {
    const secret = 'synthetic-straddling-value'
    const note = `${'a'.repeat(990)} ${secret} tail`
    const raw = new ReadableStream<CoordinatorWorkflowStreamPart>({ start(controller) { controller.enqueue(start()); controller.enqueue(call('c1', 'dispatch_run', { note })); controller.close() } })
    const events = await drain(raw.pipeThrough(coordinatorTextStream('owner', [fingerprint('owner', secret)])))
    const tool = events.find((event): event is Extract<CoordinatorStreamEvent, { type: 'tool' }> => event.type === 'tool')
    assert.equal(tool?.quote, undefined, 'the quote is left out')
    assert.equal(JSON.stringify(events).includes('synthetic-st'), false, 'not even the secret\'s start')
  } finally {
    if (old === undefined) delete process.env.BETTER_AUTH_SECRET
    else process.env.BETTER_AUTH_SECRET = old
  }
})

test('a tool call names how much of the reply was said before it, held back or not, so it shows after those words', async () => {
  const events = await project([start(), delta('I will make the task first.'), call('c1', 'create_issue', {}), result('c1', 'create_issue', {}), delta('Done.'), committed()])
  const tools = events.filter((event): event is Extract<CoordinatorStreamEvent, { type: 'tool' }> => event.type === 'tool')
  assert.deepEqual(tools.map(tool => tool.at), ['I will make the task first.'.length, undefined], 'the call carries it; its result keeps the call\'s place')
})

const reasoningDelta = (text: string) => ({ type: 'reasoning-delta', id: 'r', text }) as unknown as CoordinatorWorkflowStreamPart

test('reasoning streams masked as it goes: no credential or saved secret, whole or in part, ever leaves; encrypted or empty reasoning streams no text', async () => {
  const old = process.env.BETTER_AUTH_SECRET
  process.env.BETTER_AUTH_SECRET = 'offline-stream-guard-fixture-secret'
  try {
    const secret = 'synthetic-password-value'
    const token = 'ghp_' + 'B'.repeat(36)
    const run = async (parts: CoordinatorWorkflowStreamPart[]) => {
      const raw = new ReadableStream<CoordinatorWorkflowStreamPart>({ start(controller) { [start(), ...parts].forEach(part => controller.enqueue(part)); controller.close() } })
      return (await drain(raw.pipeThrough(coordinatorTextStream('owner', [fingerprint('owner', secret)])))).filter(event => event.type === 'thinking')
    }
    const streamed = (events: CoordinatorStreamEvent[]) => events.flatMap(event => event.type === 'thinking' && event.state === 'delta' ? [event.text] : []).join('')
    // A credential split over deltas is held back while it grows and masked whole; no part of it streams.
    const split = await run([reasoning('reasoning-start'), reasoningDelta(`use ${token.slice(0, 10)}`), reasoningDelta(`${token.slice(10)} to call GitHub`), reasoning('reasoning-end')])
    assert.match(streamed(split), /^use \[secret:github-token\] to call GitHub$/)
    assert.equal(JSON.stringify(split).includes(token.slice(0, 4)), false, 'not even its first characters stream')
    // Words before a credential stream before it ends.
    const early = await run([reasoning('reasoning-start'), reasoningDelta('first I check the logs, '), reasoningDelta('then ghp_'), reasoningDelta(`${'C'.repeat(36)} done`), reasoning('reasoning-end')])
    assert.equal(streamed(early), 'first I check the logs, then [secret:github-token] done')
    const firstDelta = early.findIndex(event => event.type === 'thinking' && event.state === 'delta')
    assert.ok(firstDelta > 0 && early.filter(event => event.type === 'thinking' && event.state === 'delta').length > 1, 'it streams in pieces, not as one block at the end')
    // Encrypted reasoning (no text) or empty text: start and end only.
    assert.deepEqual(await run([reasoning('reasoning-start'), reasoning('reasoning-end')]), [{ type: 'thinking', id: 'run:0', state: 'start' }, { type: 'thinking', id: 'run:0', state: 'end' }])
    assert.deepEqual(await run([reasoning('reasoning-start'), reasoningDelta('  '), reasoning('reasoning-end')]), [{ type: 'thinking', id: 'run:0', state: 'start' }, { type: 'thinking', id: 'run:0', state: 'end' }])
    // A saved secret: no part of it leaves, however the deltas cut it, and the block streams nothing after it.
    for (const parts of [[`the password is ${secret}`], ['the password is synth', `etic-password-value and more`], [`${'x'.repeat(60)} then `, secret, ' after']]) {
      const held = await run([reasoning('reasoning-start'), ...parts.map(reasoningDelta), reasoning('reasoning-end')])
      const json = JSON.stringify(held)
      for (let k = 4; k <= secret.length; k++) assert.equal(json.includes(secret.slice(0, k)), false, `${parts.length} parts: ${secret.slice(0, k)}`)
      assert.equal(json.includes('after') || json.includes('and more'), false)
      assert.deepEqual(held.at(-1), { type: 'thinking', id: 'run:0', state: 'end' })
    }
  } finally {
    if (old === undefined) delete process.env.BETTER_AUTH_SECRET
    else process.env.BETTER_AUTH_SECRET = old
  }
})

test('a retried model step drops the reasoning it streamed; earlier steps keep theirs', async () => {
  const reasoningOf = (id: string, type: 'reasoning-start' | 'reasoning-end') => ({ type, id }) as unknown as CoordinatorWorkflowStreamPart
  const thinkingDelta = (id: string, text: string) => ({ type: 'reasoning-delta', id, text }) as unknown as CoordinatorWorkflowStreamPart
  const events = await project([start(), boundary('start-step'), reasoningOf('a', 'reasoning-start'), thinkingDelta('a', 'first thought'), reasoningOf('a', 'reasoning-end'), boundary('finish-step'),
    boundary('start-step'), reasoningOf('b', 'reasoning-start'), thinkingDelta('b', 'wrong'), { type: 'reset-step' },
    reasoningOf('c', 'reasoning-start'), thinkingDelta('c', 'right'), reasoningOf('c', 'reasoning-end'), delta('Done.'), committed()])
  let replies: CoordinatorLiveReply[] = []
  for (const event of events) if (event.type !== 'committed') replies = coordinatorStreamReply(replies, event)
  assert.equal(replies[0].thinking?.text, 'first thought\n\nright')
  assert.ok(events.some(event => event.type === 'thinking' && event.state === 'reset' && event.text === 'first thought'))
})

test('a hand-off turn that may end quiet streams no tools or thinking', async () => {
  const events = await project([start('run:0', true), reasoning('reasoning-start'), reasoning('reasoning-end'), call('c1', 'list_issues', {}), result('c1', 'list_issues', []), committed('run:0', 2, true)])
  assert.deepEqual(events.map(event => event.type), ['start', 'committed'])
})

test('a tool preview that would carry a saved secret or a credential is masked or left out, never streamed', async () => {
  const old = process.env.BETTER_AUTH_SECRET
  process.env.BETTER_AUTH_SECRET = 'offline-stream-guard-fixture-secret'
  try {
    const secret = 'synthetic-password-value'
    const raw = new ReadableStream<CoordinatorWorkflowStreamPart>({ start(controller) {
      controller.enqueue(start())
      controller.enqueue(call('c1', 'send_email', { to: 'a@example.com', body: `my password is ${secret}` }))
      controller.enqueue(call('c2', 'github_call', { token: 'ghp_' + 'A'.repeat(36) }))
      controller.enqueue(result('c2', 'github_call', { ok: true }))
      controller.close()
    } })
    const events = await drain(raw.pipeThrough(coordinatorTextStream('owner', [fingerprint('owner', secret)])))
    const tools = events.filter((event): event is Extract<CoordinatorStreamEvent, { type: 'tool' }> => event.type === 'tool')
    assert.deepEqual(tools.map(tool => [tool.call, tool.state]), [['c1', 'running'], ['c2', 'running'], ['c2', 'done']], 'the tool itself still shows')
    assert.equal(tools[0].input, undefined, 'a preview holding a saved secret is left out')
    assert.equal(tools[0].quote, undefined, 'and so is the quote')
    assert.equal(JSON.stringify(events).includes(secret), false)
    assert.equal(JSON.stringify(events).includes('ghp_' + 'A'.repeat(36)), false, 'credential patterns are masked as stored messages are')
  } finally {
    if (old === undefined) delete process.env.BETTER_AUTH_SECRET
    else process.env.BETTER_AUTH_SECRET = old
  }
})
