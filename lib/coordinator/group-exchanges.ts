import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'

/** Called only by the group-turn host, inside its locked and reauthorized
 * source-group transaction. No request/model can select a source or DM ID.
 */
export async function appendGroupExchange(client: PoolClient, input: {
  sourceId: string; anchorId: string; ownerId: string; workspaceId: string
  senderId: string; recipientId: string; text: string; title: string; linkId?: string
  senderType?: 'agent' | 'bot'; recipientType?: 'agent' | 'bot'
}): Promise<{ linkId: string }> {
  const pair = [{ id: input.senderId, type: input.senderType ?? 'agent' }, { id: input.recipientId, type: input.recipientType ?? 'agent' }]
    .sort((a, b) => `${a.type}:${a.id}`.localeCompare(`${b.type}:${b.id}`))
  if (input.senderId === input.recipientId) throw new Error('group_private_peer_required')
  const anchor = (await client.query(`SELECT m.position::text FROM conversation_messages m JOIN conversations c ON c.id=m."conversationId"
    WHERE c.id=$1 AND c.kind='group' AND c."createdBy"=$2 AND c."workspaceId"=$3 AND m.id=$4 AND m."authorType"='user'`,
  [input.sourceId, input.ownerId, input.workspaceId, input.anchorId])).rows[0]
  if (!anchor) throw new Error('group_private_source_unavailable')
  const identities = pair.map(member => `${member.type}:${member.id}`)
  const linked = await client.query<{ id: string; linkedConversationId: string; lastPosition: string }>(`SELECT l.id,l."linkedConversationId",l."lastPosition"::text
    FROM conversation_links l JOIN conversations dm ON dm.id=l."linkedConversationId"
    WHERE l."sourceConversationId"=$1 AND dm.kind='agent_dm' AND dm."createdBy"=$2 AND dm."workspaceId"=$3
      AND (SELECT array_agg(cm."memberType" || ':' || cm."memberId" ORDER BY cm."memberType",cm."memberId") FROM conversation_members cm
        WHERE cm."conversationId"=dm.id AND cm."leftAt" IS NULL)=$4::text[]
      AND ($5::uuid IS NULL OR (l.id=$5 AND l."anchorPosition"=$6)) ORDER BY l."anchorPosition" DESC,l.id LIMIT 1 FOR UPDATE OF dm,l`,
  [input.sourceId, input.ownerId, input.workspaceId, identities, input.linkId ?? null, anchor.position])
  const previous = linked.rows[0]
  if (input.linkId && !previous) throw new Error('group_private_link_unavailable')
  let dmId = previous?.linkedConversationId
  if (!dmId) {
    dmId = randomUUID()
    await client.query(`INSERT INTO conversations(id,"workspaceId",kind,title,"createdBy") VALUES($1,$2,'agent_dm',$3,$4)`,
    [dmId, input.workspaceId, input.title, input.ownerId])
    for (const member of pair) await client.query(`INSERT INTO conversation_members("conversationId","memberType","memberId",role) VALUES($1,$2,$3,'member')`, [dmId, member.type, member.id])
  }
  const position = (await client.query(`UPDATE conversations SET "lastPosition"="lastPosition"+1 WHERE id=$1 RETURNING "lastPosition"::text AS position`, [dmId])).rows[0].position
  await client.query(`INSERT INTO conversation_messages(id,"conversationId",position,"authorType","authorId",body) VALUES($1,$2,$3,$4,$5,$6)`,
  [randomUUID(), dmId, position, input.senderType ?? 'agent', input.senderId, input.text])
  if (input.linkId && previous && BigInt(previous.lastPosition) + BigInt(1) === BigInt(position)) {
    await client.query(`UPDATE conversation_links SET "lastPosition"=$2,"messageCount"="messageCount"+1 WHERE id=$1 AND "anchorPosition"=$3`, [previous.id, position, anchor.position])
    return { linkId: previous.id }
  }
  const linkId = randomUUID()
  await client.query(`INSERT INTO conversation_links(id,"sourceConversationId","linkedConversationId","anchorPosition","firstPosition","lastPosition","messageCount") VALUES($1,$2,$3,$4,$5,$5,1)`,
  [linkId, input.sourceId, dmId, anchor.position, position])
  return { linkId }
}
