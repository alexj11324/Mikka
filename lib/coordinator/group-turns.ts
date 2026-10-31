import { randomUUID } from 'node:crypto'
import { hostedBillingScope } from '@/lib/abuse/context'
import type { Pool, PoolClient } from 'pg'
import { checkedCorrection, GroupJudgmentPendingError, type CorrectionInput, type CorrectionJudgment } from './group-correction'
export { GroupJudgmentPendingError } from './group-correction'
import { addsNothing, followUpInstructions, mentionRoute, UnknownMentionError, type GroupMessage, type GroupRoute, type RoutingCorrection, type RoutingMember } from './group-routing'
import { appendGroupExchange } from './group-exchanges'

export const GROUP_MAX_ROUNDS = 3
export type GroupAgent = RoutingMember
export type GroupReply = { text: string; mentions: string[]; privateTo?: string | null }
export type GroupRuntime = {
  agents(ownerId: string, ids: string[], client: PoolClient): Promise<GroupAgent[]>
  authorized(workspaceId: string, userId: string): Promise<boolean>
  route(message: GroupMessage, members: GroupAgent[], leadId: string | null, corrections: RoutingCorrection[]): Promise<GroupRoute>
  correction(input: CorrectionInput): Promise<CorrectionJudgment>
  generate(agent: GroupAgent, input: { message: GroupMessage; earlier: { author: string; text: string }[]; followUp: string; members: RoutingMember[]; ask?: string; privatePeer?: RoutingMember }): Promise<GroupReply>
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
    // Recover only this group's linked chat runs; never alter daemon/issue runs.
    await client.query(`UPDATE agent_runs SET status='failed',"finishedAt"=now(),"leaseExpiresAt"=NULL,"updatedAt"=now() WHERE id IN (SELECT "activeRunId" FROM group_turns WHERE "conversationId"=$1 AND status='running') AND kind='group_chat' AND status='running'`, [conversationId])
    await client.query(`UPDATE group_turns SET "activeRunId"=NULL,status='failed',"agentId"=NULL,error='interrupted_generation_not_replayed',"updatedAt"=now() WHERE "conversationId"=$1 AND status='running'`, [conversationId])
    const { rows } = await client.query(`SELECT t.*, m.body,m.mentions,m.position,c."workspaceId",c."createdBy",c."leadAgentId" FROM group_turns t
      JOIN conversation_messages m ON m.id=t."messageId" JOIN conversations c ON c.id=t."conversationId"
      WHERE t."conversationId"=$1 AND t.status='queued' ORDER BY m.position LIMIT 1`, [conversationId])
    const root = rows[0]
    if (!root) return false
    const modelScope = <T>(work: () => Promise<T>) => hostedBillingScope.run({ workspaceId: root.workspaceId, ownerId: root.createdBy }, work)
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
      return runtime.agents(root.createdBy, members.rows.map(m => m.memberId), client)
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
      const prior = route.responders.length === 1 && route.by !== 'mention' ? { message: previous.rows[0].body as string, responderId: route.responders[0] } : null
      const judgment = prior ? await modelScope(() => runtime.correction({ previous: prior, current: input, members })) : null
      if (judgment?.kind === 'uncertain') throw new GroupJudgmentPendingError()
      if (prior && judgment?.kind === 'correction') {
        // Membership mutations acquire the same row lock. Revalidate and persist
        // together so a removed member cannot become a stored correction fact.
        await client.query('BEGIN')
        try {
          await client.query('SELECT id FROM conversations WHERE id=$1 FOR UPDATE', [conversationId])
          const correction = checkedCorrection(judgment, prior, await eligible())
          if (!correction || correction === 'uncertain' || !judgment.execution) throw new GroupJudgmentPendingError()
          await client.query(`INSERT INTO group_routing_corrections ("messageId","conversationId",message,"wrongId","rightId","decisionExecution") VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`, [messageId, conversationId, correction.message, correction.wrongId, correction.rightId ?? null, JSON.stringify(judgment.execution)])
          await client.query('COMMIT')
        } catch (error) { await client.query('ROLLBACK'); throw error }
      }
    }
    if (!members.length) throw new GroupJudgmentPendingError()
    {
      const corrections = await client.query(`SELECT message,"wrongId","rightId" FROM group_routing_corrections WHERE "conversationId"=$1 ORDER BY "createdAt" DESC,"messageId" DESC LIMIT 10`, [conversationId])
      const route = mentionRoute(input, members) ?? await modelScope(() => runtime.route(input, members, members.some(m => m.id === root.leadAgentId) ? root.leadAgentId : null, corrections.rows.reverse().map(c => ({ ...c, rightId: c.rightId ?? undefined }))))
      const unknown = route.responders.filter(id => !members.some(m => m.id === id))
      if (unknown.length) throw new UnknownMentionError(unknown)
      await client.query('UPDATE group_turns SET route=$2 WHERE "messageId"=$1', [messageId, JSON.stringify(route)])
      const exchangeLinks = new Map<string, string>()
      await runGroupRounds(route, input, {
        eligible,
        generate: (agent, input) => modelScope(() => runtime.generate(agent, input)),
        async status(id, outcome = 'succeeded') {
          await client.query('BEGIN')
          try {
            if (id) {
              const runId = randomUUID()
              // #102 reads owner-filtered, live agent_runs. No device, prompt,
              // transcript or group/member IDs enter that shared status contract.
              // Provider calls time out after 20s; the 60s lease bounds stale UI
              // status if the process dies before its finally/recovery path.
              await client.query(`INSERT INTO agent_runs (id,"userId","agentId",kind,status,"startedAt","leaseExpiresAt") VALUES ($1,$2,$3,'group_chat','running',now(),now()+interval '60 seconds')`, [runId, root.createdBy, id])
              await client.query('UPDATE group_turns SET "agentId"=$2,"activeRunId"=$3,"updatedAt"=now() WHERE "messageId"=$1', [messageId, id, runId])
            } else {
              await client.query(`UPDATE agent_runs SET status=$2,"finishedAt"=now(),"leaseExpiresAt"=NULL,"updatedAt"=now() WHERE id=(SELECT "activeRunId" FROM group_turns WHERE "messageId"=$1) AND kind='group_chat' AND "userId"=$3`, [messageId, outcome, root.createdBy])
              await client.query('UPDATE group_turns SET "agentId"=NULL,"activeRunId"=NULL,"updatedAt"=now() WHERE "messageId"=$1', [messageId])
            }
            await client.query('COMMIT')
          } catch (error) { await client.query('ROLLBACK'); throw error }
        },
        async publishPrivate(senderId, recipientId, reply) {
          await client.query('BEGIN')
          try {
            await client.query('SELECT id FROM conversations WHERE id=$1 FOR UPDATE', [conversationId])
            const current = await eligible()
            const sender = current.find(a => a.id === senderId), recipient = current.find(a => a.id === recipientId)
            if (!sender || !recipient || senderId === recipientId) { await client.query('ROLLBACK'); return false }
            const pair = [senderId, recipientId].sort().join(':')
            const link = await appendGroupExchange(client, { sourceId: conversationId, anchorId: messageId!, ownerId: root.createdBy, workspaceId: root.workspaceId,
              senderId, recipientId, text: reply.text, title: `${sender.name} ⇄ ${recipient.name}`, linkId: exchangeLinks.get(pair) })
            await client.query('COMMIT')
            exchangeLinks.set(pair, link.linkId)
            return true
          } catch (error) { await client.query('ROLLBACK'); throw error }
        },
        async publish(id, reply) {
          await client.query('BEGIN')
          try {
            await client.query('SELECT id FROM conversations WHERE id=$1 FOR UPDATE', [conversationId])
            const current = await eligible()
            if (!current.some(a => a.id === id)) { await client.query('ROLLBACK'); return false }
            const unknown = reply.mentions.filter(mention => !current.some(a => a.id === mention))
            if (unknown.length) throw new UnknownMentionError(unknown)
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
    await client.query(`UPDATE group_turns SET status='failed',"agentId"=NULL,error=$2,"updatedAt"=now() WHERE "messageId"=$1`, [messageId, error instanceof GroupJudgmentPendingError ? 'group_judgment_pending' : error instanceof UnknownMentionError ? 'unknown_mention' : 'generation_failed_not_replayed'])
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
  publishPrivate?(senderId: string, recipientId: string, reply: GroupReply): Promise<boolean>
  status(id: string | null, outcome?: 'succeeded' | 'failed'): Promise<void>
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
      let outcome: 'succeeded' | 'failed' = 'failed'
      try { reply = await io.generate(agent, { message, earlier: [...earlier], members: current.map(({ id, name, description }) => ({ id, name, description })), followUp: followUpInstructions(earlier), ask: route.by === 'lead' ? route.ask : undefined }); outcome = 'succeeded' }
      finally { await io.status(null, outcome) }
      const known = new Set(current.map(a => a.id))
      if (reply.mentions.some(mention => !known.has(mention))) throw new UnknownMentionError(reply.mentions.filter(mention => !known.has(mention)))
      if (!reply.text.trim() || addsNothing(reply.text)) continue
      if (reply.privateTo) {
        if (reply.privateTo === id || !known.has(reply.privateTo)) throw new UnknownMentionError([reply.privateTo])
        if (!io.publishPrivate) throw new Error('group_private_writer_unavailable')
        const privateEarlier: { author: string; text: string }[] = []
        let sender = agent, recipientId = reply.privateTo, privateReply = reply
        for (let privateRound = 0; privateRound < GROUP_MAX_ROUNDS - round; privateRound++) {
          const peers = await io.eligible(), recipient = peers.find(a => a.id === recipientId)
          if (!recipient || !peers.some(a => a.id === sender.id)) break
          if (privateReply.privateTo && privateReply.privateTo !== recipientId || privateReply.mentions.some(id => id !== recipientId)) throw new Error('group_private_peer_mismatch')
          if (!await io.publishPrivate(sender.id, recipientId, privateReply)) break
          privateEarlier.push({ author: sender.name, text: privateReply.text })
          if (privateRound + 1 >= GROUP_MAX_ROUNDS - round) break
          if (Date.now() > deadline) throw new Error('group_generation_budget_exceeded')
          await io.status(recipientId)
          let privateOutcome: 'succeeded' | 'failed' = 'failed'
          try {
            privateReply = await io.generate(recipient, { message, earlier: [...privateEarlier], members: peers.map(({ id, name, description }) => ({ id, name, description })),
              followUp: followUpInstructions(privateEarlier), privatePeer: sender })
            privateOutcome = 'succeeded'
          } finally { await io.status(null, privateOutcome) }
          if (!privateReply.text.trim() || addsNothing(privateReply.text)) break
          recipientId = sender.id; sender = recipient
        }
        // Private transcripts never become public round context or mentions.
        continue
      }
      if (!await io.publish(id, reply)) continue
      earlier.push({ author: agent.name, text: reply.text })
      for (const mention of reply.mentions) follow.add(mention)
    }
    next = [...follow]
  }
}
