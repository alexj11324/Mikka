import assert from 'node:assert/strict'
import test from 'node:test'
import { captureParityReadReceipts, parityBotReadKeys } from './parity-reads.mjs'

const ids = { coordinator: 'coordinator-bot', bot: 'bot', coordinatorUser: 'c1', coordinatorReply: 'c2', botUser: 'b1', botReply: 'b2' }
const coordinator = { conversationId: 'coordinator', lastReadMessageId: 'c2', lastReadPosition: 2 }
function fixture(initial = []) {
  const state = { reads: initial, messages: [{ id: 'c2', position: 2, botId: ids.coordinator }, { id: 'b2', position: 2, botId: ids.bot }], deletes: [] }
  return { state, client: { query: async (sql, args) => {
    assert.equal(args[0], 'leased-owner', 'every read and deletion retains the leased owner')
    if (sql.startsWith('SELECT "conversationId"')) return { rows: state.reads }
    if (sql.startsWith('SELECT id::text')) return { rows: state.messages }
    if (sql.startsWith('DELETE')) { state.deletes.push(args); return { rowCount: 1 } }
    assert.fail('unexpected query')
  } } }
}
test('receipt reservation uses actual fresh bot keys, never raw IDs or the shared coordinator label', () => {
  assert.deepEqual(parityBotReadKeys(ids), ['bot:coordinator-bot', 'bot:bot'])
})
test('a pre-existing coordinator receipt is refused without any deletion', async () => {
  const { client, state } = fixture([coordinator])
  await assert.rejects(captureParityReadReceipts(client, 'leased-owner', ids), /PARITY_READ_BASELINE_PRESENT/)
  assert.equal(state.deletes.length, 0)
})
test('only new receipts for the seeded owner messages and exact positions are removed', async () => {
  const { client, state } = fixture()
  const clean = await captureParityReadReceipts(client, 'leased-owner', ids)
  state.reads = [coordinator, { conversationId: 'bot:bot', lastReadMessageId: 'b2', lastReadPosition: 2 }]
  await clean(client)
  assert.deepEqual(state.deletes, [['leased-owner', 'coordinator', 'c2', 2], ['leased-owner', 'bot:bot', 'b2', 2]])
})
test('foreign messages, changed positions and unproven message owners fail before any row deletion', async () => {
  for (const patch of [{ lastReadMessageId: 'foreign-message' }, { lastReadPosition: 3 }, { conversationId: 'bot:foreign' }, null]) {
    const { client, state } = fixture()
    const clean = await captureParityReadReceipts(client, 'leased-owner', ids)
    state.reads = [{ ...coordinator, ...patch }]
    if (!patch) state.messages = []
    await assert.rejects(clean(client), /PARITY_READ_OWNERSHIP_UNPROVEN/)
    assert.equal(state.deletes.length, 0)
  }
})
