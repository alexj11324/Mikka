import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fingerprint } from '@/lib/credentials/fingerprint'
import { QUIET_REPLY } from '@/lib/attention/handoff'
import { coordinatorTextStream } from './stream-response'
import type { CoordinatorStreamEvent, CoordinatorWorkflowStreamPart } from './stream'

const start = (id = 'run:0', quietEligible = false): CoordinatorWorkflowStreamPart => ({ type: 'coordinator-turn-start', id, quietEligible })
const delta = (text: string): CoordinatorWorkflowStreamPart => ({ type: 'text-delta', id: '0', text })
const committed = (id = 'run:0', through = 2, quiet = false): CoordinatorWorkflowStreamPart => ({ type: 'coordinator-turn-committed', id, through, quiet })
const boundary = (type: 'start-step' | 'finish-step') => ({ type }) as unknown as CoordinatorWorkflowStreamPart
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

test('each tool streams its name, state and short previews; thinking streams as start and end only', async () => {
  const events = await project([start(), reasoning('reasoning-start'), { type: 'reasoning-delta', id: 'r', text: 'private reasoning' } as CoordinatorWorkflowStreamPart, reasoning('reasoning-end'),
    call('c1', 'create_issue', { title: 'Fix login', body: 'x'.repeat(400) }), result('c1', 'create_issue', { id: 'i1' }),
    call('c2', 'record_attention', { level: 'high' }), result('c2', 'record_attention', {}),
    call('c3', 'dispatch_run', { issueId: 'i1' }), failure('c3', 'dispatch_run'), delta('Done.'), committed()])
  const steps = events.filter(event => event.type === 'tool' || event.type === 'thinking')
  assert.deepEqual(steps.map(event => event.type === 'tool' ? [event.call, event.name, event.state] : [event.type, event.state]), [
    ['thinking', 'start'], ['thinking', 'end'], ['c1', 'create_issue', 'running'], ['c1', 'create_issue', 'done'], ['c3', 'dispatch_run', 'running'], ['c3', 'dispatch_run', 'error'],
  ], 'a hidden tool never shows')
  const created = steps[2] as Extract<CoordinatorStreamEvent, { type: 'tool' }>
  assert.equal(created.input?.length, 200, 'the input preview is as short as the stored one')
  assert.ok(created.input?.startsWith('{"title":"Fix login"'))
  assert.equal((steps[3] as Extract<CoordinatorStreamEvent, { type: 'tool' }>).output, '{"id":"i1"}')
  assert.equal(JSON.stringify(events).includes('private'), false, 'reasoning text and error details stay on the server')
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
    assert.equal(JSON.stringify(events).includes(secret), false)
    assert.equal(JSON.stringify(events).includes('ghp_' + 'A'.repeat(36)), false, 'credential patterns are masked as stored messages are')
  } finally {
    if (old === undefined) delete process.env.BETTER_AUTH_SECRET
    else process.env.BETTER_AUTH_SECRET = old
  }
})
