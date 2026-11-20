import 'server-only'
import { z } from 'zod'
import { ActionFailureError } from '@/lib/action-error'
import { db, pool, withDatabaseTransaction } from '@/lib/db'
import { bots, WORKSPACE_BOT_MODELS } from '@/lib/db/schema'
import { BOT_COLORS, BOT_SHAPES } from '@/lib/bot-shapes'
import { defaultBotEnvironment } from '@/lib/bot-environment'
import type { BotSettingsInput } from '@/lib/bot-settings'
import { aliasConflict, assertBotSettings, botSettingsColumns, parseBotSettings } from '@/lib/bot-settings-store'
import { repositoryAvailable, workspaceBotDefaults } from '@/lib/workspace-admin/bots'
import { botListChanged } from './live/lists'
import { withTaskWorkspace } from './task-workspace'
import { initializeWorkVisibility, readWorkCreationPolicy, workCreationVisibility } from './settings/work-creation'

export interface CreateBotInput extends BotSettingsInput {
  name: string
  color: string
  shape: string
  model?: string | null
  /** An older client's 仓库 choice: the Bot binds the Environment that lists it. Never stored on the Bot. */
  repository?: string | null
  /** Omitted uses the owner's workspace-scoped default and creation policy. */
  visibility?: 'shared' | 'private'
  /** Members who follow the Bot from the start. */
  subscribers?: string[]
}

/**
 * 新建 Bot, for the web's action and the iOS app's route: a name, a colour and
 * a shape, and Captain's settings (decision 2026-11-19-2105): the Environment
 * it works in, where it and its tasks run, its default Agent and profile, its
 * alias, access and followers. `model` defaults to the workspace's 新 Bot 默认值;
 * without an Environment the Bot binds the one listing the workspace's default
 * repository, else the workspace default Environment, made now when there is
 * none. The Bot row, its access and its followers are one transaction.
 */
export async function createOwnedBot(owner: { ownerId: string; workspaceId: string }, input: CreateBotInput) {
  const { name, color, shape, model: requestedModel, repository: requestedRepository, visibility, subscribers, ...rest } = input
  const parsed = z.object({
    name: z.string().trim().min(1).max(60), color: z.enum(BOT_COLORS), shape: z.enum(BOT_SHAPES),
    model: z.enum(WORKSPACE_BOT_MODELS).nullable().optional(), repository: z.string().trim().min(1).max(300).nullable().optional(),
    visibility: z.enum(['shared', 'private']).optional(),
  }).safeParse({ name, color, shape, model: requestedModel, repository: requestedRepository, visibility })
  if (!parsed.success) throw new ActionFailureError(parsed.error.issues[0]?.path[0] === 'name' ? 'validationNameRequired' : 'validationGeneric')
  const { model, repository, visibility: access, ...look } = parsed.data
  const settings = parseBotSettings(rest)
  // A bot works only in a repository the workspace has installed; never trust the client's choice.
  if (repository && !(await repositoryAvailable(owner.workspaceId, repository))) throw new ActionFailureError('botDefaultRepositoryUnavailable')
  await assertBotSettings(pool, owner, settings)
  const actor = { userId: owner.ownerId, workspaceId: owner.workspaceId }
  const access_ = await import('@/lib/bot-access')
  const defaults = model === undefined || (!settings.environmentId && repository === undefined) ? await workspaceBotDefaults(owner.workspaceId) : null
  // Every new Bot has an Environment: the one picked, else the default (made now in a workspace with none).
  const environmentId = settings.environmentId
    ?? await defaultBotEnvironment(owner.ownerId, owner.workspaceId, repository === undefined ? defaults!.defaultRepository : repository)
  const bot = { id: crypto.randomUUID(), ...look }
  // The Bot, its access and its followers commit together or not at all.
  await withTaskWorkspace(owner.ownerId, owner.workspaceId, () => db.transaction(tx => withDatabaseTransaction(tx, async () => {
    const visibility = workCreationVisibility(await readWorkCreationPolicy(tx, actor), access)
    // Refuse policy or follower input before the row exists; the WS lease is
    // held until this Bot and its existing ACL trigger commit together.
    await access_.assertBotAccessInput(actor, visibility, subscribers ?? [])
    try {
      await db.insert(bots).values({ ...bot, ...owner, ...botSettingsColumns(settings), environmentId, model: model === undefined ? defaults!.defaultModel : model })
    } catch (error) {
      if (aliasConflict(error)) throw new ActionFailureError('botAliasTaken', undefined, undefined, { cause: error })
      // 23505 is the per-person, per-workspace name index.
      const failure = error as { code?: string; cause?: { code?: string } }
      if (failure.code === '23505' || failure.cause?.code === '23505') throw new ActionFailureError('botDuplicateName', undefined, undefined, { cause: error })
      throw new ActionFailureError('validationGeneric', undefined, undefined, { cause: error })
    }
    await initializeWorkVisibility(tx, actor, { kind: 'bot', id: bot.id, visibility: access })
    await botListChanged(db, bot.id)
    // Access and followers need the Bot's policy row, which its insert registered.
    if (subscribers?.length) await access_.setBotSubscribers(actor, bot.id, subscribers)
  })))
  return bot
}
