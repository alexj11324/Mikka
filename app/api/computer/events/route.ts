import { auth } from '@/lib/api-auth'
import { pool } from '@/lib/db'
import { workspacePool } from '@/lib/workspace-db'
import { LIVE_ID } from '@/lib/live/events'
import { computerEventCursor } from '@/lib/computer/event-page'
import { readComputerEvents } from '@/lib/computer/event-log'
import { withRequestLog } from '@/lib/request-log'
import { humanSessionHeaders } from '@/lib/desktop-rpc/handler'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
const headers = { 'cache-control': 'private, no-store' }

/** Browser notifications contain no data; each incremental read authorizes again. */
async function events(request: Request) {
  const sessionHeaders = humanSessionHeaders(request)
  if (!sessionHeaders) return new Response(null, { status: 401, headers })
  const session = await auth.api.getSession({ headers: sessionHeaders, query: { disableCookieCache: true } })
  if (!session?.user) return new Response(null, { status: 401, headers })
  const params = new URL(request.url).searchParams
  const workspaceId = params.get('workspace') ?? ''
  const cursor = computerEventCursor(params.get('after') ?? '0')
  if (!LIVE_ID.test(workspaceId) || cursor === null) return new Response(null, { status: 400, headers })
  const member = await workspacePool.query(
    `SELECT 1 FROM mikka_workspace_members WHERE "workspaceId"=$1 AND "userId"=$2 AND status='active'`,
    [workspaceId, session.user.id],
  )
  if (!member.rowCount) return new Response(null, { status: 403, headers })
  const page = await readComputerEvents(pool, { ownerId: session.user.id, workspaceId }, cursor)
  return Response.json(page, { headers })
}

export const GET = withRequestLog('/api/computer/events', events)
