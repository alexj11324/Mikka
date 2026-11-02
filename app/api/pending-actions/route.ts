import { NextResponse } from 'next/server'
import { auth } from '@/lib/api-auth'
import { listPendingActions } from '@/lib/pending-action-store'
import { pendingActionsOutsideToken } from '@/lib/tokens/scope'

// A plain GET, not a server action: the card list polls, and polling through
// server actions would queue behind (and be mistaken for) the app's own actions.
export async function GET(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers })
  if (!session?.user) return NextResponse.json({ error: 'authRequired' }, { status: 401 })
  const listed = await listPendingActions(session.user.id)
  const outside = await pendingActionsOutsideToken(session.user, listed.map(item => item.id))
  return NextResponse.json(listed.filter(item => !outside.has(item.id)), { headers: { 'Cache-Control': 'private, no-store' } })
}
