import { createHash, randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { z } from 'zod'
import type { Directory } from './group-conversations-store'
import { reject, requireAgent, requireGroup, transaction, ReviewFailure } from './group-review-access'
import { authorizedWork, lockedWork } from './group-review-runtime'
import { lockedGroupRun } from './group-worker-authority'

export const exchangeInput = z.object({
  workId: z.uuid().transform(value => value.toLowerCase()), triggerMessageId: z.uuid().transform(value => value.toLowerCase()), claimEpoch: z.number().int().positive(),
  exchangeId: z.uuid().transform(value => value.toLowerCase()), messageId: z.uuid().transform(value => value.toLowerCase()), toAgentId: z.uuid().transform(value => value.toLowerCase()), body: z.string().trim().min(1).max(32000),
}).strict()

/** Caller holds the source conversation lock before loading scope or DM state.
 * No legacy/private DM can acquire read permission merely by adding a link. */
async function scopeFor(client: PoolClient, directory: Directory, sourceId: string, linkId: string) {
  const scope = (await client.query(`SELECT s.*,c."workspaceId" FROM conversation_exchange_scopes s
    JOIN conversations c ON c.id=s."sourceId" AND c.kind='group'
    JOIN conversations dm ON dm.id=s."dmId" AND dm.kind='agent_dm' AND dm."workspaceId"=c."workspaceId" AND dm."createdBy"=s."requestedBy"
    JOIN conversation_links l ON l.id=s."linkId" AND l."sourceConversationId"=s."sourceId" AND l."linkedConversationId"=s."dmId" AND l."anchorPosition"=s."anchorPosition" AND l."firstPosition"=1
    JOIN conversation_messages trigger ON trigger.id=s."triggerMessageId" AND trigger."conversationId"=s."sourceId" AND trigger."authorType"='user' AND trigger."authorId"=s."requestedBy"
    JOIN conversation_members requester ON requester."conversationId"=s."sourceId" AND requester."memberType"='user' AND requester."memberId"=s."requestedBy" AND requester."joinedAt"=s."requesterJoinedAt" AND requester."leftAt" IS NULL
    JOIN conversation_members agent_a ON agent_a."conversationId"=s."sourceId" AND agent_a."memberType"='agent' AND agent_a."memberId"=s."agentA"::text AND agent_a."joinedAt"=s."joinedA" AND agent_a."leftAt" IS NULL
    JOIN conversation_members agent_b ON agent_b."conversationId"=s."sourceId" AND agent_b."memberType"='agent' AND agent_b."memberId"=s."agentB"::text AND agent_b."joinedAt"=s."joinedB" AND agent_b."leftAt" IS NULL
    WHERE s."linkId"=$1 AND s."sourceId"=$2 AND s."revokedAt" IS NULL`, [linkId, sourceId])).rows[0]
  if (!scope || !await directory(scope.workspaceId, scope.requestedBy, [], client)) return reject(404, 'not_found')
  for (const suffix of ['A', 'B']) {
    try {
      const grant = await requireAgent(client, directory, sourceId, scope.workspaceId, scope[`agent${suffix}`])
      if (grant.id !== scope[`grant${suffix}`]) return reject(404, 'not_found')
    } catch (error) { if (error instanceof ReviewFailure) return reject(404, 'not_found'); throw error }
  }
  // A linked DM contains exactly these two Agents; users never become members.
  const members = (await client.query('SELECT "memberType","memberId","leftAt" FROM conversation_members WHERE "conversationId"=$1', [scope.dmId])).rows
  if (members.length !== 2 || members.some(m => m.memberType !== 'agent' || m.leftAt || ![scope.agentA, scope.agentB].includes(m.memberId))) return reject(404, 'not_found')
  const integrity = (await client.query(`SELECT 1 FROM conversation_links l JOIN conversations dm ON dm.id=l."linkedConversationId"
    JOIN LATERAL (SELECT count(*)::bigint AS n,min(m.position) AS first,max(m.position) AS last
      FROM conversation_exchange_messages r JOIN conversation_messages m ON m.id=r."messageId"
      WHERE r."linkId"=l.id AND m."conversationId"=dm.id AND m."authorType"='agent' AND m."authorId"=ANY($2::text[])) stats ON true
    WHERE l.id=$1 AND stats.n=l."messageCount" AND stats.first=l."firstPosition" AND stats.last=l."lastPosition" AND dm."lastPosition"=stats.last`, [linkId, [scope.agentA, scope.agentB]])).rowCount
  if (!integrity) return reject(404, 'not_found')
  return scope
}

/** Dedicated device-authenticated group-run ingress. Never accepts sender, owner,
 * workspace, arbitrary DM IDs, private run transcripts or browser-authored replies.
 * A new exchange always creates a fresh DM and explicit provenance. Replays of
 * one message UUID are idempotent; a segment UUID cannot be reused across scopes. */
export async function appendAgentExchange(pool: Pool, directory: Directory, userId: string, deviceId: string, runId: string, input: unknown) {
  const parsed = exchangeInput.safeParse(input)
  if (!parsed.success) return reject(422, 'invalid_input')
  const value = parsed.data
  return transaction(pool, async client => {
    const work = await lockedWork(client, value.workId)
    if (work.runId !== runId || work.triggerMessageId !== value.triggerMessageId) return reject(403, 'runtime_binding_mismatch')
    const run = await lockedGroupRun(client, runId)
    if (run.userId !== userId || run.deviceId !== deviceId) return reject(404, 'not_found')
    if (work.status !== 'dispatched' || work.uncertainAt || work.claimEpoch !== value.claimEpoch || !run.enabled || run.status !== 'running' || run.stopRequestedAt || !run.leaseExpiresAt || new Date(run.leaseExpiresAt).getTime() <= Date.now()) return reject(409, 'work_not_live')
    await authorizedWork(client, directory, work)
    const { group } = await requireGroup(client, directory, work.conversationId, work.requestedBy)
    if (work.agentId === value.toAgentId) return reject(422, 'distinct_agents_required')
    const ids = [work.agentId, value.toAgentId].sort()
    const grants = []
    for (const id of ids) grants.push(await requireAgent(client, directory, group.id, group.workspaceId, id))
    // Lock operation identities independently of the source: concurrent attempts
    // to reuse UUIDs in two groups return conflict instead of unique violations.
    for (const key of [value.exchangeId, value.messageId].sort()) await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`agent-exchange:${key}`])
    const hash = createHash('sha256').update(JSON.stringify({ ...value, authorAgentId: work.agentId })).digest('hex')
    const prior = (await client.query('SELECT * FROM conversation_exchange_messages WHERE "messageId"=$1', [value.messageId])).rows[0]
    const existing = (await client.query('SELECT * FROM conversation_exchange_scopes WHERE "linkId"=$1', [value.exchangeId])).rows[0]
    if (existing) {
      const scope = await scopeFor(client, directory, group.id, value.exchangeId)
      if (scope.triggerMessageId !== work.triggerMessageId || scope.requestedBy !== work.requestedBy || scope.agentA !== ids[0] || scope.agentB !== ids[1]) return reject(409, 'exchange_scope_mismatch')
      if (prior) {
        if (prior.linkId !== value.exchangeId || prior.workId !== work.id || prior.hash !== hash) return reject(409, 'message_mismatch')
        return { linkId: value.exchangeId, messageId: value.messageId, duplicate: true }
      }
    } else {
      if (prior || (await client.query('SELECT 1 FROM conversation_links WHERE id=$1', [value.exchangeId])).rowCount) return reject(409, 'exchange_scope_mismatch')
      const dmId = randomUUID()
      const position = (await client.query('UPDATE conversations SET "lastPosition"="lastPosition"+1 WHERE id=$1 RETURNING "lastPosition"', [group.id])).rows[0].lastPosition
      await client.query(`INSERT INTO conversations (id,"workspaceId",kind,title,"createdBy") VALUES ($1,$2,'agent_dm','',$3)`, [dmId, group.workspaceId, work.requestedBy])
      for (const id of ids) await client.query(`INSERT INTO conversation_members ("conversationId","memberType","memberId",role) VALUES ($1,'agent',$2,'member')`, [dmId, id])
      await client.query('INSERT INTO conversation_links (id,"sourceConversationId","linkedConversationId","anchorPosition","firstPosition","lastPosition","messageCount") VALUES ($1,$2,$3,$4,1,1,1)', [value.exchangeId, group.id, dmId, position])
      await client.query(`INSERT INTO conversation_exchange_scopes ("linkId","sourceId","dmId","triggerMessageId","anchorPosition","requestedBy","requesterJoinedAt","agentA","agentB","grantA","grantB","joinedA","joinedB") SELECT $1,$2,$3,$4,$5,$6,u."joinedAt",$7::uuid,$8::uuid,$9::uuid,$10::uuid,a."joinedAt",b."joinedAt"
        FROM conversation_members u JOIN conversation_members a ON a."conversationId"=u."conversationId" JOIN conversation_members b ON b."conversationId"=u."conversationId"
        WHERE u."conversationId"=$2 AND u."memberType"='user' AND u."memberId"=$6 AND a."memberType"='agent' AND a."memberId"=($7::uuid)::text AND b."memberType"='agent' AND b."memberId"=($8::uuid)::text`, [value.exchangeId, group.id, dmId, work.triggerMessageId, position, work.requestedBy, ids[0], ids[1], grants[0].id, grants[1].id])
    }
    if ((await client.query('SELECT 1 FROM conversation_messages WHERE id=$1', [value.messageId])).rowCount) return reject(409, 'message_mismatch')
    const scope = (await client.query('SELECT * FROM conversation_exchange_scopes WHERE "linkId"=$1', [value.exchangeId])).rows[0]
    const position = (await client.query('UPDATE conversations SET "lastPosition"="lastPosition"+1 WHERE id=$1 RETURNING "lastPosition"', [scope.dmId])).rows[0].lastPosition
    await client.query(`INSERT INTO conversation_messages (id,"conversationId",position,"authorType","authorId",body) VALUES ($1,$2,$3,'agent',$4,$5)`, [value.messageId, scope.dmId, position, work.agentId, value.body])
    await client.query('INSERT INTO conversation_exchange_messages ("messageId","linkId","workId",hash) VALUES ($1,$2,$3,$4)', [value.messageId, value.exchangeId, work.id, hash])
    await client.query('UPDATE conversation_links SET "lastPosition"=$2,"messageCount"=$2 WHERE id=$1', [value.exchangeId, position])
    return { linkId: value.exchangeId, messageId: value.messageId, duplicate: false }
  })
}

/** Whitelist presentation fields only. No run/config/credential/mention/reply IDs. */
async function participants(client: PoolClient, scope: Record<string, string>) {
  return (await client.query('SELECT id,name,NULL::text AS avatar FROM agents WHERE id=ANY($1::uuid[]) ORDER BY id', [[scope.agentA, scope.agentB]])).rows
}
export async function exchangeMarkers(client: PoolClient, directory: Directory, sourceId: string, before: string | null, limit: number) {
  const markers = []
  let cursor = before
  while (markers.length < limit) {
    const rows = (await client.query(`SELECT "linkId","anchorPosition"::text FROM conversation_exchange_scopes WHERE "sourceId"=$1 AND "revokedAt" IS NULL AND ($2::bigint IS NULL OR "anchorPosition"<$2) ORDER BY "anchorPosition" DESC LIMIT 100`, [sourceId, cursor])).rows
    for (const row of rows) {
      cursor = row.anchorPosition
      try {
        const scope = await scopeFor(client, directory, sourceId, row.linkId)
        const link = (await client.query('SELECT "anchorPosition"::text,"messageCount"::text FROM conversation_links WHERE id=$1', [row.linkId])).rows[0]
        markers.push({ type: 'agent_exchange' as const, linkId: row.linkId, position: link.anchorPosition, count: link.messageCount, participants: await participants(client, scope) })
      } catch (error) { if (!(error instanceof ReviewFailure)) throw error }
      if (markers.length >= limit) break
    }
    if (rows.length < 100) break
  }
  return markers
}

export async function handleConversationLink(pool: Pool, directory: Directory, req: { userId: string | null; id: string; method: string; origin: string | null; host: string; before?: string | null; limit?: string | null }) {
  try {
    if (!req.userId) return reject(401, 'unauthorized')
    if (!['GET', 'DELETE'].includes(req.method)) return reject(405, 'method_not_allowed')
    if (!z.uuid().transform(value => value.toLowerCase()).safeParse(req.id).success) return reject(404, 'not_found')
    if (req.method === 'DELETE' && req.origin) {
      let origin
      try { origin = new URL(req.origin) } catch { return reject(403, 'forbidden') }
      if (!['http:', 'https:'].includes(origin.protocol) || origin.host !== req.host) return reject(403, 'forbidden')
    }
    const limit = req.limit ?? '50', before = req.before ?? null
    if (!/^[1-9][0-9]*$/.test(limit) || BigInt(limit) > BigInt(100) || (before !== null && (!/^[1-9][0-9]*$/.test(before) || BigInt(before) > BigInt("9223372036854775807")))) return reject(422, 'invalid_input')
    const body = await transaction(pool, async client => {
      const identity = (await client.query('SELECT "sourceId" FROM conversation_exchange_scopes WHERE "linkId"=$1', [req.id])).rows[0]
      if (!identity) return reject(404, 'not_found')
      const { member } = await requireGroup(client, directory, identity.sourceId, req.userId!)
      if (req.method === 'DELETE') {
        if (member.role !== 'owner') return reject(403, 'forbidden')
        await client.query('UPDATE conversation_exchange_scopes SET "revokedAt"=now() WHERE "linkId"=$1 AND "revokedAt" IS NULL', [req.id])
        return { ok: true }
      }
      const scope = await scopeFor(client, directory, identity.sourceId, req.id)
      const link = (await client.query('SELECT * FROM conversation_links WHERE id=$1', [req.id])).rows[0]
      const rows = (await client.query(`SELECT m.id,m.position::text,m.body,m."createdAt",m."authorId",a.name AS "senderName",NULL::text AS "senderAvatar"
        FROM conversation_exchange_messages receipt JOIN conversation_messages m ON m.id=receipt."messageId" AND m."conversationId"=$2 AND m."authorType"='agent'
        JOIN agents a ON a.id::text=m."authorId"
        WHERE receipt."linkId"=$1 AND m.position BETWEEN $3 AND $4 AND m."authorId"=ANY($5::text[]) AND ($6::bigint IS NULL OR m.position<$6)
        ORDER BY m.position DESC LIMIT $7`, [req.id, scope.dmId, link.firstPosition, link.lastPosition, [scope.agentA, scope.agentB], before, Number(limit) + 1])).rows
      const more = rows.length > Number(limit), messages = rows.slice(0, Number(limit))
      return { linkId: req.id, readOnly: true, participants: await participants(client, scope), messages, nextBefore: more ? messages.at(-1)?.position : null }
    })
    return { status: 200, body }
  } catch (error) { if (error instanceof ReviewFailure) return { status: error.status, body: { error: error.code } }; throw error }
}
