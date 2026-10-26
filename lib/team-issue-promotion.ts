import 'server-only'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@/lib/db'
import { issues, issueVersions, teamIssuePromotions } from '@/lib/db/schema'
import { workspaceDb } from '@/lib/workspace-db'
import { teams, teamIssues, teamIssuePromotionReceipts, teamProjects } from '@/lib/db/team-schema'
import { workspaceMembers } from '@/lib/db/workspace-schema'
import { projects } from '@/lib/db/projects'
import { lockTeamRelations } from '@/lib/team-access'
import { userActor } from '@/lib/activity-actor'
import { issueView } from '@/lib/task-identifier-server'

const schema = z.object({ requestId: z.uuid(), issueId: z.uuid(), revision: z.number().int().positive(), teamId: z.uuid(), expectedTeamId: z.uuid().nullable() })
type WorkspaceTx = Parameters<Parameters<typeof workspaceDb.transaction>[0]>[0]
type Code = 'teamIssueAccessDenied' | 'teamIssueRequestConflict' | 'teamIssueChanged'
class PromotionError extends Error { constructor(readonly code: Code) { super(code) } }
async function allowedTeam(tx: WorkspaceTx, userId: string, teamId: string) {
  const [team] = await tx.select({ id: teams.id, workspaceId: teams.workspaceId }).from(teams)
    .innerJoin(workspaceMembers, and(eq(workspaceMembers.workspaceId, teams.workspaceId), eq(workspaceMembers.userId, userId), eq(workspaceMembers.status, 'active')))
    .where(eq(teams.id, teamId)).for('update').limit(1)
  if (!team) throw new PromotionError('teamIssueAccessDenied')
  return team
}
const syncResult = { enabled: false as const, reason: 'no_explicit_target' as const }

/** A stable request ID binds the existing issue, revision and explicit team.
 * Workspace receipt and relation commit together; the app promotion is fenced
 * by both databases' locks and never publishes to an inferred provider. */
export async function promoteExistingIssueForUser(userId: string, input: unknown) {
  const parsed = schema.safeParse(input)
  if (!parsed.success) return { error: 'teamIssueInvalid' as const }
  const { requestId, issueId, revision, teamId, expectedTeamId } = parsed.data
  let promotionStarted = false
  try {
    await workspaceDb.transaction(async workspace => {
      await lockTeamRelations(workspace)
      const team = await allowedTeam(workspace, userId, teamId)
      const [current] = await workspace.select().from(teamIssues).where(eq(teamIssues.issueId, issueId)).for('update')
      const [receipt] = await workspace.select().from(teamIssuePromotionReceipts).where(eq(teamIssuePromotionReceipts.requestId, requestId)).for('update')
      if (receipt && (receipt.issueId !== issueId || receipt.ownerId !== userId || receipt.teamId !== teamId || receipt.workspaceId !== team.workspaceId)) throw new PromotionError('teamIssueRequestConflict')
      if (receipt && (!current || current.teamId !== teamId || current.workspaceId !== team.workspaceId || current.userId !== userId)) throw new PromotionError('teamIssueChanged')
      if (!receipt) {
        if ((current?.teamId ?? null) !== expectedTeamId || (current && current.userId !== userId)) throw new PromotionError('teamIssueChanged')
        if (current) {
          const old = await allowedTeam(workspace, userId, current.teamId)
          if (old.workspaceId !== team.workspaceId) throw new PromotionError('teamIssueChanged')
        }
        const containing = await workspace.select({ id: projects.id }).from(projects).where(sql`${projects.issueIds} @> ${JSON.stringify([issueId])}::jsonb`)
        if (containing.length) {
          const links = await workspace.select().from(teamProjects).where(inArray(teamProjects.projectId, containing.map(p => p.id)))
          if (links.length && !links.some(link => link.teamId === teamId)) throw new PromotionError('teamIssueChanged')
        }
      }
      const completed = await db.transaction(async tx => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`team-issue-promotion:${requestId}`}, 0))`)
        const [issue] = await tx.select().from(issues).where(eq(issues.id, issueId)).for('update')
        if (!issue || issue.userId !== userId) throw new PromotionError('teamIssueAccessDenied')
        const [request] = await tx.select().from(teamIssuePromotions).where(eq(teamIssuePromotions.requestId, requestId)).for('update')
        if (request && (request.ownerId !== userId || request.issueId !== issueId || request.teamId !== teamId || request.expectedTeamId !== expectedTeamId || request.expectedRevision !== revision)) throw new PromotionError('teamIssueRequestConflict')
        if (request?.status === 'stale') throw new PromotionError('teamIssueChanged')
        if (request?.status === 'complete') return true
        if (issue.scope !== 'personal' || issue.revision !== revision) throw new PromotionError('teamIssueChanged')
        if (!request) {
          await tx.update(teamIssuePromotions).set({ status: 'stale' }).where(and(eq(teamIssuePromotions.issueId, issueId), eq(teamIssuePromotions.status, 'preparing')))
          await tx.update(issues).set({ linearSyncBlocked: true }).where(eq(issues.id, issueId))
          await tx.insert(teamIssuePromotions).values({ requestId, ownerId: userId, issueId, teamId, expectedTeamId, expectedRevision: revision })
        }
        return false
      })
      if (completed && !receipt) throw new PromotionError('teamIssueChanged')
      if (!receipt) {
        await workspace.insert(teamIssues).values({ issueId, teamId, workspaceId: team.workspaceId, userId }).onConflictDoUpdate({ target: teamIssues.issueId, set: { teamId, workspaceId: team.workspaceId } })
        await workspace.insert(teamIssuePromotionReceipts).values({ requestId, issueId, teamId, workspaceId: team.workspaceId, ownerId: userId })
      }
    })
    return await workspaceDb.transaction(async workspace => {
      await lockTeamRelations(workspace)
      const team = await allowedTeam(workspace, userId, teamId)
      const [link] = await workspace.select().from(teamIssues).where(eq(teamIssues.issueId, issueId)).for('update')
      if (!link || link.teamId !== teamId || link.workspaceId !== team.workspaceId || link.userId !== userId) throw new PromotionError('teamIssueChanged')
      promotionStarted = true
      return db.transaction(async tx => {
        const [issue] = await tx.select().from(issues).where(eq(issues.id, issueId)).for('update')
        const [request] = await tx.select().from(teamIssuePromotions).where(eq(teamIssuePromotions.requestId, requestId)).for('update')
        if (!request || !issue || issue.userId !== userId || request.ownerId !== userId || request.issueId !== issueId || request.teamId !== teamId || request.expectedTeamId !== expectedTeamId || request.expectedRevision !== revision) throw new PromotionError('teamIssueChanged')
        if (request.status === 'complete') return { issue: await issueView(issue, tx), linearSync: syncResult }
        if (request.status !== 'preparing' || issue.scope !== 'personal' || issue.revision !== revision || !issue.linearSyncBlocked) throw new PromotionError('teamIssueChanged')
        await tx.execute(sql`select set_config('mikka.team_scope_verified', ${issueId}, true), set_config('mikka.team_scope_team', ${teamId}, true), set_config('mikka.team_scope_request', ${requestId}, true)`)
        const [saved] = await tx.update(issues).set({ scope: 'workspace', linearSyncBlocked: true, scopeSetBy: 'user', scopeConfidence: null, revision: issue.revision + 1, updatedAt: new Date() }).where(eq(issues.id, issueId)).returning()
        await tx.insert(issueVersions).values({ id: crypto.randomUUID(), issueId, userId, revision: saved.revision, title: saved.title, content: saved.content, status: saved.status, priority: saved.priority, ...userActor(userId) })
        await tx.update(teamIssuePromotions).set({ status: 'complete' }).where(eq(teamIssuePromotions.requestId, requestId))
        return { issue: await issueView(saved, tx), linearSync: syncResult }
      })
    })
  } catch (error) {
    if (error instanceof PromotionError) return { error: error.code, requestId }
    if (promotionStarted) {
      try {
        const [request] = await db.select().from(teamIssuePromotions).where(eq(teamIssuePromotions.requestId, requestId)).limit(1)
        if (request?.ownerId === userId && request.issueId === issueId && request.teamId === teamId && request.expectedTeamId === expectedTeamId && request.expectedRevision === revision && request.status === 'complete') {
          const [issue] = await db.select().from(issues).where(and(eq(issues.id, issueId), eq(issues.userId, userId))).limit(1)
          if (issue) return { issue: await issueView(issue), linearSync: syncResult }
        }
      } catch { return { error: 'teamIssueOutcomeUnknown' as const, requestId } }
    }
    console.error('Team task promotion failed')
    return { error: 'teamIssueRetry' as const, requestId }
  }
}
