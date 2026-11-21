import 'server-only'
import { and, eq, isNull, sql } from 'drizzle-orm'
import { z } from 'zod'
import { db, pool } from '@/lib/db'
import { captureDatabaseQuery } from '@/lib/db/commit-effects'
import { issueListScopesBeforeChange, issueListScopeChanged } from '@/lib/live/lists'
import { issues, issueVersions, teamIssuePromotions } from '@/lib/db/schema'
import { workspaceDb } from '@/lib/workspace-db'
import { withTeamWorkspace } from '@/lib/team-workspace'
import { ActionFailureError } from '@/lib/action-error'
import { teams, teamIssues, teamIssuePromotionReceipts } from '@/lib/db/team-schema'
import { workspaceMembers } from '@/lib/db/workspace-schema'
import { lockTeamRelations } from '@/lib/team-access'
import { userActor, type ActivityActor } from '@/lib/activity-actor'
import { issueView } from '@/lib/task-identifier-server'
import { documentScopesBeforeChange, documentScopeChanged } from '@/lib/live/panels'
import { runPolicyStopSQL, notifyStoppedPolicyRuns, type StoppedPolicyRun } from '@/lib/run-policy-stop'
import { markReviewSessionsRevoked, drainRevokedReviewSessions } from './coding-workspace/review-sessions'

const schema = z.object({ requestId: z.uuid(), issueId: z.uuid(), revision: z.number().int().positive(), teamId: z.uuid(), expectedTeamId: z.uuid().nullable() })
type AppTx = Parameters<Parameters<typeof db.transaction>[0]>[0]
type WorkspaceTx = Parameters<Parameters<typeof workspaceDb.transaction>[0]>[0]
type Code = 'teamIssueAccessDenied' | 'teamIssueRequestConflict' | 'teamIssueChanged'
class PromotionError extends Error { constructor(readonly code: Code) { super(code) } }
async function allowedTeam(tx: WorkspaceTx, userId: string, teamId: string, expectedWorkspaceId?: string) {
  // withTeamWorkspace already holds member SHARE before the relation lock.
  // This read must not upgrade that lock while another admission waits on us.
  const [team] = await tx.select({ id: teams.id, workspaceId: teams.workspaceId }).from(teams)
    .innerJoin(workspaceMembers, and(eq(workspaceMembers.workspaceId, teams.workspaceId), eq(workspaceMembers.userId, userId), eq(workspaceMembers.status, 'active')))
    .where(and(eq(teams.id, teamId), expectedWorkspaceId ? eq(teams.workspaceId, expectedWorkspaceId) : undefined, isNull(teams.archivedAt))).for('share').limit(1)
  if (!team) throw new PromotionError('teamIssueAccessDenied')
  return team
}
const syncResult = { enabled: false as const, reason: 'no_explicit_target' as const }

/** A stable request ID binds the existing issue, revision and explicit team.
 * Workspace receipt and relation commit together; the app promotion is fenced
 * by both databases' locks and never publishes to an inferred provider. */
export async function promoteExistingIssueForUser(userId: string, input: unknown, actor: ActivityActor = userActor(userId)) {
  const parsed = schema.safeParse(input)
  if (!parsed.success) return { error: 'teamIssueInvalid' as const }
  const { requestId, issueId, revision, teamId, expectedTeamId } = parsed.data
  let promotionStarted = false
  const reviewIds = new Set<string>()
  const fenceReview = async (database: Pick<typeof pool, 'query'>) => {
    for (const id of await markReviewSessionsRevoked(database, { taskId: issueId }, 'task_changed')) reviewIds.add(id)
  }
  try {
    await withTeamWorkspace(userId, teamId, async workspace => {
      await lockTeamRelations(workspace)
      const team = await allowedTeam(workspace, userId, teamId)
      const [current] = await workspace.select().from(teamIssues).where(eq(teamIssues.issueId, issueId)).for('update')
      const [receipt] = await workspace.select().from(teamIssuePromotionReceipts).where(eq(teamIssuePromotionReceipts.requestId, requestId)).for('update')
      if (receipt && (receipt.issueId !== issueId || receipt.ownerId !== userId || receipt.teamId !== teamId || receipt.workspaceId !== team.workspaceId)) throw new PromotionError('teamIssueRequestConflict')
      if (receipt && (!current || current.teamId !== teamId || current.workspaceId !== team.workspaceId || current.userId !== userId)) throw new PromotionError('teamIssueChanged')
      if (!receipt) {
        if ((current?.teamId ?? null) !== expectedTeamId || (current && current.userId !== userId)) throw new PromotionError('teamIssueChanged')
        if (current) {
          if (current.workspaceId !== team.workspaceId) throw new PromotionError('teamIssueChanged')
          const old = await allowedTeam(workspace, userId, current.teamId, team.workspaceId)
          if (old.workspaceId !== team.workspaceId) throw new PromotionError('teamIssueChanged')
        }

      }
      const completed = await db.transaction(async tx => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`team-issue-promotion:${requestId}`}, 0))`)
        const [issue] = await tx.select().from(issues).where(eq(issues.id, issueId)).for('update')
        if (!issue || issue.userId !== userId || issue.ownershipState !== 'bound' || issue.workspaceId !== team.workspaceId) throw new PromotionError('teamIssueAccessDenied')
        const [request] = await tx.select().from(teamIssuePromotions).where(eq(teamIssuePromotions.requestId, requestId)).for('update')
        if (request && (request.ownerId !== userId || request.issueId !== issueId || request.teamId !== teamId || request.expectedTeamId !== expectedTeamId || request.expectedRevision !== revision)) throw new PromotionError('teamIssueRequestConflict')
        if (request?.status === 'stale') throw new PromotionError('teamIssueChanged')
        if (request?.status === 'complete') return true
        if (issue.revision !== revision) throw new PromotionError('teamIssueChanged')
        if (!request) {
          await tx.update(teamIssuePromotions).set({ status: 'stale' }).where(and(eq(teamIssuePromotions.issueId, issueId), eq(teamIssuePromotions.status, 'preparing')))
          await tx.update(issues).set({ linearSyncPolicy: 'disabled', linearSyncBlocked: true }).where(eq(issues.id, issueId))
          await tx.insert(teamIssuePromotions).values({ requestId, ownerId: userId, issueId, teamId, expectedTeamId, expectedRevision: revision })
        }
        return false
      })
      if (completed && !receipt) throw new PromotionError('teamIssueChanged')
      if (!receipt) {
        if (current?.teamId !== teamId || current?.workspaceId !== team.workspaceId) await fenceReview(pool)
        await workspace.insert(teamIssues).values({ issueId, teamId, workspaceId: team.workspaceId, userId }).onConflictDoUpdate({ target: teamIssues.issueId, set: { teamId, workspaceId: team.workspaceId } })
        await workspace.insert(teamIssuePromotionReceipts).values({ requestId, issueId, teamId, workspaceId: team.workspaceId, ownerId: userId })
      }
    })
    return await withTeamWorkspace(userId, teamId, async workspace => {
      await lockTeamRelations(workspace)
      const team = await allowedTeam(workspace, userId, teamId)
      const [link] = await workspace.select().from(teamIssues).where(eq(teamIssues.issueId, issueId)).for('update')
      if (!link || link.teamId !== teamId || link.workspaceId !== team.workspaceId || link.userId !== userId) throw new PromotionError('teamIssueChanged')
      promotionStarted = true
      const lockPromotion = async (tx: AppTx) => {
        const [issue] = await tx.select().from(issues).where(eq(issues.id, issueId)).for('update')
        const [request] = await tx.select().from(teamIssuePromotions).where(eq(teamIssuePromotions.requestId, requestId)).for('update')
        if (!request || !issue || issue.userId !== userId || issue.ownershipState !== 'bound' || issue.workspaceId !== team.workspaceId || request.ownerId !== userId || request.issueId !== issueId || request.teamId !== teamId || request.expectedTeamId !== expectedTeamId || request.expectedRevision !== revision) throw new PromotionError('teamIssueChanged')
        const complete = request.status === 'complete'
        if (!complete && (request.status !== 'preparing' || issue.revision !== revision || !issue.linearSyncBlocked)) throw new PromotionError('teamIssueChanged')
        return { issue, complete }
      }
      // A grant can appear between Workspace stages even when the grouping
      // already matched. Commit its exact fence before the fallible APP write.
      const completed = await db.transaction(async tx => {
        const { issue, complete } = await lockPromotion(tx)
        if (complete) return { issue: await issueView(issue, tx), linearSync: syncResult }
        await fenceReview(captureDatabaseQuery(tx))
        return null
      })
      if (completed) return completed
      return db.transaction(async tx => {
        // Revalidate and retain the APP locks through the actual scope change.
        const { issue, complete } = await lockPromotion(tx)
        if (complete) return { issue: await issueView(issue, tx), linearSync: syncResult }
        await tx.execute(sql`select set_config('mikka.team_scope_verified', ${issueId}, true), set_config('mikka.team_scope_team', ${teamId}, true), set_config('mikka.team_scope_request', ${requestId}, true)`)
        const previousScopes = await documentScopesBeforeChange(issue)
        const previousLists = await issueListScopesBeforeChange(issue)
        const [saved] = await tx.update(issues).set({ linearSyncPolicy: 'disabled', linearSyncBlocked: true, scopeSetBy: 'user', scopeConfidence: null, revision: issue.revision + 1, updatedAt: new Date() }).where(eq(issues.id, issueId)).returning()
        await tx.insert(issueVersions).values({ id: crypto.randomUUID(), issueId, userId, revision: saved.revision, title: saved.title, content: saved.content, status: saved.status, priority: saved.priority, ...actor })
        await tx.update(teamIssuePromotions).set({ status: 'complete' }).where(eq(teamIssuePromotions.requestId, requestId))
        await documentScopeChanged(tx, saved.id, previousScopes)
        await issueListScopeChanged(tx, issueId, previousLists)
        // A scope change stops this task's admitted direct runner. Other
        // tasks owned by the person keep their machines and credentials.
        const stopped = await tx.execute<StoppedPolicyRun>(runPolicyStopSQL({ kind: 'task', issueId }))
        notifyStoppedPolicyRuns(workspace, stopped.rows)
        return { issue: await issueView(saved, tx), linearSync: syncResult }
      })
    })
  } catch (error) {
    if (error instanceof PromotionError) return { error: error.code, requestId }
    if (error instanceof ActionFailureError && (error.code === 'workspaceAccessDenied' || error.code === 'teamIssueAccessDenied')) return { error: 'teamIssueAccessDenied' as const, requestId }
    if (promotionStarted) {
      try {
        const [request] = await db.select().from(teamIssuePromotions).where(eq(teamIssuePromotions.requestId, requestId)).limit(1)
        if (request?.ownerId === userId && request.issueId === issueId && request.teamId === teamId && request.expectedTeamId === expectedTeamId && request.expectedRevision === revision && request.status === 'complete') {
          const [issue] = await db.select().from(issues).where(and(eq(issues.id, issueId), eq(issues.userId, userId))).limit(1)
          if (issue) return { issue: await issueView(issue), linearSync: syncResult }
        }
      } catch { return { error: 'teamIssueOutcomeUnknown' as const, requestId } }
      // A plain read can still see preparing while the original COMMIT is in
      // flight. Only a completed request proves success; do not report a
      // definite retry/private outcome for any other second-stage failure.
      return { error: 'teamIssueOutcomeUnknown' as const, requestId }
    }
    console.error('Team task promotion failed')
    return { error: 'teamIssueRetry' as const, requestId }
  } finally { await drainRevokedReviewSessions(pool, [...reviewIds]) }
}
