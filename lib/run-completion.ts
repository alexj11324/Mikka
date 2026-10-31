import 'server-only'
import { and, eq, inArray, isNull } from 'drizzle-orm'
import { runStateForStop } from '@mikka/protocol/daemon'
import { reachesReview, type RunCompleteRequest } from '@mikka/protocol/run'
import { db } from '@/lib/db'
import { agentRuns, devices, issues, runTokens, type RunStatus } from '@/lib/db/schema'
import { issueTeamAccess } from '@/lib/issue-team-access'
import { readIssueMetadata } from '@/lib/issue-metadata'
import { recordCoordinatorEvent } from '@/lib/coordinator-event-store'
import { runFinishedEvent } from '@/lib/coordinator-events'

const LIVE_STATUSES = ['queued', 'preparing', 'running', 'paused', 'waiting_input', 'finishing'] as const
type Issue = typeof issues.$inferSelect
type Executor = Parameters<Parameters<typeof db.transaction>[0]>[0]

export async function mayCompleteIssue(issue: Issue, userId: string) {
  if (readIssueMetadata(issue.content).deletedAt) return false
  return issue.userId === userId || (issue.scope === 'workspace' && (await issueTeamAccess(issue.id, userId)).allowed)
}

/** The issue hint selects lock order only; every permission and run field is
 * reread after the locks. Scope changes acquire this same issue -> run order. */
export async function completeRunForDevice(userId: string, hint: { id: string; issueId: string | null }, input: RunCompleteRequest) {
  for (let attempt = 0; ; attempt++) {
    try { return await completeRunTransaction(userId, hint, input) }
    catch (error) {
      const cause = error instanceof Error && error.cause ? error.cause : error
      const code = cause && typeof cause === 'object' && 'code' in cause ? cause.code : null
      if (attempt >= 2 || (code !== '40P01' && code !== '40001')) throw error
    }
  }
}

async function completeRunTransaction(userId: string, hint: { id: string; issueId: string | null }, input: RunCompleteRequest) {
  return db.transaction(async tx => {
    const [issue] = hint.issueId ? await tx.select().from(issues).where(eq(issues.id, hint.issueId)).for('update') : []
    const [run] = await tx.select({ run: agentRuns }).from(agentRuns)
      .innerJoin(devices, eq(devices.id, agentRuns.deviceId))
      .where(and(eq(agentRuns.id, hint.id), eq(devices.ownerId, userId))).for('update', { of: agentRuns })
    if (!run || run.run.issueId !== hint.issueId || !(LIVE_STATUSES as readonly string[]).includes(run.run.status)) return null
    if (run.run.issueId && (!issue || !await mayCompleteIssue(issue, run.run.userId))) return null
    const { stopReason, report } = input
    let status: RunStatus = runStateForStop(stopReason)
    if (stopReason === 'submitted' && report?.verify.status !== 'passed' && run.run.kind !== 'plan') status = report?.verify.status === 'failed' ? 'failed' : 'stopped'
    const [ended] = await tx.update(agentRuns).set({ status, pauseReason: null, resumeStatus: null, stopReason, report: report ?? null, finishedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(agentRuns.id, hint.id), inArray(agentRuns.status, [...LIVE_STATUSES]))).returning({ id: agentRuns.id })
    if (!ended) return null
    await tx.update(runTokens).set({ revokedAt: new Date() }).where(and(eq(runTokens.runId, ended.id), isNull(runTokens.revokedAt)))
    await recordCoordinatorEvent(tx, runFinishedEvent({ ...run.run, status, stopReason, report }))
    const review = issue && reachesReview(stopReason, report)
      ? (await tx.update(issues).set({ status: 'review', updatedAt: new Date() }).where(eq(issues.id, issue.id)).returning({ id: issues.id, scopeVersion: issues.scopeVersion }))[0]
      : null
    return { userId: run.run.userId, review }
  })
}

/** Scheduling is guarded after commit as well: retirement may happen between
 * the completion commit and its background notification. The callback must
 * only schedule work; never perform provider IO inside this short lock. */
export async function dispatchCompletedIssue(result: { userId: string; review: { id: string; scopeVersion: number } | null }, schedule: (issueId: string) => void) {
  if (!result.review) return false
  return db.transaction(async (tx: Executor) => {
    const [issue] = await tx.select().from(issues).where(eq(issues.id, result.review!.id)).for('update')
    if (!issue || issue.scope !== 'workspace' || issue.scopeVersion !== result.review!.scopeVersion || !await mayCompleteIssue(issue, result.userId)) return false
    schedule(issue.id)
    return true
  })
}
