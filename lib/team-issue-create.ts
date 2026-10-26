import 'server-only'
import { createHash } from 'node:crypto'
import { and, eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@/lib/db'
import { issues, issueVersions, teamIssueCreateRequests } from '@/lib/db/schema'
import { workspaceDb } from '@/lib/workspace-db'
import { teams, teamIssues, teamIssueCreateReceipts } from '@/lib/db/team-schema'
import { workspaceMembers } from '@/lib/db/workspace-schema'
import { createIssueForUserInTransaction } from '@/lib/issue-create'
import { lockTeamRelations } from '@/lib/team-access'
import { userActor } from '@/lib/activity-actor'
import { issueView } from '@/lib/task-identifier-server'
import { ISSUE_PRIORITY_CODES, ISSUE_STATUS_CODES } from '@/lib/issue-meta'
import type { JSONContent } from '@tiptap/core'

const schema = z.object({
  requestId: z.uuid(), teamId: z.uuid(), title: z.string().trim().min(1).max(200),
  content: z.custom<JSONContent>(value => !!value && typeof value === 'object' && (value as JSONContent).type === 'doc' && JSON.stringify(value).length <= 250000),
  status: z.enum(ISSUE_STATUS_CODES), priority: z.enum(ISSUE_PRIORITY_CODES),
})
type WorkspaceTx = Parameters<Parameters<typeof workspaceDb.transaction>[0]>[0]
class TeamCreateError extends Error { constructor(readonly code: 'teamIssueAccessDenied' | 'teamIssueRequestConflict' | 'teamIssueChanged') { super(code) } }

async function lockAllowedTeam(tx: WorkspaceTx, userId: string, teamId: string) {
  await lockTeamRelations(tx)
  const [team] = await tx.select({ id: teams.id, workspaceId: teams.workspaceId }).from(teams)
    .innerJoin(workspaceMembers, and(eq(workspaceMembers.workspaceId, teams.workspaceId), eq(workspaceMembers.userId, userId), eq(workspaceMembers.status, 'active')))
    .where(eq(teams.id, teamId)).for('update').limit(1)
  if (!team) throw new TeamCreateError('teamIssueAccessDenied')
  return team
}

/** Creates a personal, provider-blocked issue first; commits its team relation;
 * then rechecks membership and that relation under workspace locks while the
 * application transaction promotes it. requestId is an idempotency key, not an
 * issue ID. No provider call is made and failures retain the private issue. */
export async function createTeamIssueForUser(userId: string, input: unknown) {
  const parsed = schema.safeParse(input)
  if (!parsed.success) return { error: 'teamIssueInvalid' as const }
  const { requestId, teamId, ...content } = parsed.data
  const fingerprint = createHash('sha256').update(JSON.stringify({ teamId, ...content })).digest('hex')
  let promotionStarted = false
  try {
    const issueId = await workspaceDb.transaction(async workspace => {
      const team = await lockAllowedTeam(workspace, userId, teamId)
      const id = await db.transaction(async tx => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`team-issue-create:${requestId}`}, 0))`)
        const [old] = await tx.select().from(teamIssueCreateRequests).where(eq(teamIssueCreateRequests.requestId, requestId)).for('update')
        if (old) {
          if (old.ownerId !== userId || old.teamId !== teamId || old.fingerprint !== fingerprint) throw new TeamCreateError('teamIssueRequestConflict')
          return old.issueId
        }
        const id = crypto.randomUUID()
        const issue = await createIssueForUserInTransaction(tx, userId, content, userActor(userId), { id, linearSyncBlocked: true })
        if (!issue) throw new TeamCreateError('teamIssueRequestConflict')
        await tx.insert(teamIssueCreateRequests).values({ requestId, issueId: id, ownerId: userId, teamId, fingerprint })
        return id
      })
      const [receipt] = await workspace.select().from(teamIssueCreateReceipts).where(eq(teamIssueCreateReceipts.requestId, requestId)).for('update')
      if (receipt && (receipt.issueId !== id || receipt.teamId !== teamId || receipt.workspaceId !== team.workspaceId || receipt.ownerId !== userId)) throw new TeamCreateError('teamIssueRequestConflict')
      if (!receipt) await workspace.insert(teamIssues).values({ issueId: id, teamId, workspaceId: team.workspaceId, userId }).onConflictDoNothing()
      const [link] = await workspace.select().from(teamIssues).where(eq(teamIssues.issueId, id)).for('update')
      if (!link || link.teamId !== teamId || link.workspaceId !== team.workspaceId || link.userId !== userId) throw new TeamCreateError('teamIssueChanged')
      if (!receipt) await workspace.insert(teamIssueCreateReceipts).values({ requestId, issueId: id, teamId, workspaceId: team.workspaceId, ownerId: userId })
      return id
    })
    return await workspaceDb.transaction(async workspace => {
      const team = await lockAllowedTeam(workspace, userId, teamId)
      const [link] = await workspace.select().from(teamIssues).where(eq(teamIssues.issueId, issueId)).for('update')
      if (!link || link.teamId !== teamId || link.workspaceId !== team.workspaceId || link.userId !== userId) throw new TeamCreateError('teamIssueChanged')
      promotionStarted = true
      return db.transaction(async tx => {
        const [request] = await tx.select().from(teamIssueCreateRequests).where(eq(teamIssueCreateRequests.requestId, requestId)).for('update')
        const [issue] = await tx.select().from(issues).where(eq(issues.id, issueId)).for('update')
        if (!request || request.ownerId !== userId || request.issueId !== issueId || request.teamId !== teamId || request.fingerprint !== fingerprint || !issue || issue.userId !== userId || !issue.linearSyncBlocked) throw new TeamCreateError('teamIssueChanged')
        if (request.status === 'complete') return { issue: await issueView(issue, tx), linearSync: { enabled: false as const, reason: 'no_explicit_target' as const } }
        if (issue.scope !== 'personal' || issue.revision !== 1) throw new TeamCreateError('teamIssueChanged')
        // The workspace transaction still holds membership and relation locks.
        // Bind the transaction-local database fence to exactly this task.
        await tx.execute(sql`select set_config('mikka.team_scope_verified', ${issueId}, true), set_config('mikka.team_scope_team', ${teamId}, true), set_config('mikka.team_scope_request', ${requestId}, true)`)
        const [saved] = await tx.update(issues).set({ scope: 'workspace', linearSyncBlocked: true, scopeSetBy: 'user', scopeConfidence: null, revision: 2, updatedAt: new Date() }).where(eq(issues.id, issueId)).returning()
        await tx.insert(issueVersions).values({ id: crypto.randomUUID(), issueId, userId, revision: saved.revision, title: saved.title, content: saved.content, status: saved.status, priority: saved.priority, ...userActor(userId) })
        await tx.update(teamIssueCreateRequests).set({ status: 'complete' }).where(eq(teamIssueCreateRequests.requestId, requestId))
        return { issue: await issueView(saved, tx), linearSync: { enabled: false as const, reason: 'no_explicit_target' as const } }
      })
    })
  } catch (error) {
    if (error instanceof TeamCreateError) return { error: error.code, requestId }
    // An application commit can succeed even if a database connection loses
    // its response. Reconcile before reporting a failure; never create a new
    // request ID for an uncertain result.
    if (promotionStarted) {
      try {
        const [request] = await db.select().from(teamIssueCreateRequests).where(eq(teamIssueCreateRequests.requestId, requestId)).limit(1)
        if (request?.ownerId === userId && request.fingerprint === fingerprint && request.status === 'complete') {
          const [issue] = await db.select().from(issues).where(and(eq(issues.id, request.issueId), eq(issues.userId, userId))).limit(1)
          if (issue) return { issue: await issueView(issue), linearSync: { enabled: false as const, reason: 'no_explicit_target' as const } }
        }
      } catch { return { error: 'teamIssueOutcomeUnknown' as const, requestId } }
    }
    console.error('Team task creation failed')
    return { error: 'teamIssueRetry' as const, requestId }
  }
}
