'use server'

import { headers } from 'next/headers'
import { and, asc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { ActionFailureError } from '@/lib/action-error'
import type { ActionResult } from '@/lib/action-result'
import { auth } from '@/lib/auth'
import { loadWorkspaceContext } from '@/lib/workspace-access'
import { db } from '@/lib/db'
import { bots, WORKSPACE_BOT_MODELS } from '@/lib/db/schema'
import { BOT_COLORS, BOT_SHAPES } from '@/lib/bot-shapes'
import { workspaceAction } from '@/lib/workspace-admin/action'
import { currentWorkspaceActor } from '@/lib/workspace-admin/current'
import { botDefaultOptions, listBotThreadsFor, repositoryAvailable, saveBotDefaults, workspaceBotDefaults, workspaceBots, type BotDefaultOptions, type BotDefaults, type BotThreadPage, type WorkspaceBotView } from '@/lib/workspace-admin/bots'

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
  const owner = await getOwner()
  const parsed = z.object({
    name: z.string().trim().min(1).max(60), color: z.enum(BOT_COLORS), shape: z.enum(BOT_SHAPES),
    model: z.enum(WORKSPACE_BOT_MODELS).nullable().optional(), repository: z.string().trim().min(1).max(300).nullable().optional(),
  }).safeParse(input)
  if (!parsed.success) throw new ActionFailureError(parsed.error.issues[0]?.path[0] === 'name' ? 'validationNameRequired' : 'validationGeneric')
  const { model, repository, ...look } = parsed.data
  // A bot works only in a repository the workspace has installed; never trust the client's choice.
  if (repository && !(await repositoryAvailable(owner.workspaceId, repository))) throw new ActionFailureError('botDefaultRepositoryUnavailable')
  const defaults = model === undefined || repository === undefined ? await workspaceBotDefaults(owner.workspaceId) : null
  const bot = { id: crypto.randomUUID(), ...look }
  try {
    await db.insert(bots).values({ ...bot, ...owner, model: model === undefined ? defaults!.defaultModel : model, repository: repository === undefined ? defaults!.defaultRepository : repository })
  } catch (error) {
    // 23505 is the per-person, per-workspace name index.
    if ((error as { code?: string }).code === '23505') throw new ActionFailureError('botDuplicateName')
    throw new ActionFailureError('validationGeneric')
  }
  return bot
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
export async function listBotThreads(input: { botId: string; limit?: number; cursor?: string | null }): Promise<ActionResult<BotThreadPage>> {
  return workspaceAction(async () => {
    const actor = await currentWorkspaceActor()
    return listBotThreadsFor(actor.userId, actor.workspaceId, input)
  })
}
