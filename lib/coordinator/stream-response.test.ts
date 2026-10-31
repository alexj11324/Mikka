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

async function project(parts: CoordinatorWorkflowStreamPart[]) {
  const output = new ReadableStream<CoordinatorWorkflowStreamPart>({ start(controller) { parts.forEach(part => controller.enqueue(part)); controller.close() } })
  const events: CoordinatorStreamEvent[] = []
  for await (const event of output.pipeThrough(coordinatorTextStream('owner', []))) events.push(event)
  return events
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
    await assert.rejects(async () => {
      for await (const event of raw.pipeThrough(coordinatorTextStream('owner', fingerprints))) seen.push(event)
    }, { code: 'credential_secret_detected' })
    assert.ok(body(seen).length > 0)
    assert.equal(body(seen), ('safe '.repeat(10)).slice(0, body(seen).length))

    const safe = new ReadableStream<CoordinatorWorkflowStreamPart>({ start(controller) {
      controller.enqueue(start()); controller.enqueue(delta('short safe reply')); controller.enqueue(committed()); controller.close()
    } })
    const safeEvents: CoordinatorStreamEvent[] = []
    for await (const event of safe.pipeThrough(coordinatorTextStream('owner', fingerprints))) safeEvents.push(event)
    assert.equal(body(safeEvents), 'short safe reply')
  } finally {
    if (old === undefined) delete process.env.BETTER_AUTH_SECRET
    else process.env.BETTER_AUTH_SECRET = old
  }
})
