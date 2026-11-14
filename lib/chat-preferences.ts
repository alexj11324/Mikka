import 'server-only'
import { pool } from '@/lib/db'
import { botChatChanged } from '@/lib/live/chats'
import { groupListReadChanged } from '@/lib/live/lists'

/** The person's own state for one chat: 置顶, 通知, hidden from the home list, marked unread, and its drag order. */
export type ChatPreference = { pinned: boolean; muted: boolean; hidden: boolean; markedUnread: boolean; pinOrder: number | null; listOrder: number | null }
/** What a person can change on one chat from the home list or its page. */
export type ChatChange = Partial<Pick<ChatPreference, 'pinned' | 'muted' | 'hidden' | 'markedUnread'>>

/** The most chats pinned at once: four rows of the home screen's pin grid. */
export const MAX_PINNED_CHATS = 16

/** The person's own state per chat, only for chats they changed. */
export async function chatPreferences(userId: string): Promise<Record<string, ChatPreference>> {
  const { rows } = await pool.query<ChatPreference & { chatKey: string }>(
    'SELECT "chatKey", pinned, muted, hidden, "markedUnread", "pinOrder", "listOrder" FROM chat_preferences WHERE "userId"=$1', [userId])
  return Object.fromEntries(rows.map(({ chatKey, ...preference }) => [chatKey, preference]))
}

/** Whether the person turned 通知 off for this chat. */
export async function chatMuted(userId: string, botId: string): Promise<boolean> {
  const { rows } = await pool.query<{ muted: boolean }>('SELECT muted FROM chat_preferences WHERE "userId"=$1 AND "chatKey"=$2', [userId, botId])
  return rows[0]?.muted ?? false
}

const ownsBot = async (userId: string, botId: string) =>
  Boolean((await pool.query('SELECT 1 FROM bots WHERE id=$1::uuid AND "ownerId"=$2', [botId, userId])).rowCount)
const inGroup = async (userId: string, conversationId: string) =>
  Boolean((await pool.query(`SELECT 1 FROM conversation_members WHERE "conversationId"=$1::uuid AND "memberType"='user' AND "memberId"=$2 AND "leftAt" IS NULL`, [conversationId, userId])).rowCount)

/** Whether pinning one more chat would pass the limit; a chat already pinned never does. A Coordinator counts while it is pinned by default. */
async function pinFull(userId: string, chatKey: string): Promise<boolean> {
  const { rows } = await pool.query<{ count: string }>(
    `SELECT count(*) FROM (SELECT "chatKey" FROM chat_preferences WHERE "userId"=$1 AND pinned AND "chatKey"<>$2
      UNION SELECT cb."botId"::text FROM coordinator_bots cb WHERE cb."ownerId"=$1 AND cb."botId"::text<>$2
        AND NOT EXISTS (SELECT 1 FROM chat_preferences p WHERE p."userId"=$1 AND p."chatKey"=cb."botId"::text)) pins`,
    [userId, chatKey])
  return Number(rows[0]?.count ?? 0) >= MAX_PINNED_CHATS
}

async function writePreference(userId: string, chatKey: string, change: ChatChange, pinnedDefault: boolean, group = false) {
  // A first change keeps a chat pinned by default (the Coordinator) unless it is the pin itself.
  await pool.query(`WITH manual_revision AS (
    INSERT INTO conversation_reads AS r ("userId","conversationId","unreadRevision")
    SELECT $1,$2,1 WHERE $8::boolean AND $6::boolean
    ON CONFLICT ("userId","conversationId") DO UPDATE SET "unreadRevision"=r."unreadRevision"+1
  ) INSERT INTO chat_preferences ("userId","chatKey",pinned,muted,hidden,"markedUnread")
    VALUES ($1,$2,COALESCE($3::boolean,$7::boolean),COALESCE($4::boolean,false),COALESCE($5::boolean,false),COALESCE($6::boolean,false))
    ON CONFLICT ("userId","chatKey") DO UPDATE SET pinned=COALESCE($3::boolean,chat_preferences.pinned), muted=COALESCE($4::boolean,chat_preferences.muted),
      hidden=COALESCE($5::boolean,chat_preferences.hidden), "markedUnread"=COALESCE($6::boolean,chat_preferences."markedUnread"),
      "pinOrder"=CASE WHEN $3::boolean IS FALSE THEN NULL ELSE chat_preferences."pinOrder" END, "updatedAt"=now()`,
    [userId, chatKey, change.pinned ?? null, change.muted ?? null, change.hidden ?? null, change.markedUnread ?? null, pinnedDefault, group])
}

/**
 * Changes the person's own state for one of their bots' chats, the Coordinator included (`chatKey` is the bot's
 * id). 'notFound' when the bot is not theirs; 'pinLimit' when the pins are full.
 */
export async function setChatPreference(userId: string, botId: string, change: ChatChange): Promise<'ok' | 'notFound' | 'pinLimit'> {
  if (!await ownsBot(userId, botId)) return 'notFound'
  if (change.pinned && await pinFull(userId, botId)) return 'pinLimit'
  await writePreference(userId, botId, change, await pinnedByDefault(userId, botId))
  // The person's other screens (the home list, the bot's page) re-read after this committed write.
  await botChatChanged(pool, userId, botId)
  return 'ok'
}

/** The same for a group chat the person is in (`chatKey` is the conversation id); 通知 stays the group's own setting. */
export async function setGroupPreference(userId: string, conversationId: string, change: Omit<ChatChange, 'muted'>): Promise<'ok' | 'notFound' | 'pinLimit'> {
  if (!await inGroup(userId, conversationId)) return 'notFound'
  if (change.pinned && await pinFull(userId, conversationId)) return 'pinLimit'
  await writePreference(userId, conversationId, change, false, true)
  await groupListReadChanged(pool, conversationId, userId)
  return 'ok'
}

/**
 * A drag's result on the home list: the pins in their order and the other chats in theirs. A chat in `pinned` is
 * pinned and one in `list` is not. Every key must be one of the person's bots or groups; nothing is written otherwise.
 */
export async function setChatOrder(userId: string, order: { pinned: string[]; list: string[] }): Promise<'ok' | 'notFound' | 'pinLimit'> {
  if (order.pinned.length > MAX_PINNED_CHATS) return 'pinLimit'
  const keys = [...order.pinned, ...order.list]
  if (new Set(keys).size !== keys.length) return 'notFound'
  const owned = await pool.query<{ key: string; group: boolean }>(
    `SELECT id::text AS key, false AS "group" FROM bots WHERE "ownerId"=$1 AND id::text = ANY($2::text[])
     UNION SELECT "conversationId"::text, true FROM conversation_members WHERE "memberType"='user' AND "memberId"=$1 AND "leftAt" IS NULL AND "conversationId"::text = ANY($2::text[])`,
    [userId, keys])
  if (owned.rows.length !== keys.length) return 'notFound'
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(`INSERT INTO chat_preferences ("userId","chatKey",pinned,"pinOrder","listOrder")
      SELECT $1, key, ord <= $3, CASE WHEN ord <= $3 THEN ord ELSE NULL END, CASE WHEN ord > $3 THEN ord - $3 ELSE NULL END
      FROM unnest($2::text[]) WITH ORDINALITY AS t(key, ord)
      ON CONFLICT ("userId","chatKey") DO UPDATE SET pinned=EXCLUDED.pinned, "pinOrder"=EXCLUDED."pinOrder", "listOrder"=EXCLUDED."listOrder", "updatedAt"=now()`,
      [userId, keys, order.pinned.length])
    for (const row of owned.rows) {
      if (row.group) await groupListReadChanged(client, row.key, userId)
      else await botChatChanged(client, userId, row.key)
    }
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw new Error('chat order not saved', { cause: error })
  } finally {
    client.release()
  }
  return 'ok'
}

/**
 * Whether a chat is pinned before the person changes it: the Coordinator is,
 * like any bot they pin, and they can unpin it (Alex: the star is the pin, the
 * same for every bot; the Coordinator is an ordinary bot).
 */
export async function pinnedByDefault(userId: string, botId: string): Promise<boolean> {
  return Boolean((await pool.query('SELECT 1 FROM coordinator_bots WHERE "ownerId"=$1 AND "botId"=$2', [userId, botId])).rowCount)
}
