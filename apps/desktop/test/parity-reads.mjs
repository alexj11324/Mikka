import { TestAccountError } from '../../../scripts/test-accounts/pool.mjs'

export const parityBotReadKeys = ids => [`bot:${ids.coordinator}`, `bot:${ids.bot}`]

/** Called inside the fixture's current-lease transaction before any UI starts.
 * The fixed coordinator key is owner-scoped, never globally reserved/adopted. */
export async function captureParityReadReceipts(client, ownerId, ids) {
  const messages = new Map([
    ['coordinator', [[ids.coordinatorUser, 1, ids.coordinator], [ids.coordinatorReply, 2, ids.coordinator]]],
    [`bot:${ids.coordinator}`, [[ids.coordinatorUser, 1, ids.coordinator], [ids.coordinatorReply, 2, ids.coordinator]]],
    [`bot:${ids.bot}`, [[ids.botUser, 1, ids.bot], [ids.botReply, 2, ids.bot]]],
  ])
  const keys = [...messages.keys()]
  const read = tx => tx.query('SELECT "conversationId", "lastReadMessageId", "lastReadPosition" FROM public.conversation_reads WHERE "userId"=$1 AND "conversationId"=ANY($2::text[]) FOR UPDATE', [ownerId, keys])
  if ((await read(client)).rows.length) throw new TestAccountError('PARITY_READ_BASELINE_PRESENT')
  return async tx => {
    const { rows } = await read(tx)
    if (!rows.length) return
    const own = (await tx.query('SELECT id::text AS id, "botId"::text AS "botId", position FROM public.coordinator_messages WHERE "userId"=$1 AND id=ANY($2::uuid[])', [ownerId, [ids.coordinatorUser, ids.coordinatorReply, ids.botUser, ids.botReply]])).rows
    for (const row of rows) {
      const expected = messages.get(row.conversationId)?.find(([id, position]) => row.lastReadMessageId === id && row.lastReadPosition === position)
      if (!expected || !own.some(message => message.id === expected[0] && message.position === expected[1] && message.botId === expected[2])) throw new TestAccountError('PARITY_READ_OWNERSHIP_UNPROVEN')
    }
    // Delete only validated, locked rows. A concurrent unexpected insert stays
    // dirty instead of being swept up by a broad key/owner predicate.
    for (const row of rows) {
      const deleted = await tx.query('DELETE FROM public.conversation_reads WHERE "userId"=$1 AND "conversationId"=$2 AND "lastReadMessageId"=$3 AND "lastReadPosition"=$4', [ownerId, row.conversationId, row.lastReadMessageId, row.lastReadPosition])
      if (deleted.rowCount !== 1) throw new TestAccountError('PARITY_READ_CHANGED')
    }
  }
}
