import { NextResponse } from 'next/server'
import { auth } from '@/lib/api-auth'
import { activeTaskWorkspaces } from '@/lib/task-workspace'
import { withRequestLog } from '@/lib/request-log'
import { LIVE_ID } from '@/lib/live/events'
import { liveGatewayConfig } from '@/lib/live/scope'
import { workspaceLiveTicket } from '@/lib/enterprise/live-authority'
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
  const [workspace] = await activeTaskWorkspaces(session.user, workspaceId)
  if (!workspace) return NextResponse.json({ error: 'workspaceAccessDenied' }, { status: 403, headers })
  const access = await (await import('@/lib/resource-access/cache-proof')).readResourceAccessProof(session.user.id,workspaceId)
  const config = liveGatewayConfig(process.env)
  if (!config) return NextResponse.json({ url: null, protocol: null, expiresAt: null, ...access }, { headers })
  const scope = { ownerId: session.user.id, workspaceId }
  const result = await workspaceLiveTicket(scope, session.session?.id ?? '', config)
  if (result.status === 'denied') return NextResponse.json({ error: 'workspaceAccessDenied' }, { status: 403, headers })
  if (result.status === 'pending') return NextResponse.json({ url: null, protocol: null, expiresAt: null, ...access }, { headers })
  const issued = result.ticket
  const homeScope = workspace.kind === 'personal' ? homeScopeProof(scope, issued.expiresAt, config.secret) : null
  return NextResponse.json({ ...issued, ...access, ...(homeScope ? { homeScope } : {}) }, { headers })
}

export const GET = withRequestLog('/api/live/ticket', ticket)
