import 'server-only'
import { and, eq, inArray, isNotNull, isNull, ne, sql } from 'drizzle-orm'
import { z } from 'zod'
import { db, pool, withDatabaseTransaction } from '@/lib/db'
import { agentRuns, bots } from '@/lib/db/schema'
import { teamMembers, teams } from '@/lib/db/team-schema'
import { workspaceInvitations, workspaceMembers } from '@/lib/db/workspace-schema'
import { requireWorkspace, WorkspaceError, type WorkspaceTransaction } from '@/lib/workspace-access'
import { workspaceDb } from '@/lib/workspace-db'
import { releasePaymentDesignation } from '@/lib/payment-designation'
import { stopRunsUsingSubscriptions } from '@/lib/personal-policy'
import { stopRunsUsingApiKeys } from '@/lib/model-api-key-runs'
import { UNFINISHED_RUN_STATUSES } from '@/lib/agent-run-statuses'
import { enqueueWorkspaceAudit, type AuditRequestContext } from '@/lib/audit/delivery'
import type { MainTransaction } from './general'
import { botListChanged, ownerListChanged, workspaceListChanged, workspaceListScopesBeforeChange, workspaceListScopeChanged } from '../live/lists'
import { lockResourceAccess, lockResourcesAccess, resourceActionAllowed } from '@/lib/resource-access/store'
import type { ResourcePolicy } from '@/lib/resource-access/contract'
import { withTaskWorkspace } from '@/lib/task-workspace'
import { revokeMemberResourceAuthority } from '@/lib/resource-access/lifecycle'
import { notifyResourceAccessChanged } from '@/lib/live/resource-access'
import { ActionFailureError } from '@/lib/action-error'

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
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, toUserId), eq(workspaceMembers.status, 'active'))).limit(1).for('share')
  if (!target) throw new WorkspaceError('workspaceTransferTargetInvalid')
}

/**
 * Hands already shared bots to another member. A private bot needs its owner's
 * explicit single-resource transfer receipt; an Admin role is not that receipt.
 * Chat, Run and Secret owners and ACLs never move with the bot.
 * Rows bound to the old owner (cloud desktops, cloud runtimes, computer run
 * bindings) are removed and recreated for the new owner on first use. The
 * agent-kit history is immutable and remains keyed by its original owner. The
 * old head is detached; the new owner starts with its own built-in definition.
 * Refused while any of those bots is still working. The person's Coordinator
 * (coordinator_bots) is never handed over: every member has their own, so it
 * is paused with their other bots when they leave (releaseDepartingMember)
 * and stays theirs.
 */
export async function transferBots(tx: MainTransaction, workspaceId: string, fromUserId: string | null, toUserId: string,
  only?: string[], custody: { actorId: string; ownerApproved?: ResourcePolicy } = { actorId: 'system' }): Promise<AssetTransfer> {
  // A null owner (「待接管」, the owner deleted their account) is only ever taken over one bot at a time.
  if (fromUserId === null && !only) throw new Error('transferBots needs explicit bots for a null owner')
  const ownedBy = fromUserId === null ? isNull(bots.ownerId) : eq(bots.ownerId, fromUserId)
  const candidates = await tx.execute<{ id: string }>(sql`select b.id from bots b join resource_access_policies p on p.kind='bot' and p.id=b.id
    where b."workspaceId"=${workspaceId}::uuid and b."ownerId" is not distinct from ${fromUserId}
      and p."workspaceId"=b."workspaceId" and not exists(select 1 from coordinator_bots cb where cb."botId"=b.id)
      and ${only ? sql`b.id=any(${sql.param(only)}::uuid[])` : sql`true`}
      and ${custody.ownerApproved ? sql`p.id=${custody.ownerApproved.id}::uuid and p.revision=${custody.ownerApproved.revision}
        and p."ownerId"=${custody.actorId}` : sql`p.visibility='shared' and mikka_resource_acl_allowed('account',${toUserId},p."workspaceId",p.kind,p.id,'canReadContent')`}`)
  if (!candidates.rows.length) return { bots: 0 }
  if (custody.ownerApproved && (fromUserId !== custody.actorId || only?.length !== 1 || only[0] !== custody.ownerApproved.id))
    throw new WorkspaceError('botNotFound')
  if (!custody.ownerApproved) await lockResourcesAccess(tx, toUserId,
    candidates.rows.map(row => ({ reference: { kind: 'bot', id: row.id, workspaceId }, action: 'canReadContent' })), true, false)
  const owned = await tx.select({ id: bots.id, name: bots.name }).from(bots)
    .where(and(eq(bots.workspaceId, workspaceId), ownedBy, inArray(bots.id, candidates.rows.map(row => row.id)))).orderBy(bots.id).for('update')
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
  // The runtime's hidden agents stay: their threads' history points at them (agent_runs cascade). They give up
  // their name, so the next owner of this bot, the previous one included, can make its own (bot-runtime.ts).
  await tx.execute(sql`update agents a set name = a.name || ' · ' || a.id::text, "updatedAt" = now()
    from bot_cloud_runtimes x where x."agentId" = a.id and x."botId" in ${ids}`)
  await tx.execute(sql`delete from bot_cloud_runtimes where "botId" in ${ids}`)
  await tx.execute(sql`delete from computer_run_bindings where "botId" in ${ids}`)
  await tx.execute(sql`update agent_kit_heads set detached_bot_id=bot_id,detached_workspace_id=workspace_id,
    bot_id=null,workspace_id=null where bot_id in ${ids}`)
  // A bot handed over runs on its new owner's resources, never on the previous owner's credentials.
  await tx.execute(sql`select set_config('mikka.acl_actor',${custody.actorId},true),
    set_config('mikka.acl_source',${custody.ownerApproved ? 'owner_bot_transfer' : 'shared_bot_admin_transfer'},true)`)
  const removed = await tx.execute<{ subjectId: string }>(sql`delete from resource_access_grants where "resourceKind"='bot' and "resourceId" in ${ids}
    returning case when "subjectKind"='account' then "subjectId" end as "subjectId"`)
  await tx.execute(sql`update resource_access_policies set "ownerId"=${toUserId} where kind='bot' and id in ${ids} and "workspaceId"=${workspaceId}::uuid`)
  await tx.update(bots).set({ ownerId: toUserId, archivedAt: null, updatedAt: new Date() }).where(and(inArray(bots.id, ids), eq(bots.workspaceId, workspaceId), ownedBy))
  for (const id of ids) await botListChanged(tx, id)
  if (fromUserId) await ownerListChanged(tx, fromUserId, ['thread_list', 'task_run_list', 'bot_chat_list'])
  await workspaceListChanged(tx, workspaceId, ['bot_list'])
  notifyResourceAccessChanged(tx, workspaceId, [...(fromUserId ? [fromUserId] : []), toUserId, ...removed.rows.flatMap(row => row.subjectId ? [row.subjectId] : [])])
  return { bots: ids.length }
}

export const ownerBotTransferInput = z.object({ expectedRevision: z.number().int().positive(),
  confirmPrivateTransfer: z.boolean().default(false) }).strict()

/** Explicit Owner action. Only the Bot's configuration changes custody; the
 * target receives no old personal machine, model token or private transcript. */
export async function transferOwnedBot(actorId: string, workspaceId: string, botId: string, toUserId: string,
  input: z.input<typeof ownerBotTransferInput>): Promise<AssetTransfer> {
  z.uuid().parse(botId)
  const value = ownerBotTransferInput.parse(input)
  try { return await withTaskWorkspace(actorId, workspaceId, async (_workspace, membership) => {
    await requireTransferTarget(membership, workspaceId, actorId, toUserId)
    return db.transaction(tx => withDatabaseTransaction(tx, async () => {
      const policy = await lockResourceAccess(tx, actorId, { kind: 'bot', id: botId, workspaceId }, 'canTransfer', true)
      if (policy.ownerId !== actorId || policy.revision !== value.expectedRevision) throw new WorkspaceError('botNotFound')
      if (policy.visibility === 'private' && !value.confirmPrivateTransfer) throw new WorkspaceError('validationGeneric')
      if (policy.parentKind && policy.parentId && !await resourceActionAllowed(tx, toUserId,
        { kind: policy.parentKind, id: policy.parentId, workspaceId }, 'canReadContent')) throw new WorkspaceError('workspaceTransferTargetInvalid')
      const result = await transferBots(tx, workspaceId, actorId, toUserId, [botId], { actorId, ownerApproved: policy })
      if (!result.bots) throw new WorkspaceError('botNotFound')
      return result
    }))
  }) } catch (error) {
    if (error instanceof ActionFailureError) throw Object.assign(new WorkspaceError('botNotFound'), { cause: error })
    throw error
  }
}

/**
 * §8.3 (decision 2026-10-31-2225): when someone leaves a team or is suspended,
 * their subscription share, API key shares and credit share leave with them and their bots there pause until an
 * admin takes one over. Runs on that subscription are stopped at once, and
 * the machine receives a stop through its control channel. New admissions and
 * background credential renewals check the current share and membership.
 */
export async function releaseDepartingMember(workspaceId: string, userId: string) {
  // A card they designated keeps paying through its grace period; admins see when it stops (计费).
  await releasePaymentDesignation(workspaceId, userId)
  await db.transaction(main => withDatabaseTransaction(main, async () => {
    await revokeMemberResourceAuthority(pool, workspaceId, userId)
    await main.execute(sql`delete from workspace_subscription_shares where "ownerId" = ${userId} and "workspaceId" = ${workspaceId}`)
    await main.execute(sql`delete from personal_mcp_workspace_shares g using personal_mcp_servers s where g.server_id=s.id and s.user_id=${userId} and g.workspace_id=${workspaceId}`)
    // Their credits stop paying for the team at once (lib/credit-shares.ts).
    await main.execute(sql`delete from workspace_credit_shares where "userId" = ${userId} and "workspaceId" = ${workspaceId}`)
    await main.execute(sql`delete from model_api_key_shares s using model_api_keys k where k.id = s."keyId" and k."ownerId" = ${userId} and s."workspaceId" = ${workspaceId}`)
    const archived = await main.update(bots).set({ archivedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(bots.workspaceId, workspaceId), eq(bots.ownerId, userId), isNull(bots.archivedAt))).returning({ id: bots.id })
    for (const { id } of archived) await botListChanged(main, id)
  }))
  // Runs there on their subscription stop now, including other members' bots they had shared it with.
  await stopRunsUsingSubscriptions(pool, { ownerId: userId, workspaceId })
  await stopRunsUsingApiKeys(pool, { ownerId: userId, workspaceId })
}

/** Reactivation brings a suspended member's own bots back; their subscription stays unshared until they share it again. */
export async function restoreReturningMember(workspaceId: string, userId: string) {
  const restored = await db.update(bots).set({ archivedAt: null, updatedAt: new Date() }).where(and(eq(bots.workspaceId, workspaceId), eq(bots.ownerId, userId))).returning({ id: bots.id })
  for (const { id } of restored) await botListChanged(db, id)
}

/** An admin takes over a paused bot of someone who left, was suspended or deleted their account (null owner); it then runs on the admin's own resources. */
export async function takeOverBot(actorId: string, workspaceId: string, botId: string): Promise<AssetTransfer> {
  z.uuid().parse(botId)
  try { return await workspaceDb.transaction(async tx => {
    const { membership } = await requireWorkspace(tx, workspaceId, actorId, true)
    return db.transaction(main => withDatabaseTransaction(main, async () => {
      const policy = await lockResourceAccess(main, actorId, { kind: 'bot', id: botId, workspaceId }, 'canReadContent', true)
      const [bot] = await main.select({ ownerId: bots.ownerId, name: bots.name }).from(bots)
        .where(and(eq(bots.id, botId), eq(bots.workspaceId, workspaceId), isNotNull(bots.archivedAt))).for('update').limit(1)
      if (!bot || policy.visibility !== 'shared' && bot.ownerId !== actorId) throw new WorkspaceError('botNotFound')
      const coordinator = await main.execute(sql`select 1 from coordinator_bots where "botId"=${botId}::uuid`)
      if (coordinator.rows.length) return { bots: 0 }
      if (bot.ownerId === actorId) {
        await main.update(bots).set({ archivedAt: null, updatedAt: new Date() }).where(eq(bots.id, botId))
        await botListChanged(main, botId)
      } else await transferBots(main, workspaceId, bot.ownerId, actorId, [botId], { actorId })
      await enqueueWorkspaceAudit(tx, { workspaceId, actor: { type: 'user', id: actorId, name: membership.name }, action: 'bot.taken_over', target: { type: 'bot', id: botId, label: bot.name } })
      return { bots: 1 }
    }))
  }) } catch (error) {
    if (error instanceof ActionFailureError) throw Object.assign(new WorkspaceError('botNotFound'), { cause: error })
    throw error
  }
}

/** Paused bots in this workspace, for its admins. */
export async function archivedBots(actorId: string, workspaceId: string) {
  return workspaceDb.transaction(async tx => {
    await requireWorkspace(tx, workspaceId, actorId, true)
    return db.select({ id: bots.id, name: bots.name, color: bots.color, shape: bots.shape, ownerId: bots.ownerId, archivedAt: bots.archivedAt })
    .from(bots).where(and(eq(bots.workspaceId, workspaceId), isNotNull(bots.archivedAt),
      sql`mikka_resource_acl_allowed('account',${actorId},${workspaceId}::uuid,'bot',${bots.id},'canReadContent')`)).orderBy(bots.name)
  })
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
  const { enqueueMemberLifecycle, drainMemberLifecycleOutbox } = await import('@/lib/governance/member-outbox')
  memberId.parse(targetId)
  if (targetId === actorId) throw new WorkspaceError('workspaceCannotRemoveSelf')
  const removed = await workspaceDb.transaction(async tx => {
    const { membership } = await requireWorkspace(tx, workspaceId, actorId, true)
    const [target] = await tx.select().from(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, targetId))).for('update').limit(1)
    if (!target) throw new WorkspaceError('workspaceMemberNotFound')
    if (target.role === 'admin' && target.status === 'active') await assertAnotherAdmin(tx, workspaceId, targetId)
    const before = await workspaceListScopesBeforeChange(tx, workspaceId)
    if (transferTo !== undefined) await requireTransferTarget(tx, workspaceId, targetId, transferTo)
    await enqueueWorkspaceAudit(tx, { workspaceId, actor: { type: 'user', id: actorId, name: membership.name }, action: 'member.removed', target: { type: 'member', id: targetId, label: target.name || target.email }, ...audit })
    const transferred = transferTo === undefined ? { bots: 0 } : await db.transaction(main => transferBots(main, workspaceId, targetId, transferTo, undefined, { actorId }))
    const teamIds = (await tx.select({ id: teams.id }).from(teams).where(eq(teams.workspaceId, workspaceId))).map(row => row.id)
    if (teamIds.length) await tx.delete(teamMembers).where(and(inArray(teamMembers.teamId, teamIds), eq(teamMembers.userId, targetId)))
    await tx.update(workspaceInvitations).set({ status: 'revoked' })
      .where(and(eq(workspaceInvitations.workspaceId, workspaceId), eq(workspaceInvitations.email, target.email.toLowerCase()), eq(workspaceInvitations.status, 'pending')))
    await tx.delete(workspaceMembers).where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, targetId)))
    await enqueueMemberLifecycle(tx, workspaceId, targetId, 'suspend')
    await workspaceListScopeChanged(tx, workspaceId, before)
    return { removed: true as const, transferred, label: target.name || target.email }
  })
  // After the membership is gone: the membership check already fences them, this removes what stays behind.
  await drainMemberLifecycleOutbox(workspaceId, targetId)
  return removed
}

/** Used by updateWorkspaceMember when an admin suspends someone and names who takes over their bots. */
export async function transferOnSuspend(tx: WorkspaceTransaction, workspaceId: string, targetId: string, transferTo: string, actorId = 'system'): Promise<AssetTransfer> {
  await requireTransferTarget(tx, workspaceId, targetId, transferTo)
  return db.transaction(main => transferBots(main, workspaceId, targetId, transferTo, undefined, { actorId }))
}
