import { timingSafeEqual } from 'node:crypto'
import { schedules } from '@/lib/schedules/runtime'
import { retryCoordinatorInbox } from '@/lib/coordinator/wake'
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60
export async function GET(request: Request) {
  const expected = process.env.CRON_SECRET ? `Bearer ${process.env.CRON_SECRET}` : ''
  const actual = request.headers.get('authorization') ?? ''
  if (!expected || Buffer.byteLength(expected) !== Buffer.byteLength(actual) || !timingSafeEqual(Buffer.from(expected), Buffer.from(actual))) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (process.env.MIKKA_RUNTIME_SWEEP_ENABLED !== '1') return Response.json({ error: 'runtimeSweepDisabled' }, { status: 503 })
  try { return Response.json({ schedules: await schedules().tick(25), wake: await retryCoordinatorInbox() }, { headers: { 'Cache-Control': 'no-store' } }) }
  catch { return Response.json({ error: 'runtimeSweepUnavailable' }, { status: 503 }) }
}
