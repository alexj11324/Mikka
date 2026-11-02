import 'server-only'
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { db, pool } from '@/lib/db'
import { agentRuns, issues, runMessages } from '@/lib/db/schema'
import type { TaskThreadRun } from '@/lib/thread-dispatch'
import { ActionFailureError } from '@/lib/action-error'
import { ACTION_ERROR_CODES, type ActionErrorCode } from '@/lib/action-result'
import { addRunMessage } from '@/lib/agent-runs'
import { readRunChain } from '@/lib/run-chain'
import { UNFINISHED_RUN_STATUSES } from '@/lib/agent-run-statuses'
import { tiptapToText } from '@/lib/tiptap-text'

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
export async function sendThreadMessage(userId: string, runId: string, text: string, source: Source = 'user'): Promise<{ runId: string; continued: boolean }> {
  const parsed = z.object({ runId: z.uuid(), text: z.string().trim().min(1).max(10_000) }).safeParse({ runId, text })
  if (!parsed.success) throw new ActionFailureError('messageRequired')
  // The owner's chain only: a teammate who can see a shared thread cannot run it.
  const chain = await readRunChain(pool, userId, parsed.data.runId)
  if (!chain) throw new ActionFailureError('runNotFound')
  const latest = chain.attempts.find(attempt => attempt.runId === chain.latestRunId)!
  if (UNFINISHED_RUN_STATUSES.some(status => status === latest.status)) {
    await addRunMessage(userId, { runId: latest.runId, text: parsed.data.text }, source)
    return { runId: latest.runId, continued: false }
  }
  // An ended run that asked a Factory question is answered there, as before.
  const { rows: [question] } = await pool.query('SELECT 1 FROM factory_questions WHERE "originRunId"=$1 AND "userId"=$2 LIMIT 1', [latest.runId, userId])
  if (question) {
    await addRunMessage(userId, { runId: latest.runId, text: parsed.data.text }, source)
    return { runId: latest.runId, continued: false }
  }
  const [run] = await db.select().from(agentRuns).where(and(eq(agentRuns.id, latest.runId), eq(agentRuns.userId, userId))).limit(1)
  if (!run) throw new ActionFailureError('runNotFound')
  // The next run is the task's (one task, one thread); a thread with no task has nothing to run again.
  if (!run.issueId || !run.deviceRepoId) throw new ActionFailureError('threadCannotContinue')
  const issueId = run.issueId
  const { dispatchToTask, latestTaskRun } = await import('@/lib/thread-dispatch')
  // Another thread took the task over (a new thread was asked for): this one is history now.
  if ((await latestTaskRun(pool, userId, issueId))?.id !== run.id) throw new ActionFailureError('threadReplaced')
  const result = await dispatchToTask(userId, issueId, {
    note: parsed.data.text,
    start: async (previous, note) => {
      if (previous?.id !== run.id) throw new ActionFailureError('threadReplaced')
      return queueNextRun(userId, run, previous, note)
    },
  })
  // A dispatch the person can act on (no machine, say) queued nothing.
  if ('error' in result) throw new ActionFailureError(isActionErrorCode(result.error) ? result.error : 'runInvalid')
  if (result.thread === 'message') return { runId: result.runId, continued: false }
  // The words are already in the new run's note; this row shows them in the thread and is never delivered again.
  await db.insert(runMessages).values({ id: crypto.randomUUID(), runId: result.runId, userId, text: parsed.data.text, origin: 'owner', mailboxWakeDepth: -1, deliveredAt: new Date() })
  return { runId: result.runId, continued: true }
}

/** The thread's next run, queued the way its last one was: on the bot's cloud computer, else on the same device. */
async function queueNextRun(userId: string, run: typeof agentRuns.$inferSelect, previous: TaskThreadRun, note: string | undefined) {
  const issueId = run.issueId!, deviceRepoId = run.deviceRepoId!
  const readOnly = previous.readOnly ? { readOnly: true } : {}
  if (previous.cloud) {
    const [issue] = await db.select({ title: issues.title, content: issues.content }).from(issues).where(eq(issues.id, issueId)).limit(1)
    if (!issue) throw new ActionFailureError('issueNotFound')
    const { queueCloudRun } = await import('@/lib/computer/queue-run')
    return queueCloudRun(pool, { userId, workspaceId: previous.cloud.workspaceId }, { botId: previous.cloud.botId, issueId, agentId: run.agentId, deviceRepoId, title: issue.title, body: tiptapToText(issue.content),
      note, withoutBot: run.botId === null, idempotencyKey: `thread:${run.id}:${crypto.randomUUID()}`, ...readOnly })
  }
  if (!previous.remoteUrl) throw new ActionFailureError('agentRepoMissing')
  const model = run.agentDefinition?.cliModelSelection === 'explicit' ? run.agentDefinition.model : undefined
  const { queueRun } = await import('@/lib/agent-runs')
  return queueRun(userId, { issueId, agentId: run.agentId, repo: previous.remoteUrl, note, ...(model ? { model } : {}), ...readOnly }, run.botId, undefined, undefined, run.source === 'mcp' ? 'mcp' : null)
}
