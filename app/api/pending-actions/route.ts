import { NextResponse } from 'next/server'
import { auth } from '@/lib/api-auth'
import { listPendingActions } from '@/lib/pending-action-store'
import { pendingActionsOutsideToken } from '@/lib/tokens/scope'

// A plain authenticated GET: push invalidates this read without queuing behind
// the app's own actions. Keep the array body for existing consumers.
export async function GET(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers })
  if (!session?.user) return NextResponse.json({ error: 'authRequired' }, { status: 401 })
  const observedAt = new Date().toISOString()
  const listed = await listPendingActions(session.user.id)
  const outside = await pendingActionsOutsideToken(session.user, listed.map(item => item.id))
  return NextResponse.json(listed.filter(item => !outside.has(item.id)), { headers: { 'Cache-Control': 'private, no-store', 'X-Mikka-Observed-At': observedAt, 'X-Mikka-Viewer': encodeURIComponent(session.user.id) } })
}
