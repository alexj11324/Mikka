import { z } from 'zod'
import { cronUnauthorized } from '@/lib/cron-auth'
import { replayCoordinatorWake, retryCoordinatorWakes } from '@/lib/coordinator/wake'

export const runtime = 'nodejs'
export const maxDuration = 60
const headers = { 'cache-control': 'no-store' }

/** Cron-only documented exception to read-only GET. Replays use POST. */
export async function GET(request: Request) {
  const refused = await cronUnauthorized(request); if (refused) return refused
  try { return Response.json(await retryCoordinatorWakes(), { headers }) }
  catch { return Response.json({ error: 'coordinatorWakeSweepFailed' }, { status: 502, headers }) }
}

export async function POST(request: Request) {
  const refused = await cronUnauthorized(request); if (refused) return refused
  const input = z.strictObject({ eventId: z.uuid() }).safeParse(await request.json().catch(() => null))
  if (!input.success) return Response.json({ error: 'invalidWakeReplay' }, { status: 400, headers })
  try { return Response.json({ replayed: await replayCoordinatorWake(input.data.eventId) }, { headers }) }
  catch { return Response.json({ error: 'coordinatorWakeReplayFailed' }, { status: 502, headers }) }
}
