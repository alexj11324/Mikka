import 'server-only'
import { pool } from '@/lib/db'

/** The reactions a long press offers, as in Messages and Slack (decision 2026-11-01-0030-mobile-reactions). */
export const REACTIONS = ['❤️', '👍', '👎', '😂', '🎉', '🙏'] as const

export type MessageReaction = { emoji: string; count: number; mine: boolean }

/** Reactions on these messages, grouped by emoji, most given first, with whether this person gave it. */
export async function reactionsFor(userId: string, messageIds: readonly string[]): Promise<Record<string, MessageReaction[]>> {
  if (!messageIds.length) return {}
  const { rows } = await pool.query<{ messageId: string; emoji: string; count: string; mine: boolean }>(
    `SELECT "messageId", emoji, count(*)::text AS count, bool_or("userId"=$1) AS mine FROM message_reactions
     WHERE "messageId" = ANY($2::uuid[]) GROUP BY "messageId", emoji ORDER BY count(*) DESC, min("createdAt")`, [userId, messageIds])
  const result: Record<string, MessageReaction[]> = {}
  for (const row of rows) (result[row.messageId] ??= []).push({ emoji: row.emoji, count: Number(row.count), mine: row.mine })
  return result
}

/**
 * Sets or clears (`emoji` null) this person's reaction to a message they can
 * see: one in their own bot chat, or one in a group they are still in. False
 * when the message is not theirs to react to.
 */
export async function setReaction(userId: string, messageId: string, emoji: string | null): Promise<boolean> {
  const { rowCount } = await pool.query(
    `SELECT 1 FROM coordinator_messages WHERE id=$1::uuid AND "userId"=$2
     UNION ALL
     SELECT 1 FROM conversation_messages m JOIN conversation_members cm ON cm."conversationId"=m."conversationId"
       AND cm."memberType"='user' AND cm."memberId"=$2 AND cm."leftAt" IS NULL
     WHERE m.id=$1::uuid LIMIT 1`, [messageId, userId])
  if (!rowCount) return false
  if (emoji === null) await pool.query('DELETE FROM message_reactions WHERE "userId"=$1 AND "messageId"=$2', [userId, messageId])
  else await pool.query(`INSERT INTO message_reactions ("userId","messageId",emoji) VALUES ($1,$2,$3)
    ON CONFLICT ("userId","messageId") DO UPDATE SET emoji=EXCLUDED.emoji, "createdAt"=now()`, [userId, messageId, emoji])
  return true
}

/** Of these group-chat messages, the ones in groups this person is still in. */
export async function visibleGroupMessages(userId: string, messageIds: readonly string[]): Promise<string[]> {
  if (!messageIds.length) return []
  const { rows } = await pool.query<{ id: string }>(
    `SELECT m.id FROM conversation_messages m JOIN conversation_members cm ON cm."conversationId"=m."conversationId"
       AND cm."memberType"='user' AND cm."memberId"=$1 AND cm."leftAt" IS NULL
     WHERE m.id = ANY($2::uuid[])`, [userId, messageIds])
  return rows.map(row => row.id)
}
