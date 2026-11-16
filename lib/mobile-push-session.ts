import 'server-only'
import { pool, withDatabaseClient } from '@/lib/db'
import { getApiSession } from '@/lib/api-auth'
import { enterprisePrincipal } from '@/lib/enterprise/principal'
import { unauthorized } from '@/lib/mobile-api'

type PushSession = { userId: string; sessionId: string }

export async function pushSession(request: Request): Promise<PushSession | null> {
  const session = await getApiSession({ headers: request.headers, query: { disableCookieCache: true } })
  const principal = session?.user[enterprisePrincipal]
  if (!session || principal?.kind !== 'session' || principal.sessionId !== session.session.id) return null
  return { userId: session.user.id, sessionId: principal.sessionId }
}

/** Authentication and mutation share a fresh session row lock. A logout or
 * reassignment cannot commit between the check and the token write. */
export async function withPushSession<T>(session: PushSession, action: () => Promise<T>): Promise<T | Response> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    try {
      const response = await withDatabaseClient(client, async () => {
        const active = await client.query(
          'SELECT id FROM "session" WHERE id=$1 AND "userId"=$2 AND "expiresAt">clock_timestamp() FOR SHARE',
          [session.sessionId, session.userId])
        return active.rowCount ? action() : unauthorized()
      })
      await client.query('COMMIT')
      return response
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    }
  } finally { client.release() }
}
