import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { addsNothing, correctionFrom, followUpInstructions, mentionRoute, UnknownMentionError, type GroupMessage, type GroupRoute, type RoutingCorrection, type RoutingMember } from './group-routing'

export const GROUP_MAX_ROUNDS = 3
export type GroupAgent = RoutingMember
export type GroupReply = { text: string; mentions: string[] }
export type GroupRuntime = {
  agents(ownerId: string, ids: string[]): Promise<GroupAgent[]>
  authorized(workspaceId: string, userId: string): Promise<boolean>
  route(message: GroupMessage, members: GroupAgent[], leadId: string, corrections: RoutingCorrection[]): Promise<GroupRoute>
  generate(agent: GroupAgent, input: { message: GroupMessage; earlier: { author: string; text: string }[]; followUp: string; members: RoutingMember[]; ask?: string }): Promise<GroupReply>
}
export async function enqueueGroupTurn(client: PoolClient, conversationId: string, messageId: string, userId: string) {
  await client.query('INSERT INTO group_turns ("messageId","conversationId","userId") VALUES ($1,$2,$3)', [messageId, conversationId, userId])
}
/** One durable root message. A session advisory lock spans model calls, not a long
 * transaction: concurrent workers queue, while membership changes remain possible.
 * A crashed generation is marked failed on next wake, NEVER automatically replayed.
 */
export async function processGroupTurn(pool: Pool, conversationId: string, runtime: GroupRuntime, deadline = Date.now() + 220000): Promise<boolean> {
  const client = await pool.connect()
  let locked = false
  let discard = false
  let messageId: string | undefined
  try {
    const acquired = await client.query(`SELECT pg_try_advisory_lock(hashtextextended(current_database() || '.' || current_schema() || '.group-turn.' || $1,0)) AS acquired`, [conversationId])
    if (!acquired.rows[0].acquired) return false
    locked = true
    await client.query(`UPDATE group_turns SET status='failed',"agentId"=NULL,error='interrupted_generation_not_replayed',"updatedAt"=now() WHERE "conversationId"=$1 AND status='running'`, [conversationId])
    const { rows } = await client.query(`SELECT t.*, m.body,m.mentions,m.position,c."workspaceId",c."createdBy" FROM group_turns t
      JOIN conversation_messages m ON m.id=t."messageId" JOIN conversations c ON c.id=t."conversationId"
      WHERE t."conversationId"=$1 AND t.status='queued' ORDER BY m.position LIMIT 1`, [conversationId])
    const root = rows[0]
    if (!root) return false
    messageId = root.messageId
    await client.query(`UPDATE group_turns SET status='running',"updatedAt"=now() WHERE "messageId"=$1`, [messageId])
    const authorized = async () => {
      if (!await runtime.authorized(root.workspaceId, root.userId) || !await runtime.authorized(root.workspaceId, root.createdBy)) return false
      const member = await client.query(`SELECT 1 FROM conversation_members WHERE "conversationId"=$1 AND "memberType"='user' AND "memberId"=$2 AND "leftAt" IS NULL`, [conversationId, root.userId])
      return Boolean(member.rowCount)
    }
    if (!await authorized()) throw new Error('group_actor_no_longer_authorized')
    const eligible = async () => {
      if (!await authorized()) return []
      const members = await client.query(`SELECT "memberId" FROM conversation_members WHERE "conversationId"=$1 AND "memberType"='agent' AND "leftAt" IS NULL ORDER BY "joinedAt","memberId"`, [conversationId])
      return runtime.agents(root.createdBy, members.rows.map(m => m.memberId))
    }
    const members = await eligible()
    const recent = await client.query(`SELECT "authorId" AS author,body AS text FROM conversation_messages m WHERE "conversationId"=$1 AND
      (position<$2 OR ("authorType"='agent' AND "replyToId" IN (SELECT id FROM conversation_messages WHERE "conversationId"=$1 AND position<$2))) ORDER BY position DESC LIMIT 10`, [conversationId, root.position])
    const input: GroupMessage = { text: root.body, mentions: root.mentions.filter((m: { memberType: string }) => m.memberType === 'agent').map((m: { memberId: string }) => m.memberId), recent: recent.rows.reverse() }
    // Validate before recording a correction or invoking any model.
    mentionRoute(input, members)
    const previous = await client.query(`SELECT m.body,t.route FROM group_turns t JOIN conversation_messages m ON m.id=t."messageId" WHERE t."conversationId"=$1 AND m.position<$2 AND t.route IS NOT NULL AND t.status='complete' ORDER BY m.position DESC LIMIT 1`, [conversationId, root.position])
    if (previous.rows[0]) {
      const route = previous.rows[0].route as GroupRoute
      const correction = route.responders.length === 1 ? correctionFrom({ message: previous.rows[0].body, responderId: route.responders[0], by: route.by }, input) : null
      if (correction) await client.query(`INSERT INTO group_routing_corrections ("messageId","conversationId",message,"wrongId","rightId") VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, [messageId, conversationId, correction.message, correction.wrongId, correction.rightId ?? null])
    }
    if (members.length) {
      const corrections = await client.query(`SELECT message,"wrongId","rightId" FROM group_routing_corrections WHERE "conversationId"=$1 ORDER BY "createdAt" DESC,"messageId" DESC LIMIT 10`, [conversationId])
      const route = mentionRoute(input, members) ?? await runtime.route(input, members, members[0].id, corrections.rows.reverse().map(c => ({ ...c, rightId: c.rightId ?? undefined })))
      const unknown = route.responders.filter(id => !members.some(m => m.id === id))
      if (unknown.length) throw new UnknownMentionError(unknown)
      await client.query('UPDATE group_turns SET route=$2 WHERE "messageId"=$1', [messageId, JSON.stringify(route)])
      await runGroupRounds(route, input, {
        eligible,
        generate: runtime.generate,
        async status(id) { await client.query('UPDATE group_turns SET "agentId"=$2,"updatedAt"=now() WHERE "messageId"=$1', [messageId, id]) },
        async publish(id, reply) {
          await client.query('BEGIN')
          try {
            await client.query('SELECT id FROM conversations WHERE id=$1 FOR UPDATE', [conversationId])
            if (!(await eligible()).some(a => a.id === id)) { await client.query('ROLLBACK'); return false }
            const { rows: positions } = await client.query('UPDATE conversations SET "lastPosition"="lastPosition"+1 WHERE id=$1 RETURNING "lastPosition"::text AS position', [conversationId])
            await client.query(`INSERT INTO conversation_messages (id,"conversationId",position,"authorType","authorId",body,mentions,"replyToId") VALUES ($1,$2,$3,'agent',$4,$5,$6,$7)`, [randomUUID(), conversationId, positions[0].position, id, reply.text, JSON.stringify(reply.mentions.map(memberId => ({ memberType: 'agent', memberId }))), messageId])
            await client.query('COMMIT')
            return true
          } catch (error) { await client.query('ROLLBACK'); throw error }
        },
      }, deadline)
    }
    await client.query(`UPDATE group_turns SET status='complete',"updatedAt"=now() WHERE "messageId"=$1`, [messageId])
    return true
  } catch (error) {
    if (!messageId) throw error
    await client.query(`UPDATE group_turns SET status='failed',"agentId"=NULL,error=$2,"updatedAt"=now() WHERE "messageId"=$1`, [messageId, error instanceof UnknownMentionError ? 'unknown_mention' : 'generation_failed_not_replayed'])
    throw error
  } finally {
    try { if (locked) await client.query(`SELECT pg_advisory_unlock(hashtextextended(current_database() || '.' || current_schema() || '.group-turn.' || $1,0))`, [conversationId]) }
    catch { discard = true }
    finally { client.release(discard) }
  }
}

/** Pure serial round engine, shared by the real adapter and scripted CI. */
export async function runGroupRounds(route: GroupRoute, message: GroupMessage, io: {
  eligible(): Promise<GroupAgent[]>
  generate: GroupRuntime['generate']
  publish(id: string, reply: GroupReply): Promise<boolean>
  status(id: string | null): Promise<void>
}, deadline = Date.now() + 220000) {
  let next = route.responders
  const earlier: { author: string; text: string }[] = []
  for (let round = 0; round < GROUP_MAX_ROUNDS && next.length; round++) {
    const follow = new Set<string>()
    for (const id of new Set(next)) {
      if (Date.now() > deadline) throw new Error('group_generation_budget_exceeded')
      const current = await io.eligible()
      const agent = current.find(a => a.id === id)
      if (!agent) continue
      await io.status(id)
      let reply: GroupReply
      try { reply = await io.generate(agent, { message, earlier: [...earlier], members: current.map(({ id, name, description }) => ({ id, name, description })), followUp: followUpInstructions(earlier), ask: route.by === 'lead' ? route.ask : undefined }) }
      finally { await io.status(null) }
      const known = new Set(current.map(a => a.id))
      if (reply.mentions.some(mention => !known.has(mention))) throw new UnknownMentionError(reply.mentions.filter(mention => !known.has(mention)))
      if (!reply.text.trim() || addsNothing(reply.text)) continue
      if (!await io.publish(id, reply)) continue
      earlier.push({ author: agent.name, text: reply.text })
      for (const mention of reply.mentions) follow.add(mention)
    }
    next = [...follow]
  }
}
