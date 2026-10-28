import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { withRequestLog, noteLogUser } from '@/lib/request-log'
import { db } from '@/lib/db'
import { mobilePushTokens } from '@/lib/db/schema'
import { forbiddenOrigin, json, mobileUser, unauthorized, writeAllowed } from '@/lib/mobile-api'

export const dynamic = 'force-dynamic'

const EXPO_TOKEN = z.string().regex(/^(?:Exponent|Expo)PushToken\[[A-Za-z0-9_-]{10,200}\]$/)

/**
 * `POST /api/mobile/push-tokens` with `{ token, platform, deviceName? }`: this
 * phone may get pushes. A token moves to whoever signed in on it last.
 */
async function handlePOST(request: Request) {
  const user = await mobileUser(request)
  noteLogUser(user?.id)
  if (!user) return unauthorized()
  if (!writeAllowed(request)) return forbiddenOrigin()
  const body = z.object({ token: EXPO_TOKEN, platform: z.enum(['ios', 'android']), deviceName: z.string().trim().max(120).nullable().optional() })
    .safeParse(await request.json().catch(() => null))
  if (!body.success) return json({ error: 'invalidPushToken' }, 400)
  const now = new Date()
  const values = { userId: user.id, platform: body.data.platform, deviceName: body.data.deviceName ?? null, updatedAt: now }
  await db.insert(mobilePushTokens).values({ id: crypto.randomUUID(), token: body.data.token, ...values })
    .onConflictDoUpdate({ target: mobilePushTokens.token, set: values })
  return json({ registered: true })
}

/** `DELETE /api/mobile/push-tokens` with `{ token }`: on sign-out, this phone stops getting the person's pushes. */
async function handleDELETE(request: Request) {
  const user = await mobileUser(request)
  noteLogUser(user?.id)
  if (!user) return unauthorized()
  if (!writeAllowed(request)) return forbiddenOrigin()
  const body = z.object({ token: EXPO_TOKEN }).safeParse(await request.json().catch(() => null))
  if (!body.success) return json({ error: 'invalidPushToken' }, 400)
  await db.delete(mobilePushTokens).where(and(eq(mobilePushTokens.token, body.data.token), eq(mobilePushTokens.userId, user.id)))
  return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } })
}

export const POST = withRequestLog('/api/mobile/push-tokens', handlePOST)
export const DELETE = withRequestLog('/api/mobile/push-tokens', handleDELETE)
