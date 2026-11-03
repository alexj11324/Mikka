import { auth } from '@/lib/auth'
import { pool } from '@/lib/db'
import { freshSessionRoute } from '@/lib/fresh-session'
import { createConnectIntent, readConnectIntent } from '@/lib/github/connect-intent'
import { withRequestLog } from '@/lib/request-log'

export const runtime = 'nodejs'
const headers = { 'Cache-Control': 'private, no-store' }

/** The desktop app's Link GitHub: a one-time token naming the app's own account, for the browser it opens. */
async function handlePOST(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers })
  if (!session?.user) return Response.json({ error: 'authRequired' }, { status: 401, headers })
  return Response.json(await createConnectIntent(pool, session.user.id), { headers })
}

/** Where that link stands, for the app that started it or for a browser signed in as another account. */
async function handleGET(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers })
  if (!session?.user) return Response.json({ error: 'authRequired' }, { status: 401, headers })
  const token = new URL(request.url).searchParams.get('token') ?? ''
  return Response.json(await readConnectIntent(pool, token, session.user.id), { headers })
}

// A credential flow: the session is read from the database, not the cookie cache.
export const POST = freshSessionRoute(withRequestLog('/api/integrations/github/connect/intent', handlePOST))
export const GET = withRequestLog('/api/integrations/github/connect/intent', handleGET)
