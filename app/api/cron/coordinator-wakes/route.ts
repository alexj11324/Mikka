import { z } from 'zod'
import { cronJob } from '@/lib/background'
import { cronUnauthorized } from '@/lib/cron-auth'
import { replayCoordinatorWake, retryCoordinatorWakes } from '@/lib/coordinator/wake'

export const runtime = 'nodejs'
export const maxDuration = 60
const headers = { 'cache-control': 'no-store' }

/** Cron-only documented exception to read-only GET. Replays use POST. */
async function handleGET(request: Request) {
  const refused = await cronUnauthorized(request); if (refused) return refused
  try { return Response.json(await retryCoordinatorWakes(), { headers }) }
  catch { return Response.json({ error: 'coordinatorWakeSweepFailed' }, { status: 502, headers }) }
}

async function handlePOST(request: Request) {
  const refused = await cronUnauthorized(request); if (refused) return refused
  const input = z.strictObject({ eventId: z.uuid() }).safeParse(await request.json().catch(() => null))
  if (!input.success) return Response.json({ error: 'invalidWakeReplay' }, { status: 400, headers })
  try { return Response.json({ replayed: await replayCoordinatorWake(input.data.eventId) }, { headers }) }
  catch { return Response.json({ error: 'coordinatorWakeReplayFailed' }, { status: 502, headers }) }
}

export const GET = cronJob('coordinator-wakes', handleGET)

export const POST = cronJob('coordinator-wakes', handlePOST)
