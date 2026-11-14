import { queueTaskRun } from '@/lib/factory/queue-local'
import 'server-only'
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { db, pool } from '@/lib/db'
import { agentRuns, runMessages } from '@/lib/db/schema'
import type { TaskThreadRun } from '@/lib/thread-dispatch'
import { ActionFailureError } from '@/lib/action-error'
import { ACTION_ERROR_CODES, type ActionErrorCode } from '@/lib/action-result'
import { addRunMessage } from '@/lib/agent-runs'
import { readRunChain } from '@/lib/run-chain'
import { UNFINISHED_RUN_STATUSES } from '@/lib/agent-run-statuses'
import { splitChatFiles } from '@mikka/protocol/chat-attachments'
import { runChanged } from '@/lib/live/panels'

type Source = Parameters<typeof addRunMessage>[2]
const isActionErrorCode = (code: string): code is ActionErrorCode => (ACTION_ERROR_CODES as readonly string[]).includes(code)

/**
 * What someone types in an open thread (R-10, R-81). A thread that is working
 * gets it as a message, as before. One that has ended (done, failed, stopped,
 * cancelled) runs again in the same thread: its task's next run goes on from
 * the thread's last one (lib/thread-dispatch.ts), on the same machine and
 * repository, with the words as its note, and through the same admission as
 * any dispatch (the device or cloud computer, the credential and its quota).
 * Only the thread's owner may send, as for a working thread.
 */
export async function sendThreadMessage(userId: string, runId: string, text: string, source: Source = 'user', requestId?: string, delivery?: 'queue' | 'steer' | 'interrupt' | 'afterRun' | 'version'): Promise<{ runId: string; continued: boolean }> {
  const parsed = z.object({ runId: z.uuid(), text: z.string().trim().min(1).max(10_000), requestId: z.uuid().optional() }).safeParse({ runId, text, requestId })
  if (!parsed.success) throw new ActionFailureError('messageRequired')
  // The owner's chain only: a teammate who can see a shared thread cannot run it.
  const chain = await readRunChain(pool, userId, parsed.data.runId)
  if (!chain) throw new ActionFailureError('runNotFound')
  if (splitChatFiles(parsed.data.text).files.length) {
    const { validateChatFiles } = await import('@/lib/chat-attachments/store')
    try { await validateChatFiles(userId, { kind: 'thread', id: parsed.data.runId }, parsed.data.text) } catch { throw new ActionFailureError('messageRequired') }
  }
  const active = UNFINISHED_RUN_STATUSES.some(status => status === chain.attempts.at(-1)?.status)
  if (delivery === 'queue' && requestId) {
    const { queueThreadReply, readQueuedReplyReceipt } = await import('./thread-delivery-queue')
    const receipt = await readQueuedReplyReceipt(pool, userId, chain, parsed.data.text, requestId, parsed.data.runId)
    if (receipt) return receipt
    if (active) return queueThreadReply(pool, userId, chain, parsed.data.text, requestId, parsed.data.runId)
  }
  if (delivery && !requestId) throw new ActionFailureError('validationGeneric')
  if (parsed.data.requestId) {
    // The client anchors its first attempt, even when a lost response has
    // already moved this chain. Resolve that receipt before choosing work.
    const { rows: [scope] } = await pool.query(`SELECT r."issueId",CASE WHEN f.id IS NOT NULL THEN f."botId" ELSE r."botId" END AS "botId"
      FROM agent_runs r LEFT JOIN LATERAL (SELECT t.id,t."botId" FROM factory_attempts a
        JOIN factory_tasks t ON t.id=a."taskId" WHERE a."runId"=r.id AND t."userId"=r."userId" LIMIT 1) f ON true
      WHERE r.id=$1 AND r."userId"=$2`, [parsed.data.runId, userId])
    if (!scope) throw new ActionFailureError('runNotFound')
    const { submitThreadOnce } = await import('@/lib/thread-submission')
    return submitThreadOnce(pool, { userId, requestId: parsed.data.requestId, rootRunId: chain.rootRunId,
      requestedRunId: parsed.data.runId, previousRunId: chain.latestRunId, issueId: scope.issueId, botId: scope.botId, text: parsed.data.text, delivery,
      mode: UNFINISHED_RUN_STATUSES.some(status => status === chain.attempts.find(attempt => attempt.runId === chain.latestRunId)?.status) ? 'message' : 'continuation' },
    sourceEventId => {
      if ((delivery === 'afterRun' || delivery === 'version') && (active || chain.latestRunId !== parsed.data.runId)) throw new ActionFailureError('threadReplaced')
      if (delivery === 'afterRun' && chain.attempts.at(-1)?.status !== 'succeeded') throw new ActionFailureError('threadDeliveryUnavailable')
      if ((delivery === 'steer' || delivery === 'interrupt') && (!active || chain.latestRunId !== parsed.data.runId)) throw new ActionFailureError('runNotActive')
      return continueThread(userId, parsed.data.text, source, chain, sourceEventId, delivery)
    },
    typeof source === 'object' && source.source === 'human'
      ? (sourceEventId, previousRunId, receiptOnly) => recoverThreadQuestionAnswer(userId, previousRunId, parsed.data.text, source.sessionId, sourceEventId, scope, receiptOnly)
      : undefined)
  }
  return continueThread(userId, parsed.data.text, source, chain)
}

/** Only the question that already existed when this owner submitted may be
 * retried. Never re-enter ordinary dispatch, target the chain's newer run or
 * forward an old answer as a mailbox message. */
async function recoverThreadQuestionAnswer(userId: string, previousRunId: string, text: string,
  sessionId: string, sourceEventId: string, scope: { issueId: string | null; botId: string | null }, receiptOnly: boolean) {
  const { rows: [identity] } = await pool.query(`SELECT q.id FROM coordinator_events submission
    JOIN factory_questions q ON q."originRunId"=$3 AND q."userId"=submission."userId"
      AND q."issueId"=submission."issueId" AND q."createdAt"<=submission."createdAt"
    JOIN factory_tasks t ON t.id=q."taskId" AND t."userId"=q."userId" AND t."issueId"=q."issueId"
      AND t."botId" IS NOT DISTINCT FROM submission."botId"
    JOIN agent_runs origin ON origin.id=q."originRunId" AND origin."userId"=q."userId" AND origin."issueId"=q."issueId"
    JOIN "session" human ON human.id=$6 AND human."userId"=submission."userId" AND human."expiresAt">clock_timestamp()
    WHERE submission.id=$1 AND submission."userId"=$2 AND submission."issueId"=$4
      AND submission."botId" IS NOT DISTINCT FROM $5::uuid`,
  [sourceEventId, userId, previousRunId, scope.issueId, scope.botId, sessionId])
  if (!identity) return null
  const { factoryRuntimeForBot } = await import('@/lib/factory/runtime')
  const { factoryEventId } = await import('@/lib/factory/event-id')
  const { questionFingerprint, humanQuestionAnswerSchema } = await import('@/lib/factory/questions/contract')
  const { questionReference } = await import('@/lib/factory/questions/store')
  const questions = factoryRuntimeForBot(scope.botId).questions
  const question = await questions.read(userId, identity.id)
  const answerId = factoryEventId('task-thread-question-answer', questionFingerprint({ questionId: question.id, userId, text }))
  if (question.answerId) {
    const saved = question.answer as { source?: string; userId?: string; input?: unknown } | null
    const parsed = humanQuestionAnswerSchema.safeParse(saved?.input)
    if (question.answerId !== answerId || question.answerSource !== 'human' || saved?.source !== 'human'
      || saved.userId !== userId || !parsed.success || parsed.data.answerId !== answerId || parsed.data.text !== text
      || parsed.data.reference.questionId !== question.id || parsed.data.reference.originRunId !== previousRunId
      || parsed.data.reference.originSessionId !== question.originSessionId
      || questionFingerprint(parsed.data.reference.binding) !== questionFingerprint(question.waitingBinding)
      || question.answerFingerprint !== questionFingerprint({ source: 'human', userId, input: parsed.data })) return null
    // A committed answer's immutable receipt, not its mutable status, proves
    // acceptance even after the child has completed or the task has advanced.
    const { rows: [accepted] } = await pool.query(`SELECT e.result->'task'->>'sourceEventId' AS "requestEpoch",
        e.result->'task'->>'attemptId' AS "attemptId" FROM factory_events e
      JOIN agent_runs child ON child.id=$3::uuid AND child."userId"=$4 AND child."issueId"=$5
        AND child."questionContinuation"->>'questionId'=$6 AND child."questionContinuation"->>'originRunId'=$7
        AND child."questionContinuation"->>'originSessionId'=$8 AND child."questionContinuation"->>'requireSessionResume'='true'
      WHERE e."taskId"=$1 AND e."eventId"=$2 AND e.request=$9::jsonb
        AND e.result->>'questionId'=$6 AND e.result->>'answerId'=$10
        AND e.result->>'answerFingerprint'=$11 AND e.result->>'originRunId'=$7
        AND e.result->>'originSessionId'=$8 AND e.result->>'originAttemptId'=$12
        AND e.result->>'continuationRunId'=$3::text`,
    [question.taskId, factoryEventId('question-resume', answerId), question.continuationRunId, userId, scope.issueId,
      question.id, previousRunId, question.originSessionId, JSON.stringify({ kind: 'question_resume', source: 'human', userId, input: parsed.data }),
      answerId, question.answerFingerprint, question.attemptId])
    if (!accepted || !z.uuid().safeParse(accepted.requestEpoch).success || !z.uuid().safeParse(accepted.attemptId).success) return null
    const pendingWake = async () => Boolean((await pool.query(`SELECT 1 FROM factory_questions q
      JOIN factory_tasks t ON t.id=q."taskId" AND t."userId"=q."userId" AND t."issueId"=q."issueId"
      JOIN factory_attempts a ON a.id=t."attemptId" AND a."taskId"=t.id
      JOIN agent_runs child ON child.id=q."continuationRunId" AND child.id=a."runId"
        AND child."userId"=q."userId" AND child."issueId"=q."issueId"
      WHERE q.id=$1 AND q."userId"=$2 AND q."continuationRunId"=$3 AND q."answerId"=$4
        AND q.status='resuming' AND (q."expiresAt" IS NULL OR q."expiresAt">clock_timestamp())
        AND t.status='running' AND a.status='running' AND t.stage=q.stage
        AND t."sourceEventId"=$5::uuid AND t."attemptId"=$6::uuid AND t."candidateId" IS NOT DISTINCT FROM q."candidateId"
        AND child.status='queued' AND child."stopRequestedAt" IS NULL`,
    [question.id, userId, question.continuationRunId, answerId, accepted.requestEpoch, accepted.attemptId])).rowCount)
    if (await pendingWake()) {
      try {
        // Reuse the existing answer replay: it cannot admit another run and
        // its postcommit hook wakes this same queued native continuation.
        await questions.answer({ source: 'human', userId, sessionId }, parsed.data)
      } catch (error) {
        const { FactoryError } = await import('@/lib/factory/contract')
        // Cancellation/advance may win after the eligibility read. The exact
        // receipt stays accepted history; never wake or retry another target.
        if (!(error instanceof FactoryError) || !['factoryStopped', 'factoryQuestionExpired', 'factoryQuestionStale'].includes(error.code)
          || await pendingWake()) throw error
      }
    }
    return { runId: previousRunId, continued: false }
  }
  if (receiptOnly) return null
  // answer() locks and revalidates the task/question/session, preserves the
  // original model and machine, and admits at most one native continuation.
  await questions.answer({ source: 'human', userId, sessionId }, { reference: questionReference(question), answerId, text })
  return { runId: previousRunId, continued: false }
}

async function continueThread(userId: string, text: string, source: Source,
  chain: NonNullable<Awaited<ReturnType<typeof readRunChain>>>, sourceEventId?: string, delivery?: 'queue' | 'steer' | 'interrupt' | 'afterRun' | 'version'): Promise<{ runId: string; continued: boolean }> {
  const latest = chain.attempts.find(attempt => attempt.runId === chain.latestRunId)!
  if (UNFINISHED_RUN_STATUSES.some(status => status === latest.status)) {
    if (delivery === 'steer') {
      // Cursor queues during a prompt; Claude SDK may defer or fold an input.
      // Only Codex exposes a native active-turn steer receipt.
      const { rows: [run] } = await pool.query(`SELECT coalesce(r."agentDefinition"->>'harness',a.harness) AS harness
        FROM agent_runs r JOIN agents a ON a.id=r."agentId" JOIN devices device ON device.id=r."deviceId" AND device."ownerId"=r."userId"
        WHERE r.id=$1 AND r."userId"=$2 AND r.status='running' AND device.harnesses @> '[{"harness":"codex","installed":true,"activeTurnSteer":true}]'::jsonb
        AND r."stopRequestedAt" IS NULL`, [latest.runId, userId])
      if (run?.harness !== 'codex') throw new ActionFailureError('threadDeliveryUnavailable')
      await addRunMessage(userId, { runId: latest.runId, text }, source, sourceEventId)
      return { runId: latest.runId, continued: false }
    }
    if (source === 'user' || (typeof source === 'object' && source.source === 'human'))
      if (await (await import('@/lib/factory/request-epoch')).continueActiveFactoryRequest(pool, userId, latest.runId, text, sourceEventId, sourceEventId ? { recordOwnerMessage: true } : undefined))
        return { runId: latest.runId, continued: false }
    if (delivery === 'interrupt') throw new ActionFailureError('threadDeliveryUnavailable')
    await addRunMessage(userId, { runId: latest.runId, text }, source, sourceEventId)
    return { runId: latest.runId, continued: false }
  }
  // An ended run that asked a Factory question is answered there, as before.
  const { rows: [question] } = await pool.query('SELECT 1 FROM factory_questions WHERE "originRunId"=$1 AND "userId"=$2 LIMIT 1', [latest.runId, userId])
  if (question) {
    // A pre-existing queued instruction cannot answer a question the user
    // had not seen when they wrote it.
    if (delivery === 'afterRun' || delivery === 'version') throw new ActionFailureError('factoryQuestionNeedsAnswerTool')
    await addRunMessage(userId, { runId: latest.runId, text }, source, sourceEventId)
    return { runId: latest.runId, continued: false }
  }
  const [run] = await db.select().from(agentRuns).where(and(eq(agentRuns.id, latest.runId), eq(agentRuns.userId, userId))).limit(1)
  if (!run) throw new ActionFailureError('runNotFound')
  // A failed required-SID continuation belongs to its original Factory task.
  // Ordinary text must not cancel that task and create a fresh request epoch;
  // only the explicit owner recovery path can resume its retained session.
  if (run.status === 'failed' && run.questionContinuation?.requireSessionResume === true) throw new ActionFailureError('threadCannotContinue')
  // The next run is the task's (one task, one thread); a thread with no task has nothing to run again.
  if (!run.issueId || !run.deviceRepoId) throw new ActionFailureError('threadCannotContinue')
  const issueId = run.issueId
  const { dispatchToTask, latestTaskRun } = await import('@/lib/thread-dispatch')
  // Another thread took the task over (a new thread was asked for): this one is history now.
  if ((await latestTaskRun(pool, userId, issueId))?.id !== run.id) throw new ActionFailureError('threadReplaced')
  const version = delivery === 'version' ? (await pool.query<{ executionNote:string }>(
    'SELECT "executionNote" FROM thread_reply_versions WHERE "sourceEventId"=$1 AND "userId"=$2 AND "workspaceId"=$3 AND "admissionRunId"=$4 AND text=$5',
    [sourceEventId,userId,run.workspaceId,run.id,text])).rows[0] : undefined
  if (delivery === 'version' && !version) throw new ActionFailureError('submissionConflict')
  const result = await dispatchToTask(userId, issueId, {
    note: text,
    ...(sourceEventId ? { expectedRunId: run.id } : {}),
    start: async (previous, note) => {
      if (previous?.id !== run.id) throw new ActionFailureError('threadReplaced')
      // This is provenance for this already authorized thread action, not a
      // second Bot inbox message. Preserve the raw turn before adding the
      // execution-only continuation summary to its note.
      let request: { sourceEventId: string; botId: string | null } | undefined
      if (source === 'user' || (typeof source === 'object' && source.source === 'human')) {
        const { rows: [factory] } = await pool.query(`SELECT t."botId" FROM factory_attempts a JOIN factory_tasks t ON t.id=a."taskId" WHERE a."runId"=$1 AND t."userId"=$2 AND t."issueId"=$3 ORDER BY a.position DESC LIMIT 1`, [run.id, userId, issueId])
        const botId = factory ? factory.botId : run.botId
        const eventId = sourceEventId ?? crypto.randomUUID()
        await pool.query(`INSERT INTO coordinator_events (id,"userId","botId","issueId",kind,"dedupeKey",payload,tier,"deliveredAt") VALUES ($1,$2,$3,$4,'user_message',$5,$6,'background',now()) ON CONFLICT DO NOTHING`,
          [eventId, userId, botId, issueId, `thread-continuation:${eventId}`, JSON.stringify({ text, source: 'thread_continuation', previousRunId: run.id, postedToChat: true })])
        request = { sourceEventId: eventId, botId }
      }
      return queueNextRun(userId, run, previous, version?.executionNote ?? note, request)
    },
  })
  // A dispatch the person can act on (no machine, say) queued nothing.
  if ('error' in result) throw new ActionFailureError(isActionErrorCode(result.error) ? result.error : 'runInvalid')
  if (result.thread === 'message') return { runId: result.runId, continued: false }
  // The words are already in the new run's note; this row shows them in the thread and is never delivered again.
  const display = db.insert(runMessages).values({ id: sourceEventId ?? crypto.randomUUID(), runId: result.runId, userId, text, origin: 'owner', mailboxWakeDepth: -1, deliveredAt: new Date() })
  if (sourceEventId) await display.onConflictDoNothing()
  else await display
  await runChanged(db, result.runId)
  return { runId: result.runId, continued: true }
}

/** The thread's next run, queued the way its last one was: on the bot's cloud computer, else on the same device. */
async function queueNextRun(userId: string, run: typeof agentRuns.$inferSelect, previous: TaskThreadRun, note: string | undefined, request?: { sourceEventId: string; botId: string | null }) {
  const issueId = run.issueId!
  const readOnly = previous.readOnly ? { readOnly: true } : {}
  if (previous.cloud) {
    if (previous.harness !== 'codex' && previous.harness !== 'claude_code') throw new ActionFailureError('threadCannotContinue')
    const { latestThreadRunModel } = await import('@/lib/computer/run-model')
    const runModel = await latestThreadRunModel(pool, userId, issueId, run.agentId)
    if (!runModel) throw new ActionFailureError('threadModelUnavailable')
    // The last run's repository belongs to its dedicated task machine. The
    // ordinary dispatcher resolves it on the Bot computer, then provisions
    // the next task machine and starts its lifecycle before reporting queued.
    const { dispatchComputerTask } = await import('@/workflows/coordinator/steps')
    return dispatchComputerTask(userId, { botId: previous.cloud.botId, issueId, harness: previous.harness,
      ...(previous.remoteUrl ? { repo: previous.remoteUrl } : {}), note, ...(request ? { sourceEventId: request.sourceEventId, factoryBotId: request.botId } : {}), withoutBot: run.botId === null,
      // A person's continuation in an open thread is an app entry.
      origin: 'web', originRef: null,
      ...runModel, threadRunId: run.id, ...readOnly }, `thread:${run.id}:${request?.sourceEventId ?? crypto.randomUUID()}`)
  }
  if (!previous.remoteUrl) throw new ActionFailureError('agentRepoMissing')
  // The thread's own model and account, as on the cloud; when it has none left, the person is told instead of the CLI choosing.
  const { latestThreadRunModel } = await import('@/lib/computer/run-model')
  const runModel = await latestThreadRunModel(pool, userId, issueId, run.agentId)
  if (!runModel) throw new ActionFailureError('threadModelUnavailable')
  return queueTaskRun(userId, { issueId, agentId: run.agentId, repo: previous.remoteUrl, note, ...runModel, threadRunId: run.id, ...(request ? { requestKey: `thread:${run.id}:${request.sourceEventId}` } : {}), ...readOnly }, request ? request.botId : run.botId, undefined, request?.sourceEventId, { source: run.source === 'mcp' ? 'mcp' : null, origin: 'web', originRef: null })
}
