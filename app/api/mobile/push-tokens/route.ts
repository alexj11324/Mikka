import { z } from 'zod'
import { withRequestLog, noteLogUser } from '@/lib/request-log'
import { db, pool } from '@/lib/db'
import { mobilePushTokens } from '@/lib/db/schema'
import { pushSession, removePushBinding, withPushSession } from '@/lib/mobile-push-session'
import { forbiddenOrigin, json, unauthorized, writeAllowed } from '@/lib/mobile-api'


const EXPO_TOKEN = z.string().regex(/^(?:Exponent|Expo)PushToken\[[A-Za-z0-9_-]{10,200}\]$/)
/** List only this person's bindings that are still eligible for native delivery. */
async function handleGET(request: Request) {
  const session = await pushSession(request)
  noteLogUser(session?.userId)
  if (!session) return unauthorized()
  return withPushSession(session, async () => {
    const { rows } = await pool.query(
      `SELECT binding.id, binding.platform, binding."deviceName", binding.label, binding."updatedAt",
              binding."sessionId" = $2 AS "currentSession", binding."sessionId" = $2 AS "canTest",
              binding."sessionId" = $2 AS "canRename"
         FROM mobile_push_tokens AS binding
         JOIN "session" AS active ON active.id = binding."sessionId" AND active."userId" = binding."userId"
        WHERE binding."userId" = $1 AND active."expiresAt" > clock_timestamp()
        ORDER BY binding."updatedAt" DESC, binding.id`,
      [session.userId, session.sessionId])
    return json({ installations: rows })
  })
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
    const [binding] = await db.insert(mobilePushTokens).values({ id: crypto.randomUUID(), token: body.data.token, ...values })
      .onConflictDoUpdate({ target: mobilePushTokens.token, set: values }).returning({ id: mobilePushTokens.id })
    return json({ registered: true, id: binding.id })
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
  return removePushBinding(session, body.data)
}

export const GET = withRequestLog('/api/mobile/push-tokens', handleGET)
export const POST = withRequestLog('/api/mobile/push-tokens', handlePOST)
export const DELETE = withRequestLog('/api/mobile/push-tokens', handleDELETE)
