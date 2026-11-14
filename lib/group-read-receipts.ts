import type { PoolClient } from 'pg'

/** The caller holds the conversation locks and has admitted each participant.
 * An ordinary history read acknowledges its observed message. A directory
 * read-all takes the latest committed message under those same locks. */
export async function acknowledgeGroupReads(client: PoolClient, ownerId: string, conversationIds: string[], observed?: { messageId: string | null; revision?: number }) {
  if (!conversationIds.length) return false
  const { rows: [result] } = await client.query<{ changed: boolean }>(`WITH snapshots AS (
    SELECT chat.id::text AS key,message.id::text AS message,message.position
    FROM unnest($2::uuid[]) AS chat(id)
    LEFT JOIN LATERAL (SELECT m.id,m.position FROM conversation_messages m
      WHERE m."conversationId"=chat.id AND m.position<=2147483647
        AND ($4::boolean OR m.id=$3::uuid)
      ORDER BY m.position DESC LIMIT 1) message ON true
  ), advanced AS (
    INSERT INTO conversation_reads AS r ("userId","conversationId","lastReadPosition","lastReadMessageId","updatedAt")
    SELECT $1,key,position,message,now() FROM snapshots WHERE position IS NOT NULL
    ORDER BY key
    ON CONFLICT ("userId","conversationId") DO UPDATE SET
      "lastReadPosition"=EXCLUDED."lastReadPosition","lastReadMessageId"=EXCLUDED."lastReadMessageId","updatedAt"=now()
    WHERE EXCLUDED."lastReadPosition">r."lastReadPosition" RETURNING 1
  ), cleared AS (
    UPDATE chat_preferences p SET "markedUnread"=false,"updatedAt"=now() FROM snapshots s
    WHERE p."userId"=$1 AND p."chatKey"=s.key AND p."markedUnread"
      AND ($4::boolean OR (coalesce(s.position,0) >= coalesce((SELECT r."lastReadPosition" FROM conversation_reads r WHERE r."userId"=$1 AND r."conversationId"=s.key),0)
        AND ($5::integer IS NULL OR $5=coalesce((SELECT r."unreadRevision" FROM conversation_reads r WHERE r."userId"=$1 AND r."conversationId"=s.key),0))))
    RETURNING 1
  ) SELECT EXISTS (SELECT FROM advanced) OR EXISTS (SELECT FROM cleared) AS changed`,
  [ownerId, conversationIds, observed?.messageId ?? null, !observed, observed?.revision ?? null])
  return result.changed
}
