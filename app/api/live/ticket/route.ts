import { NextResponse } from 'next/server'
import { auth } from '@/lib/api-auth'
import { workspacePool } from '@/lib/workspace-db'
import { withRequestLog } from '@/lib/request-log'
import { LIVE_ID } from '@/lib/live/events'
import { liveGatewayConfig, liveTicket } from '@/lib/live/scope'
import { desktopBearerHeaders } from '@/lib/desktop-rpc/handler'
import { homeScopeProof } from '@/lib/live/home-scope-proof'

export const dynamic = 'force-dynamic'
const headers = { 'cache-control': 'private, no-store' }

async function ticket(request: Request) {
  // A native session grants the same owner channel as its browser session. PATs
  // remain workspace-scoped and never grant this ambient owner capability.
  const bearerHeaders = request.headers.has('authorization') ? desktopBearerHeaders(request) : null
  if (request.headers.has('authorization') && !bearerHeaders) return NextResponse.json({ error: 'authRequired' }, { status: 401, headers })
  // A new capability must not extend a revoked session through its cached cookie.
  const session = await auth.api.getSession({ headers: bearerHeaders ?? request.headers, query: { disableCookieCache: true } })
  if (!session?.user) return NextResponse.json({ error: 'authRequired' }, { status: 401, headers })
  const workspaceId = (new URL(request.url).searchParams.get('workspace') ?? '').toLowerCase()
  if (!LIVE_ID.test(workspaceId)) return NextResponse.json({ error: 'workspaceAccessDenied' }, { status: 403, headers })
  const member = await workspacePool.query<{ personalHome: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM mikka_workspaces w WHERE w.id=m."workspaceId" AND w."userId"=$2 AND w.kind='personal') AS "personalHome"
       FROM mikka_workspace_members m WHERE m."workspaceId"=$1 AND m."userId"=$2 AND m.status='active'`,
    [workspaceId, session.user.id],
  )
  if (!member.rowCount) return NextResponse.json({ error: 'workspaceAccessDenied' }, { status: 403, headers })
  const config = liveGatewayConfig(process.env)
  if (!config) return NextResponse.json({ url: null, protocol: null, expiresAt: null }, { headers })
  const scope = { ownerId: session.user.id, workspaceId }, issued = liveTicket(scope, config, Date.now(), session.session?.id)
  const homeScope = member.rows[0]?.personalHome ? homeScopeProof(scope, issued.expiresAt, config.secret) : null
  return NextResponse.json({ ...issued, ...(homeScope ? { homeScope } : {}) }, { headers })
}

export const GET = withRequestLog('/api/live/ticket', ticket)
