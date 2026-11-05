import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fingerprint } from '@/lib/credentials/fingerprint'
import { QUIET_REPLY } from '@/lib/attention/handoff'
import { coordinatorTextStream } from './stream-response'
import { coordinatorStreamReply, type CoordinatorLiveReply } from '../coordinator-stream-client'
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
    assert.equal(JSON.stringify(events).includes(secret), false)
    assert.equal(JSON.stringify(events).includes('ghp_' + 'A'.repeat(36)), false, 'credential patterns are masked as stored messages are')
  } finally {
    if (old === undefined) delete process.env.BETTER_AUTH_SECRET
    else process.env.BETTER_AUTH_SECRET = old
  }
})
