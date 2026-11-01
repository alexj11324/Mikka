import 'server-only'
import { pool } from '@/lib/db'

export type ChatPreference = { pinned: boolean; muted: boolean }


/** The person's 置顶 and 通知 per chat, only for chats they changed. */
export async function chatPreferences(userId: string): Promise<Record<string, ChatPreference>> {
  const { rows } = await pool.query<{ chatKey: string; pinned: boolean; muted: boolean }>(
    'SELECT "chatKey", pinned, muted FROM chat_preferences WHERE "userId"=$1', [userId])
  return Object.fromEntries(rows.map(row => [row.chatKey, { pinned: row.pinned, muted: row.muted }]))
}

/** Whether the person turned 通知 off for this chat. */
export async function chatMuted(userId: string, botId: string): Promise<boolean> {
  const { rows } = await pool.query<{ muted: boolean }>('SELECT muted FROM chat_preferences WHERE "userId"=$1 AND "chatKey"=$2', [userId, botId])
  return rows[0]?.muted ?? false
}

/**
 * Changes 置顶 or 通知 for one of the person's own bots, the Coordinator
 * included (`chatKey` is the bot's id). False when the bot is not theirs.
 */
export async function setChatPreference(userId: string, botId: string, change: Partial<ChatPreference>): Promise<boolean> {
  if (!(await pool.query('SELECT 1 FROM bots WHERE id=$1::uuid AND "ownerId"=$2', [botId, userId])).rowCount) return false
  // A first change to the Coordinator keeps it pinned unless it is the pin itself (pinnedByDefault).
  await pool.query(`INSERT INTO chat_preferences ("userId","chatKey",pinned,muted) VALUES ($1,$2,COALESCE($3::boolean,$5::boolean),COALESCE($4::boolean,false))
    ON CONFLICT ("userId","chatKey") DO UPDATE SET pinned=COALESCE($3::boolean,chat_preferences.pinned), muted=COALESCE($4::boolean,chat_preferences.muted), "updatedAt"=now()`,
    [userId, botId, change.pinned ?? null, change.muted ?? null, await pinnedByDefault(userId, botId)])
  return true
}

/**
 * Whether a chat is pinned before the person changes it: the Coordinator is,
 * like any bot they pin, and they can unpin it (Alex: the star is the pin, the
 * same for every bot; the Coordinator is an ordinary bot).
 */
export async function pinnedByDefault(userId: string, botId: string): Promise<boolean> {
  return Boolean((await pool.query('SELECT 1 FROM coordinator_bots WHERE "ownerId"=$1 AND "botId"=$2', [userId, botId])).rowCount)
}
