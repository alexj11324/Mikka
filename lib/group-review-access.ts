import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import type { Directory } from './group-conversations-store'

export class ReviewFailure extends Error {
  constructor(readonly status: number, readonly code: string) { super(code) }
}
export function reject(status: number, code: string): never { throw new ReviewFailure(status, code) }
export async function transaction<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try { await client.query('BEGIN'); const result = await fn(client); await client.query('COMMIT'); return result }
  catch (error) { await client.query('ROLLBACK'); throw error }
  finally { client.release() }
}
/** Conversation lock is always first; all writes and revocations share this order. */
export async function requireGroup(client: PoolClient, directory: Directory, conversationId: string, userId: string) {
  const group = (await client.query(`SELECT * FROM conversations WHERE id=$1 AND kind='group' FOR UPDATE`, [conversationId])).rows[0]
  const member = (await client.query(`SELECT * FROM conversation_members WHERE "conversationId"=$1 AND "memberType"='user' AND "memberId"=$2 AND "leftAt" IS NULL FOR SHARE`, [conversationId, userId])).rows[0]
  if (!group || !member || !await directory(group.workspaceId, userId, [], client)) return reject(404, 'not_found')
  return { group, member }
}
/** Grant owner remains an active human member and still owns this agent. Never enumerate private agents. */
export async function requireAgent(client: PoolClient, directory: Directory, conversationId: string, workspaceId: string, agentId: string) {
  const row = (await client.query(`SELECT g.*, m."joinedAt" AS "agentJoinedAt" FROM conversation_agent_grants g
    JOIN conversation_members m ON m."conversationId"=g."conversationId" AND m."memberType"='agent' AND m."memberId"=g."agentId"::text AND m."leftAt" IS NULL
    JOIN conversation_members owner ON owner."conversationId"=g."conversationId" AND owner."memberType"='user' AND owner."memberId"=g."ownerId" AND owner."leftAt" IS NULL
    WHERE g."conversationId"=$1 AND g."agentId"=$2 AND g."revokedAt" IS NULL FOR SHARE OF g,m,owner`, [conversationId, agentId])).rows[0]
  if (!row || !await directory(workspaceId, row.ownerId, [{ memberType: 'agent', memberId: agentId }], client)) return reject(403, 'agent_grant_required')
  return row
}
export async function grantAgent(client: PoolClient, conversationId: string, agentId: string, ownerId: string) {
  await client.query(`INSERT INTO conversation_agent_grants (id,"conversationId","agentId","ownerId") VALUES ($1,$2,$3,$4) ON CONFLICT ("conversationId","agentId") WHERE "revokedAt" IS NULL DO NOTHING`, [randomUUID(), conversationId, agentId, ownerId])
}
export async function enqueueWork(client: PoolClient, directory: Directory, conversationId: string, userId: string, triggerMessageId: string, agentId: string, round = 0, ordinal = 0) {
  const { group } = await requireGroup(client, directory, conversationId, userId)
  const grant = await requireAgent(client, directory, conversationId, group.workspaceId, agentId)
  const id = randomUUID()
  const row = (await client.query(`INSERT INTO conversation_work (id,"conversationId","triggerMessageId","agentId","grantId","requestedBy","requesterJoinedAt","agentJoinedAt",round,ordinal)
    SELECT $1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6::text,u."joinedAt",a."joinedAt",$7::integer,$8::integer FROM conversation_members u JOIN conversation_members a ON a."conversationId"=u."conversationId"
    WHERE u."conversationId"=$2 AND u."memberType"='user' AND u."memberId"=$6 AND a."memberType"='agent' AND a."memberId"=$4::text
    ON CONFLICT ("triggerMessageId","agentId",round) DO NOTHING RETURNING *`, [id, conversationId, triggerMessageId, agentId, grant.id, userId, round, ordinal])).rows[0]
  return row ?? (await client.query('SELECT * FROM conversation_work WHERE "triggerMessageId"=$1 AND "agentId"=$2 AND round=$3', [triggerMessageId, agentId, round])).rows[0]
}
export async function appendGroupMessage(client: PoolClient, conversationId: string, authorType: 'user' | 'agent', authorId: string, body: string, replyToId: string | null = null) {
  const position = (await client.query('UPDATE conversations SET "lastPosition"="lastPosition"+1 WHERE id=$1 RETURNING "lastPosition"', [conversationId])).rows[0].lastPosition
  return (await client.query(`INSERT INTO conversation_messages (id,"conversationId",position,"authorType","authorId",body,"replyToId") VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`, [randomUUID(), conversationId, position, authorType, authorId, body, replyToId])).rows[0]
}
/** Revocation also removes unsent inputs; running work receives no permission to post late. */
export async function cancelWork(client: PoolClient, conversationId: string, filter: { agentId?: string; userId?: string; workId?: string } = {}) {
  await client.query(`UPDATE conversation_work w SET status='cancelled' WHERE "conversationId"=$1 AND status IN ('pending','dispatched')
    AND ($2::uuid IS NULL OR "agentId"=$2) AND ($3::text IS NULL OR "requestedBy"=$3 OR EXISTS (SELECT 1 FROM conversation_agent_grants g WHERE g.id=w."grantId" AND g."ownerId"=$3)) AND ($4::uuid IS NULL OR id=$4)`, [conversationId, filter.agentId ?? null, filter.userId ?? null, filter.workId ?? null])
  // Stop only a bound dedicated run. Never touch an owner's private session.
  await client.query(`UPDATE agent_runs r SET "stopRequestedAt"=COALESCE(r."stopRequestedAt",now()), status='cancelled', "finishedAt"=COALESCE(r."finishedAt",now()) FROM conversation_work w
    WHERE w."conversationId"=$1 AND w.status='cancelled' AND r.id=w."runId" AND r.kind='group_review'`, [conversationId])
  await client.query(`DELETE FROM run_messages m USING conversation_work w, agent_runs r
    WHERE w."conversationId"=$1 AND w.status='cancelled' AND r.id=w."runId" AND r.kind='group_review'
    AND m."runId"=r.id AND m."deliveredAt" IS NULL`, [conversationId])
}
