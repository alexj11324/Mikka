import assert from 'node:assert/strict'
import test from 'node:test'
import { coordinatorStreamReply, readCoordinatorStream, visibleCoordinatorReplies, type CoordinatorLiveReply } from './coordinator-stream-client'
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
