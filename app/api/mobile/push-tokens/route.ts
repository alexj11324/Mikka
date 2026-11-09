import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { withRequestLog, noteLogUser } from '@/lib/request-log'
import { db, pool, withDatabaseClient } from '@/lib/db'
import { mobilePushTokens } from '@/lib/db/schema'
import { getApiSession } from '@/lib/api-auth'
import { enterprisePrincipal } from '@/lib/enterprise/principal'
import { forbiddenOrigin, json, unauthorized, writeAllowed } from '@/lib/mobile-api'

export const dynamic = 'force-dynamic'

const EXPO_TOKEN = z.string().regex(/^(?:Exponent|Expo)PushToken\[[A-Za-z0-9_-]{10,200}\]$/)
type PushSession = { userId: string; sessionId: string }

async function pushSession(request: Request): Promise<PushSession | null> {
  const session = await getApiSession({ headers: request.headers, query: { disableCookieCache: true } })
  const principal = session?.user[enterprisePrincipal]
  if (!session || principal?.kind !== 'session' || principal.sessionId !== session.session.id) return null
  return { userId: session.user.id, sessionId: principal.sessionId }
}

/** Authentication and mutation share a fresh session row lock. A logout or
 * reassignment cannot commit between the check and the token write. */
async function withPushSession(session: PushSession, write: () => Promise<Response>): Promise<Response> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    try {
      const response = await withDatabaseClient(client, async () => {
        const active = await client.query(
          'SELECT id FROM "session" WHERE id=$1 AND "userId"=$2 AND "expiresAt">clock_timestamp() FOR SHARE',
          [session.sessionId, session.userId])
        return active.rowCount ? write() : unauthorized()
      })
      await client.query('COMMIT')
      return response
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    }
  } finally { client.release() }
}

/**
 * POST with token, platform and optional deviceName binds this installation
 * to the authenticated native session. A client cannot select its session.
 */
async function handlePOST(request: Request) {
  const session = await pushSession(request)
  noteLogUser(session?.userId)
  if (!session) return unauthorized()
  if (!writeAllowed(request)) return forbiddenOrigin()
  const body = z.object({ token: EXPO_TOKEN, platform: z.enum(['ios', 'android']), deviceName: z.string().trim().max(120).nullable().optional() }).strict()
    .safeParse(await request.json().catch(() => null))
  if (!body.success) return json({ error: 'invalidPushToken' }, 400)
  return withPushSession(session, async () => {
    const values = { userId: session.userId, sessionId: session.sessionId, platform: body.data.platform,
      deviceName: body.data.deviceName ?? null, updatedAt: new Date() }
    await db.insert(mobilePushTokens).values({ id: crypto.randomUUID(), token: body.data.token, ...values })
      .onConflictDoUpdate({ target: mobilePushTokens.token, set: values })
    return json({ registered: true })
  })
}

/** An old sign-out must not remove a token rebound to a newer session. */
async function handleDELETE(request: Request) {
  const session = await pushSession(request)
  noteLogUser(session?.userId)
  if (!session) return unauthorized()
  if (!writeAllowed(request)) return forbiddenOrigin()
  const body = z.object({ token: EXPO_TOKEN }).strict().safeParse(await request.json().catch(() => null))
  if (!body.success) return json({ error: 'invalidPushToken' }, 400)
  return withPushSession(session, async () => {
    await db.delete(mobilePushTokens).where(and(eq(mobilePushTokens.token, body.data.token),
      eq(mobilePushTokens.userId, session.userId), eq(mobilePushTokens.sessionId, session.sessionId)))
    return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } })
  })
}

export const POST = withRequestLog('/api/mobile/push-tokens', handlePOST)
export const DELETE = withRequestLog('/api/mobile/push-tokens', handleDELETE)
