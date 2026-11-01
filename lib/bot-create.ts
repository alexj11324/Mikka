import 'server-only'
import { z } from 'zod'
import { ActionFailureError } from '@/lib/action-error'
import { db } from '@/lib/db'
import { bots, WORKSPACE_BOT_MODELS } from '@/lib/db/schema'
import { BOT_COLORS, BOT_SHAPES } from '@/lib/bot-shapes'
import { repositoryAvailable, workspaceBotDefaults } from '@/lib/workspace-admin/bots'

/**
 * 新建 Bot, for the web's action and the iOS app's route: a name, a colour and
 * a shape. Bots run on Mikka's own harness, so there is no machine to pick.
 * `model` and `repository` default to the workspace's 新 Bot 默认值 when omitted.
 */
export async function createOwnedBot(owner: { ownerId: string; workspaceId: string }, input: { name: string; color: string; shape: string; model?: string | null; repository?: string | null }) {
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
