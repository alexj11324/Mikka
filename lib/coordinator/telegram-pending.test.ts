import assert from 'node:assert/strict'
import test from 'node:test'
import { markTelegramPending, pendingTelegramTargets, telegramReplyPending } from './telegram-pending'

const source = (id: string, messageId: number, threadId = 'telegram:fixture') => ({ id, kind: 'user_message', payload: { text: 'Synthetic request', telegram: { threadId, telegramUserId: 'fixture-owner', messageId } } })
const pending = (id: string, messageId: number, threadId?: string) => {
  const event = source(id, messageId, threadId)
  return { ...event, payload: markTelegramPending(event)! }
}

test('only newly staged, valid human Telegram sources become pending', () => {
  const event = source('first', 1)
  assert.equal(telegramReplyPending(event), false)
  assert.deepEqual(pendingTelegramTargets([event]), [], 'historical messages are not sent retroactively')
  assert.equal(markTelegramPending({ ...event, kind: 'run_report' }), null)
  assert.equal(markTelegramPending({ ...event, payload: { telegram: { threadId: 'forged', telegramUserId: 'fixture-owner' } } }), null)
  assert.equal(telegramReplyPending(pending('first', 1)), true)
})

test('serialized pending receipts survive failed turns and preserve exact event watermarks', () => {
  const rows = JSON.parse(JSON.stringify([pending('first', 1), pending('second', 2), pending('other', 3, 'telegram:other')]))
  const targets = pendingTelegramTargets(rows)
  assert.deepEqual(targets, [
    { threadId: 'telegram:fixture', telegramUserId: 'fixture-owner', sourceEventIds: ['first', 'second'] },
    { threadId: 'telegram:other', telegramUserId: 'fixture-owner', sourceEventIds: ['other'] },
  ])
  const afterAck = [...rows, pending('later', 4)].map(event => targets[0].sourceEventIds.includes(event.id)
    ? { ...event, payload: { ...event.payload, mikkaTelegramReply: { version: 1, state: 'sent' } } }
    : event)
  assert.deepEqual(pendingTelegramTargets(afterAck), [
    { threadId: 'telegram:other', telegramUserId: 'fixture-owner', sourceEventIds: ['other'] },
    { threadId: 'telegram:fixture', telegramUserId: 'fixture-owner', sourceEventIds: ['later'] },
  ])
})

test('invalid receipt versions, settled rows and duplicate sources do not add send authority', () => {
  const event = pending('first', 1)
  assert.equal(telegramReplyPending({ ...event, payload: { ...event.payload, mikkaTelegramReply: { version: 2, state: 'pending' } } }), false)
  assert.equal(telegramReplyPending({ ...event, payload: { ...event.payload, mikkaTelegramReply: { version: 1, state: 'sent' } } }), false)
  assert.deepEqual(pendingTelegramTargets([event, event])[0].sourceEventIds, ['first'])
})
