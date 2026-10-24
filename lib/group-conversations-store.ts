import { createHash, randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { z } from 'zod'
import { cancelWork, enqueueWork, grantAgent, requireAgent, ReviewFailure } from './group-review-access'
import { mentionRoute } from './coordinator/group-routing'

const member = z.object({ memberType: z.enum(['user', 'agent']), memberId: z.string().min(1).max(256) }).strict()
const create = z.object({ workspaceId: z.uuid(), title: z.string().trim().min(1).max(200), members: z.array(member).max(100).default([]) }).strict()
const message = z.object({ clientMessageId: z.uuid().optional(), body: z.string().trim().min(1).max(32000), mentions: z.array(member).max(100).default([]), replyToId: z.uuid().nullable().optional() }).strict()
export type Member = z.infer<typeof member>
export type Directory = (workspaceId: string, userId: string, members: Member[], client?: PoolClient) => Promise<boolean>
export type GroupRequest = { userId: string | null; method: 'GET' | 'POST' | 'DELETE'; resource: 'conversations' | 'messages' | 'members'; id?: string; origin: string | null; host: string; body?: string; before?: string | null; limit?: string | null; workspaceId?: string | null }
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
export async function handleGroup(pool: Pool, directory: Directory, req: GroupRequest): Promise<{ status: number; body: unknown }> {
  let client: PoolClient | undefined
  try {
    const userId = req.userId
    if (!userId) return fail(401)
    if (req.method !== 'GET' && req.origin) {
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
      if (!await directory(input.workspaceId, userId, input.members, client)) return fail(404)
      const id = randomUUID()
      await q('INSERT INTO conversations (id,"workspaceId",kind,title,"createdBy") VALUES ($1,$2,\'group\',$3,$4)', [id, input.workspaceId, input.title, userId])
      await q('INSERT INTO conversation_members ("conversationId","memberType","memberId",role) VALUES ($1,\'user\',$2,\'owner\')', [id, userId])
      for (const m of input.members) {
        await q('INSERT INTO conversation_members ("conversationId","memberType","memberId",role) VALUES ($1,$2,$3,\'member\') ON CONFLICT DO NOTHING', [id, m.memberType, m.memberId])
        if (m.memberType === 'agent') await grantAgent(client, id, m.memberId, userId)
      }
      result = { id, title: input.title }; status = 201
    } else if (req.resource === 'conversations' && req.method === 'GET') {
      if (req.workspaceId && (!z.uuid().safeParse(req.workspaceId).success || !await directory(req.workspaceId, userId, [], client))) return fail(404)
      const { rows } = await q(`SELECT c.*, last.message AS "lastMessage",
        (SELECT count(*)::text FROM conversation_messages m WHERE m."conversationId"=c.id
          AND m.position > COALESCE(r."lastReadPosition",0) AND NOT (m."authorType"='user' AND m."authorId"=$1)) AS "unreadCount"
        FROM conversations c JOIN conversation_members cm ON cm."conversationId"=c.id AND cm."memberType"='user' AND cm."memberId"=$1 AND cm."leftAt" IS NULL
        LEFT JOIN conversation_reads r ON r."conversationId"=c.id::text AND r."userId"=$1
        LEFT JOIN LATERAL (SELECT to_jsonb(m) || jsonb_build_object('position', m.position::text) AS message FROM conversation_messages m WHERE m."conversationId"=c.id ORDER BY position DESC LIMIT 1) last ON true
        WHERE c.kind='group' AND ($2::uuid IS NULL OR c."workspaceId"=$2) ORDER BY c."createdAt" DESC,c.id DESC`, [userId, req.workspaceId ?? null])
      const accessible = []
      for (const row of rows) if (await directory(row.workspaceId, userId, [], client)) accessible.push(row)
      result = { conversations: accessible }
    } else {
      // Acquire the serialization lock before reading membership in a new statement.
      // A joined SELECT FOR UPDATE can retain a pre-wait membership snapshot.
      const { rows: groups } = await q(`SELECT * FROM conversations WHERE id=$1 AND kind='group' FOR UPDATE`, [req.id])
      const group = groups[0]
      const { rows: memberships } = await q(`SELECT role FROM conversation_members WHERE "conversationId"=$1 AND "memberType"='user' AND "memberId"=$2 AND "leftAt" IS NULL`, [req.id, userId])
      if (!group || !memberships.length || !await directory(group.workspaceId, userId, [], client)) return fail(404)
      group.role = memberships[0].role
      if (req.resource === 'members' && req.method === 'GET') {
        const rows = (await q(`SELECT cm."memberType",cm."memberId",cm.role, CASE WHEN cm."memberType"='user' THEN u.name ELSE a.name END AS name
          FROM conversation_members cm LEFT JOIN "user" u ON cm."memberType"='user' AND u.id=cm."memberId"
          LEFT JOIN agents a ON cm."memberType"='agent' AND a.id::text=cm."memberId"
          WHERE cm."conversationId"=$1 AND cm."leftAt" IS NULL ORDER BY cm."joinedAt",cm."memberId"`, [req.id])).rows
        for (const row of rows) {
          row.active = await directory(group.workspaceId, row.memberType === 'user' ? row.memberId : userId, [], client)
          if (row.memberType === 'agent') {
            try { await requireAgent(client, directory, req.id!, group.workspaceId, row.memberId) }
            catch (error) { if (!(error instanceof ReviewFailure)) throw error; row.active = false; row.name = null }
          }
        }
        result = { conversation: { id: group.id, workspaceId: group.workspaceId, title: group.title, role: group.role }, members: rows, capabilities: { agentExecution: false } }
      } else if (req.resource === 'messages' && req.method === 'GET') {
        const before = req.before == null ? null : decimal(req.before, '')
        const limit = Number(decimal(req.limit, '50'))
        if (limit > 100) return fail(422)
        const { rows } = await q('SELECT * FROM conversation_messages WHERE "conversationId"=$1 AND ($2::bigint IS NULL OR position < $2) ORDER BY position DESC LIMIT $3', [req.id, before, limit + 1])
        const more = rows.length > limit
        const messages = rows.slice(0, limit)
        result = { messages, nextBefore: more ? messages.at(-1)?.position : null }
      } else if (req.resource === 'messages' && req.method === 'POST') {
        const input = parse(message, req.body)
        if (!await directory(group.workspaceId, userId, input.mentions.filter(m => m.memberType === 'user'), client)) return fail(422)
        for (const m of input.mentions) {
          const { rowCount } = await q('SELECT 1 FROM conversation_members WHERE "conversationId"=$1 AND "memberType"=$2 AND "memberId"=$3 AND "leftAt" IS NULL', [req.id, m.memberType, m.memberId])
          if (!rowCount) return fail(422)
          if (m.memberType === 'agent') {
            if (!z.uuid().safeParse(m.memberId).success) return fail(422)
            await requireAgent(client, directory, req.id!, group.workspaceId, m.memberId)
          }
        }
        if (input.replyToId) {
          const { rowCount } = await q('SELECT 1 FROM conversation_messages WHERE id=$1 AND "conversationId"=$2', [input.replyToId, req.id])
          if (!rowCount) return fail(422)
        }
        const hash = createHash('sha256').update(JSON.stringify({ body: input.body, mentions: input.mentions, replyToId: input.replyToId ?? null })).digest('hex')
        const prior = input.clientMessageId ? (await q('SELECT * FROM conversation_message_keys WHERE "conversationId"=$1 AND "userId"=$2 AND key=$3', [req.id, userId, input.clientMessageId])).rows[0] : null
        if (prior) {
          if (prior.hash !== hash) return fail(409)
          result = (await q('SELECT * FROM conversation_messages WHERE id=$1', [prior.messageId])).rows[0]
          await client.query('COMMIT')
          return { status: 200, body: result }
        }
        const { rows: positions } = await q('UPDATE conversations SET "lastPosition"="lastPosition"+1 WHERE id=$1 RETURNING "lastPosition"::text AS position', [req.id])
        const id = randomUUID(), position = positions[0].position
        const { rows } = await q('INSERT INTO conversation_messages (id,"conversationId",position,"authorType","authorId",body,mentions,"replyToId") VALUES ($1,$2,$3,\'user\',$4,$5,$6,$7) RETURNING *', [id, req.id, position, userId, input.body, JSON.stringify(input.mentions), input.replyToId ?? null])
        if (input.clientMessageId) await q('INSERT INTO conversation_message_keys ("conversationId","userId",key,hash,"messageId") VALUES ($1,$2,$3,$4,$5)', [req.id, userId, input.clientMessageId, hash, id])
        // Explicit mentions reuse the existing router's deterministic rule. Unaddressed
        // messages wait for a human choice; this path never calls a decision model.
        const agentIds = input.mentions.filter(m => m.memberType === 'agent').map(m => m.memberId)
        const route = mentionRoute({ text: input.body, mentions: agentIds }, agentIds.map(id => ({ id, name: '', description: '' })))
        for (const agentId of route?.responders ?? []) await enqueueWork(client, directory, req.id!, userId, id, agentId)
        result = rows[0]; status = 201
      } else if (req.resource === 'members' && ['POST', 'DELETE'].includes(req.method)) {
        if (group.role !== 'owner') return fail(403)
        const input = parse(member, req.body)
        if (req.method === 'POST') {
          if (!await directory(group.workspaceId, userId, [input], client)) return fail(404)
          await q(`INSERT INTO conversation_members ("conversationId","memberType","memberId",role) VALUES ($1,$2,$3,'member')
            ON CONFLICT ("conversationId","memberType","memberId") DO UPDATE SET "leftAt"=NULL,"joinedAt"=CASE WHEN conversation_members."leftAt" IS NULL THEN conversation_members."joinedAt" ELSE now() END`, [req.id, input.memberType, input.memberId])
          if (input.memberType === 'agent') await grantAgent(client, req.id!, input.memberId, userId)
        } else {
          // Owner transfer is not part of this API; never strand a group with no owner.
          const { rows } = await q('SELECT role FROM conversation_members WHERE "conversationId"=$1 AND "memberType"=$2 AND "memberId"=$3 AND "leftAt" IS NULL', [req.id, input.memberType, input.memberId])
          if (!rows.length) return fail(404)
          if (rows[0].role === 'owner') return fail(422)
          await q('UPDATE conversation_members SET "leftAt"=now() WHERE "conversationId"=$1 AND "memberType"=$2 AND "memberId"=$3', [req.id, input.memberType, input.memberId])
          await cancelWork(client, req.id!, input.memberType === 'agent' ? { agentId: input.memberId } : { userId: input.memberId })
          await q('UPDATE conversation_agent_grants SET "revokedAt"=now() WHERE "conversationId"=$1 AND "revokedAt" IS NULL AND ("agentId"::text=$2 OR "ownerId"=$2)', [req.id, input.memberId])
        }
        result = { ok: true }
      } else return fail(405)
    }
    await client.query('COMMIT')
    return { status, body: result }
  } catch (error) {
    if (client) await client.query('ROLLBACK')
    if (error instanceof ReviewFailure) return { status: error.status, body: { error: error.code } }
    if (error instanceof Failure) return { status: error.status, body: { error: ({ 401: 'unauthorized', 403: 'forbidden', 404: 'not_found', 422: 'invalid_input', 405: 'method_not_allowed', 409: 'conflict' } as Record<number, string>)[error.status] } }
    throw error
  } finally { client?.release() }
}
