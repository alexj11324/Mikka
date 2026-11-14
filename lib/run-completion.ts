import 'server-only'
import { completionFailureDetails } from './run-failure-details'
import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import { runStateForStop } from '@mikka/protocol/daemon'
import { reachesReview, type RunCompleteRequest } from '@mikka/protocol/run'
import { db, pool, withDatabaseClient } from '@/lib/db'
import { agentRuns, devices, issues, issueVersions, runTokens, type RunStatus } from '@/lib/db/schema'
import { systemActor } from '@/lib/activity-actor'
import { advancesTo, personChangedStatusSince } from '@/lib/task-status-advance'
import { scheduleConversationTitle } from '@/lib/conversation-title-schedule'
import { readIssueMetadata } from '@/lib/issue-metadata'
import { requireTaskWorkspace, withTaskWorkspace } from '@/lib/task-workspace'
import { ActionFailureError } from '@/lib/action-error'
import { recordCoordinatorEvent } from '@/lib/coordinator-event-store'
import { runFinishedEvent } from '@/lib/coordinator-events'
import { issueListChanged, runListChanged } from './live/lists'
import { runChanged } from './live/panels'
import { issueRelationsChanged } from './live/issue-detail'

const LIVE_STATUSES = ['queued', 'preparing', 'running', 'paused', 'waiting_input', 'finishing'] as const
type Issue = typeof issues.$inferSelect
type Executor = Parameters<Parameters<typeof db.transaction>[0]>[0]

export async function mayCompleteIssue(issue: Pick<Issue, 'workspaceId' | 'ownershipState' | 'content'>, userId: string, runWorkspaceId?: string | null) {
  if (issue.ownershipState !== 'bound' || !issue.workspaceId || readIssueMetadata(issue.content).deletedAt
    || (runWorkspaceId !== undefined && runWorkspaceId !== issue.workspaceId)) return false
  try { await requireTaskWorkspace(userId, issue.workspaceId); return true }
  catch (error) {
    if (error instanceof ActionFailureError && error.code === 'workspaceAccessDenied') return false
    throw error
  }
}

/** Lock the persisted tenant before application rows. Creation, completion,
 * claim and publication must all serialize with membership suspension. */
export async function withRunWorkspace<T>(userId: string, workspaceId: string | null, work: () => Promise<T>): Promise<T | null> {
  if (!workspaceId) return null
  try { return await withTaskWorkspace(userId, workspaceId, work) }
  catch (error) {
    if (error instanceof ActionFailureError && error.code === 'workspaceAccessDenied') return null
    throw error
  }
}

/** The issue hint selects lock order only; every permission and run field is
 * reread after the locks. Scope changes acquire this same issue -> run order. */
export async function completeRunForDevice(userId: string, hint: { id: string; issueId: string | null }, input: RunCompleteRequest) {
  for (let attempt = 0; ; attempt++) {
    try {
      const [stored] = await db.select({ workspaceId: agentRuns.workspaceId }).from(agentRuns)
        .innerJoin(devices, eq(devices.id, agentRuns.deviceId))
        .where(and(eq(agentRuns.id, hint.id), eq(agentRuns.userId, userId), eq(devices.ownerId, userId))).limit(1)
      if (!stored?.workspaceId) return null
      return await withRunWorkspace(userId, stored.workspaceId, () => completeRunTransaction(userId, hint, input, stored.workspaceId!))
    }
    catch (error) {
      const cause = error instanceof Error && error.cause ? error.cause : error
      const code = cause && typeof cause === 'object' && 'code' in cause ? cause.code : null
      if (attempt >= 2 || (code !== '40P01' && code !== '40001')) throw error
    }
  }
}

async function completeRunTransaction(userId: string, hint: { id: string; issueId: string | null }, input: RunCompleteRequest, workspaceId: string) {
  const client = await pool.connect()
  try {
    return await withDatabaseClient(client, () => db.transaction(async tx => {
      const [issue] = hint.issueId ? await tx.select().from(issues).where(eq(issues.id, hint.issueId)).for('update') : []
      const [run] = await tx.select({ run: agentRuns }).from(agentRuns)
        .innerJoin(devices, eq(devices.id, agentRuns.deviceId))
        .where(and(eq(agentRuns.id, hint.id), eq(agentRuns.userId, userId), eq(devices.ownerId, userId))).for('update', { of: agentRuns })
      if (!run || run.run.workspaceId !== workspaceId || run.run.issueId !== hint.issueId || !(LIVE_STATUSES as readonly string[]).includes(run.run.status)) return null
      if (run.run.issueId && (!issue || !await mayCompleteIssue(issue, run.run.userId, workspaceId))) return null
      const { stopReason, report } = input
      let status: RunStatus = runStateForStop(stopReason)
      if (stopReason === 'submitted' && report?.verify.status !== 'passed' && run.run.kind !== 'plan') status = report?.verify.status === 'failed' ? 'failed' : 'stopped'
      const [ended] = await tx.update(agentRuns).set({ status, pauseReason: null, resumeStatus: null, stopReason, report: report ?? null,
        failureDetails: completionFailureDetails(input, hint.id, { status, stopRequested: Boolean(run.run.stopRequestedAt), sensitiveText: [run.run.prompt, run.run.agentDefinition?.instructions ?? ''] }), finishedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(agentRuns.id, hint.id), inArray(agentRuns.status, [...LIVE_STATUSES]))).returning({ id: agentRuns.id })
      if (!ended) return null
      // Its real content is known now: the first run's end names the conversation again while its title is a generated one.
      scheduleConversationTitle(tx, ended.id, run.run.userId, 'first_run_ended')
      await runListChanged(tx, ended.id)
      await runChanged(tx, ended.id)
      await tx.update(runTokens).set({ revokedAt: new Date() }).where(and(eq(runTokens.runId, ended.id), isNull(runTokens.revokedAt)))
      await recordCoordinatorEvent(tx, runFinishedEvent({ ...run.run, status, stopReason, report }))
      // 评审中 only as a step forward, and never over a status the person set after this run was asked for
      // (lib/task-status-advance.ts). The move is a versioned system change.
      const since = run.run.createdAt
      const moves = issue && reachesReview(stopReason, report) && advancesTo(issue.status, 'review')
        && !(await tx.execute<{ changed: boolean }>(sql`SELECT ${personChangedStatusSince(issue.id, since)} AS changed`)).rows[0]?.changed
      const [review] = moves ? await tx.update(issues).set({ status: 'review', revision: issue.revision + 1, updatedAt: new Date() }).where(eq(issues.id, issue.id)).returning() : []
      if (review) await tx.insert(issueVersions).values({ id: crypto.randomUUID(), issueId: review.id, userId: review.userId, revision: review.revision, title: review.title, content: review.content, status: review.status, priority: review.priority, ...systemActor('run-review') })
      if (review) { await issueListChanged(tx, review.id); await issueRelationsChanged(tx, [review.id]) }
      return { userId: run.run.userId, review: review ? { id: review.id, scopeVersion: review.scopeVersion } : null }
    }))
  } finally { client.release() }
}

/** Scheduling is guarded after commit as well: retirement may happen between
 * the completion commit and its background notification. The callback must
 * only schedule work; never perform provider IO inside this short lock. */
export async function dispatchCompletedIssue(result: { userId: string; review: { id: string; scopeVersion: number } | null }, schedule: (issueId: string) => void) {
  if (!result.review) return false
  const [stored] = await db.select({ workspaceId: issues.workspaceId }).from(issues).where(eq(issues.id, result.review.id)).limit(1)
  if (!stored?.workspaceId) return false
  return await withRunWorkspace(result.userId, stored.workspaceId, async () => {
    const client = await pool.connect()
    try {
      return await withDatabaseClient(client, () => db.transaction(async (tx: Executor) => {
        const [issue] = await tx.select().from(issues).where(eq(issues.id, result.review!.id)).for('update')
        if (!issue || issue.linearSyncPolicy !== 'explicit' || issue.scopeVersion !== result.review!.scopeVersion || !await mayCompleteIssue(issue, result.userId, stored.workspaceId)) return false
        schedule(issue.id)
        return true
      }))
    } finally { client.release() }
  }) ?? false
}
