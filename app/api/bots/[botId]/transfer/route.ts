import { z } from 'zod'
import { botBody, botRoute } from '@/lib/bot-route'

/** The owner hands the Bot to another active member of the workspace. */
export async function POST(request: Request, { params }: { params: Promise<{ botId: string }> }) {
  return botRoute(request, params, async ({ userId, workspaceId, botId }) => {
    const { ownerId } = await botBody(request, z.object({ ownerId: z.string().min(1).max(128) }).strict())
    return (await import('@/lib/bot-access')).transferBotOwnership({ userId, workspaceId }, botId, ownerId)
  })
}
