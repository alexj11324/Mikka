import { botRoute } from '@/lib/bot-route'

/** Follow (PUT) or stop following (DELETE) a Bot the person can find. */
async function handle(request: Request, { params }: { params: Promise<{ botId: string }> }) {
  return botRoute(request, params, async ({ userId, workspaceId, botId }) =>
    (await import('@/lib/bot-access')).followBot({ userId, workspaceId }, botId, request.method === 'PUT'))
}
export const PUT = handle
export const DELETE = handle
