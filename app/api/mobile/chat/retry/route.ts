import { afterJob } from '@/lib/background'
import { z } from 'zod'
import { pool } from '@/lib/db'
import { requestBotChat } from '@/lib/resource-access/request-chat'
import { botChatOwnerExclusive } from '@/lib/collaboration/bot-chat'
import { ActionFailureError } from '@/lib/action-error'
import { chatView, retryFailedTurn } from '@/lib/coordinator/store'
import { coordinatorEnabled, wakeCoordinator } from '@/lib/coordinator/wake'
import { withRequestLog, noteLogUser } from '@/lib/request-log'
import { forbiddenOrigin, json, mobileUser, unauthorized, writeAllowed } from '@/lib/mobile-api'

export const dynamic = 'force-dynamic'

/**
 * `POST /api/mobile/chat/retry` with `{ botId? }`: 重试 on a failed reply, the
 * same turn again, as the web's retryCoordinatorTurn. `queued` false when
 * nothing failed or a turn is already running.
 */
async function handlePOST(request: Request) {
  const user = await mobileUser(request)
  noteLogUser(user?.id)
  if (!user) return unauthorized()
  if (!writeAllowed(request)) return forbiddenOrigin()
  const parsed = z.object({ botId: z.uuid().nullable().optional() }).safeParse(await request.json().catch(() => ({})))
  if (!parsed.success) return json({ error: 'invalidBot' }, 400)
  const access = await requestBotChat(user, parsed.data.botId, 'canSteer')
  // A shared reply needs a new explicit Actor/model/budget receipt. A legacy
  // retry cannot silently re-use the Owner's personal connection or quota.
  if (access.ownerId !== user.id || !await botChatOwnerExclusive(pool, access.ownerId, access.id)) return json({ queued: false, reason: 'unavailable' })
  const resolved = access.id
  if (!await coordinatorEnabled(user.id, resolved)) return json({ queued: false, reason: 'unavailable' })
  const queued = await retryFailedTurn(user.id, resolved)
  if (queued) {
    afterJob('after:coordinator-wake', () => wakeCoordinator(user.id))
    return json({ queued: true })
  }
  const current = await chatView(user.id, 1, resolved)
  return json({ queued: false, reason: current.working ? 'working' : 'nothingToRetry' })
}

export const POST = withRequestLog('/api/mobile/chat/retry', async request => {
  try { return await handlePOST(request) } catch (error) {
    if (error instanceof ActionFailureError) return json({ error: error.code }, error.code === 'authRequired' ? 401 : 404)
    throw error
  }
})
