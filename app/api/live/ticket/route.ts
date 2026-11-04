import { NextResponse } from 'next/server'
import { auth } from '@/lib/api-auth'
import { workspacePool } from '@/lib/workspace-db'
import { withRequestLog } from '@/lib/request-log'
import { LIVE_ID } from '@/lib/live/events'
import { liveGatewayConfig, liveTicket } from '@/lib/live/scope'

export const dynamic = 'force-dynamic'
const headers = { 'cache-control': 'private, no-store' }

async function ticket(request: Request) {
  // This is a browser subscription. API tokens do not grant an ambient owner channel.
  if (request.headers.has('authorization')) return NextResponse.json({ error: 'authRequired' }, { status: 401, headers })
  const session = await auth.api.getSession({ headers: request.headers })
  if (!session?.user) return NextResponse.json({ error: 'authRequired' }, { status: 401, headers })
  const workspaceId = new URL(request.url).searchParams.get('workspace') ?? ''
  if (!LIVE_ID.test(workspaceId)) return NextResponse.json({ error: 'workspaceAccessDenied' }, { status: 403, headers })
  const member = await workspacePool.query(
    `SELECT 1 FROM mikka_workspace_members WHERE "workspaceId"=$1 AND "userId"=$2 AND status='active'`,
    [workspaceId, session.user.id],
  )
  if (!member.rowCount) return NextResponse.json({ error: 'workspaceAccessDenied' }, { status: 403, headers })
  const config = liveGatewayConfig(process.env)
  return NextResponse.json(config ? liveTicket({ ownerId: session.user.id, workspaceId }, config) : { url: null, protocol: null, expiresAt: null }, { headers })
}

export const GET = withRequestLog('/api/live/ticket', ticket)
