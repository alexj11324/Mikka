import 'server-only'
import type { Pool } from 'pg'
import { z } from 'zod'
import { ActionFailureError } from './action-error'
import { factoryEventId } from './factory/event-id'
import { runChanged } from './live/panels'

export type ThreadSubmissionResult = { runId: string; continued: boolean }
type Input = {
  userId: string; requestId: string; rootRunId: string; requestedRunId: string
  previousRunId: string; issueId: string | null; botId: string | null; text: string
  delivery?: 'queue' | 'steer' | 'interrupt' | 'afterRun' | 'version'
  mode: 'message' | 'continuation'
}
const resultSchema = z.object({ runId: z.uuid(), continued: z.boolean() }).strict()

/** This is the existing owner turn's receipt, not another inbox or dispatcher.
 * A client ID belongs to one owner and immutable thread/payload. An existing
 * intent without a durable outcome is never dispatched a second time. Only
 * the host's existing question-answer adapter may recover its own transaction. */
export async function submitThreadOnce(pool: Pool, input: Input,
  deliver: (sourceEventId: string) => Promise<ThreadSubmissionResult>,
  recoverQuestion?: (sourceEventId: string, previousRunId: string, receiptOnly: boolean) => Promise<ThreadSubmissionResult | null>,
): Promise<ThreadSubmissionResult> {
  const requestId = z.uuid().parse(input.requestId).toLowerCase()
  const id = factoryEventId('thread-submission', JSON.stringify([input.userId, requestId]))
  const binding = { requestId, rootRunId: input.rootRunId, requestedRunId: input.requestedRunId, mode: input.mode, ...(input.delivery ? { delivery: input.delivery } : {}) }
  // Queue and immediate delivery share one client request namespace. Acquire
  // the lock before the receipt read so concurrent intents see the winner.
  const client = await pool.connect()
  let inserted: boolean
  try {
    await client.query('BEGIN')
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))', [id])
    const queued = await client.query('SELECT 1 FROM thread_queued_messages WHERE "userId"=$1 AND "requestId"=$2', [input.userId, requestId])
    if (queued.rowCount) throw new ActionFailureError('submissionConflict')
    const receipt = await client.query(`INSERT INTO coordinator_events
    (id,"userId","botId","issueId",kind,"dedupeKey",payload,tier,"deliveredAt")
    VALUES($1,$2,$3,$4,'user_message',$5,$6,'background',now()) ON CONFLICT DO NOTHING RETURNING id`,
  [id, input.userId, input.botId, input.issueId, `thread-submission:${id}`,
    JSON.stringify({ text: input.text, source: 'thread_continuation', previousRunId: input.previousRunId,
      postedToChat: true, threadSubmission: binding })])
    inserted = Boolean(receipt.rowCount)
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally { client.release() }
  const { rows: [event] } = await pool.query(`SELECT "userId","botId","issueId",kind,payload
    FROM coordinator_events WHERE id=$1`, [id])
  const recorded = event?.payload?.threadSubmission
  if (!event || event.userId !== input.userId || event.botId !== input.botId || event.issueId !== input.issueId
    || event.kind !== 'user_message' || event.payload?.source !== 'thread_continuation'
    || event.payload?.text !== input.text || recorded?.requestId !== binding.requestId
    || recorded?.delivery !== binding.delivery
    || recorded?.rootRunId !== binding.rootRunId || recorded?.requestedRunId !== binding.requestedRunId
    || !['message','continuation'].includes(recorded?.mode)
    || !z.uuid().safeParse(event.payload?.previousRunId).success) throw new ActionFailureError('submissionConflict')
  const previousRunId: string = event.payload.previousRunId

  const showOnce = async (result: ThreadSubmissionResult) => {
    // A recovered Factory acceptance can precede the original response's
    // display row. This is history only: the target already reached its epoch.
    const shown = await pool.query(`INSERT INTO run_messages(id,"runId","userId",text,origin,"mailboxWakeDepth","deliveredAt")
      SELECT $1,id,$2,$3,'owner',-1,now() FROM agent_runs
      WHERE id=$4 AND "userId"=$2 AND "issueId" IS NOT DISTINCT FROM $5::uuid
      ON CONFLICT DO NOTHING RETURNING id`, [id, input.userId, input.text, result.runId, input.issueId])
    if (shown.rowCount) await runChanged(pool, result.runId)
  }
  const saveResult = async (result: ThreadSubmissionResult) => {
    const { rows: [saved] } = await pool.query(`UPDATE coordinator_events
      SET payload=jsonb_set(payload,'{threadSubmission,result}',coalesce(payload#>'{threadSubmission,result}',$3::jsonb))
      WHERE id=$1 AND "userId"=$2 RETURNING payload#>'{threadSubmission,result}' AS result`,
    [id, input.userId, JSON.stringify(result)])
    return resultSchema.parse(saved?.result)
  }
  const readOutcome = async (): Promise<ThreadSubmissionResult | null> => {
    const { rows: [current] } = await pool.query(`SELECT payload->'threadSubmission'->'result' AS result
      FROM coordinator_events WHERE id=$1 AND "userId"=$2`, [id, input.userId])
    const saved = resultSchema.safeParse(current?.result)
    if (saved.success) return saved.data
    // request_epoch was committed with the target advance. Even if another
    // request has superseded it, this receipt remains accepted history. Never
    // call advance/stop on replay, and never treat result.task as live state.
    const { rows: [accepted] } = await pool.query(`SELECT a."runId"
      FROM factory_events e JOIN factory_tasks t ON t.id=e."taskId"
      LEFT JOIN LATERAL (SELECT fa."runId" FROM factory_attempts fa JOIN agent_runs r ON r.id=fa."runId"
        WHERE fa."taskId"=t.id AND fa.stage='execute' AND r."userId"=$2 AND r."issueId"=$3
          AND (fa.output->>'requestEpoch'=$1::text OR fa.id::text=e.result->'task'->>'attemptId')
        ORDER BY fa.position,fa.id LIMIT 1) a ON true
      WHERE e."eventId"=$4 AND t."userId"=$2 AND t."issueId"=$3
        AND t."botId" IS NOT DISTINCT FROM $5::uuid AND e.request->>'kind'='request_epoch'
        AND e.request->>'sourceEventId'=$1::text AND e.request->>'previousRunId'=$6
        AND e.result->>'requestEpoch'=$1::text`,
    [id, input.userId, input.issueId, factoryEventId('request-epoch', id), input.botId, previousRunId])
    if (accepted && (recorded.mode === 'message' || accepted.runId)) {
      const result = recorded.mode === 'message' ? { runId: previousRunId, continued: false }
        : { runId: accepted.runId, continued: accepted.runId !== previousRunId }
      await showOnce(result)
      return saveResult(result)
    }
    // The normal admission key also survives a response lost after queueing
    // but before the thread's display/link write completed.
    const { rows: [queued] } = await pool.query(`SELECT id FROM agent_runs
      WHERE "userId"=$1 AND "issueId" IS NOT DISTINCT FROM $2::uuid AND "dispatchKey"=$3`,
    [input.userId, input.issueId, `thread:${previousRunId}:${id}`])
    if (queued) {
      const result = { runId: queued.id, continued: queued.id !== previousRunId }
      await showOnce(result)
      return saveResult(result)
    }
    const { rows: [message] } = await pool.query(`SELECT m."runId" FROM run_messages m
      JOIN agent_runs r ON r.id=m."runId" WHERE m.id=$1 AND m."userId"=$2 AND r."userId"=$2
        AND r."issueId" IS NOT DISTINCT FROM $3::uuid AND m.text=$4 AND m.origin='owner'`,
    [id, input.userId, input.issueId, input.text])
    return message ? saveResult({ runId: message.runId, continued: message.runId !== previousRunId }) : null
  }
  if (!inserted) {
    const outcome = await readOutcome()
    if (outcome) {
      // An answered question can be durable before its VM wake succeeds. A
      // saved acknowledgement permits replay of that exact receipt only;
      // it never authorizes answering a new question or dispatching again.
      if (recorded.mode === 'continuation' && outcome.runId === previousRunId && !outcome.continued)
        await recoverQuestion?.(id, previousRunId, true)
      return outcome
    }
    const answer = recorded.mode === 'continuation' ? await recoverQuestion?.(id, previousRunId, false) : null
    if (answer) return saveResult(answer)
    throw new Error('threadSubmissionOutcomeUnconfirmed')
  }
  try { return await saveResult(await deliver(id)) }
  catch (error) {
    // afterRunEnded/notification or the response can fail after the transaction
    // committed. A host receipt can acknowledge it; a missing receipt cannot.
    const outcome = await readOutcome()
    if (outcome) return outcome
    throw error
  }
}
