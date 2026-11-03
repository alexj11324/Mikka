import { auth } from '@/lib/auth'
import { pool } from '@/lib/db'
import { freshSessionRoute } from '@/lib/fresh-session'
import { confirmLoopbackIntent } from '@/lib/github/connect-intent'
import { saveSealedGitHubConnection } from '@/lib/github/connection'
import { withRequestLog } from '@/lib/request-log'

export const runtime = 'nodejs'
const headers = { 'Cache-Control': 'private, no-store' }

/**
 * The desktop app's loopback got GitHub's return, so it was this computer: it
 * sends the verifier only it holds, and the waiting answer becomes this
 * account's connection.
 */
async function handlePOST(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers })
  if (!session?.user) return Response.json({ error: 'authRequired' }, { status: 401, headers })
  const body = await request.json().catch(() => null) as { token?: unknown; verifier?: unknown } | null
  const linked = typeof body?.token === 'string' ? await confirmLoopbackIntent(pool, body.token, body.verifier, session.user.id, { save: saveSealedGitHubConnection }) : null
  if (!linked) return Response.json({ error: 'linkUnavailable' }, { status: 409, headers })
  return Response.json(linked, { headers })
}

// A credential write: the session is read from the database, not the cookie cache.
export const POST = freshSessionRoute(withRequestLog('/api/integrations/github/connect/intent/confirm', handlePOST))
