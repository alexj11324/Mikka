import type { RunChainQueryable } from './run-chain'
import type { DirectoryInput } from './conversation-directory-input'

/** Named chats use the ordinary group membership, activity and message storage.
 * Existing group-only chats keep their independent navigation entry. */
export async function standaloneChatDirectory(database: RunChainQueryable, owner: string, workspace: string, input: DirectoryInput) {
  if (input.state && input.state !== 'all' && input.state !== 'idle') return []
  const result = await database.query(`SELECT c.id,c.title,(c."conversationPinnedAt" IS NOT NULL) AS pinned,
      (coalesce(cp."markedUnread",false) OR EXISTS (SELECT 1 FROM conversation_messages unread
        WHERE unread."conversationId"=c.id AND unread.position>coalesce(receipt."lastReadPosition",0)
          AND NOT (unread."authorType"='user' AND unread."authorId"=$1))) AS unread,
      to_char(activity.at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at
    FROM conversations c JOIN conversation_members member ON member."conversationId"=c.id AND member."memberType"='user'
      AND member."memberId"=$1 AND member."leftAt" IS NULL
    LEFT JOIN conversation_reads receipt ON receipt."userId"=$1 AND receipt."conversationId"=c.id::text
    LEFT JOIN chat_preferences cp ON cp."userId"=$1 AND cp."chatKey"=c.id::text
    LEFT JOIN LATERAL (SELECT m."createdAt" FROM conversation_messages m
      WHERE m."conversationId"=c.id ORDER BY m.position DESC LIMIT 1) last ON true
    CROSS JOIN LATERAL (SELECT greatest(c."createdAt", last."createdAt") AS at) activity
    WHERE c."workspaceId"=$2 AND c."createdBy"=$1 AND c."creationPurpose"='conversation' AND c.kind='group'
      AND (c."conversationArchivedAt" IS NOT NULL)=$8 AND strpos(lower(c.title),lower($3))>0
      AND ($4::uuid IS NULL OR EXISTS (SELECT 1 FROM conversation_members bot
        WHERE bot."conversationId"=c.id AND bot."memberType"='bot' AND bot."memberId"=($4::uuid)::text AND bot."leftAt" IS NULL))
      AND ($5::uuid IS NULL OR ((c."conversationPinnedAt" IS NOT NULL),activity.at,c.id)<($6::boolean,$7::timestamptz,$5::uuid))
    ORDER BY pinned DESC,activity.at DESC,c.id DESC LIMIT 101`,[owner,workspace,input.search ?? '',input.botId ?? null,input.cursor?.id ?? null,
      input.cursor?.pinned ?? false,input.cursor?.at ?? null,input.archived])
  return (result.rows as {id:string;title:string;at:string;pinned:boolean;unread:boolean}[]).map(row=>({
    ...row, kind:'chat' as const, issueId:null, identifier:null, state:'idle' as const,
  }))
}
