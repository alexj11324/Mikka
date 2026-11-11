import assert from 'node:assert/strict'
import test from 'node:test'
import { coordinatorStreamReply, readCoordinatorStream, visibleCoordinatorReplies, type CoordinatorLiveReply } from '@/tests/support/legacy-coordinator-stream'
import type { CoordinatorStreamEvent } from './coordinator/stream'

test('JSONL decoding preserves split UTF-8, split records, and an unterminated final line', async () => {
  const expected: CoordinatorStreamEvent[] = [{ type: 'start', id: 'run:0' }, { type: 'text', id: 'run:0', delta: '你好🙂' }, { type: 'committed', id: 'run:0', through: 4, quiet: false }]
  const bytes = new TextEncoder().encode(expected.map(event => JSON.stringify(event)).join('\n'))
  const events: CoordinatorStreamEvent[] = []
  await readCoordinatorStream(new ReadableStream({ start(controller) {
    for (const byte of bytes) controller.enqueue(Uint8Array.of(byte))
    controller.close()
  } }), event => events.push(event))
  assert.deepEqual(events, expected)
})

test('reset replaces a retried model step; replay rebuilds rather than duplicates rounds', () => {
  const events: CoordinatorStreamEvent[] = [
    { type: 'start', id: 'run:0' }, { type: 'text', id: 'run:0', delta: 'partial' },
    { type: 'reset', id: 'run:0', text: '' }, { type: 'text', id: 'run:0', delta: 'first' },
    { type: 'committed', id: 'run:0', through: 4, quiet: false },
    { type: 'start', id: 'run:1' }, { type: 'text', id: 'run:1', delta: 'second' },
  ]
  const replay = () => events.reduce(coordinatorStreamReply, [] as CoordinatorLiveReply[])
  assert.deepEqual(replay(), replay())
  assert.deepEqual(replay().map(reply => reply.text), ['first', 'second'])
  assert.deepEqual(visibleCoordinatorReplies(replay(), 3, 'run').map(reply => reply.text), ['first', 'second'])
  assert.deepEqual(visibleCoordinatorReplies(replay(), 4, 'run').map(reply => reply.text), ['second'])
  assert.deepEqual(visibleCoordinatorReplies(replay(), 3, undefined).map(reply => reply.text), ['first'])
  assert.deepEqual(visibleCoordinatorReplies([{ id: 'run:2', text: 'quiet', committedThrough: 5, quiet: true }], 4, 'run'), [])
})

test('invalid records fail and cancel the reader instead of becoming a completed reply', async () => {
  let cancelled = false
  const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('{"type":"text","id":"run:0","delta":42}\n')) }, cancel() { cancelled = true } })
  await assert.rejects(readCoordinatorStream(body, () => assert.fail('must not emit')), /Invalid Coordinator stream event/)
  assert.equal(cancelled, true)
  assert.throws(() => coordinatorStreamReply([], { type: 'error' }), /Coordinator stream failed/)
})

test('saved history hides its live reply even before the committed marker arrives', () => {
  const replies: CoordinatorLiveReply[] = [{ id: 'run:0', text: 'saved first reply' }, { id: 'run:1', text: 'still growing' }]
  assert.deepEqual(visibleCoordinatorReplies(replies, 4, 'run', ['run:0']), [replies[1]])
})

test('aborting an idle reader cancels it without emitting unfinished content', async () => {
  const controller = new AbortController()
  let cancelled = false
  const reading = readCoordinatorStream(new ReadableStream({ cancel() { cancelled = true } }), () => assert.fail('must not emit'), controller.signal)
  controller.abort()
  await reading
  assert.equal(cancelled, true)
})

test('a live reply keeps each tool in call order with its latest state, and adds up thinking time', async () => {
  const id = 'run:0'
  const timed: [CoordinatorStreamEvent, number][] = [
    [{ type: 'start', id }, 0],
    [{ type: 'thinking', id, state: 'start' }, 1_000], [{ type: 'thinking', id, state: 'start' }, 1_500], [{ type: 'thinking', id, state: 'end' }, 3_400],
    [{ type: 'tool', id, call: 'c1', name: 'create_issue', state: 'running', input: '{"title":"Fix"}', at: 12 }, 3_500],
    [{ type: 'tool', id, call: 'c2', name: 'web_search', state: 'running' }, 3_600],
    [{ type: 'tool', id, call: 'c1', name: 'create_issue', state: 'done', output: '{"id":"i1"}' }, 4_000],
    [{ type: 'thinking', id, state: 'start' }, 5_000], [{ type: 'thinking', id, state: 'end' }, 6_000],
    [{ type: 'tool', id, call: 'c2', name: 'web_search', state: 'error' }, 6_100],
  ]
  let replies: CoordinatorLiveReply[] = []
  for (const [event, at] of timed) replies = coordinatorStreamReply(replies, event, at)
  assert.deepEqual(replies[0].tools, [
    { call: 'c1', name: 'create_issue', state: 'done', input: '{"title":"Fix"}', output: '{"id":"i1"}', at: 12 },
    { call: 'c2', name: 'web_search', state: 'error' },
  ])
  assert.deepEqual(replies[0].thinking, { ms: 3_400 }, 'a repeated start does not restart the clock')
  // What it thinks arrives as it thinks, while the clock runs; a block without text adds none.
  let thought: CoordinatorLiveReply[] = [{ id, text: '' }]
  const seen: (string | undefined)[] = []
  for (const [event, at] of [[{ type: 'thinking', id, state: 'start' }, 0], [{ type: 'thinking', id, state: 'delta', text: 'fir' }, 400], [{ type: 'thinking', id, state: 'delta', text: 'st' }, 800], [{ type: 'thinking', id, state: 'end' }, 1_000],
    [{ type: 'thinking', id, state: 'start' }, 2_000], [{ type: 'thinking', id, state: 'end' }, 2_500], [{ type: 'thinking', id, state: 'start' }, 3_000], [{ type: 'thinking', id, state: 'delta', text: '\n\nsecond' }, 3_200], [{ type: 'thinking', id, state: 'end' }, 3_500]] as [CoordinatorStreamEvent, number][]) {
    thought = coordinatorStreamReply(thought, event, at)
    seen.push(thought[0].thinking?.text)
  }
  assert.deepEqual(seen.slice(0, 3), [undefined, 'fir', 'first'], 'the words show before the block ends')
  assert.equal(thought[0].thinking?.since, undefined)
  assert.deepEqual(thought[0].thinking, { ms: 2_000, text: 'first\n\nsecond' })
  // A retried model step drops its part: the server sends what remains.
  assert.deepEqual(coordinatorStreamReply(thought, { type: 'thinking', id, state: 'reset', text: 'first' })[0].thinking, { ms: 2_000, text: 'first' })
  assert.deepEqual(coordinatorStreamReply(thought, { type: 'thinking', id, state: 'reset', text: '' })[0].thinking, { ms: 2_000 })
  // Before any words, a reply with only steps already shows; one with nothing does not.
  assert.equal(visibleCoordinatorReplies(replies, 0, 'run').length, 1)
  assert.equal(visibleCoordinatorReplies([{ id, text: '' }], 0, 'run').length, 0)
  // The JSONL reader accepts the new events and drops unknown states.
  const lines = [{ type: 'tool', id, call: 'c1', name: 'x', state: 'done', output: 'o' }, { type: 'thinking', id, state: 'start' }]
  const events: CoordinatorStreamEvent[] = []
  await readCoordinatorStream(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(lines.map(line => JSON.stringify(line)).join('\n'))); controller.close() } }), event => events.push(event))
  assert.deepEqual(events, lines)
  await assert.rejects(readCoordinatorStream(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(JSON.stringify({ type: 'tool', id, call: 'c1', name: 'x', state: 'maybe' }))); controller.close() } }), () => {}))
})
