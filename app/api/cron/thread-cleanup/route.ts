import { pool } from '@/lib/db'
import { verifyBearer } from '@/lib/linear-sync/webhook'
import { reconcileFinishedThreads } from '@/lib/computer/thread-result'

export const runtime = 'nodejs'
export const maxDuration = 300

/** Retry one interrupted result snapshot per invocation. Never destroy a
 * thread whose work has not first been preserved. */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET
  if (!secret) return Response.json({ error: 'Cron is not configured' }, { status: 503 })
  if (!await verifyBearer(request.headers.get('authorization'), secret)) return new Response(null, { status: 401 })
  const result = await reconcileFinishedThreads(pool)
  return Response.json(result, { status: result.failed ? 503 : 200, headers: { 'Cache-Control': 'no-store' } })
}
