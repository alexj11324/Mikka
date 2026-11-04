import { createHash, randomUUID } from 'node:crypto'

import { hostedBillingScope } from '@/lib/abuse/context'
import type { Pool, PoolClient } from 'pg'
import { checkedCorrection, GroupJudgmentPendingError, type CorrectionInput, type CorrectionJudgment } from './group-correction'
export { GroupJudgmentPendingError } from './group-correction'
import { addsNothing, followUpInstructions, mentionRoute, UnknownMentionError, type GroupMessage, type GroupRoute, type RoutingCorrection, type RoutingMember } from './group-routing'
import { appendGroupExchange } from './group-exchanges'
import type { HostedRuntimeSnapshot } from '@/lib/subscription-model-snapshot'
import { initializeGroupDecisionTrace, recordGroupDecisionRoute, recordGroupTraceEvent, finishGroupDecisionTrace } from './group-decision-trace'
import { recordGroupFeedback } from './group-decision-feedback'
import { groupCopy, readGroupLocale } from './group-copy'

export const GROUP_MAX_ROUNDS = 3
export type GroupAgent = RoutingMember
export type GroupReply = { text: string; mentions: string[]; privateTo?: string | null;
  /** Host-only receipt from Factory, never accepted from chat model output. */
  taskReceipt?: {taskId:string|null;issueId:string;runId:string|null;requestEpoch:string|null;outcome:'succeeded'|'blocked'|'stopped';reportTiming:'now'|'on_completion'} }
export type GroupRuntime = {
  agents(ownerId: string, ids: string[], client: PoolClient): Promise<GroupAgent[]>
  bots?(ownerId: string, workspaceId: string, ids: string[], client: PoolClient): Promise<GroupAgent[]>
  prepareBot?(actor: GroupAgent, scope: { ownerId: string; workspaceId: string }, client: PoolClient): Promise<HostedRuntimeSnapshot>
  authorized(workspaceId: string, userId: string): Promise<boolean>
  route(message: GroupMessage, members: GroupAgent[], leadId: string | null, corrections: RoutingCorrection[]): Promise<GroupRoute>
  /** Production classifies the action even for an explicit @mention; member selection stays constrained. */
  routeMention?: GroupRuntime['route']
  contribution?(message: GroupMessage, member: GroupAgent, earlier: readonly { author: string; text: string }[]): Promise<{ contribute: boolean; execution?: import('./decide').DecisionExecution }>
  tasks?(scope: { userId: string; conversationId: string }, client: PoolClient): Promise<import('./group-routing').GroupTaskReference[]>
  delegate?(scope: { userId: string; workspaceId: string; conversationId: string; messageId: string; reporter: GroupAgent; text: string; delegation: import('./group-routing').GroupDelegation }, client: PoolClient): Promise<GroupReply>
  correction(input: CorrectionInput): Promise<CorrectionJudgment>
  generate(agent: GroupAgent, input: { message: GroupMessage; earlier: { author: string; text: string }[]; followUp: string; members: RoutingMember[]; ask?: string; privatePeer?: RoutingMember; modelRuntime?: HostedRuntimeSnapshot; signal?: AbortSignal; attachmentContext?: { userId: string; conversationId: string } }): Promise<GroupReply>
}
/** 停止 in a group: the turn's error once a member stopped it; it keeps the replies already posted and is never replayed. */
export const GROUP_TURN_STOPPED = 'stopped'
/** How often a generation checks whether the turn was stopped. */
const STOP_POLL_MS = 1000

/** Finite diagnostics only: provider errors may contain private prompts, URLs and credentials. */
export function groupGenerationFailure(error: unknown) {
  let invalidOutput = false
  const seen = new Set<unknown>()
  for (let current = error, depth = 0; current && typeof current === 'object' && depth < 8 && !seen.has(current); depth++) {
    seen.add(current)
    const value = current as { name?: string; statusCode?: number; cause?: unknown }
    if (value.name === 'TimeoutError') return 'generation_timeout'
    if (value.name === 'AbortError') return 'generation_aborted'
    if (value.statusCode === 401 || value.statusCode === 403) return 'generation_authentication'
    if (value.statusCode === 429) return 'generation_rate_limited'
    if (typeof value.statusCode === 'number' && value.statusCode >= 500 && value.statusCode <= 599) return 'generation_upstream'
    invalidOutput ||= ['AI_NoOutputGeneratedError', 'AI_NoObjectGeneratedError', 'AI_TypeValidationError'].includes(value.name ?? '')
    current = value.cause
  }
  return invalidOutput ? 'generation_invalid_output' : 'generation_failed_not_replayed'
}

/** 停止: ends the group's running and queued turns. The worker sees it, aborts the reply in flight and posts nothing more. */
export async function stopGroupTurns(client: Pick<PoolClient, 'query'>, conversationId: string, actorUserId?: string): Promise<number> {
  const { rows } = await client.query<{ messageId: string; activeRunId: string | null }>(`UPDATE group_turns SET status='failed',error=$2,"agentId"=NULL,"botId"=NULL,trace=trace || jsonb_build_object('status','stopped','finishedAt',now()),"updatedAt"=now()
    WHERE "conversationId"=$1 AND (status IN ('queued','running') OR error='group_judgment_pending') RETURNING "messageId","activeRunId"`, [conversationId, GROUP_TURN_STOPPED])
  if (actorUserId) for (const row of rows) await recordGroupFeedback(client, { conversationId, messageId: row.messageId, userId: actorUserId, source: 'human_cancellation', kind: 'cancelled_turn' })
  const runs = rows.flatMap(row => row.activeRunId ? [row.activeRunId] : [])
  if (runs.length) await client.query(`UPDATE agent_runs SET status='stopped',"finishedAt"=now(),"leaseExpiresAt"=NULL,"updatedAt"=now() WHERE id=ANY($1::uuid[]) AND kind='group_chat' AND status='running'`, [runs])
  return rows.length
}

/** Groups with a turn still to run (queued, or running with no live worker): the minute cron resumes them. */
export async function groupsWithPendingTurns(client: Pick<PoolClient, 'query'>, limit = 20): Promise<string[]> {
  const { rows } = await client.query<{ conversationId: string }>(`SELECT "conversationId" FROM group_turns WHERE status IN ('queued','running') OR (status='failed' AND error='group_judgment_pending' AND "nextDecisionAt"<=now())
    GROUP BY "conversationId" ORDER BY min("createdAt") LIMIT $1`, [limit])
  return rows.map(row => row.conversationId)
}

/** Whether a group has a turn to run, so a history read starts the worker only then. */
export async function hasPendingGroupTurn(client: Pick<PoolClient, 'query'>, conversationId: string): Promise<boolean> {
  const { rows } = await client.query<{ pending: boolean }>(`SELECT EXISTS (SELECT 1 FROM group_turns WHERE "conversationId"=$1 AND (status IN ('queued','running') OR (status='failed' AND error='group_judgment_pending' AND "nextDecisionAt"<=now()))) AS pending`, [conversationId])
  return Boolean(rows[0]?.pending)
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
    // An unavailable routing decision has not woken a responder. Retry only
    // that judgment with bounded backoff, never an interrupted generation.
    await client.query(`UPDATE group_turns SET status='queued',error=NULL,"nextDecisionAt"=NULL WHERE "conversationId"=$1 AND status='failed' AND error='group_judgment_pending' AND "nextDecisionAt"<=now()`,[conversationId])
    // Recover only this group's linked chat runs; never alter daemon/issue runs.
    await client.query(`UPDATE agent_runs SET status='failed',"finishedAt"=now(),"leaseExpiresAt"=NULL,"updatedAt"=now() WHERE id IN (SELECT "activeRunId" FROM group_turns WHERE "conversationId"=$1 AND status='running') AND kind='group_chat' AND status='running'`, [conversationId])
    await client.query(`UPDATE group_turns SET "activeRunId"=NULL,status='failed',"agentId"=NULL,"botId"=NULL,error='interrupted_generation_not_replayed',trace=trace || '{"status":"failed"}'::jsonb,"updatedAt"=now() WHERE "conversationId"=$1 AND status='running'`, [conversationId])
    const { rows } = await client.query(`SELECT t.*, m.body,m.mentions,m.position,c."workspaceId",c."createdBy",c."leadAgentId",c."leadBotId" FROM group_turns t
      JOIN conversation_messages m ON m.id=t."messageId" JOIN conversations c ON c.id=t."conversationId"
      WHERE t."conversationId"=$1 AND t.status='queued' ORDER BY m.position LIMIT 1`, [conversationId])
    const root = rows[0]
    if (!root) return false
    // 停止 (stopGroupTurns) moves the turn off 'running'; the worker checks before each step and while a reply generates.
    const stopped = async () => (await client.query(`SELECT status FROM group_turns WHERE "messageId"=$1`, [root.messageId])).rows[0]?.status !== 'running'
    const modelScope = <T>(work: () => Promise<T>) => hostedBillingScope.run({ workspaceId: root.workspaceId, ownerId: root.userId }, work)
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
      const members = (await client.query(`SELECT "memberType","memberId" FROM conversation_members WHERE "conversationId"=$1 AND "memberType" IN ('agent','bot') AND "leftAt" IS NULL ORDER BY "joinedAt","memberId"`, [conversationId])).rows
      const agents = await runtime.agents(root.createdBy, members.filter(m => m.memberType === 'agent').map(m => m.memberId), client)
      const bots = members.some(m => m.memberType === 'bot') && runtime.bots ? await runtime.bots(root.userId, root.workspaceId, members.filter(m => m.memberType === 'bot').map(m => m.memberId), client) : []
      return members.flatMap(m => { const actor = (m.memberType === 'bot' ? bots : agents).find(a => a.id === m.memberId); return actor ? [{ ...actor, ...(m.memberType === 'bot' ? { memberType: 'bot' as const } : {}) }] : [] })
    }
    const members = await eligible()
    const recent = await client.query(`SELECT id,"authorId" AS author,body AS text FROM conversation_messages m WHERE "conversationId"=$1 AND
      (position<$2 OR ("authorType" IN ('agent','bot') AND "replyToId" IN (SELECT id FROM conversation_messages WHERE "conversationId"=$1 AND position<$2))) ORDER BY position DESC LIMIT 10`, [conversationId, root.position])
    await initializeGroupDecisionTrace(client, messageId!, members, recent.rows.map(row => row.id).reverse())
    let generationCount = 0, wakeCount = 0
    const input: GroupMessage = { text: root.body, mentions: root.mentions.filter((m: { memberType: string }) => m.memberType === 'agent' || m.memberType === 'bot').map((m: { memberId: string }) => m.memberId), recent: recent.rows.reverse().map(({ author, text }) => ({ author, text })), ...(runtime.tasks ? { tasks: await runtime.tasks({ userId:root.userId, conversationId },client) }: {}) }
    // Validate before recording a correction or invoking any model.
    mentionRoute(input, members)
    const previous = await client.query(`SELECT t."messageId",m.body,t.route FROM group_turns t JOIN conversation_messages m ON m.id=t."messageId" WHERE t."conversationId"=$1 AND m.position<$2 AND t.route IS NOT NULL AND t.status='complete' ORDER BY m.position DESC LIMIT 1`, [conversationId, root.position])
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
          await recordGroupFeedback(client, { conversationId, messageId: previous.rows[0].messageId, userId: root.userId, source: 'human_correction', kind: 'wrong_member', targetId: correction.rightId, sourceMessageId: messageId })
          await client.query('COMMIT')
        } catch (error) { await client.query('ROLLBACK'); throw error }
      }
    }
    if (!members.length) throw new GroupJudgmentPendingError()
    {
      const corrections = await client.query(`SELECT message,"wrongId","rightId" FROM group_routing_corrections WHERE "conversationId"=$1 ORDER BY "createdAt" DESC,"messageId" DESC LIMIT 10`, [conversationId])
      const leadId = root.leadBotId ?? root.leadAgentId
      const mentioned = mentionRoute(input, members)
      const contextCorrections = corrections.rows.reverse().map(c => ({ ...c, rightId: c.rightId ?? undefined }))
      const judgment = mentioned && !runtime.routeMention ? mentioned : await modelScope(() => (mentioned ? runtime.routeMention! : runtime.route)(input, mentioned ? members.filter(m=>mentioned.responders.includes(m.id)) : members, members.some(m => m.id === leadId) ? leadId : null, contextCorrections))
      const route:GroupRoute = mentioned ? {...judgment,by:'mention'} : judgment
      const unknown = route.responders.filter(id => !members.some(m => m.id === id))
      if (unknown.length) throw new UnknownMentionError(unknown)
      await client.query('UPDATE group_turns SET route=$2 WHERE "messageId"=$1', [messageId, JSON.stringify(route)])
      await recordGroupDecisionRoute(client, messageId!, route)
      const exchangeLinks = new Map<string, string>()
      const selections = new Map<string, HostedRuntimeSnapshot>()
      await runGroupRounds(route, input, {
        eligible,
        stopped,
        chatUnavailableText:async()=>groupCopy(await readGroupLocale(client,root.userId)).chatUnavailable,
        contribution: runtime.contribution ? (message, member, earlier) => modelScope(()=>runtime.contribution!(message, member, earlier)) : undefined,
        delegate: runtime.delegate ? (reporter, delegation) => runtime.delegate!({ userId:root.userId, workspaceId:root.workspaceId, conversationId, messageId:messageId!, reporter, text:input.text, delegation },client) : undefined,
        generate: (agent, input) => untilStopped(stopped, async signal => {
          input = { ...input, signal, attachmentContext: { userId: root.userId, conversationId } }
          const generate = async (value: typeof input) => {
            const eventId = `generate:${++generationCount}`
            await recordGroupTraceEvent(client, messageId!, { id: eventId, type: 'generate', memberId: agent.id })
            const reply = await runtime.generate(agent, value)
            if (addsNothing(reply.text) || !reply.text.trim()) await recordGroupTraceEvent(client, messageId!, { id: `silent:${eventId}`, type: 'silent', memberId: agent.id })
            return reply
          }
          if (agent.memberType !== 'bot') return modelScope(() => generate(input))
          const { withDatabaseClient } = await import('@/lib/db')
          return withDatabaseClient(client, async () => {
            let selected = selections.get(agent.id) ?? root.modelSelections?.[agent.id]
            if (!selected) {
              if (!runtime.prepareBot) throw Error('group_bot_model_unavailable')
              const value = await runtime.prepareBot(agent, { ownerId: root.userId, workspaceId: root.workspaceId }, client)
              selected = { harness: value.harness, model: value.model, ...(value.modelSelection === undefined ? {} : { modelSelection: value.modelSelection }) }
              await client.query(`UPDATE group_turns SET "modelSelections"=jsonb_set("modelSelections",ARRAY[$2::text],$3::jsonb,true) WHERE "messageId"=$1`, [messageId, agent.id, JSON.stringify(selected)])
              selections.set(agent.id, selected!)
            }
            return modelScope(() => generate({ ...input, modelRuntime: selected }))
          })
        }),
        async status(id, outcome = 'succeeded') {
          await client.query('BEGIN')
          try {
            if (id) {
              const actor = (await eligible()).find(a => a.id === id)
              if (!actor) throw Error('group_actor_no_longer_authorized')
              await recordGroupTraceEvent(client, messageId!, { id: `wake:${++wakeCount}`, type: 'wake', memberId: id })
              if (actor.memberType === 'bot') {
                await client.query(`UPDATE group_turns SET "botId"=$2,"agentId"=NULL,"activeRunId"=NULL,"updatedAt"=now() WHERE "messageId"=$1`, [messageId, id])
                await client.query('COMMIT')
                return
              }
              const runId = randomUUID()
              // #102 reads owner-filtered, live agent_runs. No device, prompt,
              // transcript or group/member IDs enter that shared status contract.
              // Provider calls time out after 20s; the 60s lease bounds stale UI
              // status if the process dies before its finally/recovery path.
              await client.query(`INSERT INTO agent_runs (id,"userId","agentId",kind,status,"startedAt","leaseExpiresAt") VALUES ($1,$2,$3,'group_chat','running',now(),now()+interval '60 seconds')`, [runId, root.createdBy, id])
              await client.query('UPDATE group_turns SET "agentId"=$2,"activeRunId"=$3,"botId"=NULL,"updatedAt"=now() WHERE "messageId"=$1', [messageId, id, runId])
            } else {
              await client.query(`UPDATE agent_runs SET status=$2,"finishedAt"=now(),"leaseExpiresAt"=NULL,"updatedAt"=now() WHERE id=(SELECT "activeRunId" FROM group_turns WHERE "messageId"=$1) AND kind='group_chat' AND "userId"=$3 AND status='running'`, [messageId, outcome, root.createdBy])
              await client.query('UPDATE group_turns SET "agentId"=NULL,"activeRunId"=NULL,"botId"=NULL,"updatedAt"=now() WHERE "messageId"=$1', [messageId])
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
            const pair = [`${sender.memberType ?? 'agent'}:${senderId}`, `${recipient.memberType ?? 'agent'}:${recipientId}`].sort().join(':')
            const link = await appendGroupExchange(client, { sourceId: conversationId, anchorId: messageId!, ownerId: root.createdBy, workspaceId: root.workspaceId,
              senderId, recipientId, senderType: sender.memberType ?? 'agent', recipientType: recipient.memberType ?? 'agent', text: reply.text, title: `${sender.name} ⇄ ${recipient.name}`, linkId: exchangeLinks.get(pair) })
            await recordGroupTraceEvent(client, messageId!, { id: randomUUID(), type: 'private_publish', memberId: senderId })
            await client.query('COMMIT')
            exchangeLinks.set(pair, link.linkId)
            return true
          } catch (error) { await client.query('ROLLBACK'); throw error }
        },
        async publish(id, reply) {
          await client.query('BEGIN')
          try {
            await client.query('SELECT id FROM conversations WHERE id=$1 FOR UPDATE', [conversationId])
            // A reply that finished as the person pressed 停止 is not posted.
            if ((await client.query(`SELECT status FROM group_turns WHERE "messageId"=$1 FOR UPDATE`, [messageId])).rows[0]?.status !== 'running') { await client.query('ROLLBACK'); return false }
            const current = await eligible()
            const actor = current.find(a => a.id === id)
            if (!actor) { await client.query('ROLLBACK'); return false }
            const unknown = reply.mentions.filter(mention => !current.some(a => a.id === mention))
            if (unknown.length) throw new UnknownMentionError(unknown)
            const { rows: positions } = await client.query('UPDATE conversations SET "lastPosition"="lastPosition"+1 WHERE id=$1 RETURNING "lastPosition"::text AS position', [conversationId])
            await client.query(`INSERT INTO conversation_messages (id,"conversationId",position,"authorType","authorId",body,mentions,"replyToId") VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [randomUUID(), conversationId, positions[0].position, actor.memberType ?? 'agent', id, reply.text, JSON.stringify(reply.mentions.map(memberId => ({ memberType: current.find(a => a.id === memberId)?.memberType ?? 'agent', memberId }))), messageId])
            await recordGroupTraceEvent(client, messageId!, { id: `publish:${positions[0].position}`, type: 'publish', memberId: id, contentDigest: createHash('sha256').update(reply.text.trim()).digest('hex') })
            await client.query('COMMIT')
            return true
          } catch (error) { await client.query('ROLLBACK'); throw error }
        },
      }, deadline)
    }
    const completed = await client.query(`UPDATE group_turns SET status='complete',"updatedAt"=now() WHERE "messageId"=$1 AND status='running'`, [messageId])
    if (completed.rowCount) await finishGroupDecisionTrace(client, messageId!, 'complete')
    return true
  } catch (error) {
    if (!messageId) throw error
    // Stopped: the abort it caused is the stop, not a failure.
    if ((await client.query(`SELECT error FROM group_turns WHERE "messageId"=$1`, [messageId])).rows[0]?.error === GROUP_TURN_STOPPED) return true
    const reason = error instanceof GroupJudgmentPendingError ? 'group_judgment_pending' : error instanceof UnknownMentionError ? 'unknown_mention' : groupGenerationFailure(error)
    await client.query(`UPDATE group_turns SET status='failed',"agentId"=NULL,"botId"=NULL,error=$2,"updatedAt"=now(),
      "decisionAttempts"="decisionAttempts"+CASE WHEN $2='group_judgment_pending' THEN 1 ELSE 0 END,
      "nextDecisionAt"=CASE WHEN $2='group_judgment_pending' AND route IS NULL THEN now()+make_interval(secs=>LEAST(900,60*power(2,LEAST("decisionAttempts",4)))::double precision) ELSE NULL END
      WHERE "messageId"=$1 AND status='running'`, [messageId, reason])
    await finishGroupDecisionTrace(client, messageId, error instanceof GroupJudgmentPendingError ? 'blocked' : 'failed')
    console.error(JSON.stringify({ event: 'group_generation_failed', reason, conversationId, messageId }))
    throw error
  } finally {
    try { if (locked) await client.query(`SELECT pg_advisory_unlock(hashtextextended(current_database() || '.' || current_schema() || '.group-turn.' || $1,0))`, [conversationId]) }
    catch { discard = true }
    finally { client.release(discard) }
  }
}

/** Pure serial round engine, shared by the real adapter and scripted CI. */
/** Runs `work` with a signal that aborts once `stopped()` says the turn was stopped (polled while it runs). */
export async function untilStopped<T>(stopped: () => Promise<boolean>, work: (signal: AbortSignal) => Promise<T>, every = STOP_POLL_MS): Promise<T> {
  const controller = new AbortController()
  let polling = false
  const timer = setInterval(() => {
    if (polling) return
    polling = true
    void stopped().then(yes => { if (yes) controller.abort(new Error(GROUP_TURN_STOPPED)) }, () => undefined).finally(() => { polling = false })
  }, every)
  try { return await work(controller.signal) } finally { clearInterval(timer) }
}

export async function runGroupRounds(route: GroupRoute, message: GroupMessage, io: {
  eligible(): Promise<GroupAgent[]>
  /** 停止: true once the turn was stopped; no further reply is generated. */
  stopped?(): Promise<boolean>
  chatUnavailableText?(): Promise<string>
  generate: GroupRuntime['generate']
  contribution?: GroupRuntime['contribution']
  delegate?(reporter: GroupAgent, delegation: import('./group-routing').GroupDelegation): Promise<GroupReply>
  publish(id: string, reply: GroupReply): Promise<boolean>
  publishPrivate?(senderId: string, recipientId: string, reply: GroupReply): Promise<boolean>
  status(id: string | null, outcome?: 'succeeded' | 'failed'): Promise<void>
}, deadline = Date.now() + 220000) {
  if (route.action === 'ignore' || route.action === 'observe') {
    if (route.responders.length) throw new GroupJudgmentPendingError()
    return
  }
  if (route.action === 'delegate') {
    if (route.responders.length !== 1 || !route.delegation || !io.delegate) throw new GroupJudgmentPendingError()
    if (await io.stopped?.()) return
    const reporter = (await io.eligible()).find(member=>member.id === route.responders[0])
    if (!reporter) throw Error('group_actor_no_longer_authorized')
    const reply = await io.delegate(reporter, route.delegation)
    if (reply.text.trim() && !await io.stopped?.()) await io.publish(reporter.id, reply)
    return
  }
  let next = route.responders
  const earlier: { author: string; text: string }[] = []
  for (let round = 0; round < GROUP_MAX_ROUNDS && next.length; round++) {
    const follow = new Set<string>()
    for (const id of new Set(next)) {
      if (await io.stopped?.()) return
      if (Date.now() > deadline) throw new Error('group_generation_budget_exceeded')
      const current = await io.eligible()
      const agent = current.find(a => a.id === id)
      if (!agent) continue
      if (agent.chatAvailable === false) {
        const reply={text:await io.chatUnavailableText?.() ?? groupCopy('zh-CN').chatUnavailable,mentions:[]}
        if (await io.publish(id,reply)) earlier.push({author:agent.name,text:reply.text})
        continue
      }
      // Decide before paying for a second answer. The generation marker remains a final output guard.
      if (earlier.length && io.contribution && !(await io.contribution(message, agent, earlier)).contribute) continue
      await io.status(id)
      let reply: GroupReply
      let outcome: 'succeeded' | 'failed' = 'failed'
      try { reply = await io.generate(agent, { message, earlier: [...earlier], members: current, followUp: route.action === 'clarify' ? 'Ask only for the essential missing information or permission. Do not claim execution has started.' : followUpInstructions(earlier), ask: route.by === 'lead' ? route.ask : undefined }); outcome = 'succeeded' }
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
          if (await io.stopped?.()) return
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
