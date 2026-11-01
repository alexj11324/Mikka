import 'server-only'
import { and, eq, inArray, isNotNull, isNull, ne, sql } from 'drizzle-orm'
import { z } from 'zod'
import { db, pool } from '@/lib/db'
import { agentRuns, bots } from '@/lib/db/schema'
import { teamMembers, teams } from '@/lib/db/team-schema'
import { workspaceInvitations, workspaceMembers } from '@/lib/db/workspace-schema'
import { requireWorkspace, WorkspaceError, type WorkspaceTransaction } from '@/lib/workspace-access'
import { workspaceDb } from '@/lib/workspace-db'
import { releasePaymentDesignation } from '@/lib/payment-designation'
import { stopRunsUsingSubscriptions } from '@/lib/personal-policy'
import { UNFINISHED_RUN_STATUSES } from '@/lib/agent-run-statuses'
import { enqueueWorkspaceAudit, type AuditRequestContext } from '@/lib/audit/delivery'
import type { MainTransaction } from './general'

const memberId = z.string().min(1).max(200)

export interface AssetTransfer {
  /** Bots handed to the new owner. */
  bots: number
}

/** The new owner must be another active member of the same workspace. */
async function requireTransferTarget(tx: WorkspaceTransaction, workspaceId: string, fromUserId: string, toUserId: string) {
  memberId.parse(toUserId)
  if (toUserId === fromUserId) throw new WorkspaceError('workspaceTransferTargetInvalid')
  const [target] = await tx.select({ userId: workspaceMembers.userId }).from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, toUserId), eq(workspaceMembers.status, 'active'))).limit(1)
  if (!target) throw new WorkspaceError('workspaceTransferTargetInvalid')
}

/**
 * Hands every bot `fromUserId` owns in the workspace to `toUserId`.
 * The bot keeps its id, chats, threads and finished background tasks.
 * Rows bound to the old owner (cloud desktops, cloud runtimes, computer run
 * bindings) are removed and recreated for the new owner on first use. The
 * agent-kit history is immutable and keyed by its owner, so it is removed too:
 * the bot continues on the built-in definition for its new owner.
 * Refused while any of those bots is still working.
 */
export async function transferBots(tx: MainTransaction, workspaceId: string, fromUserId: string, toUserId: string, only?: string[]): Promise<AssetTransfer> {
  const owned = await tx.select({ id: bots.id, name: bots.name }).from(bots)
    .where(and(eq(bots.workspaceId, workspaceId), eq(bots.ownerId, fromUserId), ...(only ? [inArray(bots.id, only)] : []))).for('update')
  if (!owned.length) return { bots: 0 }
  const ids = owned.map(bot => bot.id)
  const [busyRun] = await tx.select({ id: agentRuns.id }).from(agentRuns)
    .where(and(inArray(agentRuns.botId, ids), inArray(agentRuns.status, [...UNFINISHED_RUN_STATUSES]))).limit(1)
  const busyTask = await tx.execute<{ id: string }>(sql`select id from bot_subagents where "botId" in ${ids} and status in ('queued', 'running', 'needs_you') limit 1`)
  if (busyRun || busyTask.rows.length) throw new WorkspaceError('botTransferBusy')
  const names = owned.map(bot => bot.name.toLowerCase())
  const clash = await tx.execute<{ id: string }>(sql`select id from bots where "workspaceId" = ${workspaceId} and "ownerId" = ${toUserId} and lower(name) in ${names} limit 1`)
  if (clash.rows.length) throw new WorkspaceError('botTransferNameConflict')
  await tx.execute(sql`delete from bot_desktops where "botId" in ${ids}`)
  await tx.execute(sql`delete from bot_cloud_runtimes where "botId" in ${ids}`)
  await tx.execute(sql`delete from computer_run_bindings where "botId" in ${ids}`)
  await tx.execute(sql`delete from agent_kit_heads where bot_id in ${ids}`)
  // A bot handed over runs on its new owner's resources, never on the previous owner's credentials.
  await tx.update(bots).set({ ownerId: toUserId, archivedAt: null, updatedAt: new Date() }).where(and(inArray(bots.id, ids), eq(bots.workspaceId, workspaceId), eq(bots.ownerId, fromUserId)))
  return { bots: ids.length }
}

/**
 * §8.3 (decision 2026-10-31-2225): when someone leaves a team or is suspended,
 * their subscription share leaves with them and their bots there pause until an
 * admin takes one over. Runs on that subscription are stopped at once, and
 * model calls check the share and the membership on every call.
 */
export async function releaseDepartingMember(workspaceId: string, userId: string) {
  // A card they designated keeps paying through its grace period; admins see when it stops (计费).
  await releasePaymentDesignation(workspaceId, userId)
  await db.transaction(async main => {
    await main.execute(sql`delete from workspace_subscription_shares where "ownerId" = ${userId} and "workspaceId" = ${workspaceId}`)
    await main.update(bots).set({ archivedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(bots.workspaceId, workspaceId), eq(bots.ownerId, userId), isNull(bots.archivedAt)))
  })
  // Runs there on their subscription stop now, including other members' bots they had shared it with.
  await stopRunsUsingSubscriptions(pool, { ownerId: userId, workspaceId })
}

/** Reactivation brings a suspended member's own bots back; their subscription stays unshared until they share it again. */
export async function restoreReturningMember(workspaceId: string, userId: string) {
  await db.update(bots).set({ archivedAt: null, updatedAt: new Date() }).where(and(eq(bots.workspaceId, workspaceId), eq(bots.ownerId, userId)))
}

/** An admin takes over a paused bot of someone who left or was suspended; it then runs on the admin's own resources. */
export async function takeOverBot(actorId: string, workspaceId: string, botId: string): Promise<AssetTransfer> {
  z.uuid().parse(botId)
  await workspaceDb.transaction(tx => requireWorkspace(tx, workspaceId, actorId, true))
  return db.transaction(async main => {
    const [bot] = await main.select({ ownerId: bots.ownerId }).from(bots)
      .where(and(eq(bots.id, botId), eq(bots.workspaceId, workspaceId), isNotNull(bots.archivedAt))).for('update').limit(1)
    if (!bot) throw new WorkspaceError('botNotFound')
    if (bot.ownerId === actorId) {
      await main.update(bots).set({ archivedAt: null, updatedAt: new Date() }).where(eq(bots.id, botId))
      return { bots: 1 }
    }
    return transferBots(main, workspaceId, bot.ownerId, actorId, [botId])
  })
}

/** Paused bots in this workspace, for its admins. */
export async function archivedBots(actorId: string, workspaceId: string) {
  await workspaceDb.transaction(tx => requireWorkspace(tx, workspaceId, actorId, true))
  return db.select({ id: bots.id, name: bots.name, color: bots.color, shape: bots.shape, ownerId: bots.ownerId, archivedAt: bots.archivedAt })
    .from(bots).where(and(eq(bots.workspaceId, workspaceId), isNotNull(bots.archivedAt))).orderBy(bots.name)
}

/** An active admin other than `userId` remains. */
async function assertAnotherAdmin(tx: WorkspaceTransaction, workspaceId: string, userId: string) {
  const others = await tx.select({ id: workspaceMembers.userId }).from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), ne(workspaceMembers.userId, userId), eq(workspaceMembers.role, 'admin'), eq(workspaceMembers.status, 'active'))).limit(1)
  if (!others.length) throw new WorkspaceError('workspaceLastAdmin')
}

export interface MemberRemoval { removed: true; transferred: AssetTransfer }
/** removeMember's result plus who was removed, for the audit row. */
export interface RemovedMember extends MemberRemoval { label: string }

/**
 * 移除成员. Not yourself (use leave) and never the last active admin. The
 * membership row goes, so every later request of that person fails the
 * membership check for this workspace at once. Team memberships in this
 * workspace and pending invitations to the same email go with it.
 */
export async function removeMember(actorId: string, workspaceId: string, targetId: string, transferTo?: string, audit?: AuditRequestContext): Promise<RemovedMember> {
  memberId.parse(targetId)
  if (targetId === actorId) throw new WorkspaceError('workspaceCannotRemoveSelf')
  const removed = await workspaceDb.transaction(async tx => {
    const { membership } = await requireWorkspace(tx, workspaceId, actorId, true)
    const [target] = await tx.select().from(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, targetId))).for('update').limit(1)
    if (!target) throw new WorkspaceError('workspaceMemberNotFound')
    if (target.role === 'admin' && target.status === 'active') await assertAnotherAdmin(tx, workspaceId, targetId)
    if (transferTo !== undefined) await requireTransferTarget(tx, workspaceId, targetId, transferTo)
    await enqueueWorkspaceAudit(tx, { workspaceId, actor: { type: 'user', id: actorId, name: membership.name }, action: 'member.removed', target: { type: 'member', id: targetId, label: target.name || target.email }, ...audit })
    const transferred = transferTo === undefined ? { bots: 0 } : await db.transaction(main => transferBots(main, workspaceId, targetId, transferTo))
    const teamIds = (await tx.select({ id: teams.id }).from(teams).where(eq(teams.workspaceId, workspaceId))).map(row => row.id)
    if (teamIds.length) await tx.delete(teamMembers).where(and(inArray(teamMembers.teamId, teamIds), eq(teamMembers.userId, targetId)))
    await tx.update(workspaceInvitations).set({ status: 'revoked' })
      .where(and(eq(workspaceInvitations.workspaceId, workspaceId), eq(workspaceInvitations.email, target.email.toLowerCase()), eq(workspaceInvitations.status, 'pending')))
    await tx.delete(workspaceMembers).where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, targetId)))
    return { removed: true as const, transferred, label: target.name || target.email }
  })
  // After the membership is gone: the membership check already fences them, this removes what stays behind.
  await releaseDepartingMember(workspaceId, targetId)
  return removed
}

/** Used by updateWorkspaceMember when an admin suspends someone and names who takes over their bots. */
export async function transferOnSuspend(tx: WorkspaceTransaction, workspaceId: string, targetId: string, transferTo: string): Promise<AssetTransfer> {
  await requireTransferTarget(tx, workspaceId, targetId, transferTo)
  return db.transaction(main => transferBots(main, workspaceId, targetId, transferTo))
}
