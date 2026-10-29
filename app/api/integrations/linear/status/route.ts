import { linearSyncState } from '@/lib/linear-sync/flags'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Global availability only. No session, user, token or database reads. */
export async function GET() {
  const state = await linearSyncState()
  return Response.json({ enabled: state === 'enabled', state }, { headers: { 'cache-control': 'no-store' } })
}
