import { z } from 'zod'
import { verifyBearer } from '@/lib/linear-sync/webhook'
import { replayCoordinatorWake, retryCoordinatorWakes } from '@/lib/coordinator/wake'

export const runtime = 'nodejs'
export const maxDuration = 60
const headers = { 'cache-control': 'no-store' }

async function authorized(request: Request) {
  const secret = process.env.CRON_SECRET
  if (!secret) return Response.json({ error: 'Cron is not configured' }, { status: 503, headers })
  if (!await verifyBearer(request.headers.get('authorization'), secret)) return new Response(null, { status: 401, headers })
  return null
}

/** Cron-only documented exception to read-only GET. Replays use POST. */
export async function GET(request: Request) {
  const refusal = await authorized(request)
  if (refusal) return refusal
  try { return Response.json(await retryCoordinatorWakes(), { headers }) }
  catch { return Response.json({ error: 'coordinatorWakeSweepFailed' }, { status: 502, headers }) }
}

export async function POST(request: Request) {
  const refusal = await authorized(request)
  if (refusal) return refusal
  const input = z.strictObject({ eventId: z.uuid() }).safeParse(await request.json().catch(() => null))
  if (!input.success) return Response.json({ error: 'invalidWakeReplay' }, { status: 400, headers })
  try { return Response.json({ replayed: await replayCoordinatorWake(input.data.eventId) }, { headers }) }
  catch { return Response.json({ error: 'coordinatorWakeReplayFailed' }, { status: 502, headers }) }
}
