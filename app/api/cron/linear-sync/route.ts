import { verifyBearer } from '@/lib/linear-sync/crypto'
import { processLinearSyncBatch } from '@/lib/linear-sync/worker'

export const runtime = 'nodejs'
export const maxDuration = 60

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET
  if (!secret) return Response.json({ error: 'Cron is not configured' }, { status: 503 })
  if (!verifyBearer(request.headers.get('authorization'), secret)) return new Response(null, { status: 401 })
  return Response.json(await processLinearSyncBatch())
}
