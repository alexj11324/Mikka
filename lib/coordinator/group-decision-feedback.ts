import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { z } from 'zod'
import type { Directory } from '@/lib/group-conversations-store'
import type { GroupDecisionTrace } from './group-decision-trace'
import { priceGroupDecisions, traceDecisionSteps } from './group-decision-trace'
import { groupDecisionTotals } from './group-decision-chain'

export const groupFeedbackInput = z.object({ messageId: z.uuid(), kind: z.enum(['helpful','unhelpful','wrong_member','missed_intervention','unwanted_task','reaction_positive','reaction_negative']), targetId: z.uuid().nullable().optional() }).strict()
export async function recordGroupFeedback(client: Pick<PoolClient, 'query'>, input: {
  conversationId: string; messageId: string; userId: string; kind: z.infer<typeof groupFeedbackInput>['kind'] | 'cancelled_task' | 'cancelled_turn'
  source: 'human_explicit' | 'human_correction' | 'human_cancellation' | 'agent_evaluation'; targetId?: string | null; sourceMessageId?: string | null
}) {
  await client.query(`INSERT INTO group_decision_feedback (id,"conversationId","messageId","userId",source,kind,"targetId","sourceMessageId")
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT ("messageId","userId",source,kind)
    DO UPDATE SET "targetId"=EXCLUDED."targetId","sourceMessageId"=EXCLUDED."sourceMessageId"`,
  [randomUUID(), input.conversationId, input.messageId, input.userId, input.source, input.kind, input.targetId ?? null, input.sourceMessageId ?? null])
}

/** Shares the existing group directory and membership checks. Caller identity,
 * human provenance and workspace scope never come from the request body. */
export async function handleGroupDecisionQuality(pool: Pool, directory: Directory, req: {
  userId: string | null; conversationId: string; method: string; origin: string | null; host: string; body?: string; limit?: string | null
}) {
  if (!req.userId) return { status: 401, body: { error: 'unauthorized' } }
  if (!z.uuid().safeParse(req.conversationId).success) return { status: 404, body: { error: 'not_found' } }
  if (req.method !== 'GET' && req.method !== 'POST') return { status: 405, body: { error: 'method_not_allowed' } }
  if (req.origin) {
    try { const url = new URL(req.origin); if (!['http:', 'https:'].includes(url.protocol) || url.host !== req.host) return { status: 403, body: { error: 'origin_rejected' } } }
    catch { return { status: 403, body: { error: 'origin_rejected' } } }
  }
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const finish = async (status: number, body: unknown) => { await client.query(status < 400 ? 'COMMIT' : 'ROLLBACK'); return { status, body } }
    // Lock against removal while the trace or feedback is read/written.
    const { rows: [group] } = await client.query(`SELECT c."workspaceId" FROM conversations c JOIN conversation_members m ON m."conversationId"=c.id
      WHERE c.id=$1 AND c.kind='group' AND m."memberType"='user' AND m."memberId"=$2 AND m."leftAt" IS NULL FOR SHARE OF c`, [req.conversationId, req.userId])
    if (!group || !await directory(group.workspaceId, req.userId, [])) return finish(404, { error: 'not_found' })
    if (req.method === 'POST') {
      let parsed: unknown
      try { parsed = JSON.parse(req.body ?? '') } catch { return finish(422, { error: 'invalid_feedback' }) }
      const input = groupFeedbackInput.safeParse(parsed)
      if (!input.success) return finish(422, { error: 'invalid_feedback' })
      if (!(await client.query('SELECT 1 FROM group_turns WHERE "messageId"=$1 AND "conversationId"=$2', [input.data.messageId, req.conversationId])).rowCount) return finish(404, { error: 'not_found' })
      if (input.data.targetId) {
        const target = await client.query(`SELECT "memberType","memberId" FROM conversation_members WHERE "conversationId"=$1 AND "memberId"=$2 AND "memberType" IN ('agent','bot') AND "leftAt" IS NULL`, [req.conversationId, input.data.targetId])
        if (!target.rowCount) return finish(422, { error: 'invalid_target' })
      }
      await recordGroupFeedback(client, { conversationId: req.conversationId, userId: req.userId, ...input.data, source: 'human_explicit' })
      return finish(201, { recorded: true, source: 'human_explicit', policyChanged: false })
    }
    const limit = Number(req.limit ?? '50')
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) return finish(422, { error: 'invalid_limit' })
    const { rows } = await client.query<{ messageId: string; status: string; error: string | null; trace: GroupDecisionTrace; feedback: unknown[] }>(`SELECT t."messageId",t.status,t.error,t.trace,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('kind',f.kind,'source',f.source,'targetId',f."targetId",'createdAt',f."createdAt") ORDER BY f."createdAt") FROM group_decision_feedback f WHERE f."messageId"=t."messageId"),'[]'::jsonb)
      || COALESCE((SELECT jsonb_agg(jsonb_build_object('kind',CASE r.emoji WHEN '👍' THEN 'reaction_positive' WHEN '👎' THEN 'reaction_negative' ELSE 'reaction' END,
        'source','human_reaction','emoji',r.emoji,'replyMessageId',m.id,'createdAt',r."createdAt") ORDER BY r."createdAt")
        FROM conversation_messages m JOIN message_reactions r ON r."messageId"=m.id
        WHERE m."conversationId"=t."conversationId" AND m."replyToId"=t."messageId" AND m."authorType" IN ('agent','bot')),'[]'::jsonb) AS feedback
      FROM group_turns t JOIN conversation_messages m ON m.id=t."messageId" WHERE t."conversationId"=$1 ORDER BY m.position DESC LIMIT $2`, [req.conversationId, limit])
    const steps=rows.flatMap(row=>traceDecisionSteps(row.trace))
    const priced=await priceGroupDecisions(client,steps)
    const costs=new Map(priced.map(step=>[step.id,step.decisionCostUsd??null]))
    return finish(200, { turns: rows.map(row=>{
      const decisions=traceDecisionSteps(row.trace).map(step=>({...step,decisionCostUsd:costs.get(step.id)??null}))
      const totals=groupDecisionTotals(decisions,row.trace.decisionsOmitted??0)
      return {...row,trace:{...row.trace,decisions,decisionLatencyMs:totals.decisionLatencyMs},...totals,
        decisionCostUsd:decisions.length?totals.decisionCostUsd:null}
    }), costScope: 'routing-decision-chain', feedbackIsGroundTruth: false })
  } catch (error) { await client.query('ROLLBACK'); throw error }
  finally { client.release() }
}
