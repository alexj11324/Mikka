import { linearSyncEnabled } from '@/lib/linear-sync/flags'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Global availability only. No session, user, token or database reads. */
export async function GET() {
  return Response.json({ enabled: await linearSyncEnabled() }, { headers: { 'cache-control': 'no-store' } })
}
