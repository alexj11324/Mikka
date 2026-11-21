import 'server-only'
import { and, eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { bots } from '@/lib/db/schema'
import { ActionFailureError } from '@/lib/action-error'
import { withTaskWorkspace } from '@/lib/task-workspace'
import { workspaceInstructions } from '@/lib/settings/schema'

/** Read each turn from the bot's actual workspace under current membership admission. */
export async function readWorkspaceInstructionsForBot(userId: string, botId: string): Promise<string> {
  const [bot] = await db.select({ workspaceId: bots.workspaceId }).from(bots)
    .where(and(eq(bots.id, botId), eq(bots.ownerId, userId))).limit(1)
  if (!bot) throw new ActionFailureError('botNotFound')
  return withTaskWorkspace(userId, bot.workspaceId, async () => {
    const [row] = await db.select({ instructions: workspaceInstructions.instructions }).from(workspaceInstructions)
      .where(eq(workspaceInstructions.workspaceId, bot.workspaceId)).limit(1)
    return row?.instructions ?? ''
  })
}
