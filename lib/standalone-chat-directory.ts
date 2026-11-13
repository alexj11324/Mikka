import type { RunChainQueryable } from './run-chain'
import type { DirectoryInput } from './conversation-directory-input'

/** Named chats use the ordinary group membership, activity and message storage.
 * Existing group-only chats keep their independent navigation entry. */
export async function standaloneChatDirectory(database: RunChainQueryable, owner: string, workspace: string, input: DirectoryInput) {
  if (input.archived || (input.state && input.state !== 'all' && input.state !== 'idle')) return []
  const result = await database.query(`SELECT c.id,c.title,
      to_char(activity.at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at
    FROM conversations c JOIN conversation_members member ON member."conversationId"=c.id AND member."memberType"='user'
      AND member."memberId"=$1 AND member."leftAt" IS NULL
    JOIN mikka_workspace_members w ON w."userId"=$1 AND w."workspaceId"=c."workspaceId" AND w.status='active'
    LEFT JOIN LATERAL (SELECT m."createdAt" FROM conversation_messages m
      WHERE m."conversationId"=c.id ORDER BY m.position DESC LIMIT 1) last ON true
    CROSS JOIN LATERAL (SELECT greatest(c."createdAt", last."createdAt") AS at) activity
    WHERE c."workspaceId"=$2 AND c."createdBy"=$1 AND c."creationPurpose"='conversation' AND c.kind='group'
      AND strpos(lower(c.title),lower($3))>0
      AND ($4::uuid IS NULL OR EXISTS (SELECT 1 FROM conversation_members bot
        WHERE bot."conversationId"=c.id AND bot."memberType"='bot' AND bot."memberId"=($4::uuid)::text AND bot."leftAt" IS NULL))
      AND ($5::uuid IS NULL OR $6::boolean OR (activity.at,c.id)<($7::timestamptz,$5::uuid))
    ORDER BY activity.at DESC,c.id DESC LIMIT 101`,[owner,workspace,input.search ?? '',input.botId ?? null,input.cursor?.id ?? null,
      input.cursor?.pinned ?? false,input.cursor?.at ?? null])
  return (result.rows as {id:string;title:string;at:string}[]).map(row=>({
    ...row, kind:'chat' as const, issueId:null, identifier:null, state:'idle' as const, pinned:false,
  }))
}
