import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { z } from 'zod'
import { enqueueGroupTurn } from './coordinator/group-turns'

const member = z.object({ memberType: z.enum(['user', 'agent']), memberId: z.string().min(1).max(256) }).strict()
const create = z.object({ workspaceId: z.uuid(), title: z.string().trim().min(1).max(200), members: z.array(member).max(100).default([]), leadAgentId: z.uuid().nullable().optional() }).strict()
const configure = z.object({ leadAgentId: z.uuid().nullable() }).strict()
const message = z.object({ body: z.string().trim().min(1).max(32000), mentions: z.array(member).max(100).default([]), replyToId: z.uuid().nullable().optional() }).strict()
const read = z.object({ messageId: z.string().min(1).max(64) }).strict()
export type Member = z.infer<typeof member>
export type Directory = (workspaceId: string, userId: string, members: Member[]) => Promise<boolean>
export type GroupRequest = { userId: string | null; method: 'GET' | 'POST' | 'DELETE' | 'PATCH'; resource: 'conversations' | 'messages' | 'members' | 'read' | 'links'; id?: string; origin: string | null; host: string; body?: string; before?: string | null; limit?: string | null; workspaceId?: string | null }
class Failure extends Error { constructor(readonly status: number) { super(String(status)) } }
const fail = (status: number): never => { throw new Failure(status) }
function parse<T>(schema: z.ZodType<T>, body?: string): T {
  let data: unknown
  try { data = JSON.parse(body ?? '') } catch { return fail(422) }
  const result = schema.safeParse(data)
  if (!result.success) return fail(422)
  return result.data
}
function decimal(value: string | null | undefined, fallback: string) {
  const result = value ?? fallback
  if (!/^[1-9][0-9]*$/.test(result) || BigInt(result) > BigInt("9223372036854775807")) return fail(422)
  return result
}
/** Authenticate before checking existence. All history access is private and group-only.
 * Lock the conversation before membership changes and messages: removal cannot race a send.
 * bigint positions are JSON strings (never lossy JS numbers).
 */
export async function handleGroup(pool: Pool, directory: Directory, req: GroupRequest, queueAgents = false): Promise<{ status: number; body: unknown }> {
  let client: PoolClient | undefined
  try {
    const userId = req.userId
    if (!userId) return fail(401)
    if ((req.method !== 'GET' || req.resource === 'read' || req.resource === 'links') && req.origin) {
      let origin: URL
      try { origin = new URL(req.origin) } catch { return fail(403) }
      if (!['https:', 'http:'].includes(origin.protocol) || origin.host !== req.host) return fail(403)
    }
    if (req.id && !z.uuid().safeParse(req.id).success) return fail(404)
    client = await pool.connect()
    await client.query('BEGIN')
    const q = client.query.bind(client)
    let result: unknown
    let status = 200
    if (req.resource === 'conversations' && req.method === 'POST') {
      const input = parse(create, req.body)
      if (!await directory(input.workspaceId, userId, input.members)) return fail(404)
      if (input.leadAgentId && (!queueAgents || !input.members.some(m => m.memberType === 'agent' && m.memberId === input.leadAgentId))) return fail(422)
      const id = randomUUID()
      await q('INSERT INTO conversations (id,"workspaceId",kind,title,"createdBy") VALUES ($1,$2,\'group\',$3,$4)', [id, input.workspaceId, input.title, userId])
      await q('INSERT INTO conversation_members ("conversationId","memberType","memberId",role) VALUES ($1,\'user\',$2,\'owner\')', [id, userId])
      for (const m of input.members) await q('INSERT INTO conversation_members ("conversationId","memberType","memberId",role) VALUES ($1,$2,$3,\'member\') ON CONFLICT DO NOTHING', [id, m.memberType, m.memberId])
      if (queueAgents && input.leadAgentId) await q('UPDATE conversations SET "leadAgentId"=$2 WHERE id=$1', [id, input.leadAgentId])
      result = { id, title: input.title, ...(queueAgents ? { leadAgentId: input.leadAgentId ?? null } : {}) }; status = 201
    } else if (req.resource === 'conversations' && req.method === 'GET') {
      if (req.workspaceId && (!z.uuid().safeParse(req.workspaceId).success || !await directory(req.workspaceId, userId, []))) return fail(404)
      const { rows } = await q(`SELECT c.*, last.message AS "lastMessage",
        (SELECT count(*)::text FROM conversation_messages m WHERE m."conversationId"=c.id
          AND m.position > COALESCE(r."lastReadPosition",0) AND NOT (m."authorType"='user' AND m."authorId"=$1)) AS "unreadCount"
        FROM conversations c JOIN conversation_members cm ON cm."conversationId"=c.id AND cm."memberType"='user' AND cm."memberId"=$1 AND cm."leftAt" IS NULL
        LEFT JOIN conversation_reads r ON r."conversationId"=c.id::text AND r."userId"=$1
        LEFT JOIN LATERAL (SELECT to_jsonb(m) || jsonb_build_object('position', m.position::text) AS message FROM conversation_messages m WHERE m."conversationId"=c.id ORDER BY position DESC LIMIT 1) last ON true
        WHERE c.kind='group' AND ($2::uuid IS NULL OR c."workspaceId"=$2) ORDER BY c."createdAt" DESC,c.id DESC`, [userId, req.workspaceId ?? null])
      const accessible = []
      for (const row of rows) if (await directory(row.workspaceId, userId, [])) accessible.push(row)
      result = { conversations: accessible }
    } else {
      // A link is a bounded view granted by its source group, never membership
      // in the private DM. Locate the group before taking the normal group lock.
      let groupId = req.id
      if (req.resource === 'links') {
        const { rows: [link] } = await q('SELECT "sourceConversationId" FROM conversation_links WHERE id=$1', [req.id])
        if (!link) return fail(404)
        groupId = link.sourceConversationId
      }
      // Acquire the serialization lock before reading membership in a new statement.
      // A joined SELECT FOR UPDATE can retain a pre-wait membership snapshot.
      const { rows: groups } = await q(`SELECT * FROM conversations WHERE id=$1 AND kind='group' FOR UPDATE`, [groupId])
      const group = groups[0]
      const { rows: memberships } = await q(`SELECT role FROM conversation_members WHERE "conversationId"=$1 AND "memberType"='user' AND "memberId"=$2 AND "leftAt" IS NULL`, [groupId, userId])
      if (!group || !memberships.length || !await directory(group.workspaceId, userId, [])) return fail(404)
      group.role = memberships[0].role
      if (req.resource === 'links' && req.method === 'GET') {
        const { rows: [link] } = await q(`SELECT l."linkedConversationId",l."firstPosition"::text,l."lastPosition"::text,l."messageCount"::text
          FROM conversation_links l JOIN conversations dm ON dm.id=l."linkedConversationId"
          WHERE l.id=$1 AND l."sourceConversationId"=$2 AND dm.kind='agent_dm' AND dm."workspaceId"=$3 AND dm."createdBy"=$4
          FOR SHARE OF l,dm`, [req.id, group.id, group.workspaceId, group.createdBy])
        if (!link) return fail(404)
        const { rows: members } = await client.query<{ id: string; name: string; harness: string }>(`SELECT cm."memberId" AS id,a.name,a.harness
          FROM conversation_members cm JOIN agents a ON a.id::text=cm."memberId" AND a."userId"=$2
          WHERE cm."conversationId"=$1 AND cm."memberType"='agent' AND cm."leftAt" IS NULL ORDER BY cm."memberId"`, [link.linkedConversationId, group.createdBy])
        if (members.length !== 2) return fail(404)
        const participants = members.map(m => ({ ...m, avatarUrl: null }))
        const before = req.before == null ? null : decimal(req.before, '')
        const limit = Number(decimal(req.limit, '50'))
        if (limit > 100) return fail(422)
        const { rows } = await q(`SELECT id,position::text,body,"authorId","createdAt" FROM conversation_messages
          WHERE "conversationId"=$1 AND position BETWEEN $2::bigint AND $3::bigint
            AND ($4::bigint IS NULL OR position<$4) AND "authorType"='agent' AND "authorId"=ANY($5::text[])
          ORDER BY position DESC LIMIT $6`, [link.linkedConversationId, link.firstPosition, link.lastPosition, before, members.map(m => m.id), limit + 1])
        const messages = rows.slice(0, limit).map(m => ({ id: m.id, position: m.position, body: m.body, createdAt: m.createdAt, author: participants.find(p => p.id === m.authorId)! }))
        result = { linkId: req.id, sourceConversationId: group.id, firstPosition: link.firstPosition, lastPosition: link.lastPosition, messageCount: link.messageCount, participants, messages, nextBefore: rows.length > limit ? messages.at(-1)?.position : null }
      } else if (req.resource === 'read' && ['GET', 'POST'].includes(req.method)) {
        if (req.method === 'POST') {
          const input = parse(read, req.body)
          const byId = z.uuid().safeParse(input.messageId).success
          const value = byId ? input.messageId : decimal(input.messageId, '')
          const { rows: messages } = await q(`SELECT id,position FROM conversation_messages WHERE "conversationId"=$1 AND ${byId ? 'id=$2::uuid' : 'position=$2::bigint'}`, [req.id, value])
          const selected = messages[0]
          if (!selected || BigInt(selected.position) > BigInt(2147483647)) return fail(422)
          await q(`INSERT INTO conversation_reads AS r ("userId","conversationId","lastReadPosition","lastReadMessageId","updatedAt") VALUES ($1,$2,$3,$4,now())
            ON CONFLICT ("userId","conversationId") DO UPDATE SET
              "lastReadPosition"=GREATEST(r."lastReadPosition",EXCLUDED."lastReadPosition"),
              "lastReadMessageId"=CASE WHEN EXCLUDED."lastReadPosition">r."lastReadPosition" THEN EXCLUDED."lastReadMessageId" ELSE r."lastReadMessageId" END,
              "updatedAt"=CASE WHEN EXCLUDED."lastReadPosition">r."lastReadPosition" THEN EXCLUDED."updatedAt" ELSE r."updatedAt" END`, [userId, req.id, selected.position, selected.id])
        }
        const { rows: [state] } = await q(`SELECT "lastReadPosition","lastReadMessageId" FROM conversation_reads WHERE "userId"=$1 AND "conversationId"=$2`, [userId, req.id])
        const { rows: [unread] } = await q(`SELECT count(*)::text AS n FROM conversation_messages WHERE "conversationId"=$1 AND position>$2 AND NOT ("authorType"='user' AND "authorId"=$3)`, [req.id, state?.lastReadPosition ?? 0, userId])
        result = { lastReadMessageId: state?.lastReadMessageId ?? null, lastReadPosition: state ? Number(state.lastReadPosition) : null, unreadCount: Number(unread.n) }
      } else if (req.resource === 'conversations' && req.method === 'PATCH') {
        if (group.role !== 'owner' || group.createdBy !== userId) return fail(403)
        if (!queueAgents) return fail(405)
        const input = parse(configure, req.body)
        if (input.leadAgentId) {
          const selected = { memberType: 'agent' as const, memberId: input.leadAgentId }
          if (!await directory(group.workspaceId, group.createdBy, [selected])) return fail(422)
          const { rowCount } = await q(`SELECT 1 FROM conversation_members WHERE "conversationId"=$1 AND "memberType"='agent' AND "memberId"=$2 AND "leftAt" IS NULL`, [req.id, input.leadAgentId])
          if (!rowCount) return fail(422)
        }
        await q('UPDATE conversations SET "leadAgentId"=$2 WHERE id=$1', [req.id, input.leadAgentId])
        result = { id: req.id, leadAgentId: input.leadAgentId }
      } else if (req.resource === 'messages' && req.method === 'GET') {
        const before = req.before == null ? null : decimal(req.before, '')
        const limit = Number(decimal(req.limit, '50'))
        if (limit > 100) return fail(422)
        const { rows } = await q('SELECT * FROM conversation_messages WHERE "conversationId"=$1 AND ($2::bigint IS NULL OR position < $2) ORDER BY position DESC LIMIT $3', [req.id, before, limit + 1])
        const more = rows.length > limit
        const messages = rows.slice(0, limit)
        const active = queueAgents ? await q(`SELECT "agentId",status,"updatedAt" FROM group_turns WHERE "conversationId"=$1 AND status IN ('queued','running') ORDER BY "createdAt" LIMIT 1`, [req.id]) : { rows: [] }
        const failed = queueAgents ? await q(`SELECT error FROM group_turns WHERE "conversationId"=$1 ORDER BY "createdAt" DESC,"messageId" DESC LIMIT 1`, [req.id]) : { rows: [] }
        result = { messages, nextBefore: more ? messages.at(-1)?.position : null, agentStatus: active.rows[0] ?? null,
          ...(queueAgents ? { leadAgentId: group.leadAgentId ?? null, routingError: ['group_judgment_pending','group_lead_required'].includes(failed.rows[0]?.error) ? { code: 'group_judgment_pending' } : null } : {}) }
      } else if (req.resource === 'messages' && req.method === 'POST') {
        const input = parse(message, req.body)
        // Group-selected agents belong to the creator, not necessarily this sender.
        // Caller membership was verified above; directory ownership plus current
        // group membership below still excludes arbitrary/private agent assignment.
        if (!await directory(group.workspaceId, queueAgents ? group.createdBy : userId, input.mentions)) return fail(422)
        for (const m of input.mentions) {
          const { rowCount } = await q('SELECT 1 FROM conversation_members WHERE "conversationId"=$1 AND "memberType"=$2 AND "memberId"=$3 AND "leftAt" IS NULL', [req.id, m.memberType, m.memberId])
          if (!rowCount) return fail(422)
        }
        if (input.replyToId) {
          const { rowCount } = await q('SELECT 1 FROM conversation_messages WHERE id=$1 AND "conversationId"=$2', [input.replyToId, req.id])
          if (!rowCount) return fail(422)
        }
        const { rows: positions } = await q('UPDATE conversations SET "lastPosition"="lastPosition"+1 WHERE id=$1 RETURNING "lastPosition"::text AS position', [req.id])
        const id = randomUUID(), position = positions[0].position
        const { rows } = await q('INSERT INTO conversation_messages (id,"conversationId",position,"authorType","authorId",body,mentions,"replyToId") VALUES ($1,$2,$3,\'user\',$4,$5,$6,$7) RETURNING *', [id, req.id, position, userId, input.body, JSON.stringify(input.mentions), input.replyToId ?? null])
        if (queueAgents) await enqueueGroupTurn(client, req.id!, id, userId)
        result = rows[0]; status = 201
      } else if (req.resource === 'members' && ['POST', 'DELETE'].includes(req.method)) {
        if (group.role !== 'owner') return fail(403)
        const input = parse(member, req.body)
        if (req.method === 'POST') {
          if (!await directory(group.workspaceId, userId, [input])) return fail(404)
          await q(`INSERT INTO conversation_members ("conversationId","memberType","memberId",role) VALUES ($1,$2,$3,'member')
            ON CONFLICT ("conversationId","memberType","memberId") DO UPDATE SET "leftAt"=NULL,"joinedAt"=CASE WHEN conversation_members."leftAt" IS NULL THEN conversation_members."joinedAt" ELSE now() END`, [req.id, input.memberType, input.memberId])
        } else {
          // Owner transfer is not part of this API; never strand a group with no owner.
          const { rows } = await q('SELECT role FROM conversation_members WHERE "conversationId"=$1 AND "memberType"=$2 AND "memberId"=$3 AND "leftAt" IS NULL', [req.id, input.memberType, input.memberId])
          if (!rows.length) return fail(404)
          if (rows[0].role === 'owner') return fail(422)
          if (queueAgents && input.memberType === 'agent') await q('UPDATE conversations SET "leadAgentId"=NULL WHERE id=$1 AND "leadAgentId"=$2', [req.id, input.memberId])
          await q('UPDATE conversation_members SET "leftAt"=now() WHERE "conversationId"=$1 AND "memberType"=$2 AND "memberId"=$3', [req.id, input.memberType, input.memberId])
        }
        result = { ok: true }
      } else return fail(405)
    }
    await client.query('COMMIT')
    return { status, body: result }
  } catch (error) {
    if (client) await client.query('ROLLBACK')
    if (error instanceof Failure) return { status: error.status, body: { error: ({ 401: 'unauthorized', 403: 'forbidden', 404: 'not_found', 422: 'invalid_input', 405: 'method_not_allowed' } as Record<number, string>)[error.status] } }
    throw error
  } finally { client?.release() }
}
