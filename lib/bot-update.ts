import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { ActionFailureError } from '@/lib/action-error'
import { BOT_COLORS, BOT_NAME_MAX, BOT_SHAPES } from '@/lib/bot-shapes'
import { db } from '@/lib/db'
import { bots } from '@/lib/db/schema'

const patchSchema = z.object({
  botId: z.uuid(),
  name: z.string().trim().min(1).max(BOT_NAME_MAX).optional(),
  color: z.enum(BOT_COLORS).optional(),
  shape: z.enum(BOT_SHAPES).optional(),
})

/**
 * Renames a bot or changes its look. Only its owner, in the workspace it was
 * made in, may change it; any other bot reads as not found.
 */
export async function updateOwnedBot(owner: { ownerId: string; workspaceId: string }, input: { botId: string; name?: string; color?: string; shape?: string }) {
  const parsed = patchSchema.safeParse(input)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    if (issue?.path[0] === 'botId') throw new ActionFailureError('botNotFound')
    if (issue?.path[0] === 'name') throw new ActionFailureError(issue.code === 'too_big' ? 'botNameTooLong' : 'validationNameRequired')
    throw new ActionFailureError('validationGeneric')
  }
  const { botId, ...patch } = parsed.data
  if (patch.name === undefined && patch.color === undefined && patch.shape === undefined) throw new ActionFailureError('validationGeneric')
  let row: { id: string; name: string; color: string; shape: string } | undefined
  try {
    [row] = await db.update(bots).set({ ...patch, updatedAt: new Date() })
      .where(and(eq(bots.id, botId), eq(bots.ownerId, owner.ownerId), eq(bots.workspaceId, owner.workspaceId)))
      .returning({ id: bots.id, name: bots.name, color: bots.color, shape: bots.shape })
  } catch (error) {
    // 23505 is the per-person, per-workspace name index.
    if ((error as { code?: string }).code === '23505' || (error as { cause?: { code?: string } }).cause?.code === '23505') throw new ActionFailureError('botDuplicateName')
    throw error
  }
  if (!row) throw new ActionFailureError('botNotFound')
  return row
}
