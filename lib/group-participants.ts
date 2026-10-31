import type { PoolClient } from 'pg'

export interface GroupParticipant {
  id: string; name: string; harness: string; avatarUrl: null
  memberType?: 'bot'; color?: string; shape?: string
}

/** Source-owner identities only. Bot lookup additionally requires the exact
 * source workspace, never a guessed alias to an internal execution agent.
 */
export async function groupParticipants(client: PoolClient, conversationId: string, ownerId: string, workspaceId: string): Promise<GroupParticipant[]> {
  const members = (await client.query<{ memberType: string; memberId: string }>(`SELECT "memberType","memberId" FROM conversation_members
    WHERE "conversationId"=$1 AND "memberType" IN ('agent','bot') AND "leftAt" IS NULL ORDER BY "memberId"`, [conversationId])).rows
  const agents = members.filter(m => m.memberType === 'agent').map(m => m.memberId)
  const bots = members.filter(m => m.memberType === 'bot').map(m => m.memberId)
  const found: GroupParticipant[] = []
  if (agents.length) found.push(...(await client.query<GroupParticipant>(`SELECT id,name,harness,NULL AS "avatarUrl" FROM agents WHERE "userId"=$1 AND id=ANY($2::uuid[])`, [ownerId, agents])).rows)
  if (bots.length) found.push(...(await client.query<GroupParticipant>(`SELECT id,name,'ai_sdk' AS harness,NULL AS "avatarUrl",'bot' AS "memberType",color,shape
    FROM bots WHERE "ownerId"=$1 AND "workspaceId"=$2 AND id=ANY($3::uuid[])`, [ownerId, workspaceId, bots])).rows)
  return members.flatMap(member => { const row = found.find(p => p.id === member.memberId && (p.memberType ?? 'agent') === member.memberType); return row ? [row] : [] })
}
