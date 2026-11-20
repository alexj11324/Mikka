import 'server-only'
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { z } from 'zod'
import { ActionFailureError } from '@/lib/action-error'
import { db } from '@/lib/db'
import { botSubscribers, bots } from '@/lib/db/schema'
import { workspaceMembers, workspaces } from '@/lib/db/workspace-schema'
import { requireWorkspace } from '@/lib/workspace-access'
import { workspaceDb } from '@/lib/workspace-db'
import { botListChanged } from '@/lib/live/lists'
import { requireTaskWorkspaceLease, withTaskWorkspace } from '@/lib/task-workspace'
import { assertWorkVisibilityChange } from '@/lib/settings/work-creation'

/**
 * A Bot's access, members and owner (Capy Captain, decision 2026-11-19-2105).
 * Visibility is the Bot's resource_access_policies row (kind 'bot'): `shared`
 * lets every active member find and follow it; `private` only its owner and
 * people granted access. Following never lends the owner's model, machine or
 * credentials: a follower's work runs on their own resources.
 */
export type BotVisibility = 'shared' | 'private'
export interface BotActor { userId: string; workspaceId: string }
export interface BotAccessView { visibility: BotVisibility; ownerId: string | null; subscribers: string[] }

const botId = z.uuid()
const userIds = z.array(z.string().min(1).max(128)).max(200)
type Executor = Pick<typeof db, 'execute'>
type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0]

async function ownedBot(executor: Executor, actor: BotActor, id: string, lock = false) {
  if (!botId.safeParse(id).success) throw new ActionFailureError('botNotFound')
  // The Coordinator is the person's own; it is never shared, followed or handed over.
  const { rows: [row] } = await executor.execute<{ id: string; name: string }>(sql`select b.id,b.name from bots b where b.id=${id}::uuid
    and b."workspaceId"=${actor.workspaceId}::uuid and b."ownerId"=${actor.userId} and b."archivedAt" is null
    and not exists (select 1 from coordinator_bots c where c."botId"=b.id) ${lock ? sql`for update of b` : sql``}`)
  if (!row) throw new ActionFailureError('botNotFound')
  return row
}

async function canDiscover(executor: Executor, userId: string, workspaceId: string, id: string) {
  const { rows: [row] } = await executor.execute<{ allowed: boolean }>(sql`select mikka_resource_acl_allowed('account',${userId},${workspaceId}::uuid,'bot',${id}::uuid,'canDiscover') as allowed`)
  return row?.allowed === true
}

async function activeMembers(workspaceId: string, ids: string[]) {
  if (!ids.length) return new Set<string>()
  const rows = await workspaceDb.select({ id: workspaceMembers.userId }).from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.status, 'active'), inArray(workspaceMembers.userId, ids)))
  return new Set(rows.map(row => row.id))
}

async function readAccess(executor: Executor, workspaceId: string, id: string): Promise<BotAccessView> {
  const { rows: [policy] } = await executor.execute<{ visibility: string; ownerId: string | null }>(sql`select visibility,"ownerId" from resource_access_policies where kind='bot' and id=${id}::uuid and "workspaceId"=${workspaceId}::uuid`)
  const { rows } = await executor.execute<{ userId: string }>(sql`select "userId" from bot_subscribers where "botId"=${id}::uuid order by "createdAt","userId"`)
  return { visibility: policy?.visibility === 'shared' ? 'shared' : 'private', ownerId: policy?.ownerId ?? null, subscribers: rows.map(row => row.userId) }
}

/** Drops followers who can no longer find the Bot (it went private, or their grant ended). */
async function pruneSubscribers(executor: Executor, workspaceId: string, id: string) {
  await executor.execute(sql`delete from bot_subscribers s using bots b where s."botId"=${id}::uuid and b.id=s."botId"
    and (s."userId"=b."ownerId" or not mikka_resource_acl_allowed('account',s."userId",${workspaceId}::uuid,'bot',${id}::uuid,'canDiscover'))`)
}

/**
 * New Bot's Access and 订阅者, checked before the Bot exists: sharing needs a team
 * workspace, and a private Bot has no one else who could follow it.
 */
export async function assertBotAccessInput(actor: BotActor, visibility: BotVisibility, subscribers: string[]) {
  const wanted = [...new Set(userIds.parse(subscribers))].filter(userId => userId !== actor.userId)
  if (visibility === 'shared') {
    const [workspace] = await workspaceDb.select({ kind: workspaces.kind }).from(workspaces).where(eq(workspaces.id, actor.workspaceId)).limit(1)
    if (workspace?.kind !== 'team') throw new ActionFailureError('botShareUnavailable')
  }
  if (!wanted.length) return
  if (visibility !== 'shared') throw new ActionFailureError('botSubscriberNoAccess')
  const members = await activeMembers(actor.workspaceId, wanted)
  if (wanted.some(userId => !members.has(userId))) throw new ActionFailureError('workspaceAccessDenied')
}

/** The Bot's visibility and followers, for anyone who can find it. */
export async function botAccess(actor: BotActor, id: string): Promise<BotAccessView> {
  if (!botId.safeParse(id).success) throw new ActionFailureError('botNotFound')
  if (!(await activeMembers(actor.workspaceId, [actor.userId])).has(actor.userId) || !await canDiscover(db, actor.userId, actor.workspaceId, id)) throw new ActionFailureError('botNotFound')
  return readAccess(db, actor.workspaceId, id)
}

/** The owner shares the Bot with the workspace or makes it private again. A personal workspace has no one to share with. */
export async function setBotVisibility(actor: BotActor, id: string, visibility: BotVisibility, transaction?: Transaction): Promise<BotAccessView> {
  z.enum(['shared', 'private']).parse(visibility)
  const write = async (main: Transaction) => {
    const workspace = requireTaskWorkspaceLease(actor.userId, actor.workspaceId)
    if (visibility === 'shared' && workspace.kind === 'personal') throw new ActionFailureError('botShareUnavailable')
    await ownedBot(main, actor, id, true)
    const { rows: [current] } = await main.execute<{ visibility: string }>(sql`SELECT visibility FROM resource_access_policies
      WHERE kind='bot' AND id=${id}::uuid AND "workspaceId"=${actor.workspaceId}::uuid FOR UPDATE`)
    if (!current) throw new ActionFailureError('botNotFound')
    await assertWorkVisibilityChange(main, actor, 'bot', current.visibility, visibility)
    await main.execute(sql`select set_config('mikka.acl_actor',${actor.userId},true),set_config('mikka.acl_source','owner_access_change',true)`)
    await main.execute(sql`update resource_access_policies set visibility=${visibility} where kind='bot' and id=${id}::uuid and visibility<>${visibility} and visibility<>'quarantined'`)
    await pruneSubscribers(main, actor.workspaceId, id)
    await botListChanged(main, id)
    return readAccess(main, actor.workspaceId, id)
  }
  return transaction ? write(transaction) : withTaskWorkspace(actor.userId, actor.workspaceId, () => db.transaction(write))
}

/**
 * The owner sets who follows the Bot (New Bot's 订阅者, the profile's Members).
 * Each must be an active member who can find the Bot; the owner is never listed.
 */
export async function setBotSubscribers(actor: BotActor, id: string, subscribers: string[]): Promise<BotAccessView> {
  const wanted = [...new Set(userIds.parse(subscribers))].filter(userId => userId !== actor.userId)
  const members = await activeMembers(actor.workspaceId, wanted)
  if (wanted.some(userId => !members.has(userId))) throw new ActionFailureError('workspaceAccessDenied')
  return db.transaction(async main => {
    await ownedBot(main, actor, id, true)
    for (const userId of wanted) if (!await canDiscover(main, userId, actor.workspaceId, id)) throw new ActionFailureError('botSubscriberNoAccess')
    await main.execute(sql`delete from bot_subscribers where "botId"=${id}::uuid and not ("userId"=any(${sql.param(wanted)}::text[]))`)
    for (const userId of wanted) await main.execute(sql`insert into bot_subscribers("botId","userId") values(${id}::uuid,${userId}) on conflict do nothing`)
    await botListChanged(main, id)
    return readAccess(main, actor.workspaceId, id)
  })
}

/** A member follows (or stops following) a Bot they can find. Following one's own Bot changes nothing. */
export async function followBot(actor: BotActor, id: string, follow: boolean): Promise<{ subscribed: boolean }> {
  if (!botId.safeParse(id).success) throw new ActionFailureError('botNotFound')
  if (!(await activeMembers(actor.workspaceId, [actor.userId])).has(actor.userId)) throw new ActionFailureError('botNotFound')
  return db.transaction(async main => {
    const { rows: [bot] } = await main.execute<{ ownerId: string | null }>(sql`select "ownerId" from bots where id=${id}::uuid and "workspaceId"=${actor.workspaceId}::uuid and "archivedAt" is null for share`)
    if (!bot || !await canDiscover(main, actor.userId, actor.workspaceId, id)) throw new ActionFailureError('botNotFound')
    if (bot.ownerId === actor.userId) return { subscribed: true }
    if (follow) await main.execute(sql`insert into bot_subscribers("botId","userId") values(${id}::uuid,${actor.userId}) on conflict do nothing`)
    else await main.execute(sql`delete from bot_subscribers where "botId"=${id}::uuid and "userId"=${actor.userId}`)
    await botListChanged(main, id)
    return { subscribed: follow }
  })
}

/**
 * The owner hands the Bot to another active member (Capy's Transfer ownership).
 * Same path as an admin's takeover (lib/workspace-admin/members.ts transferBots):
 * the Bot then runs on its new owner's resources and its unfinished runs stop.
 */
export async function transferBotOwnership(actor: BotActor, id: string, toUserId: string) {
  z.string().min(1).max(128).parse(toUserId)
  if (toUserId === actor.userId) throw new ActionFailureError('validationGeneric')
  const { transferBots } = await import('@/lib/workspace-admin/members')
  const { enqueueWorkspaceAudit } = await import('@/lib/audit/delivery')
  const result = await workspaceDb.transaction(async tx => {
    const { membership } = await requireWorkspace(tx, actor.workspaceId, actor.userId)
    const [target] = await tx.select({ id: workspaceMembers.userId }).from(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, actor.workspaceId), eq(workspaceMembers.userId, toUserId), eq(workspaceMembers.status, 'active'))).limit(1)
    if (!target) throw new ActionFailureError('workspaceAccessDenied')
    return db.transaction(async main => {
      const bot = await ownedBot(main, actor, id, true)
      await enqueueWorkspaceAudit(tx, { workspaceId: actor.workspaceId, actor: { type: 'user', id: actor.userId, name: membership.name }, action: 'bot.transferred', target: { type: 'bot', id, label: bot.name } })
      const moved = await transferBots(main, actor.workspaceId, actor.userId, toUserId, [id], tx)
      if (!moved.bots) throw new ActionFailureError('botNotFound')
      await pruneSubscribers(main, actor.workspaceId, id)
      return { id, ownerId: toUserId }
    })
  })
  await (await import('@/lib/run-authority-stop')).stopRunsWithoutAuthority({ botId: id })
  return result
}

/** Whether Bots here can be shared: a team workspace, not a personal one. */
export async function botsShareable(workspaceId: string): Promise<boolean> {
  const [workspace] = await workspaceDb.select({ kind: workspaces.kind }).from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1)
  return workspace?.kind === 'team'
}

/** Bots the person follows here (their sidebar's 订阅的 Bot), newest first. */
export async function followedBots(actor: BotActor) {
  return db.select({ id: bots.id, name: bots.name, color: bots.color, shape: bots.shape, ownerId: bots.ownerId }).from(bots)
    .innerJoin(botSubscribers, and(eq(botSubscribers.botId, bots.id), eq(botSubscribers.userId, actor.userId)))
    .where(and(eq(bots.workspaceId, actor.workspaceId), isNull(bots.archivedAt)))
    .orderBy(desc(botSubscribers.createdAt))
}
