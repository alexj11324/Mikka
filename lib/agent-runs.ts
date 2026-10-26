import { workspaceDb } from '@/lib/workspace-db'
import { teamIssues } from '@/lib/db/team-schema'
import 'server-only'
import { and, asc, desc, eq, inArray, or, sql } from 'drizzle-orm'
import { z } from 'zod'
import { ActionFailureError } from '@/lib/action-error'
import { db } from '@/lib/db'
import { MailboxError } from '@/lib/session-mailbox'
import { mailboxes } from '@/lib/mailbox-runtime'
import { agents, agentRuns, deviceRepos, issues, runChunks, runMessages, type SupportedHarness } from '@/lib/db/schema'
import { issueVisibility } from '@/lib/issue-visibility'
import { workspaceRunView } from '@/lib/run-visibility'
import { issueForUser } from '@/lib/issue-access'
import { tiptapToText } from '@/lib/tiptap-text'
import { dispatchInput, insertRunOnce, type DispatchInput, type DispatchResult } from '@/lib/run-dispatch'
import { UNFINISHED_RUN_STATUSES } from '@/lib/agent-run-statuses'

// Run operations for one person, by user id. The agent actions call these
// with the session's user; the Coordinator calls them with its owner's.

export interface RunView {
  id: string
  issueId: string | null
  agentId: string
  agentName: string
  harness: SupportedHarness
  status: string
  kind: string
  stopReason: string | null
  error: string | null
  report: Record<string, unknown> | null
  createdAt: Date
  startedAt: Date | null
  finishedAt: Date | null
}

export interface RunDetail {
  run: RunView
  chunks: Record<string, unknown>[]
  messages: { id: string; text: string; createdAt: Date }[]
}

export const runViewColumns = {
  id: agentRuns.id, issueId: agentRuns.issueId, agentId: agentRuns.agentId, agentName: agents.name,
  harness: agents.harness, status: agentRuns.status, kind: agentRuns.kind, stopReason: agentRuns.stopReason,
  error: agentRuns.error, report: agentRuns.report, createdAt: agentRuns.createdAt,
  startedAt: agentRuns.startedAt, finishedAt: agentRuns.finishedAt,
}

/**
 * Queues one run of one agent against one issue. The daemon picks it up on its
 * next poll, claims it, and reports back through `/v1/runs/:runId/complete`.
 * `note` is extra direction for this run only, after the issue.
 */
export async function queueRun(userId: string, input: DispatchInput, executor: Pick<typeof db, 'select' | 'transaction'> = db): Promise<DispatchResult> {
  const parsed = dispatchInput.safeParse(input)
  if (!parsed.success) throw new ActionFailureError('runInvalid')
  const issue = await issueForUser(userId, parsed.data.issueId, false, executor)
  if (!issue) throw new ActionFailureError('issueNotFound')
  const [agent] = await executor.select().from(agents)
    .where(and(eq(agents.id, parsed.data.agentId), eq(agents.userId, userId))).limit(1)
  if (!agent?.deviceId) throw new ActionFailureError('agentNoDevice')
  const [repo] = await executor.select().from(deviceRepos)
    .where(and(eq(deviceRepos.id, parsed.data.deviceRepoId), eq(deviceRepos.deviceId, agent.deviceId), eq(deviceRepos.userId, userId))).limit(1)
  if (!repo) throw new ActionFailureError('agentRepoMissing')
  const [auditScope] = await workspaceDb.select({ workspaceId: teamIssues.workspaceId }).from(teamIssues).where(eq(teamIssues.issueId, issue.id)).limit(1)
  return insertRunOnce(executor, userId, parsed.data, {
    workspaceId: issue.scope === 'workspace' ? auditScope?.workspaceId ?? `personal:${userId}` : `personal:${userId}`,
    deviceId: agent.deviceId, baseBranch: repo.baseBranch,
    prompt: runPrompt(issue.title, tiptapToText(issue.content), agent.instructions, parsed.data.note),
  })
}

/** The brief the agent starts from: the issue, any note for this run, then the agent's own role. */
function runPrompt(title: string, body: string, instructions: string, note?: string): string {
  const parts = [`# ${title}`]
  if (body) parts.push(body)
  if (note) parts.push('## Notes for this run', note)
  parts.push('---', 'Work in the repository checked out for this run. Mikka saves your changes as you go and handles commits and pushes, so you do not need to run git commit or git push. When you are done, hand in your work with a short summary of what changed.')
  if (instructions) parts.push('## Your standing instructions', instructions)
  return parts.join('\n\n').slice(0, 100_000)
}

/** Every surface uses this gate. Workspace membership never grants run control,
 * personal agent/session access, or raw transcript access. */
export async function visibleRuns(userId: string, input: { issueId?: string; runIds?: string[]; activeOnly?: boolean; limit?: number } = {}): Promise<RunView[]> {
  if (input.issueId && !z.uuid().safeParse(input.issueId).success) return []
  if (input.runIds && (!input.runIds.length || input.runIds.some(id => !z.uuid().safeParse(id).success))) return []
  const visibility = await issueVisibility(userId)
  const shared = visibility.allowedIds.length ? and(eq(issues.scope, 'workspace'), inArray(issues.id, visibility.allowedIds)) : sql`false`
  const rows = await db.select({ ...runViewColumns, ownerId: agentRuns.userId }).from(agentRuns)
    .innerJoin(agents, eq(agents.id, agentRuns.agentId)).leftJoin(issues, eq(issues.id, agentRuns.issueId))
    .where(and(
      or(eq(agentRuns.userId, userId), and(visibility.predicate, shared)),
      input.issueId ? eq(agentRuns.issueId, input.issueId) : undefined,
      input.runIds ? inArray(agentRuns.id, input.runIds) : undefined,
      input.activeOnly ? inArray(agentRuns.status, [...UNFINISHED_RUN_STATUSES]) : undefined,
    )).orderBy(desc(agentRuns.createdAt), desc(agentRuns.id)).limit(Math.max(1, Math.min(input.limit ?? 20, 100)))
  return rows.map(({ ownerId, ...run }) => ownerId === userId ? run : workspaceRunView(run))
}

export async function readRun(userId: string, runId: string): Promise<RunDetail | null> {
  const [run] = await visibleRuns(userId, { runIds: [runId], limit: 1 })
  if (!run) return null
  // Empty agentId is the deliberately restricted teammate projection.
  if (!run.agentId) return { run, chunks: [], messages: [] }
  const chunks = await db.select({ chunk: runChunks.chunk }).from(runChunks)
    .where(eq(runChunks.runId, run.id)).orderBy(asc(runChunks.seq))
  const messages = await db.select({ id: runMessages.id, text: runMessages.text, createdAt: runMessages.createdAt })
    .from(runMessages).where(eq(runMessages.runId, run.id)).orderBy(asc(runMessages.createdAt))
  return { run, chunks: chunks.map(row => row.chunk), messages }
}

/** A message to the running agent; the daemon delivers it. */
export async function addRunMessage(
  userId: string,
  input: { runId: string; text: string },
  source:
    { source: 'human'; sessionId: string } | { source: 'orchestrator' } = {
    source: 'orchestrator',
  },
): Promise<void> {
  const parsed = z
    .object({ runId: z.uuid(), text: z.string().trim().min(1).max(10_000) })
    .safeParse(input)
  if (!parsed.success) throw new ActionFailureError('messageRequired')
  const [run] = await db
    .select({ id: agentRuns.id, status: agentRuns.status })
    .from(agentRuns)
    .where(
      and(eq(agentRuns.id, parsed.data.runId), eq(agentRuns.userId, userId)),
    )
    .limit(1)
  if (!run) throw new ActionFailureError('runNotFound')
  if (
    !['queued', 'preparing', 'running', 'waiting_input', 'finishing'].includes(
      run.status,
    )
  ) {
    const { factoryQuestions } = await import('@/lib/factory/server')
    const { pool } = await import('@/lib/db')
    const {
      rows: [identity],
    } = await pool.query(
      'SELECT id FROM factory_questions WHERE "originRunId"=$1 AND "userId"=$2',
      [run.id, userId],
    )
    if (!identity) throw new ActionFailureError('runNotActive')
    const q = await factoryQuestions.read(userId, identity.id)
    if (q.status === 'resolved' && q.continuationRunId) {
      const previous = q.answer as {
        input?: { text?: string; reference?: unknown }
      } | null
      if (previous?.input?.text !== parsed.data.text)
        return addRunMessage(
          userId,
          { runId: q.continuationRunId, text: parsed.data.text },
          source,
        )
    }
    if (source.source !== 'human')
      throw new ActionFailureError('factoryQuestionNeedsAnswerTool')
    const { factoryEventId } = await import('@/lib/factory/event-id')
    const { questionReference } = await import('@/lib/factory/questions/store')
    const { questionFingerprint } =
      await import('@/lib/factory/questions/contract')
    const previous = q.answer as {
      input?: { reference?: ReturnType<typeof questionReference> }
    } | null
    const answerId = factoryEventId(
      'task-thread-question-answer',
      questionFingerprint({ questionId: q.id, userId, text: parsed.data.text }),
    )
    await factoryQuestions.answer(
      { source: 'human', userId, sessionId: source.sessionId },
      {
        reference:
          q.answerId === answerId && previous?.input?.reference
            ? previous.input.reference
            : questionReference(q),
        answerId,
        text: parsed.data.text,
      },
    )
    return
  }
  await db.insert(runMessages).values({
    id: crypto.randomUUID(),
    runId: run.id,
    userId,
    text: parsed.data.text,
  })
}

/** Asks the daemon to stop the run; it repeats until the run has ended. */
export async function requestRunStop(userId: string, runId: string): Promise<void> {
  const parsed = z.uuid().safeParse(runId)
  if (!parsed.success) throw new ActionFailureError('runNotFound')
  try { await mailboxes.stop(userId, runId) }
  catch (error) { if (error instanceof MailboxError) throw new ActionFailureError('runNotFound'); throw error }
}
