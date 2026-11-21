'use server'

import { headers } from '@/lib/server-runtime/headers'
import { listOwnerBots } from '@/lib/coordinator/coordinator-bot'
import { ActionFailureError } from '@/lib/action-error'
import type { ActionResult } from '@/lib/action-result'
import { auth } from '@/lib/auth'
import { loadWorkspaceContext } from '@/lib/workspace-access'
import { workspaceAction } from '@/lib/workspace-admin/action'
import { updateOwnedBot, type UpdateBotInput } from '@/lib/bot-update'
import { createOwnedBot, type CreateBotInput } from '@/lib/bot-create'
import { pool } from '@/lib/db'
import { deleteOwnedBot, ownArchivedBots, setOwnedBotArchived } from '@/lib/bot-lifecycle'
import { settingsWorkspaceAction, type SettingsActionResult } from '@/lib/workspace-admin/settings-action'
import { currentWorkspaceActor } from '@/lib/workspace-admin/current'
import { withTaskWorkspace } from '@/lib/task-workspace'
import { botDefaultOptions, listBotThreadsFor, saveBotDefaults, workspaceBots, type BotDefaultOptions, type BotDefaults, type BotThreadPage, type WorkspaceBotView } from '@/lib/workspace-admin/bots'

/** A bot in the left column. Its instructions grow inside its chat, so they are not here. */
export interface BotView {
  id: string
  name: string
  color: string
  shape: string
  /** The person's Coordinator (coordinator_bots): the left column draws it as the Coordinator, pinned on top. */
  coordinator?: boolean
  /** The Environment it works in; its row menu's Move to marks it. */
  environmentId?: string | null
  /** Who can find it; its row menu's Share marks it. */
  visibility?: 'shared' | 'private'
}

/** A teammate's Bot the person follows (bot_subscribers): listed apart, it opens its threads, not a chat. */
export interface FollowedBotView { id: string; name: string; color: string; shape: string; ownerId: string | null }


/** The person and the workspace they are in: a bot belongs to both. */
async function getOwner(workspaceId?: string) {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) throw new ActionFailureError('authRequired')
  const context = await loadWorkspaceContext(workspaceId, session.user)
  return { ownerId: session.user.id, workspaceId: context.workspace.id }
}

/** The bot list: the person's bots here, their Coordinator first (lib/coordinator/coordinator-bot.ts listOwnerBots). */
export async function listBots(): Promise<BotView[]> {
  return (await pollBots()).items
}

/** The Bot list for the workspace a settings page shows (`?workspace=`), not the session's active one. */
export async function listBotsForWorkspace(workspaceId: string): Promise<BotView[]> {
  const { ownerId, workspaceId: shown } = await getOwner(workspaceId)
  return listOwnerBots(ownerId, shown)
}

/** The list cache is bound to this actual authorized Owner/workspace read. */
export async function pollBots(workspaceId?: string) {
  const owner = await getOwner(workspaceId)
  const { followedBots, botsShareable } = await import('@/lib/bot-access')
  const [items, followed, shareable] = await Promise.all([listOwnerBots(owner.ownerId, owner.workspaceId), followedBots({ userId: owner.ownerId, workspaceId: owner.workspaceId }), botsShareable(owner.workspaceId)])
  // `shareable`: a team workspace, where a Bot's row menu offers Share (a personal one has no one to share with).
  return { items, followed: followed as FollowedBotView[], shareable, live: owner }
}

/**
 * 新建 Bot: a name, a colour and a shape. Bots run on Mikka's own harness, so there is no machine to pick.
 * `model` and `repository` default to the workspace's 新 Bot 默认值 when omitted.
 */
export async function createBot(input: CreateBotInput, workspaceId?: string): Promise<BotView> {
  return createOwnedBot(await getOwner(workspaceId), input)
}

/**
 * Rename a bot or change its shape and colour, from the right panel. Same rules
 * as createBot. The Coordinator keeps its name and look (the left column draws it).
 */
export async function updateBot(input: UpdateBotInput, workspaceId?: string): Promise<ActionResult<BotView>> {
  return workspaceAction(async () => updateOwnedBot(await getOwner(workspaceId), input))
}

/** Bot Profile: Alias, Environment, Tasks run on, Default agent and profile, where the Bot runs, its effort. Its owner only. */
export async function getBotSettings(botId: string, workspaceId?: string): Promise<ActionResult<import('@/lib/bot-settings-store').OwnedBotSettings>> {
  return workspaceAction(async () => {
    const settings = await (await import('@/lib/bot-settings-store')).readOwnedBotSettings(pool, await getOwner(workspaceId), botId)
    if (!settings) throw new ActionFailureError('botNotFound')
    return settings
  })
}

/** The Environments a Bot can work in here, the workspace default first. */
export async function listBotEnvironments(workspaceId?: string): Promise<ActionResult<{ environments: import('@/lib/bot-environment').BotEnvironmentOption[]; shareable: boolean }>> {
  return workspaceAction(async () => {
    const shown = (await getOwner(workspaceId)).workspaceId
    const [{ botEnvironmentOptions }, { botsShareable }] = await Promise.all([import('@/lib/bot-environment'), import('@/lib/bot-access')])
    // `shareable`: a team workspace, where a Bot's Access can be shared.
    const [environments, shareable] = await Promise.all([botEnvironmentOptions(shown), botsShareable(shown)])
    return { environments, shareable }
  })
}

/** The reasoning effort of the Bot's chat model; null is the model's default. */
export async function setBotEffort(botId: string, effort: string | null, workspaceId?: string): Promise<ActionResult<{ id: string; effort: string | null }>> {
  return workspaceAction(async () => {
    await (await import('@/lib/bot-settings-store')).setBotModelEffort(await getOwner(workspaceId), botId, effort)
    return { id: botId, effort }
  })
}

const actorOf = async (workspaceId?: string) => { const owner = await getOwner(workspaceId); return { userId: owner.ownerId, workspaceId: owner.workspaceId } }

/** Who can find the Bot and who follows it. */
export async function getBotAccess(botId: string, workspaceId?: string): Promise<ActionResult<import('@/lib/bot-access').BotAccessView>> {
  return workspaceAction(async () => (await import('@/lib/bot-access')).botAccess(await actorOf(workspaceId), botId))
}

/** Share: the owner makes the Bot shared with the workspace or private, and sets its followers. */
export async function setBotAccess(botId: string, input: { visibility?: 'shared' | 'private'; subscribers?: string[] }, workspaceId?: string): Promise<ActionResult<import('@/lib/bot-access').BotAccessView>> {
  return workspaceAction(async () => {
    const access = await import('@/lib/bot-access')
    const actor = await actorOf(workspaceId)
    const { db, withDatabaseTransaction } = await import('@/lib/db')
    // Access and followers change together or not at all.
    return withTaskWorkspace(actor.userId, actor.workspaceId, () => db.transaction(tx => withDatabaseTransaction(tx, async () => {
      let view = input.visibility ? await access.setBotVisibility(actor, botId, input.visibility, tx) : await access.botAccess(actor, botId)
      if (input.subscribers) view = await access.setBotSubscribers(actor, botId, input.subscribers)
      return view
    })))
  })
}

/** Follow or stop following a Bot one can find. */
export async function followBot(botId: string, follow: boolean, workspaceId?: string): Promise<ActionResult<{ subscribed: boolean }>> {
  return workspaceAction(async () => (await import('@/lib/bot-access')).followBot(await actorOf(workspaceId), botId, follow))
}

/** Transfer ownership to another active member; the Bot's unfinished runs stop. */
export async function transferBot(botId: string, toUserId: string, workspaceId?: string): Promise<ActionResult<{ id: string; ownerId: string }>> {
  return workspaceAction(async () => (await import('@/lib/bot-access')).transferBotOwnership(await actorOf(workspaceId), botId, toUserId))
}

/** 归档 / 取消归档 one of the person's own bots (not the Coordinator), from its sidebar row (lib/bot-lifecycle.ts). */
export async function archiveBot(botId: string, archived: boolean, workspaceId?: string): Promise<ActionResult<{ id: string; archived: boolean }>> {
  return workspaceAction(async () => setOwnedBotArchived(await getOwner(workspaceId), botId, archived))
}

/** 删除 one of the person's own bots (not the Coordinator): its chat goes; the tasks and runs it dispatched stay. */
export async function deleteBot(botId: string, workspaceId?: string): Promise<ActionResult<{ id: string; deleted: true }>> {
  return workspaceAction(async () => deleteOwnedBot(await getOwner(workspaceId), botId))
}

/** The person's own archived bots here: the sidebar's 已归档 list. */
export async function listArchivedOwnBots(workspaceId?: string): Promise<ActionResult<{ bots: { id: string; name: string; color: string; shape: string }[] }>> {
  return workspaceAction(async () => ({ bots: await ownArchivedBots(await getOwner(workspaceId)) }))
}

/** 设置 › 工作区 › Bot: the defaults a new bot starts with, and the choices. Any member may read. */
export async function getWorkspaceBotDefaults(workspaceId?: string): Promise<ActionResult<BotDefaultOptions>> {
  return workspaceAction(async () => botDefaultOptions((await currentWorkspaceActor(workspaceId)).workspaceId))
}

/** Set or clear (null) the default model and repository for new bots. Admins only. */
export async function updateWorkspaceBotDefaults(input: { defaultModel?: string | null; defaultRepository?: string | null }): Promise<ActionResult<BotDefaults>> {
  return workspaceAction(async () => {
    const actor = await currentWorkspaceActor()
    return saveBotDefaults(actor.userId, actor.workspaceId, input as Parameters<typeof saveBotDefaults>[2])
  })
}

/** Every bot in the current workspace: owner, 空闲 or 运行中 · N 个线程. Any member may read. */
export async function listWorkspaceBots(workspaceId?: string): Promise<ActionResult<{ bots: WorkspaceBotView[] }>> {
  return workspaceAction(async () => ({ bots: await workspaceBots((await currentWorkspaceActor(workspaceId)).workspaceId) }))
}

/**
 * WS-07 线程列表 for one bot in the current workspace, newest first. Any member may read;
 * titles of tasks the viewer cannot see, and chat threads someone else started, come back null.
 */
export async function listBotThreads(input: { botId: string; limit?: number; cursor?: string | null }): Promise<SettingsActionResult<BotThreadPage>> {
  return settingsWorkspaceAction(async () => {
    const actor = await currentWorkspaceActor()
    return listBotThreadsFor(actor.userId, actor.workspaceId, input)
  })
}
