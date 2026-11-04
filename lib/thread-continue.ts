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
export async function sendThreadMessage(userId: string, runId: string, text: string, source: Source = 'user', requestId?: string): Promise<{ runId: string; continued: boolean }> {
  const parsed = z.object({ runId: z.uuid(), text: z.string().trim().min(1).max(10_000), requestId: z.uuid().optional() }).safeParse({ runId, text, requestId })
  if (!parsed.success) throw new ActionFailureError('messageRequired')
  // The owner's chain only: a teammate who can see a shared thread cannot run it.
  const chain = await readRunChain(pool, userId, parsed.data.runId)
  if (!chain) throw new ActionFailureError('runNotFound')
  if (splitChatFiles(parsed.data.text).files.length) {
    const { validateChatFiles } = await import('@/lib/chat-attachments/store')
    try { await validateChatFiles(userId, { kind: 'thread', id: parsed.data.runId }, parsed.data.text) } catch { throw new ActionFailureError('messageRequired') }
  }
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
      requestedRunId: parsed.data.runId, previousRunId: chain.latestRunId, issueId: scope.issueId, botId: scope.botId, text: parsed.data.text,
      mode: UNFINISHED_RUN_STATUSES.some(status => status === chain.attempts.find(attempt => attempt.runId === chain.latestRunId)?.status) ? 'message' : 'continuation' },
    sourceEventId => continueThread(userId, parsed.data.text, source, chain, sourceEventId))
  }
  return continueThread(userId, parsed.data.text, source, chain)
}

async function continueThread(userId: string, text: string, source: Source,
  chain: NonNullable<Awaited<ReturnType<typeof readRunChain>>>, sourceEventId?: string): Promise<{ runId: string; continued: boolean }> {
  const latest = chain.attempts.find(attempt => attempt.runId === chain.latestRunId)!
  if (UNFINISHED_RUN_STATUSES.some(status => status === latest.status)) {
    if (source === 'user' || (typeof source === 'object' && source.source === 'human'))
      if (await (await import('@/lib/factory/request-epoch')).continueActiveFactoryRequest(pool, userId, latest.runId, text, sourceEventId, sourceEventId ? { recordOwnerMessage: true } : undefined))
        return { runId: latest.runId, continued: false }
    await addRunMessage(userId, { runId: latest.runId, text }, source, sourceEventId)
    return { runId: latest.runId, continued: false }
  }
  // An ended run that asked a Factory question is answered there, as before.
  const { rows: [question] } = await pool.query('SELECT 1 FROM factory_questions WHERE "originRunId"=$1 AND "userId"=$2 LIMIT 1', [latest.runId, userId])
  if (question) {
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
      return queueNextRun(userId, run, previous, note, request)
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
      ...runModel, threadRunId: run.id, ...readOnly }, `thread:${run.id}:${request?.sourceEventId ?? crypto.randomUUID()}`)
  }
  if (!previous.remoteUrl) throw new ActionFailureError('agentRepoMissing')
  // The thread's own model and account, as on the cloud; when it has none left, the person is told instead of the CLI choosing.
  const { latestThreadRunModel } = await import('@/lib/computer/run-model')
  const runModel = await latestThreadRunModel(pool, userId, issueId, run.agentId)
  if (!runModel) throw new ActionFailureError('threadModelUnavailable')
  return queueTaskRun(userId, { issueId, agentId: run.agentId, repo: previous.remoteUrl, note, ...runModel, threadRunId: run.id, ...(request ? { requestKey: `thread:${run.id}:${request.sourceEventId}` } : {}), ...readOnly }, request ? request.botId : run.botId, undefined, request?.sourceEventId, run.source === 'mcp' ? 'mcp' : null)
}
