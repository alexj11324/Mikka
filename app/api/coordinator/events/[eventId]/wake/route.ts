import { after } from 'next/server'
import { z } from 'zod'
import { auth } from '@/lib/auth'
import { appOrigin } from '@/lib/mcp/resource'
import { scheduleOriginAllowed } from '@/lib/schedules/http'
import { coordinatorInbox } from '@/lib/coordinator/inbox-runtime'
import { WakeError } from '@/lib/coordinator/inbox-receipts'
import { wakeCoordinator } from '@/lib/coordinator/wake'
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
type Context = { params: Promise<{ eventId: string }> }
const headers = { 'Cache-Control': 'private, no-store' }
async function actor(request: Request, context: Context) {
  const session = await auth.api.getSession({ headers: request.headers, query: { disableCookieCache: true } })
  if (!session?.user) throw new WakeError('authRequired', 401)
  const { eventId } = await context.params
  if (!z.uuid().safeParse(eventId).success) throw new WakeError('wakeNotFound', 404)
  return { owner: session.user.id, eventId }
}
const failure = (error: unknown) =>
  Response.json(
    { error: error instanceof WakeError ? error.code : 'wakeUnavailable' },
    { status: error instanceof WakeError ? error.status : 503, headers },
  )
export async function GET(request: Request, context: Context) {
  try {
    const { owner, eventId } = await actor(request, context),
      event = await coordinatorInbox().read(owner, eventId)
    return Response.json(
      {
        eventId: event.id,
        operationId: event.id,
        workspaceId: event.wake_workspace_id,
        status: event.wake_status,
        attempts: event.wake_attempts,
        nextRetryAt: (event as unknown as { wake_next_at: Date }).wake_next_at,
        error: event.wake_error,
        generation: event.wake_replays,
        generationState: event.wake_generation_state,
        checkpointDigest: event.wake_checkpoint_digest,
        processedAt: event.processed_at,
      },
      { headers },
    )
  } catch (error) {
    return failure(error)
  }
}
export async function POST(request: Request, context: Context) {
  try {
    if (!scheduleOriginAllowed(request, appOrigin)) throw new WakeError('originRejected', 403)
    const { owner, eventId } = await actor(request, context)
    const parsed = z
      .object({ action: z.literal('replay'), expectedGeneration: z.number().int().nonnegative() })
      .strict()
      .safeParse(await request.json().catch(() => null))
    if (!parsed.success) throw new WakeError('wakeReplayInvalid', 400)
    const result = await coordinatorInbox().replay(owner, eventId, parsed.data.expectedGeneration)
    after(() => wakeCoordinator(owner))
    return Response.json(result, { status: 202, headers })
  } catch (error) {
    return failure(error)
  }
}
