import 'server-only'
import { and, asc, eq, inArray, ne, sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@/lib/db'
import { agentRuns, bots, conversations, issues, teamIssueCreateRequests, teamIssuePromotions, workspaceBilling, workspaceCreditGrants, workspaceSettings } from '@/lib/db/schema'
import { projectEvents, projects } from '@/lib/db/project-schema'
import { teamIssueCreateReceipts, teamIssuePromotionReceipts, teamIssues, teamMembers, teamProjects, teams } from '@/lib/db/team-schema'
import { workspaceInvitations, workspaceMembers, workspaceSlugRedirects, workspaces } from '@/lib/db/workspace-schema'
import { workspaceDb } from '@/lib/workspace-db'
import { requireWorkspace, WorkspaceError, type WorkspaceTransaction } from '@/lib/workspace-access'
import { parseWorkspaceIcon } from './icon'

export type MainTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0]

export const workspaceSlugSchema = z.string().trim().toLowerCase().min(3).max(64).regex(/^[a-z0-9]([a-z0-9-]{1,62}[a-z0-9])$/)
export const updateWorkspaceInput = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  slug: workspaceSlugSchema.optional(),
  icon: z.string().max(400_000).nullable().optional(),
}).strict()
export type UpdateWorkspaceInput = z.input<typeof updateWorkspaceInput>

export interface WorkspaceGeneral { id: string; name: string; slug: string | null; icon: string | null }

/** Subscription states that still bill the customer. */
export const BILLING_LIVE_STATUSES = ['active', 'trialing', 'past_due', 'unpaid', 'incomplete'] as const

/** Another workspace already uses or used this slug (old slugs keep redirecting). */
async function slugBelongsElsewhere(tx: WorkspaceTransaction, slug: string, workspaceId: string) {
  const [current] = await tx.select({ id: workspaces.id }).from(workspaces).where(and(eq(workspaces.slug, slug), ne(workspaces.id, workspaceId))).limit(1)
  if (current) return true
  const [redirect] = await tx.select({ id: workspaceSlugRedirects.workspaceId }).from(workspaceSlugRedirects).where(eq(workspaceSlugRedirects.slug, slug)).limit(1)
  return Boolean(redirect && redirect.id !== workspaceId)
}

/** Slugs reserved by a redirect cannot be taken by a new workspace either. */
export async function slugIsReserved(tx: WorkspaceTransaction, slug: string) {
  const [redirect] = await tx.select({ id: workspaceSlugRedirects.workspaceId }).from(workspaceSlugRedirects).where(eq(workspaceSlugRedirects.slug, slug)).limit(1)
  return Boolean(redirect)
}

/** 常规: rename, change the URL slug (old slug redirects) and set or clear the icon. Admins only. */
export async function updateWorkspaceGeneral(actorId: string, workspaceId: string, input: UpdateWorkspaceInput): Promise<WorkspaceGeneral> {
  const values = updateWorkspaceInput.parse(input)
  const icon = values.icon === undefined ? undefined : parseWorkspaceIcon(values.icon)
  if (icon === false) throw new WorkspaceError('workspaceIconInvalid')
  return workspaceDb.transaction(async tx => {
    const { workspace } = await requireWorkspace(tx, workspaceId, actorId, true)
    // One lock for every slug change, so two renames cannot claim the same slug.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('mikka-workspace-slugs', 0))`)
    const changes: Partial<typeof workspaces.$inferInsert> = {}
    if (values.name !== undefined) changes.name = values.name
    if (icon !== undefined) changes.icon = icon
    if (values.slug !== undefined && values.slug !== workspace.slug) {
      if (await slugBelongsElsewhere(tx, values.slug, workspaceId)) throw new WorkspaceError('workspaceSlugTaken')
      // Taking back one of this workspace's own old slugs removes its redirect.
      await tx.delete(workspaceSlugRedirects).where(and(eq(workspaceSlugRedirects.slug, values.slug), eq(workspaceSlugRedirects.workspaceId, workspaceId)))
      if (workspace.slug) await tx.insert(workspaceSlugRedirects).values({ slug: workspace.slug, workspaceId }).onConflictDoNothing()
      changes.slug = values.slug
    }
    if (!Object.keys(changes).length) return { id: workspace.id, name: workspace.name, slug: workspace.slug, icon: workspace.icon }
    const [updated] = await tx.update(workspaces).set(changes).where(eq(workspaces.id, workspaceId))
      .returning({ id: workspaces.id, name: workspaces.name, slug: workspaces.slug, icon: workspaces.icon })
    return updated
  })
}

/**
 * Who may 转让工作区: the owner (`mikka_workspaces.userId`) while an admin, or any
 * admin once the owner is no longer an active admin here (left, suspended or demoted),
 * so a workspace never ends up with nobody able to hand it on.
 */
async function mayTransfer(tx: WorkspaceTransaction, workspace: typeof workspaces.$inferSelect, role: 'admin' | 'member', actorId: string) {
  if (role !== 'admin') return false
  if (workspace.userId === actorId) return true
  const [owner] = await tx.select({ userId: workspaceMembers.userId }).from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspace.id), eq(workspaceMembers.userId, workspace.userId), eq(workspaceMembers.role, 'admin'), eq(workspaceMembers.status, 'active'))).limit(1)
  return !owner
}

/** 常规 as the viewer sees it. Any active member may read; `canEdit` is true for admins only, `canTransfer` per mayTransfer. */
export async function readWorkspaceGeneral(actorId: string, workspaceId: string): Promise<WorkspaceGeneral & { canEdit: boolean; canTransfer: boolean }> {
  return workspaceDb.transaction(async tx => {
    const { workspace, membership } = await requireWorkspace(tx, workspaceId, actorId)
    const canTransfer = await mayTransfer(tx, workspace, membership.role, actorId)
    return { id: workspace.id, name: workspace.name, slug: workspace.slug, icon: workspace.icon, canEdit: membership.role === 'admin', canTransfer }
  })
}

export interface WorkspaceTransferTarget { userId: string; name: string; email: string }

/** 转让工作区: the active members other than the caller, who could become the owner. */
export async function workspaceTransferTargets(actorId: string, workspaceId: string): Promise<WorkspaceTransferTarget[]> {
  return workspaceDb.transaction(async tx => {
    const { workspace, membership } = await requireWorkspace(tx, workspaceId, actorId, true)
    if (!await mayTransfer(tx, workspace, membership.role, actorId)) throw new WorkspaceError('workspaceAccessDenied')
    return tx.select({ userId: workspaceMembers.userId, name: workspaceMembers.name, email: workspaceMembers.email }).from(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.status, 'active'), ne(workspaceMembers.userId, actorId)))
      .orderBy(asc(workspaceMembers.createdAt))
  })
}

export interface WorkspaceTransfer { owner: WorkspaceTransferTarget; previousRole: 'admin' | 'member' }

/**
 * 转让工作区: makes another active member the owner; a member is promoted to admin.
 * The previous owner stays an admin (they can step down in 成员).
 */
export async function transferWorkspaceOwnership(actorId: string, workspaceId: string, toUserId: string): Promise<WorkspaceTransfer> {
  z.uuid().parse(workspaceId)
  const to = z.string().min(1).max(200).parse(toUserId)
  return workspaceDb.transaction(async tx => {
    // requireWorkspace locks the workspace row, so two transfers run one after the other.
    const { workspace, membership } = await requireWorkspace(tx, workspaceId, actorId, true)
    if (!await mayTransfer(tx, workspace, membership.role, actorId)) throw new WorkspaceError('workspaceAccessDenied')
    if (to === actorId) throw new WorkspaceError('workspaceTransferTargetInvalid')
    const [target] = await tx.select().from(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, to), eq(workspaceMembers.status, 'active'))).for('update').limit(1)
    if (!target) throw new WorkspaceError('workspaceTransferTargetInvalid')
    if (target.role !== 'admin') await tx.update(workspaceMembers).set({ role: 'admin' }).where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, to)))
    await tx.update(workspaces).set({ userId: to }).where(eq(workspaces.id, workspaceId))
    return { owner: { userId: target.userId, name: target.name, email: target.email }, previousRole: target.role }
  })
}

/** What 删除工作区 (S-I) lists before the name is typed. Admins only. */
export interface WorkspaceDeletionImpact { bots: number; tasks: number; teams: number; purchasedPoints: number }

export async function workspaceDeletionImpact(actorId: string, workspaceId: string): Promise<WorkspaceDeletionImpact> {
  const { teamCount, taskCount } = await workspaceDb.transaction(async tx => {
    await requireWorkspace(tx, workspaceId, actorId, true)
    const [teamRow] = await tx.select({ n: sql<number>`count(*)::int` }).from(teams).where(eq(teams.workspaceId, workspaceId))
    const [taskRow] = await tx.select({ n: sql<number>`count(distinct ${teamIssues.issueId})::int` }).from(teamIssues).where(eq(teamIssues.workspaceId, workspaceId))
    return { teamCount: teamRow?.n ?? 0, taskCount: taskRow?.n ?? 0 }
  })
  const [botRow] = await db.select({ n: sql<number>`count(*)::int` }).from(bots).where(eq(bots.workspaceId, workspaceId))
  const [pointRow] = await db.select({ n: sql<number>`coalesce(sum(${workspaceCreditGrants.points}), 0)::int` }).from(workspaceCreditGrants)
    .where(and(eq(workspaceCreditGrants.workspaceId, workspaceId), eq(workspaceCreditGrants.bucket, 'purchased')))
  return { bots: botRow?.n ?? 0, tasks: taskCount, teams: teamCount, purchasedPoints: pointRow?.n ?? 0 }
}

/** /w/<slug> fallback: the current slug of the workspace that used to have this one, for its active members. */
export async function resolveSlugRedirect(slug: string, userId: string): Promise<string | null> {
  const [row] = await workspaceDb.select({ slug: workspaces.slug }).from(workspaceSlugRedirects)
    .innerJoin(workspaces, eq(workspaces.id, workspaceSlugRedirects.workspaceId))
    .innerJoin(workspaceMembers, and(eq(workspaceMembers.workspaceId, workspaces.id), eq(workspaceMembers.userId, userId), eq(workspaceMembers.status, 'active')))
    .where(eq(workspaceSlugRedirects.slug, slug)).limit(1)
  return row?.slug ?? null
}

export interface WorkspaceDeletion {
  deleted: { bots: number; threads: number; tasks: number; projects: number; teams: number; invitations: number; members: number }
  /** Where the deleting admin lands next; null when they have no other workspace (one is created on the next visit). */
  nextWorkspaceId: string | null
}

/**
 * Everything in the app database that belongs to the workspace. Personal data
 * (accounts, personal tasks, personal model subscriptions in byos_*, Linear and
 * GitHub connections, which are per person) is left alone.
 */
async function deleteAppData(tx: MainTransaction, workspaceId: string, teamIds: string[], issueIds: string[]) {
  const [billing] = await tx.select({ status: workspaceBilling.status }).from(workspaceBilling).where(eq(workspaceBilling.workspaceId, workspaceId)).for('update').limit(1)
  if (billing?.status && (BILLING_LIVE_STATUSES as readonly string[]).includes(billing.status)) throw new WorkspaceError('workspaceHasActiveSubscription')
  const botRows = await tx.select({ id: bots.id }).from(bots).where(eq(bots.workspaceId, workspaceId)).for('update')
  const botIds = botRows.map(row => row.id)
  // Rows that reference runs, bots or background tasks without ON DELETE CASCADE go first.
  await tx.execute(sql`delete from suggestion_executions where "workspaceId" = ${workspaceId}`)
  await tx.execute(sql`delete from thread_machines where "workspaceId" = ${workspaceId}`)
  let threads = 0
  if (botIds.length) {
    await tx.execute(sql`delete from thread_machines where "botId" in ${botIds}`)
    threads = (await tx.delete(agentRuns).where(inArray(agentRuns.botId, botIds)).returning({ id: agentRuns.id })).length
  }
  let tasks = 0
  if (issueIds.length) {
    tasks = (await tx.delete(issues).where(inArray(issues.id, issueIds)).returning({ id: issues.id })).length
  }
  if (teamIds.length) {
    await tx.delete(teamIssueCreateRequests).where(inArray(teamIssueCreateRequests.teamId, teamIds))
    await tx.delete(teamIssuePromotions).where(inArray(teamIssuePromotions.teamId, teamIds))
  }
  // Deleting bots cascades to their chats, desktops, cloud runtimes, agent kit and background tasks.
  const deletedBots = botIds.length ? (await tx.delete(bots).where(eq(bots.workspaceId, workspaceId)).returning({ id: bots.id })).length : 0
  await tx.delete(conversations).where(eq(conversations.workspaceId, workspaceId))
  for (const statement of [
    sql`delete from subagent_events where "workspaceId" = ${workspaceId}`,
    sql`delete from cloud_machines where "workspaceId" = ${workspaceId}`,
    sql`delete from workspace_snapshots where "workspaceId" = ${workspaceId}`,
    sql`delete from workspace_computer_policies where "workspaceId" = ${workspaceId}`,
    sql`delete from credential_fill_leases where workspace_id = ${workspaceId}`,
    sql`delete from credential_challenges where workspace_id = ${workspaceId}`,
    sql`delete from operation_ledger where "workspaceId" = ${workspaceId}`,
  ]) await tx.execute(statement)
  await tx.delete(workspaceSettings).where(eq(workspaceSettings.workspaceId, workspaceId))
  await tx.delete(workspaceCreditGrants).where(eq(workspaceCreditGrants.workspaceId, workspaceId))
  await tx.delete(workspaceBilling).where(eq(workspaceBilling.workspaceId, workspaceId))
  return { bots: deletedBots, threads, tasks }
}

/**
 * 删除工作区. The name must match exactly. The workspace row stays locked while
 * the app database is cleaned in its own transaction, which commits first: the
 * two databases cannot share one transaction, and every step is idempotent, so
 * if the workspace transaction then fails a retry finishes the job.
 */
export async function deleteWorkspaceData(actorId: string, workspaceId: string, confirmName: string): Promise<WorkspaceDeletion> {
  z.uuid().parse(workspaceId)
  const typed = z.string().max(200).parse(confirmName).trim()
  return workspaceDb.transaction(async tx => {
    const { workspace } = await requireWorkspace(tx, workspaceId, actorId, true)
    if (typed !== workspace.name) throw new WorkspaceError('workspaceDeleteNameMismatch')
    const teamRows = await tx.select({ id: teams.id }).from(teams).where(eq(teams.workspaceId, workspaceId)).for('update')
    const teamIds = teamRows.map(row => row.id)
    const issueRows = await tx.select({ id: teamIssues.issueId }).from(teamIssues).where(eq(teamIssues.workspaceId, workspaceId))
    const projectRows = await tx.select({ id: teamProjects.projectId }).from(teamProjects).where(eq(teamProjects.workspaceId, workspaceId))
    const projectIds = [...new Set(projectRows.map(row => row.id))]
    const app = await db.transaction(main => deleteAppData(main, workspaceId, teamIds, issueRows.map(row => row.id)))

    await tx.delete(teamIssueCreateReceipts).where(eq(teamIssueCreateReceipts.workspaceId, workspaceId))
    await tx.delete(teamIssuePromotionReceipts).where(eq(teamIssuePromotionReceipts.workspaceId, workspaceId))
    await tx.delete(teamIssues).where(eq(teamIssues.workspaceId, workspaceId))
    await tx.delete(teamProjects).where(eq(teamProjects.workspaceId, workspaceId))
    let deletedProjects = 0
    if (projectIds.length) {
      await tx.delete(projectEvents).where(inArray(projectEvents.projectId, projectIds))
      deletedProjects = (await tx.delete(projects).where(inArray(projects.id, projectIds)).returning({ id: projects.id })).length
    }
    if (teamIds.length) await tx.delete(teamMembers).where(inArray(teamMembers.teamId, teamIds))
    const deletedTeams = (await tx.delete(teams).where(eq(teams.workspaceId, workspaceId)).returning({ id: teams.id })).length
    const invitations = (await tx.delete(workspaceInvitations).where(eq(workspaceInvitations.workspaceId, workspaceId)).returning({ id: workspaceInvitations.id })).length
    const members = (await tx.delete(workspaceMembers).where(eq(workspaceMembers.workspaceId, workspaceId)).returning({ id: workspaceMembers.userId })).length
    await tx.delete(workspaceSlugRedirects).where(eq(workspaceSlugRedirects.workspaceId, workspaceId))
    await tx.delete(workspaces).where(eq(workspaces.id, workspaceId))

    const [next] = await tx.select({ id: workspaces.id }).from(workspaces)
      .innerJoin(workspaceMembers, eq(workspaceMembers.workspaceId, workspaces.id))
      .where(and(eq(workspaceMembers.userId, actorId), eq(workspaceMembers.status, 'active'))).orderBy(asc(workspaces.createdAt)).limit(1)
    return {
      deleted: { ...app, projects: deletedProjects, teams: deletedTeams, invitations, members },
      nextWorkspaceId: next?.id ?? null,
    }
  })
}
