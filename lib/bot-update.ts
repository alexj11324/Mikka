import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { ActionFailureError } from '@/lib/action-error'
import { BOT_COLORS, BOT_NAME_MAX, BOT_SHAPES } from '@/lib/bot-shapes'
import type { BotSettingsInput } from '@/lib/bot-settings'
import { aliasConflict, assertBotSettings, botSettingsColumns, parseBotSettings } from '@/lib/bot-settings-store'
import { db, pool } from '@/lib/db'
import { bots } from '@/lib/db/schema'
import { botListChanged } from './live/lists'

const patchSchema = z.object({
  botId: z.uuid(),
  name: z.string().trim().min(1).max(BOT_NAME_MAX).optional(),
  color: z.enum(BOT_COLORS).optional(),
  shape: z.enum(BOT_SHAPES).optional(),
  publicRole: z.string().trim().max(2000).optional(),
})

export interface UpdateBotInput extends BotSettingsInput { botId: string; name?: string; color?: string; shape?: string; publicRole?: string }

const returned = { id: bots.id, name: bots.name, color: bots.color, shape: bots.shape, publicRole: bots.publicRole }

/**
 * Renames a bot, changes its look, or its Captain settings (Bot Profile:
 * Alias, Description, Environment, Tasks run on, Default agent). Only its
 * owner, in the workspace it was made in, may change it; any other bot reads
 * as not found. Each setting's reference is checked against the owner.
 */
export async function updateOwnedBot(owner: { ownerId: string; workspaceId: string }, input: UpdateBotInput) {
  const { botId: id, name, color, shape, publicRole, ...rest } = input
  const parsed = patchSchema.safeParse({ botId: id, name, color, shape, publicRole })
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    if (issue?.path[0] === 'botId') throw new ActionFailureError('botNotFound')
    if (issue?.path[0] === 'name') throw new ActionFailureError(issue.code === 'too_big' ? 'botNameTooLong' : 'validationNameRequired')
    throw new ActionFailureError('validationGeneric')
  }
  const { botId, ...look } = parsed.data
  const patch = Object.fromEntries(Object.entries(look).filter(([, value]) => value !== undefined))
  const settings = botSettingsColumns(parseBotSettings(rest))
  if (!Object.keys(patch).length && !Object.keys(settings).length) throw new ActionFailureError('validationGeneric')
  if (Object.keys(settings).length) {
    // Not found before the settings' own refusals: another person's Bot reveals nothing.
    const [mine] = await db.select({ id: bots.id }).from(bots).where(and(eq(bots.id, botId), eq(bots.ownerId, owner.ownerId), eq(bots.workspaceId, owner.workspaceId))).limit(1)
    if (!mine) throw new ActionFailureError('botNotFound')
    await assertBotSettings(pool, owner, settings)
  }
  let row: { id: string; name: string; color: string; shape: string; publicRole: string } | undefined
  try {
    [row] = await db.update(bots).set({ ...patch, ...settings, updatedAt: new Date() })
      .where(and(eq(bots.id, botId), eq(bots.ownerId, owner.ownerId), eq(bots.workspaceId, owner.workspaceId)))
      .returning(returned)
  } catch (error) {
    if (aliasConflict(error)) throw new ActionFailureError('botAliasTaken', undefined, undefined, { cause: error })
    // 23505 is the per-person, per-workspace name index.
    if ((error as { code?: string }).code === '23505' || (error as { cause?: { code?: string } }).cause?.code === '23505') throw new ActionFailureError('botDuplicateName', undefined, undefined, { cause: error })
    throw error
  }
  if (!row) throw new ActionFailureError('botNotFound')
  await botListChanged(db, botId)
  return row
}
