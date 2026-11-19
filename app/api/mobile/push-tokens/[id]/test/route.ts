import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { BASE_PATH } from '@/lib/base-path'
import { cloudErrorStatus, CloudServiceError } from '@/lib/cloud-services/errors'
import { pool } from '@/lib/db'
import { appOrigin } from '@/lib/mcp/resource'
import { forbiddenOrigin, json, unauthorized, writeAllowed } from '@/lib/mobile-api'
import { deliverPhonePush } from '@/lib/mobile-push-delivery'
import { pushSession, withPushSession } from '@/lib/mobile-push-session'
import { personLocale } from '@/lib/suggestions/action-title-server'
import english from '@/messages/en.json'
import chinese from '@/messages/zh-CN.json'

export const maxDuration = 90

/** Some HTTP adapters supply an empty stream for POST even when no bytes were sent. */
async function hasBody(request: Request) {
  const reader = request.body?.getReader()
  if (!reader) return false
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return false
      if (value.byteLength) { await reader.cancel(); return true }
    }
  } finally { reader.releaseLock() }
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await pushSession(request)
  if (!session) return unauthorized()
  if (!writeAllowed(request)) return forbiddenOrigin()
  const { id } = await params
  if (!z.uuid().safeParse(id).success || new URL(request.url).search || await hasBody(request))
    return json({ error: 'invalidRequest' }, 400)
  const { userId, sessionId } = session
  const installation = async () => (await pool.query<{ token: string }>(
    'SELECT token FROM mobile_push_tokens WHERE id=$1 AND "userId"=$2 AND "sessionId"=$3 FOR UPDATE',
    [id, userId, sessionId])).rows[0]
  const key = 'push-test:' + createHash('sha256').update(userId).digest('hex')
  // Commit the attempt before any external I/O. Even a worker crash after sending consumes the quota.
  const claim = await withPushSession(session, async () => {
    if (!await installation()) return json({ error: 'installationUnavailable' }, 404)
    const { rows: [slot] } = await pool.query<{ id: string }>(`INSERT INTO "rateLimit" (id,key,count,"lastRequest")
      VALUES ($1,$2,1,floor(extract(epoch FROM clock_timestamp())*1000)::bigint)
      ON CONFLICT (key) DO UPDATE SET id=EXCLUDED.id,count=1,"lastRequest"=EXCLUDED."lastRequest"
      WHERE "rateLimit"."lastRequest" <= EXCLUDED."lastRequest"-60000 RETURNING id`, [randomUUID(), key])
    return slot?.id ?? json({ error: 'cloud_rate_limited' }, 429)
  })
  if (typeof claim !== 'string') return claim
  return withPushSession(session, async () => {
    const binding = await installation()
    if (!binding) return json({ error: 'installationUnavailable' }, 404)
    const current = await pool.query('SELECT 1 FROM "rateLimit" WHERE key=$1 AND id=$2 FOR SHARE', [key, claim])
    if (!current.rowCount) return json({ error: 'cloud_rate_limited' }, 429)
    const locale = await personLocale(userId)
    const fresh = await pool.query('SELECT 1 FROM "session" WHERE id=$1 AND "userId"=$2 AND "expiresAt">clock_timestamp()', [sessionId, userId])
    if (!fresh.rowCount) return unauthorized()
    try {
      const result = await deliverPhonePush(userId, { to: [binding.token], title: 'Mikka',
        body: (locale === 'en' ? english : chinese).MobilePush.testNotification,
        data: { serverUrl: appOrigin + BASE_PATH, userId } }, locale)
      if (result.accepted === 1) return json({ accepted: true }, 202)
      return result.invalid ? json({ error: 'installationUnavailable' }, 410) : json({ error: 'pushUnavailable' }, 503)
    } catch (error) {
      if (error instanceof CloudServiceError) {
        const status = cloudErrorStatus(error.code)
        return json({ error: error.code }, status === 401 ? 503 : status)
      }
      return json({ error: 'pushUnavailable' }, 503)
    }
  })
}
