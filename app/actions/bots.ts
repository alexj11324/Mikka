'use server'

import { headers } from 'next/headers'
import { and, asc, eq } from 'drizzle-orm'
import { ActionFailureError } from '@/lib/action-error'
import type { ActionResult } from '@/lib/action-result'
import { auth } from '@/lib/auth'
import { loadWorkspaceContext } from '@/lib/workspace-access'
import { db } from '@/lib/db'
import { bots } from '@/lib/db/schema'
import { workspaceAction } from '@/lib/workspace-admin/action'
import { updateOwnedBot } from '@/lib/bot-update'
import { createOwnedBot } from '@/lib/bot-create'
import { settingsWorkspaceAction, type SettingsActionResult } from '@/lib/workspace-admin/settings-action'
import { currentWorkspaceActor } from '@/lib/workspace-admin/current'
import { botDefaultOptions, listBotThreadsFor, saveBotDefaults, workspaceBots, type BotDefaultOptions, type BotDefaults, type BotThreadPage, type WorkspaceBotView } from '@/lib/workspace-admin/bots'

/** A bot in the left column. Its instructions grow inside its chat, so they are not here. */
export interface BotView {
  id: string
  name: string
  color: string
  shape: string
}


/** The person and the workspace they are in: a bot belongs to both. */
async function getOwner() {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) throw new ActionFailureError('authRequired')
  const context = await loadWorkspaceContext(undefined, session.user)
  return { ownerId: session.user.id, workspaceId: context.workspace.id }
}

export async function listBots(): Promise<BotView[]> {
  const { ownerId, workspaceId } = await getOwner()
  return db.select({ id: bots.id, name: bots.name, color: bots.color, shape: bots.shape }).from(bots)
    .where(and(eq(bots.ownerId, ownerId), eq(bots.workspaceId, workspaceId))).orderBy(asc(bots.createdAt))
}

/**
 * 新建 Bot: a name, a colour and a shape. Bots run on Mikka's own harness, so there is no machine to pick.
 * `model` and `repository` default to the workspace's 新 Bot 默认值 when omitted.
 */
export async function createBot(input: { name: string; color: string; shape: string; model?: string | null; repository?: string | null }): Promise<BotView> {
  return createOwnedBot(await getOwner(), input)
}

/**
 * Rename a bot or change its shape and colour, from the right panel. Same rules
 * as createBot; the Coordinator is not a bot row, so it cannot be changed here.
 */
export async function updateBot(input: { botId: string; name?: string; color?: string; shape?: string }): Promise<ActionResult<BotView>> {
  return workspaceAction(async () => updateOwnedBot(await getOwner(), input))
}

/** 设置 › 工作区 › Bot: the defaults a new bot starts with, and the choices. Any member may read. */
export async function getWorkspaceBotDefaults(): Promise<ActionResult<BotDefaultOptions>> {
  return workspaceAction(async () => botDefaultOptions((await currentWorkspaceActor()).workspaceId))
}

/** Set or clear (null) the default model and repository for new bots. Admins only. */
export async function updateWorkspaceBotDefaults(input: { defaultModel?: string | null; defaultRepository?: string | null }): Promise<ActionResult<BotDefaults>> {
  return workspaceAction(async () => {
    const actor = await currentWorkspaceActor()
    return saveBotDefaults(actor.userId, actor.workspaceId, input as Parameters<typeof saveBotDefaults>[2])
  })
}

/** Every bot in the current workspace: owner, 空闲 or 运行中 · N 个线程. Any member may read. */
export async function listWorkspaceBots(): Promise<ActionResult<{ bots: WorkspaceBotView[] }>> {
  return workspaceAction(async () => ({ bots: await workspaceBots((await currentWorkspaceActor()).workspaceId) }))
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
