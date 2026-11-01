import 'server-only'
import { pool } from '@/lib/db'

export type ChatPreference = { pinned: boolean; muted: boolean }

/** The chat a bot id names: its own id, or 'coordinator' for the Coordinator. */
export const chatKey = (botId: string | null) => botId ?? 'coordinator'

/** The person's 置顶 and 通知 per chat, only for chats they changed. */
export async function chatPreferences(userId: string): Promise<Record<string, ChatPreference>> {
  const { rows } = await pool.query<{ chatKey: string; pinned: boolean; muted: boolean }>(
    'SELECT "chatKey", pinned, muted FROM chat_preferences WHERE "userId"=$1', [userId])
  return Object.fromEntries(rows.map(row => [row.chatKey, { pinned: row.pinned, muted: row.muted }]))
}

/** Whether the person turned 通知 off for this chat. */
export async function chatMuted(userId: string, botId: string | null): Promise<boolean> {
  const { rows } = await pool.query<{ muted: boolean }>('SELECT muted FROM chat_preferences WHERE "userId"=$1 AND "chatKey"=$2', [userId, chatKey(botId)])
  return rows[0]?.muted ?? false
}

/**
 * Changes 置顶 or 通知 for the Coordinator or one of the person's own bots.
 * False when the bot is not theirs.
 */
export async function setChatPreference(userId: string, botId: string | null, change: Partial<ChatPreference>): Promise<boolean> {
  if (botId && !(await pool.query('SELECT 1 FROM bots WHERE id=$1::uuid AND "ownerId"=$2', [botId, userId])).rowCount) return false
  await pool.query(`INSERT INTO chat_preferences ("userId","chatKey",pinned,muted) VALUES ($1,$2,COALESCE($3,false),COALESCE($4,false))
    ON CONFLICT ("userId","chatKey") DO UPDATE SET pinned=COALESCE($3,chat_preferences.pinned), muted=COALESCE($4,chat_preferences.muted), "updatedAt"=now()`,
    [userId, chatKey(botId), change.pinned ?? null, change.muted ?? null])
  return true
}
