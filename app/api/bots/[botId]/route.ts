import { z } from 'zod'
import { and, eq } from 'drizzle-orm'
import { db, pool, withDatabaseTransaction } from '@/lib/db'
import { bots } from '@/lib/db/schema'
import { updateOwnedBot } from '@/lib/bot-update'
import { ActionFailureError } from '@/lib/action-error'
import { BOT_DEFAULT_AGENTS, botRunsOnSchema } from '@/lib/bot-settings'
import { taskDestinationSchema } from '@/lib/task-destination'
import { MODEL_ROUTING_EFFORTS } from '@/lib/model-routing'
import { botBody, botRoute } from '@/lib/bot-route'
import { withTaskWorkspace } from '@/lib/task-workspace'

const patch = z.object({
  name: z.string().optional(), color: z.string().optional(), shape: z.string().optional(), publicRole: z.string().max(2000).optional(),
  alias: z.string().max(64).nullable().optional(), environmentId: z.string().nullable().optional(), crewTarget: taskDestinationSchema.nullable().optional(),
  defaultAgent: z.enum(BOT_DEFAULT_AGENTS).nullable().optional(), defaultProfileId: z.string().nullable().optional(), runsOn: botRunsOnSchema.nullable().optional(),
  effort: z.enum(MODEL_ROUTING_EFFORTS).nullable().optional(),
  visibility: z.enum(['shared', 'private']).optional(), subscribers: z.array(z.string().min(1).max(128)).max(200).optional(),
}).strict()

/** The owner's Bot: its look and Captain settings (GET), or a change to them (PATCH). */
async function handle(request: Request, { params }: { params: Promise<{ botId: string }> }) {
  return botRoute(request, params, async ({ userId, workspaceId, botId }) => {
    const owner = { ownerId: userId, workspaceId }
    const store = await import('@/lib/bot-settings-store')
    const access = await import('@/lib/bot-access')
    const actor = { userId, workspaceId }
    if (request.method === 'PATCH') {
      const { effort, visibility, subscribers, ...fields } = await botBody(request, patch)
      if (!Object.keys(fields).length && effort === undefined && !visibility && !subscribers) throw new ActionFailureError('validationGeneric')
      // One change, one transaction: a refused part leaves the Bot as it was.
      await withTaskWorkspace(userId, workspaceId, () => db.transaction(tx => withDatabaseTransaction(tx, async () => {
        if (Object.keys(fields).length) await updateOwnedBot(owner, { botId, ...fields })
        if (effort !== undefined) await store.setBotModelEffort(owner, botId, effort)
        if (visibility) await access.setBotVisibility(actor, botId, visibility, tx)
        if (subscribers) await access.setBotSubscribers(actor, botId, subscribers)
      })))
    }
    const [bot] = await db.select({ id: bots.id, name: bots.name, color: bots.color, shape: bots.shape, publicRole: bots.publicRole }).from(bots)
      .where(and(eq(bots.id, botId), eq(bots.ownerId, userId), eq(bots.workspaceId, workspaceId))).limit(1)
    const settings = bot ? await store.readOwnedBotSettings(pool, owner, botId) : null
    if (!bot || !settings) throw new ActionFailureError('botNotFound')
    return { ...bot, ...settings, ...(await access.botAccess(actor, botId)) }
  })
}
export const GET = handle
export const PATCH = handle
