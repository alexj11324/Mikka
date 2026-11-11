import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { EveMessage } from 'eve/client'
import { eveChatItems } from '../features/chat/model/eve-messages.ts'

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
