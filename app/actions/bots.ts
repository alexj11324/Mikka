'use server'

import { headers } from 'next/headers'
import { and, asc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { ActionFailureError } from '@/lib/action-error'
import type { ActionFailure, ActionResult } from '@/lib/action-result'
import { auth } from '@/lib/auth'
import { loadWorkspaceContext } from '@/lib/workspace-access'
import { db } from '@/lib/db'
import { bots, WORKSPACE_BOT_MODELS } from '@/lib/db/schema'
import { BOT_COLORS, BOT_SHAPES } from '@/lib/bot-shapes'
import { workspaceAction } from '@/lib/workspace-admin/action'
import { currentWorkspaceActor } from '@/lib/workspace-admin/current'
import { botSettingsFor, listBotThreadsFor, modelAllowed, modelPolicy, newBotModel, repositoryAvailable, saveBotSettings, saveModelPolicy, workspaceBots, type BotSettingsView, type BotThreadPage, type ModelPolicy, type WorkspaceBotView } from '@/lib/workspace-admin/bots'

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
 * `model` starts as the workspace's starting model (or the first of 可用模型) and `repository` as none;
 * the owner changes both in the bot's own settings. Explicit values must be allowed and installed.
 */
export async function createBot(input: { name: string; color: string; shape: string; model?: string | null; repository?: string | null }): Promise<BotView> {
  const owner = await getOwner()
  const parsed = z.object({
    name: z.string().trim().min(1).max(60), color: z.enum(BOT_COLORS), shape: z.enum(BOT_SHAPES),
    model: z.enum(WORKSPACE_BOT_MODELS).nullable().optional(), repository: z.string().trim().min(1).max(300).nullable().optional(),
  }).safeParse(input)
  if (!parsed.success) throw new ActionFailureError(parsed.error.issues[0]?.path[0] === 'name' ? 'validationNameRequired' : 'validationGeneric')
  const { model, repository, ...look } = parsed.data
  // Never trust the client's choice: a model must be in 可用模型, a repository installed for the workspace.
  if (model && !(await modelAllowed(owner.workspaceId, model))) throw new ActionFailureError('botModelNotAllowed')
  if (repository && !(await repositoryAvailable(owner.workspaceId, repository))) throw new ActionFailureError('botRepositoryUnavailable')
  const bot = { id: crypto.randomUUID(), ...look }
  try {
    await db.insert(bots).values({ ...bot, ...owner, model: model === undefined ? await newBotModel(owner.workspaceId) : model, repository: repository ?? null })
  } catch (error) {
    // 23505 is the per-person, per-workspace name index.
    if ((error as { code?: string }).code === '23505') throw new ActionFailureError('botDuplicateName')
    throw new ActionFailureError('validationGeneric')
  }
  return bot
}

/** 设置 › 工作区 › Bot › 可用模型 and the starting model. Any member may read; their bots' menus come from it. */
export async function getWorkspaceModelPolicy(): Promise<ActionResult<ModelPolicy>> {
  return workspaceAction(async () => modelPolicy((await currentWorkspaceActor()).workspaceId))
}

/** 409: expectedVersion was stale. `current` is the stored policy to re-base on. */
export type ModelPolicyConflict = ActionFailure & { error: 'modelPolicyConflict'; status: 409; current: ModelPolicy }

/**
 * Admins only: which model families members' bots may use, and the model a new bot starts with.
 * Pass expectedVersion (from getWorkspaceModelPolicy or the last save) to make the save a
 * compare-and-set; a stale version returns ModelPolicyConflict and writes nothing.
 */
export async function updateWorkspaceModelPolicy(input: { allowedModels: string[]; startingModel: string | null; expectedVersion?: number }): Promise<ActionResult<ModelPolicy> | ModelPolicyConflict> {
  let conflict: ModelPolicy | null = null
  const result = await workspaceAction(async () => {
    const actor = await currentWorkspaceActor()
    try {
      return await saveModelPolicy(actor.userId, actor.workspaceId, input as Parameters<typeof saveModelPolicy>[2])
    } catch (error) {
      const current = (error as { code?: string; current?: ModelPolicy }).code === 'modelPolicyConflict' ? (error as { current?: ModelPolicy }).current : undefined
      if (current) conflict = current
      throw error
    }
  })
  return conflict ? { error: 'modelPolicyConflict', status: 409, current: conflict } : result
}

/** A bot's own model and repository, with the choices the workspace allows. Any member may read; `canEdit` only for the owner. */
export async function getBotSettings(input: { botId: string }): Promise<ActionResult<BotSettingsView>> {
  return workspaceAction(async () => {
    const actor = await currentWorkspaceActor()
    return botSettingsFor(actor.userId, actor.workspaceId, input.botId)
  })
}

/** The bot's owner only. Omitted fields stay; null clears. The model must be allowed, the repository installed. */
export async function updateBotSettings(input: { botId: string; model?: string | null; repository?: string | null }): Promise<ActionResult<BotSettingsView>> {
  return workspaceAction(async () => {
    const actor = await currentWorkspaceActor()
    return saveBotSettings(actor.userId, actor.workspaceId, input as Parameters<typeof saveBotSettings>[2])
  })
}

/** Every bot in the current workspace: owner, 空闲 or 运行中 · N 个线程. Any member may read; nobody edits another person's bot here. */
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
