import { timingSafeEqual } from 'node:crypto'
import { getCredentialCleanupBroker } from '@/lib/credentials/runtime'
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export async function GET(request: Request) {
  const expected = process.env.CRON_SECRET ? `Bearer ${process.env.CRON_SECRET}` : ''
  const actual = request.headers.get('authorization') ?? ''
  if (!expected || Buffer.byteLength(expected) !== Buffer.byteLength(actual) || !timingSafeEqual(Buffer.from(expected), Buffer.from(actual))) {
    return Response.json({ error: 'unauthorized' }, { status: 401 })
  }
  try { return Response.json(await getCredentialCleanupBroker().sweep(), { headers: { 'Cache-Control': 'no-store' } }) }
  catch { return Response.json({ error: 'credential_cleanup_unavailable' }, { status: 503 }) }
}
