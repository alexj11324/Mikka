import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { EveMessage } from 'eve/client'
import { eveChatItems, generatedCardDocument } from '../features/chat/model/eve-messages.ts'

test('native chat consumes eve messages and removes a live reply when its Mikka mirror arrives', () => {
  const messages: EveMessage[] = [
    { id: 'history', role: 'assistant', metadata: { imported: true }, parts: [{ type: 'text', text: 'Historical reply' }] },
    { id: 'native-a', role: 'assistant', metadata: { turnId: 'turn-a', status: 'streaming' }, parts: [{ type: 'text', text: 'Hello' }, { type: 'text', text: ' world' }] },
  ]
  const agent = { messages, events: [], session: { sessionId: 'wrun_bot' } }
  const rows = eveChatItems(agent, [])
  assert.equal(rows.length, 1)
  assert.equal(rows[0].text, 'Hello world')
  assert.equal(rows[0].streamId, 'native-a')
  assert.deepEqual(eveChatItems(agent, [{ ...rows[0], position: 8, streamId: 'eve:wrun_bot:turn-a' }]), [])
})

test('different session identity cannot hide a Bot reply even when its turn id matches', () => {
  const message: EveMessage = { id: 'reply', role: 'assistant', metadata: { turnId: 'same' }, parts: [{ type: 'text', text: 'Other Bot' }] }
  const stored = [{ from: 'coordinator' as const, position: 3, text: 'One Bot', streamId: 'eve:wrun_a:same', threads: [], artifacts: [], createdAt: '' }]
  const rows = eveChatItems({ messages: [message], session: { sessionId: 'wrun_b' }, events: [] }, stored)
  assert.equal(rows[0].text, 'Other Bot')
  assert.ok(rows[0].position > 3)
})

test('the same generated answer keeps its command on settlement without conflating deliveries or sibling controls', async () => {
  const { conversationOf } = await import('eve/client')
  const { projectEveTurn } = await import('../../../lib/eve/projection')
  const { canAnswerCard, personalMessage } = await import('../lib/outbox')
  const turnId = 'turn_1', sessionId = 'wrun_owner'
  // Deliberately equal programs and equal answer words in two different SDK messages.
  const program = 'root = Stack([BeButton("Yes", "same"), BeButton("Again", "same")])'
  const frames = [
    { type: 'turn.started', data: { turnId, cause: { deliveryId: 'start' }, follows: null } },
    { type: 'content.completed', data: { partId: 'first', kind: 'text', phase: 'reply', value: program } },
    { type: 'delivery.admitted', data: { deliveryId: 'steer' } },
    { type: 'delivery.consumed', data: { turnId, deliveryId: 'steer', parts: [{ type: 'text', text: 'continue' }] } },
    { type: 'content.completed', data: { partId: 'second', kind: 'text', phase: 'reply', value: program } },
    { type: 'turn.settled', data: { turnId, outcome: 'completed', reply: ['first', 'second'] } },
  ]
  const events = frames.map((frame, line) => ({ ...frame, scope: { turnId }, meta: {
    at: '2026-11-11T00:00:00Z', position: { line, index: 0 }, endOfLine: true,
  } })) as Parameters<typeof conversationOf>[0] & Parameters<typeof eveChatItems>[0]['events']
  const { messages, view } = conversationOf(events)
  const agent = { messages, events, session: { sessionId } }
  const [first, second] = eveChatItems(agent, [])
  assert.equal(first.streamId, 'turn_1:assistant')
  assert.equal(second.streamId, 'turn_1:steer:assistant')
  const projection = projectEveTurn(view, sessionId, turnId, 'completed')[0]
  assert.ok('mikkaStreamId' in projection)
  const mirror = { ...first, cardDocument: undefined, id: 'persisted-row', streamId: projection.mikkaStreamId,
    text: projection.content.flatMap(part => 'text' in part ? [part.text] : []).join('\n\n') }
  assert.deepEqual(eveChatItems(agent, [mirror]), [])

  const sourceOf = (row: typeof mirror | typeof first, child: string) => `${generatedCardDocument(row)}:${child}`
  const source = sourceOf(second, 'root.0')
  assert.equal(sourceOf(mirror, 'root.0'), source)
  const sending = personalMessage('first-command', 'same', [], { sourceCardId: source, chatKey: 'coordinator', context: 1, botId: null })
  assert.equal(canAnswerCard([sending], sourceOf(mirror, 'root.0')), false)
  assert.equal(canAnswerCard([sending], sourceOf(first, 'root.0')), true)
  assert.equal(canAnswerCard([sending], sourceOf(mirror, 'root.1')), true)
  assert.notEqual(sourceOf({ ...mirror, streamId: 'eve:wrun_other:turn_1' }, 'root.0'), source)
  // Legacy history can have an opaque stream id, only a row id, or only its immutable position.
  const older = { ...mirror, streamId: undefined }
  assert.notEqual(sourceOf(older, 'root'), sourceOf({ ...older, id: 'other' }, 'root'))
  assert.notEqual(sourceOf({ ...older, id: undefined }, 'root'), sourceOf({ ...older, id: undefined, position: 90 }, 'root'))
})
